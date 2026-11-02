import test from "node:test";
import assert from "node:assert/strict";
import { createAgentAuthenticator } from "./auth.js";
import { createRelayServer } from "./server.js";
import {
  TransactionNotFoundError,
  TransactionQueryValidationError,
  TransactionWaitTimeoutError
} from "./near-rpc.js";

const token = "relay-api-test-token-0123456789abcdef";
const hash = "8EjuQRnAJiWkRmqxfexQFJWXXonuSMbz5AZziJLCWnWS";

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

function authOptions() {
  return { authenticate: createAgentAuthenticator({ token }) };
}

const finalResult = {
  final_execution_status: "FINAL",
  status: { SuccessValue: "" },
  transaction: {
    hash,
    signer_id: "manex-agent.testnet",
    receiver_id: "manextech.testnet",
    actions: [{ FunctionCall: { method_name: "approve_spend", args: "secret-base64-args" } }]
  },
  transaction_outcome: {
    block_hash: "block-hash",
    outcome: {
      gas_burnt: 1000000000000,
      tokens_burnt: "100000000000000000000",
      status: { SuccessReceiptId: "receipt-1" },
      receipt_ids: ["receipt-1"]
    }
  },
  receipts_outcome: [{
    id: "receipt-1",
    block_hash: "receipt-block",
    outcome: {
      executor_id: "manextech.testnet",
      gas_burnt: 2000000000000,
      tokens_burnt: "200000000000000000000",
      status: { SuccessValue: "" },
      receipt_ids: [],
      logs: ["EVENT_JSON:{\"standard\":\"tapproved\",\"event\":\"payment_paid\"}"]
    }
  }]
};

test("transaction status endpoint authenticates before querying NEAR", async () => {
  let reads = 0;
  await withServer({
    ...authOptions(),
    getTransactionStatus: async () => { reads += 1; return finalResult; }
  }, async (base) => {
    const response = await fetch(`${base}/v1/transactions/${hash}`);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "unauthorized" });
    assert.equal(reads, 0);
  });
});

test("transaction status endpoint returns sanitized receipt outcomes and canonical signer context", async () => {
  let observed;
  await withServer({
    ...authOptions(),
    getTransactionStatus: async (txHash, options) => {
      observed = { txHash, options };
      return finalResult;
    }
  }, async (base) => {
    const response = await fetch(`${base}/v1/transactions/${hash}?wait_until=FINAL`, {
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.transaction_hash, hash);
    assert.equal(body.signer_id, "manex-agent.testnet");
    assert.equal(body.receiver_id, "manextech.testnet");
    assert.deepEqual(body.method_names, ["approve_spend"]);
    assert.equal(body.execution_state, "success");
    assert.equal(body.receipt_count, 1);
    assert.equal(body.receipts_finalized, true);
    assert.deepEqual(body.receipts[0], {
      receipt_id: "receipt-1",
      block_hash: "receipt-block",
      executor_id: "manextech.testnet",
      gas_burnt: "2000000000000",
      tokens_burnt: "200000000000000000000",
      status: "success",
      receipt_ids: [],
      logs: ["EVENT_JSON:{\"standard\":\"tapproved\",\"event\":\"payment_paid\"}"]
    });
    assert.equal(JSON.stringify(body).includes("secret-base64-args"), false);
    assert.deepEqual(observed, {
      txHash: hash,
      options: {
        env: {
          NEAR_CONTRACT_ID: "manextech.testnet",
          NEAR_SIGNER_ACCOUNT_ID: "manex-agent.testnet"
        },
        waitUntil: "FINAL"
      }
    });
  });
});

test("transaction status endpoint returns 202 until all receipts are finalized", async () => {
  await withServer({
    ...authOptions(),
    getTransactionStatus: async () => ({
      ...finalResult,
      final_execution_status: "EXECUTED",
      status: "Started",
      receipts_outcome: []
    })
  }, async (base) => {
    const response = await fetch(`${base}/v1/transactions/${hash}`, {
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.execution_state, "in_progress");
    assert.equal(body.final_execution_status, "EXECUTED");
    assert.equal(body.requested_wait_until, undefined);
    assert.equal(body.receipts_finalized, false);
  });
});

test("transaction status endpoint maps unknown hashes, invalid queries and RPC timeouts", async () => {
  await withServer({
    ...authOptions(),
    getTransactionStatus: async () => { throw new TransactionNotFoundError(); }
  }, async (base) => {
    const response = await fetch(`${base}/v1/transactions/${hash}`, {
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "transaction_not_found" });
  });

  await withServer({
    ...authOptions(),
    getTransactionStatus: async () => { throw new TransactionQueryValidationError("invalid_wait_until", "bad"); }
  }, async (base) => {
    const response = await fetch(`${base}/v1/transactions/${hash}?wait_until=INVALID`, {
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_wait_until" });
  });

  await withServer({
    ...authOptions(),
    getTransactionStatus: async () => { throw new TransactionWaitTimeoutError(); }
  }, async (base) => {
    const response = await fetch(`${base}/v1/transactions/${hash}?wait_until=FINAL`, {
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(response.status, 202);
    const body = await response.json();
    assert.equal(body.execution_state, "in_progress");
    assert.equal(body.final_execution_status, "UNKNOWN");
    assert.equal(body.requested_wait_until, "FINAL");
    assert.equal(body.receipts_finalized, false);
  });
});

test("transaction status endpoint rejects invalid base58 hashes", async () => {
  let reads = 0;
  await withServer({
    ...authOptions(),
    getTransactionStatus: async () => { reads += 1; return finalResult; }
  }, async (base) => {
    const response = await fetch(`${base}/v1/transactions/${"1".repeat(44)}`, {
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_transaction_hash" });
    assert.equal(reads, 0);
  });
});
