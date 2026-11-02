import test from "node:test";
import assert from "node:assert/strict";
import {
  createPaymentExpiryMonitor,
  readExpiryMonitorInterval
} from "./expiry-service.js";
import { CANONICAL_AGENT_ID } from "./near-signer.js";

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
      if (operations.has(id)) return { created: false, operation: operations.get(id) };
      const operation = { agent_id: agentId, payment_id: paymentId, kind, state: "submitting" };
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
    async confirmOperation(agentId, paymentId, kind, observedStatus) {
      const operation = operations.get(key(agentId, paymentId, kind));
      operation.state = "confirmed";
      operation.observed_status = observedStatus;
      return operation;
    }
  };
}

const payment = {
  id: "51",
  agent_id: CANONICAL_AGENT_ID,
  recipient_id: "merchant.testnet",
  amount_yocto: "123456789",
  nonce: "51",
  expires_at_ns: "1000",
  status: "pending"
};

test("expiry monitor compares expiry against finalized chain time, not host time", async () => {
  let submissions = 0;
  const monitor = createPaymentExpiryMonitor({
    env: {},
    operationStore: createOperationStore(),
    operationStore: createOperationStore(),
    expirySigner: { expirePayment: async () => { submissions += 1; } },
    getActivePayment: async () => payment,
    getLatestBlockTimestampNs: async () => "1000"
  });
  const result = await monitor.runOnce();
  assert.equal(result.state, "not_due");
  assert.equal(result.chain_timestamp_ns, "1000");
  assert.equal(submissions, 0);
});

test("expired pending payment is submitted once and confirmed from contract state", async () => {
  let submissions = 0;
  const monitor = createPaymentExpiryMonitor({
    env: {},
    expirySigner: {
      async expirePayment(paymentId) {
        submissions += 1;
        assert.equal(paymentId, "51");
        return { transaction_hash: "expiry-transaction-hash" };
      }
    },
    getActivePayment: async () => payment,
    getLatestBlockTimestampNs: async () => "1001",
    getPayment: async (paymentId) => ({
      ...payment,
      id: paymentId,
      status: "expired"
    })
  });
  const first = await monitor.runOnce();
  assert.equal(first.state, "expired");
  assert.equal(first.transaction_hash, "expiry-transaction-hash");
  assert.equal(first.payment.status, "expired");

  const second = await monitor.runOnce();
  assert.equal(second.state, "reconciled");
  assert.equal(submissions, 1);
});

test("expired automatically approved payments are eligible for contract expiry", async () => {
  let submitted = false;
  const monitor = createPaymentExpiryMonitor({
    expirySigner: {
      async expirePayment() {
        submitted = true;
        return { transaction_hash: "approved-expiry-hash" };
      }
    },
    getActivePayment: async () => ({ ...payment, status: "approved" }),
    getLatestBlockTimestampNs: async () => "1002",
    getPayment: async () => ({ ...payment, status: "expired" })
  });
  const result = await monitor.runOnce();
  assert.equal(result.state, "expired");
  assert.equal(submitted, true);
});

test("does not expire processing or foreign-agent payments", async () => {
  let submissions = 0;
  const monitor = createPaymentExpiryMonitor({
    expirySigner: { expirePayment: async () => { submissions += 1; } },
    getActivePayment: async () => ({ ...payment, status: "processing" }),
    getLatestBlockTimestampNs: async () => "1001"
  });
  assert.equal((await monitor.runOnce()).state, "not_expirable");
  const foreign = createPaymentExpiryMonitor({
    expirySigner: { expirePayment: async () => { submissions += 1; } },
    getActivePayment: async () => ({ ...payment, agent_id: "attacker.testnet" }),
    getLatestBlockTimestampNs: async () => "1001"
  });
  await assert.rejects(foreign.runOnce(), /invalid canonical expiry context/);
  assert.equal(submissions, 0);
});

test("persists ambiguous expiry attempts and suppresses retries across monitor restarts", async () => {
  let submissions = 0;
  const durableStore = createOperationStore();
  const first = createPaymentExpiryMonitor({
    operationStore: durableStore,
    expirySigner: {
      async expirePayment() {
        submissions += 1;
        throw new Error("connection lost after broadcast");
      }
    },
    getActivePayment: async () => payment,
    getLatestBlockTimestampNs: async () => "1001"
  });
  await assert.rejects(first.runOnce(), /connection lost after broadcast/);
  const restarted = createPaymentExpiryMonitor({
    operationStore: durableStore,
    expirySigner: {
      async expirePayment() {
        submissions += 1;
        return { transaction_hash: "duplicate-must-not-submit" };
      }
    },
    getActivePayment: async () => payment,
    getLatestBlockTimestampNs: async () => "1001",
    getPayment: async () => ({ ...payment, status: "pending" })
  });
  assert.equal((await restarted.runOnce()).state, "recovery_required");
  assert.equal(submissions, 1);
});

test("expiry monitor suppresses overlapping polls", async () => {
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  const monitor = createPaymentExpiryMonitor({
    operationStore: createOperationStore(),
    expirySigner: { expirePayment: async () => ({ transaction_hash: "unused" }) },
    getActivePayment: async () => {
      await wait;
      return null;
    },
    getLatestBlockTimestampNs: async () => "0"
  });
  const first = monitor.runOnce();
  const second = await monitor.runOnce();
  assert.equal(second.state, "already_running");
  release();
  assert.equal((await first).state, "idle");
});

test("validates expiry polling interval bounds", () => {
  assert.equal(readExpiryMonitorInterval({}), 15000);
  assert.equal(readExpiryMonitorInterval({ EXPIRY_MONITOR_INTERVAL_MS: "1000" }), 1000);
  assert.equal(readExpiryMonitorInterval({ EXPIRY_MONITOR_INTERVAL_MS: "3600000" }), 3600000);
  assert.throws(() => readExpiryMonitorInterval({ EXPIRY_MONITOR_INTERVAL_MS: "999" }), /between 1000 and 3600000/);
  assert.throws(() => readExpiryMonitorInterval({ EXPIRY_MONITOR_INTERVAL_MS: "fast" }), /decimal integer/);
});
