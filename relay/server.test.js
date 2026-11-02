import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentAuthenticator } from "./auth.js";
import { JsonIdempotencyStore } from "./payment-requests.js";
import { createRelayServer } from "./server.js";

const token = "relay-api-test-token-0123456789abcdef";
const payment = { recipient_id: "merchant.testnet", amount_yocto: "1000000000000000000000" };
const key = "agent-payment-request-0001";

async function withServer(options, run) {
  const server = createRelayServer(options);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function withJournal(run) {
  const directory = await mkdtemp(join(tmpdir(), "tapproved-api-"));
  try {
    await run(join(directory, "journal.json"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function authOptions() {
  return { authenticate: createAgentAuthenticator({ token }) };
}

test("health endpoint remains public and returns process health", async () => {
  await withServer(authOptions(), async (base) => {
    const response = await fetch(`${base}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      name: "tapproved", status: "ok", network: "testnet"
    });
  });
});

test("payment endpoint rejects unauthenticated callers before reading a request", async () => {
  await withJournal(async (path) => {
    const store = new JsonIdempotencyStore(path);
    await withServer({
      ...authOptions(),
      idempotencyStore: store,
      submitPayment: async () => { throw new Error("must not be called"); }
    }, async (base) => {
      const response = await fetch(`${base}/v1/payment-requests`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify(payment)
      });
      assert.equal(response.status, 401);
      assert.equal((await response.json()).error, "unauthorized");
      assert.equal(await store.get("manex-agent.testnet", key), null);
    });
  });
});

test("payment endpoint submits once and returns the stored result on retry", async () => {
  await withJournal(async (path) => {
    const store = new JsonIdempotencyStore(path);
    let submissions = 0;
    await withServer({
      ...authOptions(),
      idempotencyStore: store,
      submitPayment: async (request) => {
        submissions += 1;
        assert.deepEqual(request, payment);
        return {
          transaction_hash: "testnet-transaction-hash",
          execution_transaction_hash: "testnet-execution-hash",
          payment: { id: "12", status: "approved" }
        };
      }
    }, async (base) => {
      const request = () => fetch(`${base}/v1/payment-requests`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "idempotency-key": key
        },
        body: JSON.stringify(payment)
      });
      const first = await request();
      assert.equal(first.status, 202);
      const firstBody = await first.json();
      assert.equal(firstBody.state, "submitted");
      assert.equal(firstBody.replayed, false);
      assert.equal(firstBody.transaction_hash, "testnet-transaction-hash");
      assert.equal(firstBody.execution_transaction_hash, "testnet-execution-hash");

      const second = await request();
      assert.equal(second.status, 200);
      const secondBody = await second.json();
      assert.equal(secondBody.replayed, true);
      assert.equal(secondBody.payment.id, "12");
      assert.equal(submissions, 1);
    });
  });
});

test("payment endpoint rejects idempotency-key reuse with changed amount", async () => {
  await withJournal(async (path) => {
    const store = new JsonIdempotencyStore(path);
    let submissions = 0;
    await withServer({
      ...authOptions(),
      idempotencyStore: store,
      submitPayment: async () => {
        submissions += 1;
        return { transaction_hash: "tx", payment: { id: "1" } };
      }
    }, async (base) => {
      const send = (amount) => fetch(`${base}/v1/payment-requests`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "idempotency-key": key
        },
        body: JSON.stringify({ ...payment, amount_yocto: amount })
      });
      assert.equal((await send(payment.amount_yocto)).status, 202);
      const conflict = await send("2000000000000000000000");
      assert.equal(conflict.status, 409);
      assert.equal((await conflict.json()).error, "idempotency_conflict");
      assert.equal(submissions, 1);
    });
  });
});

test("payment endpoint rejects JSON numbers and missing idempotency keys", async () => {
  await withJournal(async (path) => {
    await withServer({
      ...authOptions(),
      idempotencyStore: new JsonIdempotencyStore(path),
      submitPayment: async () => ({ transaction_hash: "tx" })
    }, async (base) => {
      const headers = {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "idempotency-key": key
      };
      const numericAmount = await fetch(`${base}/v1/payment-requests`, {
        method: "POST", headers,
        body: JSON.stringify({ recipient_id: "merchant.testnet", amount_yocto: 1000 })
      });
      assert.equal(numericAmount.status, 400);

      const missingKey = await fetch(`${base}/v1/payment-requests`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(payment)
      });
      assert.equal(missingKey.status, 400);
    });
  });
});

test("payment endpoint refuses to mutate when signer adapter is not configured", async () => {
  await withJournal(async (path) => {
    await withServer({
      ...authOptions(),
      idempotencyStore: new JsonIdempotencyStore(path)
    }, async (base) => {
      const response = await fetch(`${base}/v1/payment-requests`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "idempotency-key": key
        },
        body: JSON.stringify(payment)
      });
      assert.equal(response.status, 503);
      assert.equal((await response.json()).error, "payment_submission_not_configured");
    });
  });
});
