import test from "node:test";
import assert from "node:assert/strict";
import { callViewMethod, getActivePayment, getPayment, getPolicy } from "./near-rpc.js";

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

test("defaults to the deployed Tapproved contract on NEAR testnet", async () => {
  const capture = {};
  const policy = { network_id: "testnet", paused: false, next_payment_id: 9 };
  const result = await getPolicy({
    env: {},
    fetchImpl: mockFetch(policy, capture)
  });
  assert.deepEqual(result, policy);
  assert.equal(capture.url, "https://rpc.testnet.near.org");
  assert.equal(capture.request.method, "query");
  assert.equal(capture.request.params.request_type, "call_function");
  assert.equal(capture.request.params.finality, "final");
  assert.equal(capture.request.params.account_id, "manextech.testnet");
  assert.equal(capture.request.params.method_name, "get_policy");
  assert.equal(Buffer.from(capture.request.params.args_base64, "base64").toString(), "{}");
});

test("allows an explicit contract override and preserves null active payment", async () => {
  const capture = {};
  const result = await getActivePayment({
    env: { NEAR_CONTRACT_ID: "demo.testnet" },
    fetchImpl: mockFetch(null, capture)
  });
  assert.equal(result, null);
  assert.equal(capture.request.params.account_id, "demo.testnet");
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


test("queries a payment by its exact decimal ID", async () => {
  const capture = {};
  const payment = { id: "43", status: "paid" };
  const result = await getPayment("43", { env: {}, fetchImpl: mockFetch(payment, capture) });
  assert.deepEqual(result, payment);
  assert.equal(capture.request.params.method_name, "get_payment");
  assert.deepEqual(JSON.parse(Buffer.from(capture.request.params.args_base64, "base64").toString()), {
    payment_id: 43
  });
  await assert.rejects(getPayment("not-a-number"), /decimal string/);
  await assert.rejects(getPayment("9007199254740992"), /safe JSON integer range/);
});
