import test from "node:test";
import assert from "node:assert/strict";
import { createApprovalProcessor } from "./approval-service.js";

const pendingPayment = {
  id: "45",
  agent_id: "manex-agent.testnet",
  recipient_id: "merchant.testnet",
  amount_yocto: "123456789",
  nonce: "45",
  expires_at_ns: "1793519712345678901",
  status: "pending"
};

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
  const processor = createApprovalProcessor({
    getActivePayment: async () => {
      calls.reads += 1;
      return pendingPayment;
    },
    serialBridge,
    approvalSigner,
    ...overrides
  });
  return { processor, calls };
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

test("treats an ambiguous signer failure as unknown and never retries submission", async () => {
  let submissions = 0;
  const { processor } = dependencies({
    approvalSigner: {
      async approveSpend() {
        submissions += 1;
        throw new Error("connection dropped after broadcast");
      }
    }
  });
  await assert.rejects(processor(), (error) => error.code === "approval_submission_outcome_unknown");
  assert.equal(submissions, 1);
});
