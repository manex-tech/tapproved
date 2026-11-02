import test from "node:test";
import assert from "node:assert/strict";
import {
  getTransactionStatus,
  TransactionNotFoundError,
  TransactionWaitTimeoutError
} from "./near-rpc.js";

const hash = "8EjuQRnAJiWkRmqxfexQFJWXXonuSMbz5AZziJLCWnWS";

test("queries canonical agent transaction status and receipt outcomes", async () => {
  const capture = {};
  const result = {
    final_execution_status: "FINAL",
    status: { SuccessValue: "" },
    transaction: { hash, signer_id: "manex-agent.testnet", receiver_id: "manextech.testnet" },
    transaction_outcome: { id: hash, outcome: { gas_burnt: 1000000000000, status: { SuccessReceiptId: "receipt-id" } } },
    receipts_outcome: [{
      id: "receipt-id",
      outcome: {
        executor_id: "manextech.testnet",
        gas_burnt: 2000000000000,
        tokens_burnt: "200000000000000000000",
        status: { SuccessValue: "" },
        receipt_ids: []
      }
    }]
  };
  const actual = await getTransactionStatus(hash, {
    env: {},
    waitUntil: "FINAL",
    fetchImpl: async (url, init) => {
      capture.url = url;
      capture.request = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ result }) };
    }
  });
  assert.deepEqual(actual, result);
  assert.equal(capture.url, "https://rpc.testnet.near.org");
  assert.equal(capture.request.method, "tx");
  assert.deepEqual(capture.request.params, {
    tx_hash: hash,
    sender_account_id: "manex-agent.testnet",
    wait_until: "FINAL"
  });
});

test("rejects malformed transaction hashes and unsupported finality values", async () => {
  await assert.rejects(
    getTransactionStatus("0".repeat(44), { env: {}, fetchImpl: async () => ({}) }),
    /base58-encoded 32-byte hash/
  );
  await assert.rejects(
    getTransactionStatus(hash, { env: {}, waitUntil: "INVALID", fetchImpl: async () => ({}) }),
    /wait_until/
  );
});

test("maps unknown transaction and finality timeout RPC errors", async () => {
  await assert.rejects(
    getTransactionStatus(hash, {
      env: {},
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ error: { message: "UNKNOWN_TRANSACTION: transaction not found" } }) })
    }),
    TransactionNotFoundError
  );
  await assert.rejects(
    getTransactionStatus(hash, {
      env: {},
      waitUntil: "FINAL",
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ error: { message: "TIMEOUT_ERROR: timed out waiting for finality" } }) })
    }),
    TransactionWaitTimeoutError
  );
});

test("rejects transaction results from a different signer", async () => {
  await assert.rejects(
    getTransactionStatus(hash, {
      env: {},
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          result: {
            transaction: { hash, signer_id: "other.testnet" },
            status: { SuccessValue: "" }
          }
        })
      })
    }),
    /invalid transaction status/
  );
});
