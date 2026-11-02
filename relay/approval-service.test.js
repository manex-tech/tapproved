import test from "node:test";
import assert from "node:assert/strict";
import { createApprovalProcessor } from "./approval-service.js";
import { HardwareApprovalError } from "./near-signer.js";

const pendingPayment = {
  id: "45",
  agent_id: "manex-agent.testnet",
  recipient_id: "merchant.testnet",
  amount_yocto: "123456789",
  nonce: "45",
  expires_at_ns: "1793519712345678901",
  status: "pending"
};

function createOperationStore() {
  const operations = new Map();
  const key = (agentId, paymentId, kind) => `${agentId}:${paymentId}:${kind}`;
  return {
    operations,
    async getOperation(agentId, paymentId, kind) {
      return operations.get(key(agentId, paymentId, kind)) ?? null;
    },
    async beginOperation(agentId, paymentId, kind) {
      const id = key(agentId, paymentId, kind);
      if (operations.has(id) && operations.get(id).state !== "rejected") {
        return { created: false, operation: operations.get(id) };
      }
      const operation = operations.get(id) ?? { agent_id: agentId, payment_id: paymentId, kind };
      operation.state = "submitting";
      operation.attempt_count = (operation.attempt_count ?? 0) + 1;
      operations.set(id, operation);
      return { created: true, operation };
    },
    async completeOperation(agentId, paymentId, kind, transactionHash) {
      const operation = operations.get(key(agentId, paymentId, kind));
      operation.state = "submitted";
      operation.transaction_hash = transactionHash;
      return operation;
    },
    async markOperationUncertain(agentId, paymentId, kind) {
      const operation = operations.get(key(agentId, paymentId, kind));
      operation.state = "uncertain";
      return operation;
    },
    async rejectOperation(agentId, paymentId, kind, errorCode) {
      const operation = operations.get(key(agentId, paymentId, kind));
      operation.state = "rejected";
      operation.error_code = errorCode;
      return operation;
    },
    async confirmOperation(agentId, paymentId, kind, observedStatus) {
      const operation = operations.get(key(agentId, paymentId, kind));
      operation.state = "confirmed";
      operation.observed_status = observedStatus;
      return operation;
    }
  };
}

function dependencies(overrides = {}) {
  const calls = { reads: 0, connects: 0, requests: 0, submits: 0 };
  const serialBridge = {
    async connect() { calls.connects += 1; },
    async requestApproval(payment) {
      calls.requests += 1;
      assert.equal(payment.id, pendingPayment.id);
      return { public_key_hex: "ab".repeat(32), signature_hex: "cd".repeat(64) };
    }
  };
  const approvalSigner = {
    async approveSpend(payment, signed) {
      calls.submits += 1;
      assert.equal(payment.id, pendingPayment.id);
      assert.equal(signed.public_key_hex, "ab".repeat(32));
      return { transaction_hash: "approval-transaction", payment: { ...payment, status: "processing" } };
    }
  };
  const operationStore = overrides.operationStore ?? createOperationStore();
  const processor = createApprovalProcessor({
    operationStore,
    getActivePayment: async () => {
      calls.reads += 1;
      return pendingPayment;
    },
    serialBridge,
    approvalSigner,
    ...overrides
  });
  return { processor, calls, operationStore };
}

test("does not connect to hardware when there is no pending payment", async () => {
  const { processor, calls } = dependencies({ getActivePayment: async () => null });
  assert.deepEqual(await processor(), { state: "no_pending_approval" });
  assert.equal(calls.connects, 0);
  assert.equal(calls.requests, 0);
  assert.equal(calls.submits, 0);
});

test("does not send approved or processing payments to the device", async () => {
  const { processor, calls } = dependencies({
    getActivePayment: async () => ({ ...pendingPayment, status: "processing" })
  });
  assert.deepEqual(await processor(), {
    state: "not_pending",
    payment_id: "45",
    payment_status: "processing"
  });
  assert.equal(calls.connects, 0);
  assert.equal(calls.requests, 0);
  assert.equal(calls.submits, 0);
});

test("sends only the active contract-pending payment and submits the device signature", async () => {
  const { processor, calls } = dependencies();
  const result = await processor();
  assert.deepEqual(result, {
    state: "submitted",
    payment_id: "45",
    transaction_hash: "approval-transaction",
    payment: { ...pendingPayment, status: "processing" }
  });
  assert.deepEqual(calls, { reads: 1, connects: 1, requests: 1, submits: 1 });
});

test("does not retry after a device approval failure", async () => {
  let requests = 0;
  const { processor } = dependencies({
    serialBridge: {
      async connect() {},
      async requestApproval() {
        requests += 1;
        const error = new Error("device timeout");
        error.code = "device_approval_timeout";
        throw error;
      }
    }
  });
  await assert.rejects(processor(), (error) => error.code === "device_approval_timeout");
  assert.equal(requests, 1);
});

test("prevents concurrent physical approval cycles", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { processor } = dependencies({
    serialBridge: {
      async connect() {},
      async requestApproval() {
        await gate;
        return { public_key_hex: "ab".repeat(32), signature_hex: "cd".repeat(64) };
      }
    }
  });
  const first = processor();
  await assert.rejects(processor(), (error) => error.code === "approval_already_in_progress");
  release();
  const result = await first;
  assert.equal(result.state, "submitted");
});

test("persists ambiguous approval submissions and suppresses retries", async () => {
  let submissions = 0;
  const { processor, operationStore } = dependencies({
    approvalSigner: {
      async approveSpend() {
        submissions += 1;
        throw new Error("connection dropped after broadcast");
      }
    }
  });
  await assert.rejects(processor(), (error) => error.code === "approval_submission_outcome_unknown");
  assert.equal((await operationStore.getOperation("manex-agent.testnet", "45", "approval")).state, "uncertain");
  await assert.rejects(processor(), (error) => error.code === "approval_recovery_required");
  assert.equal(submissions, 1);
});


test("does not ask the ESP32 to approve again while an interrupted attempt needs reconciliation", async () => {
  const operationStore = createOperationStore();
  await operationStore.beginOperation("manex-agent.testnet", "45", "approval");
  await operationStore.markOperationUncertain("manex-agent.testnet", "45", "approval");
  const { processor, calls } = dependencies({ operationStore });
  await assert.rejects(
    processor(),
    (error) => error.code === "approval_recovery_required"
  );
  assert.equal(calls.connects, 0);
  assert.equal(calls.requests, 0);
  assert.equal(calls.submits, 0);
});

test("records and confirms a successful approval transaction", async () => {
  const { processor, operationStore } = dependencies();
  await processor();
  const operation = await operationStore.getOperation("manex-agent.testnet", "45", "approval");
  assert.equal(operation.state, "confirmed");
  assert.equal(operation.transaction_hash, "approval-transaction");
  assert.equal(operation.observed_status, "processing");
});


test("permits a new approval cycle after a known pre-submit signature rejection", async () => {
  let signerCalls = 0;
  const { processor, operationStore } = dependencies({
    approvalSigner: {
      async approveSpend(payment) {
        signerCalls += 1;
        if (signerCalls === 1) throw new HardwareApprovalError("invalid_device_signature");
        return {
          transaction_hash: "approval-after-rejection",
          payment: { ...payment, status: "processing" }
        };
      }
    }
  });
  await assert.rejects(
    processor(),
    (error) => error.code === "invalid_device_signature"
  );
  const rejected = await operationStore.getOperation("manex-agent.testnet", "45", "approval");
  assert.equal(rejected.state, "rejected");
  const result = await processor();
  assert.equal(result.transaction_hash, "approval-after-rejection");
  const confirmed = await operationStore.getOperation("manex-agent.testnet", "45", "approval");
  assert.equal(confirmed.state, "confirmed");
  assert.equal(confirmed.attempt_count, 2);
  assert.equal(signerCalls, 2);
});
