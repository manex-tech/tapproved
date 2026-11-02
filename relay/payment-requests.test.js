import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IdempotencyConflictError,
  JsonIdempotencyStore,
  submitIdempotentPaymentRequest,
  validateIdempotencyKey,
  validatePaymentRequest,
  U128_MAX
} from "./payment-requests.js";

const agentId = "manex-agent.testnet";
const key = "request-000000000001";
const payment = { recipient_id: "merchant.testnet", amount_yocto: "1000000000000000000000" };

async function withStore(run) {
  const directory = await mkdtemp(join(tmpdir(), "tapproved-idempotency-"));
  try {
    await run(join(directory, "journal.json"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("validates NEAR recipient and exact decimal yocto amount", () => {
  assert.deepEqual(validatePaymentRequest(payment), payment);
  assert.equal(validatePaymentRequest({
    recipient_id: "merchant.testnet",
    amount_yocto: U128_MAX.toString()
  }).amount_yocto, U128_MAX.toString());
});

test("rejects malformed recipients, JSON numbers, zero, negatives and u128 overflow", () => {
  for (const input of [
    { ...payment, recipient_id: "UPPER.testnet" },
    { ...payment, recipient_id: "bad..account" },
    { ...payment, amount_yocto: 1000 },
    { ...payment, amount_yocto: "0" },
    { ...payment, amount_yocto: "-1" },
    { ...payment, amount_yocto: (U128_MAX + 1n).toString() }
  ]) {
    assert.throws(() => validatePaymentRequest(input));
  }
});

test("requires a bounded URL-safe idempotency key", () => {
  assert.equal(validateIdempotencyKey(key), key);
  for (const invalid of ["short", "contains spaces 123456", "x".repeat(129), undefined]) {
    assert.throws(() => validateIdempotencyKey(invalid));
  }
});

test("persists a reservation and returns it after store restart", async () => {
  await withStore(async (path) => {
    const first = new JsonIdempotencyStore(path);
    const reserved = await first.reserve({ agentId, idempotencyKey: key, payment });
    assert.equal(reserved.created, true);
    assert.equal(reserved.record.state, "reserved");

    const second = new JsonIdempotencyStore(path);
    const replay = await second.reserve({ agentId, idempotencyKey: key, payment });
    assert.equal(replay.created, false);
    assert.equal(replay.record.state, "reserved");
  });
});

test("same key with different payment content is rejected", async () => {
  await withStore(async (path) => {
    const store = new JsonIdempotencyStore(path);
    await store.reserve({ agentId, idempotencyKey: key, payment });
    await assert.rejects(
      store.reserve({
        agentId,
        idempotencyKey: key,
        payment: { ...payment, amount_yocto: "2000" }
      }),
      IdempotencyConflictError
    );
  });
});

test("concurrent reservations in one relay process create one record", async () => {
  await withStore(async (path) => {
    const store = new JsonIdempotencyStore(path);
    const results = await Promise.all(Array.from({ length: 12 }, () =>
      store.reserve({ agentId, idempotencyKey: key, payment })
    ));
    assert.equal(results.filter((result) => result.created).length, 1);
  });
});

test("successful submission is replayed without a second submit call", async () => {
  await withStore(async (path) => {
    const store = new JsonIdempotencyStore(path);
    let calls = 0;
    const submit = async () => {
      calls += 1;
      return { transaction_hash: "test-transaction-hash", execution_transaction_hash: "execution-transaction-hash", payment: { id: "7", status: "paid" } };
    };
    const first = await submitIdempotentPaymentRequest({
      store, agentId, idempotencyKey: key, payment, submit
    });
    const second = await submitIdempotentPaymentRequest({
      store, agentId, idempotencyKey: key, payment, submit
    });
    assert.equal(first.record.state, "submitted");
    assert.equal(second.replayed, true);
    assert.equal(second.record.result.payment.id, "7");
    assert.equal(second.record.result.execution_transaction_hash, "execution-transaction-hash");
    assert.equal(calls, 1);
  });
});

test("ambiguous submission failure is persisted and never automatically retried", async () => {
  await withStore(async (path) => {
    const store = new JsonIdempotencyStore(path);
    let calls = 0;
    const submit = async () => {
      calls += 1;
      throw new Error("connection lost after broadcast");
    };
    await assert.rejects(submitIdempotentPaymentRequest({
      store, agentId, idempotencyKey: key, payment, submit
    }));
    const replay = await submitIdempotentPaymentRequest({
      store, agentId, idempotencyKey: key, payment, submit
    });
    assert.equal(replay.record.state, "uncertain");
    assert.equal(calls, 1);
  });
});

test("corrupt journal fails closed instead of allowing a fresh reservation", async () => {
  await withStore(async (path) => {
    const store = new JsonIdempotencyStore(path);
    await store.reserve({ agentId, idempotencyKey: key, payment });
    await (await import("node:fs/promises")).writeFile(path, "{broken", "utf8");
    const restarted = new JsonIdempotencyStore(path);
    await assert.rejects(
      restarted.reserve({ agentId, idempotencyKey: "request-000000000002", payment }),
      /corrupt/
    );
    assert.equal((await readFile(path, "utf8")), "{broken");
  });
});


test("migrates v1 journal and durably suppresses duplicate approval and expiry operations", async () => {
  await withStore(async (path) => {
    await writeFile(path, JSON.stringify({ version: 1, records: [] }), "utf8");
    const first = new JsonIdempotencyStore(path);
    const approval = await first.beginOperation(agentId, "71", "approval");
    assert.equal(approval.created, true);
    await first.markOperationUncertain(agentId, "71", "approval");
    const expiry = await first.beginOperation(agentId, "72", "expiry");
    assert.equal(expiry.created, true);
    await first.completeOperation(agentId, "72", "expiry", "expiry-hash");

    const restarted = new JsonIdempotencyStore(path);
    const approvalReplay = await restarted.beginOperation(agentId, "71", "approval");
    const expiryReplay = await restarted.beginOperation(agentId, "72", "expiry");
    assert.equal(approvalReplay.created, false);
    assert.equal(approvalReplay.operation.state, "uncertain");
    assert.equal(expiryReplay.created, false);
    assert.equal(expiryReplay.operation.state, "submitted");
    await restarted.confirmOperation(agentId, "72", "expiry", "expired");
    assert.equal((await restarted.getOperation(agentId, "72", "expiry")).state, "confirmed");

    const parsed = JSON.parse(await readFile(path, "utf8"));
    assert.equal(parsed.version, 2);
    assert.equal(parsed.operations.length, 2);
  });
});


test("operation confirmation requires a contract state appropriate to the operation", async () => {
  await withStore(async (path) => {
    const store = new JsonIdempotencyStore(path);
    await store.beginOperation(agentId, "74", "approval");
    await store.beginOperation(agentId, "75", "expiry");
    await assert.rejects(
      store.confirmOperation(agentId, "74", "approval", "pending"),
      /does not confirm/
    );
    await store.confirmOperation(agentId, "74", "approval", "processing");
    // A concurrently executed payment supersedes an expiry attempt safely.
    await store.confirmOperation(agentId, "75", "expiry", "processing");
    assert.equal((await store.listUnresolvedOperations(agentId)).length, 0);
  });
});
