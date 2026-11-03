import test from "node:test";
import assert from "node:assert/strict";
import { callViewMethod, getAccountView, getActivePayment, getDailyUsage, getFinalizedBlock, getPayment, getPolicy } from "./near-rpc.js";

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


test("reads a finalized block header for a consistent preflight snapshot", async () => {
  const capture = {};
  const block = { height: 123, hash: "finalized-block-hash-12345678901234567890", timestamp_nanosec: "1793520012345678901" };
  const result = await getFinalizedBlock({
    env: {},
    fetchImpl: async (url, init) => {
      capture.url = url;
      capture.request = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ result: { header: block } }) };
    }
  });
  assert.deepEqual(result, block);
  assert.equal(capture.request.method, "block");
  assert.deepEqual(capture.request.params, { finality: "final" });
});

test("reads account balance, code hash and storage usage at a pinned block", async () => {
  const capture = {};
  const account = { amount: "100", locked: "2", code_hash: "ContractCodeHash", storage_usage: 1234 };
  const result = await getAccountView({
    env: {},
    blockId: "finalized-block-hash",
    fetchImpl: async (url, init) => {
      capture.url = url;
      capture.request = JSON.parse(init.body);
      return { ok: true, status: 200, json: async () => ({ result: account }) };
    }
  });
  assert.deepEqual(result, account);
  assert.equal(capture.request.method, "query");
  assert.deepEqual(capture.request.params, {
    request_type: "view_account",
    account_id: "manextech.testnet",
    block_id: "finalized-block-hash"
  });
});

test("reads legacy daily accounting at the same finalized block", async () => {
  const capture = {};
  const result = await getDailyUsage(20700, {
    env: {},
    blockId: "finalized-block-hash",
    fetchImpl: mockFetch({ utc_day: "20700", reserved_yocto: "75", daily_limit_yocto: "5000" }, capture)
  });
  assert.deepEqual(result, { utc_day: "20700", reserved_yocto: "75", daily_limit_yocto: "5000" });
  assert.equal(capture.request.params.block_id, "finalized-block-hash");
  assert.equal(capture.request.params.finality, undefined);
  assert.equal(capture.request.params.method_name, "get_daily_usage");
  assert.deepEqual(JSON.parse(Buffer.from(capture.request.params.args_base64, "base64").toString()), {
    utc_day: 20700
  });
  await assert.rejects(getDailyUsage(-1), /non-negative integer/);
});

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

test("accepts only explicit canonical contract/network configuration", async () => {
  const capture = {};
  const result = await getActivePayment({
    env: {
      NEAR_NETWORK: "testnet",
      NEAR_CONTRACT_ID: "manextech.testnet",
      NEAR_SIGNER_ACCOUNT_ID: "manex-agent.testnet"
    },
    fetchImpl: mockFetch(null, capture)
  });
  assert.equal(result, null);
  assert.equal(capture.request.params.account_id, "manextech.testnet");
  await assert.rejects(
    getActivePayment({
      env: { NEAR_NETWORK: "testnet", NEAR_CONTRACT_ID: "demo.testnet" },
      fetchImpl: mockFetch(null)
    }),
    /NEAR_CONTRACT_ID must be manextech\.testnet/
  );
});

test("rejects non-testnet network, noncanonical contract, noncanonical signer and non-HTTPS RPC", async () => {
  const invalidConfigurations = [
    [{ NEAR_NETWORK: "mainnet" }, /NEAR_NETWORK must be testnet/],
    [{ NEAR_CONTRACT_ID: "example.near" }, /NEAR_CONTRACT_ID must be manextech\.testnet/],
    [{ NEAR_SIGNER_ACCOUNT_ID: "other.testnet" }, /NEAR_SIGNER_ACCOUNT_ID must be manex-agent\.testnet/],
    [{ NEAR_RPC_URL: "http://localhost:3030" }, /NEAR_RPC_URL must use HTTPS/]
  ];
  for (const [overrides, expected] of invalidConfigurations) {
    await assert.rejects(
      callViewMethod("get_policy", {}, {
        env: { ...overrides },
        fetchImpl: mockFetch({})
      }),
      expected
    );
  }
});

test("surfaces RPC errors", async () => {
  await assert.rejects(
    callViewMethod("get_policy", {}, {
      env: {},
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


test("reads the finalized NEAR block timestamp as a decimal nanosecond string", async () => {
  const capture = {};
  const { getLatestBlockTimestampNs } = await import("./near-rpc.js");
  const timestamp = "1793520012345678901";
  const result = await getLatestBlockTimestampNs({
    env: {},
    fetchImpl: async (url, init) => {
      capture.url = url;
      capture.request = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          jsonrpc: "2.0",
          id: "tapproved-finalized-block-time",
          result: { header: { height: 123, hash: "finalized-block-hash-12345678901234567890", timestamp_nanosec: timestamp } }
        })
      };
    }
  });
  assert.equal(result, timestamp);
  assert.equal(capture.url, "https://rpc.testnet.near.org");
  assert.equal(capture.request.method, "block");
  assert.deepEqual(capture.request.params, { finality: "final" });
});

test("rejects malformed finalized block timestamps and RPC errors", async () => {
  const { getLatestBlockTimestampNs } = await import("./near-rpc.js");
  await assert.rejects(
    getLatestBlockTimestampNs({
      env: {},
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ result: { header: { height: 123, hash: "finalized-block-hash-12345678901234567890", timestamp_nanosec: 1793520012345678901 } } })
      })
    }),
    /invalid finalized block header/
  );
  await assert.rejects(
    getLatestBlockTimestampNs({
      env: {},
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ error: { message: "node unavailable" } })
      })
    }),
    /node unavailable/
  );
});
