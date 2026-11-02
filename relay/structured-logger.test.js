import test from "node:test";
import assert from "node:assert/strict";
import { createStructuredLogger, sanitizeError, sanitizeLogFields } from "./structured-logger.js";

test("writes timestamped JSON records with stable safe fields", () => {
  const lines = [];
  const logger = createStructuredLogger({ write: (line) => lines.push(line) });
  logger.info("request.completed", { request_id: "req-123", method: "GET", route: "/health", status: 200, duration_ms: 4 });
  assert.equal(lines.length, 1);
  const record = JSON.parse(lines[0]);
  assert.match(record.timestamp, /^\\d{4}-\\d{2}-\\d{2}T/);
  assert.equal(record.level, "info");
  assert.equal(record.event, "request.completed");
  assert.equal(record.request_id, "req-123");
  assert.equal(record.status, 200);
});

test("drops credentials, signatures, private keys and arbitrary fields", () => {
  const secret = "super-secret-token";
  const safe = sanitizeLogFields({
    request_id: "req-1", authorization: secret, token: secret,
    signature_hex: "a".repeat(128), private_key: secret,
    body: { amount_yocto: "123" }, message: secret, arbitrary: secret
  });
  assert.deepEqual(safe, { request_id: "req-1" });
  assert.equal(JSON.stringify(safe).includes(secret), false);
});

test("sanitizes errors without serializing messages or stacks", () => {
  const error = Object.assign(new Error("rpc response leaked secret"), { code: "near_rpc_failed" });
  assert.deepEqual(sanitizeError(error), { error_code: "near_rpc_failed", error_name: "Error" });
  assert.deepEqual(sanitizeError(new Error("private detail")), { error_code: "internal_error", error_name: "Error" });
});

test("logging sink failures never interrupt application control flow", () => {
  const logger = createStructuredLogger({ write: () => { throw new Error("logger unavailable"); } });
  assert.doesNotThrow(() => logger.error("operation.failed", { operation: "approval" }));
});

test("rejects invalid levels and event names", () => {
  const logger = createStructuredLogger({ write: () => {} });
  assert.throws(() => logger.log("fatal", "request.failed"), /log level/);
  assert.throws(() => logger.info("Invalid Event"), /log event/);
});
