import test from "node:test";
import assert from "node:assert/strict";
import { serializePreflightSnapshot } from "./testnet-preflight.js";

test("preflight output is a parseable JSON document with a real trailing newline", () => {
  const snapshot = {
    ready_for_upgrade: true,
    blockers: [],
    snapshot_block: { height: 276025309 }
  };
  const output = serializePreflightSnapshot(snapshot);

  assert.equal(output.endsWith(String.fromCharCode(10)), true);
  assert.equal(output.endsWith("\\n"), false);
  assert.deepEqual(JSON.parse(output), snapshot);
});
