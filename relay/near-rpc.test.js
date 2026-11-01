import test from "node:test";
import assert from "node:assert/strict";
import { callViewMethod, getActivePayment, getPolicy } from "./near-rpc.js";

function mockFetch(resultValue, capture = {}) {
  return async (url, init) => {
    capture.url = url;
    capture.request = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        jsonrpc: "2.0",
        id: "tapproved-relay",
        result: { result: [...Buffer.from(JSON.stringify(resultValue))], logs: [] }
      })
    };
  };
}

test("calls a finality-final testnet view method and decodes JSON result bytes", async () => {
  const capture = {};
  const policy = { network_id: "testnet", paused: false, next_payment_id: 9 };
  const result = await getPolicy({
    env: { NEAR_CONTRACT_ID: "tapproved.testnet" },
    fetchImpl: mockFetch(policy, capture)
  });
  assert.deepEqual(result, policy);
  assert.equal(capture.url, "https://rpc.testnet.near.org");
  assert.equal(capture.request.method, "query");
  assert.equal(capture.request.params.request_type, "call_function");
  assert.equal(capture.request.params.finality, "final");
  assert.equal(capture.request.params.account_id, "tapproved.testnet");
  assert.equal(capture.request.params.method_name, "get_policy");
  assert.equal(Buffer.from(capture.request.params.args_base64, "base64").toString(), "{}");
});

test("reads active payment and preserves null when there is no active payment", async () => {
  const result = await getActivePayment({
    env: { NEAR_CONTRACT_ID: "demo.testnet" },
    fetchImpl: mockFetch(null)
  });
  assert.equal(result, null);
});

test("rejects mainnet contract IDs and non-HTTPS RPC endpoints", async () => {
  await assert.rejects(
    callViewMethod("get_policy", {}, {
      env: { NEAR_CONTRACT_ID: "example.near" },
      fetchImpl: mockFetch({})
    }),
    /valid testnet account ID/
  );
  await assert.rejects(
    callViewMethod("get_policy", {}, {
      env: { NEAR_RPC_URL: "http://localhost:3030", NEAR_CONTRACT_ID: "demo.testnet" },
      fetchImpl: mockFetch({})
    }),
    /must use HTTPS/
  );
});

test("surfaces RPC errors", async () => {
  await assert.rejects(
    callViewMethod("get_policy", {}, {
      env: { NEAR_CONTRACT_ID: "demo.testnet" },
      fetchImpl: async () => ({
        ok: true, status: 200,
        json: async () => ({ error: { message: "contract not found" } })
      })
    }),
    /contract not found/
  );
});
