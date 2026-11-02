import test from "node:test";
import assert from "node:assert/strict";
import { getLatestBlockTimestampNs } from "./near-rpc.js";

test("reads timestamp_nanosec from the latest final NEAR block", async () => {
  let request;
  const timestamp = "1793519712345678901";
  const actual = await getLatestBlockTimestampNs({
    env: {},
    fetchImpl: async (url, init) => {
      request = JSON.parse(init.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({ result: { header: { timestamp_nanosec: timestamp } } })
      };
    }
  });
  assert.equal(actual, timestamp);
  assert.deepEqual(request, {
    jsonrpc: "2.0",
    id: "tapproved-block-time",
    method: "block",
    params: { finality: "final" }
  });
});

test("rejects malformed finalized block timestamps", async () => {
  await assert.rejects(
    getLatestBlockTimestampNs({
      env: {},
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ result: { header: { timestamp_nanosec: 1793519712345678901 } } })
      })
    }),
    /invalid timestamp_nanosec/
  );
});

test("surfaces block RPC failures instead of falling back to local wall clock", async () => {
  await assert.rejects(
    getLatestBlockTimestampNs({
      env: {},
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ error: { message: "node unavailable" } })
      })
    }),
    /NEAR block RPC error/
  );
});
