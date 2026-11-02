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


test("pending-approvals endpoint returns only a contract-pending payment", async () => {
  const pendingPayment = {
    id: "15",
    agent_id: "manex-agent.testnet",
    recipient_id: "merchant.testnet",
    amount_yocto: "1000000000000000000000",
    nonce: "15",
    created_at_ns: "1793519412345678901",
    expires_at_ns: "1793519712345678901",
    status: "pending",
    hardware_approved: false
  };
  let reads = 0;
  let queryOptions;
  await withServer({
    ...authOptions(),
    getActivePayment: async (options) => { reads += 1; queryOptions = options; return pendingPayment; }
  }, async (base) => {
    const response = await fetch(`${base}/v1/pending-approvals`, {
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      network: "testnet",
      contract_id: "manextech.testnet",
      approval_required: true,
      payment: pendingPayment,
      approval_request: {
        contract_id: "manextech.testnet",
        network_id: "testnet",
        payment_id: "15",
        recipient_id: "merchant.testnet",
        amount_yocto: "1000000000000000000000",
        nonce: "15",
        expires_at_ns: "1793519712345678901"
      }
    });
    assert.equal(reads, 1);
    assert.deepEqual(queryOptions, { env: { NEAR_CONTRACT_ID: "manextech.testnet" } });
  });
});

test("pending-approvals endpoint excludes approved, processing and absent payments", async () => {
  for (const activePayment of [
    { id: "1", agent_id: "manex-agent.testnet", status: "approved" },
    { id: "2", agent_id: "manex-agent.testnet", status: "processing" },
    null
  ]) {
    await withServer({
      ...authOptions(),
      getActivePayment: async () => activePayment
    }, async (base) => {
      const response = await fetch(`${base}/v1/pending-approvals`, {
        headers: { authorization: `Bearer ${token}` }
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        network: "testnet",
        contract_id: "manextech.testnet",
        approval_required: false,
        payment: null,
        approval_request: null
      });
    });
  }
});

test("pending-approvals endpoint requires agent authentication before RPC access", async () => {
  let reads = 0;
  await withServer({
    ...authOptions(),
    getActivePayment: async () => { reads += 1; return { id: "1", status: "pending" }; }
  }, async (base) => {
    const response = await fetch(`${base}/v1/pending-approvals`);
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error, "unauthorized");
    assert.equal(reads, 0);
  });
});

test("pending-approvals endpoint reports RPC failures without leaking details", async () => {
  await withServer({
    ...authOptions(),
    getActivePayment: async () => { throw new Error("private RPC error details"); }
  }, async (base) => {
    const response = await fetch(`${base}/v1/pending-approvals`, {
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "near_rpc_failed" });
  });
});


test("pending-approvals endpoint rejects an unexpected contract agent", async () => {
  await withServer({
    ...authOptions(),
    getActivePayment: async () => ({ id: "16", agent_id: "other.testnet", status: "pending" })
  }, async (base) => {
    const response = await fetch(`${base}/v1/pending-approvals`, {
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "near_rpc_failed" });
  });
});


test("pending-approvals exposes a canonical device request derived only from contract fields", async () => {
  const payment = {
    id: "21",
    agent_id: "manex-agent.testnet",
    recipient_id: "merchant.testnet",
    amount_yocto: "987654321",
    nonce: "21",
    created_at_ns: "1793519412345678901",
    expires_at_ns: "1793519712345678901",
    status: "pending",
    hardware_approved: false
  };
  await withServer({
    ...authOptions(),
    getActivePayment: async () => payment
  }, async (base) => {
    const response = await fetch(`${base}/v1/pending-approvals`, {
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.approval_request, {
      contract_id: "manextech.testnet",
      network_id: "testnet",
      payment_id: "21",
      recipient_id: "merchant.testnet",
      amount_yocto: "987654321",
      nonce: "21",
      expires_at_ns: "1793519712345678901"
    });
  });
});

test("payment status endpoint returns pending state and approval flag", async () => {
  const payment = {
    id: "25",
    agent_id: "manex-agent.testnet",
    recipient_id: "merchant.testnet",
    amount_yocto: "123456789",
    nonce: "25",
    created_at_ns: "1793519412345678901",
    expires_at_ns: "1793519712345678901",
    status: "pending",
    hardware_approved: false
  };
  let observed;
  await withServer({
    ...authOptions(),
    getPayment: async (id, options) => {
      observed = { id, options };
      return payment;
    }
  }, async (base) => {
    const response = await fetch(`${base}/v1/payments/25`, {
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      network: "testnet",
      contract_id: "manextech.testnet",
      approval_required: true,
      terminal: false,
      payment
    });
    assert.deepEqual(observed, {
      id: "25",
      options: { env: { NEAR_CONTRACT_ID: "manextech.testnet" } }
    });
  });
});

test("payment status endpoint marks terminal lifecycle states", async () => {
  for (const status of ["paid", "failed", "expired", "cancelled"]) {
    const payment = {
      id: "26",
      agent_id: "manex-agent.testnet",
      status
    };
    await withServer({
      ...authOptions(),
      getPayment: async () => payment
    }, async (base) => {
      const response = await fetch(`${base}/v1/payments/26`, {
        headers: { authorization: `Bearer ${token}` }
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.approval_required, false);
      assert.equal(body.terminal, true);
      assert.equal(body.payment.status, status);
    });
  }
});

test("payment status endpoint rejects unauthenticated, absent and foreign-agent records", async () => {
  let reads = 0;
  await withServer({
    ...authOptions(),
    getPayment: async () => { reads += 1; return null; }
  }, async (base) => {
    const unauthorized = await fetch(`${base}/v1/payments/27`);
    assert.equal(unauthorized.status, 401);
    assert.equal(reads, 0);
    const missing = await fetch(`${base}/v1/payments/27`, {
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error, "payment_not_found");
  });

  await withServer({
    ...authOptions(),
    getPayment: async () => ({ id: "28", agent_id: "other.testnet", status: "pending" })
  }, async (base) => {
    const foreign = await fetch(`${base}/v1/payments/28`, {
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(foreign.status, 404);
  });
});

test("payment status endpoint rejects unsafe integer IDs and maps RPC failures", async () => {
  await withServer({
    ...authOptions(),
    getPayment: async () => { throw new RangeError("unsafe ID"); }
  }, async (base) => {
    const invalid = await fetch(`${base}/v1/payments/9007199254740992`, {
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error, "invalid_payment_id");
  });

  await withServer({
    ...authOptions(),
    getPayment: async () => { throw new Error("rpc offline"); }
  }, async (base) => {
    const failed = await fetch(`${base}/v1/payments/29`, {
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(failed.status, 502);
    assert.equal((await failed.json()).error, "near_rpc_failed");
  });
});


test("payment status endpoint keeps approved and processing payments non-terminal", async () => {
  for (const status of ["approved", "processing"]) {
    const payment = { id: "30", agent_id: "manex-agent.testnet", status };
    await withServer({
      ...authOptions(),
      getPayment: async () => payment
    }, async (base) => {
      const response = await fetch(`${base}/v1/payments/30`, {
        headers: { authorization: `Bearer ${token}` }
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.approval_required, false);
      assert.equal(body.terminal, false);
      assert.equal(body.payment.status, status);
    });
  }
});

test("payment status endpoint rejects an unknown contract lifecycle status", async () => {
  await withServer({
    ...authOptions(),
    getPayment: async () => ({ id: "31", agent_id: "manex-agent.testnet", status: "unknown" })
  }, async (base) => {
    const response = await fetch(`${base}/v1/payments/31`, {
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "near_rpc_failed" });
  });
});
