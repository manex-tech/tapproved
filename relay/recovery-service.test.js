import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonIdempotencyStore } from "./payment-requests.js";
import { createRecoveryService, readRecoveryInterval } from "./recovery-service.js";

const agentId = "manex-agent.testnet";
const paymentRequest = {
  recipient_id: "merchant.testnet",
  amount_yocto: "123456789"
};
const activePayment = {
  id: "81",
  agent_id: agentId,
  ...paymentRequest,
  status: "pending"
};

async function withStore(run) {
  const directory = await mkdtemp(join(tmpdir(), "tapproved-recovery-"));
  try {
    await run(new JsonIdempotencyStore(join(directory, "journal.json")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("reconciles exactly one interrupted request from authoritative active contract state", async () => {
  await withStore(async (store) => {
    await store.reserve({ agentId, idempotencyKey: "request-000000000081", payment: paymentRequest });
    await store.transition(agentId, "request-000000000081", "submitting");
    let submitCalls = 0;
    const recovery = createRecoveryService({
      store,
      getActivePayment: async () => activePayment,
      getPayment: async () => activePayment
    });
    const result = await recovery.reconcileOnce();
    assert.equal(result.state, "reconciled");
    assert.equal(result.request_recovery, "reconciled");
    assert.equal(result.reconciled_payment_requests, 1);
    assert.equal(result.unresolved_payment_requests, 0);
    const record = await store.get(agentId, "request-000000000081");
    assert.equal(record.state, "submitted");
    assert.equal(record.result.recovered, true);
    assert.equal(record.result.payment.id, "81");
    assert.equal(submitCalls, 0);
  });
});

test("does not guess when multiple unresolved requests match the same active payment", async () => {
  await withStore(async (store) => {
    for (const key of ["request-000000000081", "request-000000000082"]) {
      await store.reserve({ agentId, idempotencyKey: key, payment: paymentRequest });
      await store.transition(agentId, key, "submitting");
    }
    const recovery = createRecoveryService({
      store,
      getActivePayment: async () => activePayment
    });
    const result = await recovery.reconcileOnce();
    assert.equal(result.request_recovery, "ambiguous_match");
    assert.equal(result.unresolved_payment_requests, 2);
    assert.equal(result.state, "manual_review_required");
  });
});

test("leaves an unresolved request for manual review when no active payment exists", async () => {
  await withStore(async (store) => {
    await store.reserve({ agentId, idempotencyKey: "request-000000000083", payment: paymentRequest });
    await store.transition(agentId, "request-000000000083", "uncertain", {
      error_code: "submission_outcome_unknown"
    });
    const recovery = createRecoveryService({
      store,
      getActivePayment: async () => null
    });
    const result = await recovery.reconcileOnce();
    assert.equal(result.request_recovery, "no_active_payment_manual_review");
    assert.equal(result.unresolved_payment_requests, 1);
    assert.equal(result.state, "manual_review_required");
  });
});

test("reconciles interrupted approval and expiry operations from payment history", async () => {
  await withStore(async (store) => {
    await store.beginOperation(agentId, "84", "approval");
    await store.markOperationUncertain(agentId, "84", "approval");
    await store.beginOperation(agentId, "85", "expiry");
    await store.completeOperation(agentId, "85", "expiry", "expiry-tx");
    const recovery = createRecoveryService({
      store,
      getActivePayment: async () => null,
      getPayment: async (id) => ({
        id,
        agent_id: agentId,
        status: id === "84" ? "processing" : "expired"
      })
    });
    const result = await recovery.reconcileOnce();
    assert.equal(result.confirmed_operations, 2);
    assert.equal(result.unresolved_operations, 0);
    assert.equal(result.state, "reconciled");
    assert.equal((await store.getOperation(agentId, "84", "approval")).state, "confirmed");
    assert.equal((await store.getOperation(agentId, "85", "expiry")).observed_status, "expired");
  });
});

test("keeps ambiguous approval attempts unresolved while the contract still says pending", async () => {
  await withStore(async (store) => {
    await store.beginOperation(agentId, "86", "approval");
    await store.markOperationUncertain(agentId, "86", "approval");
    const recovery = createRecoveryService({
      store,
      getActivePayment: async () => activePayment,
      getPayment: async () => ({ ...activePayment, id: "86" })
    });
    const result = await recovery.reconcileOnce();
    assert.equal(result.unresolved_operations, 1);
    assert.equal(result.state, "manual_review_required");
    assert.equal((await store.getOperation(agentId, "86", "approval")).state, "uncertain");
  });
});

test("validates recovery polling interval", () => {
  assert.equal(readRecoveryInterval({}), 30000);
  assert.equal(readRecoveryInterval({ RECOVERY_MONITOR_INTERVAL_MS: "5000" }), 5000);
  assert.equal(readRecoveryInterval({ RECOVERY_MONITOR_INTERVAL_MS: "3600000" }), 3600000);
  assert.throws(() => readRecoveryInterval({ RECOVERY_MONITOR_INTERVAL_MS: "4999" }), /between 5000 and 3600000/);
  assert.throws(() => readRecoveryInterval({ RECOVERY_MONITOR_INTERVAL_MS: "fast" }), /decimal integer/);
});
