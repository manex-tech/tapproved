import test from "node:test";
import assert from "node:assert/strict";
import {
  AgentRelayError,
  readAgentClientConfig,
  submitAgentPayment
} from "./agent-request.js";

const validEnv = {
  TAPPROVED_RELAY_URL: "http://127.0.0.1:3000",
  AGENT_API_TOKEN: "agent-client-test-token-0123456789",
  TAPPROVED_IDEMPOTENCY_KEY: "agent-payment-attempt-0001",
  TAPPROVED_RECIPIENT_ID: "merchant.testnet",
  TAPPROVED_AMOUNT_YOCTO: "1000000000000000000000"
};

test("reads a strict agent-to-relay configuration without generating retry keys", () => {
  const config = readAgentClientConfig(validEnv);
  assert.equal(config.relayUrl, "http://127.0.0.1:3000");
  assert.equal(config.idempotencyKey, validEnv.TAPPROVED_IDEMPOTENCY_KEY);
  assert.deepEqual(config.payment, {
    recipient_id: "merchant.testnet",
    amount_yocto: "1000000000000000000000"
  });
  assert.equal(Object.isFrozen(config), true);
  assert.equal(Object.isFrozen(config.payment), true);
});

test("requires HTTPS outside loopback and validates token, idempotency and payment fields", () => {
  assert.throws(() => readAgentClientConfig({
    ...validEnv,
    TAPPROVED_RELAY_URL: "http://relay.example.com"
  }), (error) => error.code === "relay_url_must_use_https");
  assert.throws(() => readAgentClientConfig({
    ...validEnv,
    AGENT_API_TOKEN: "short"
  }), /AGENT_API_TOKEN/);
  assert.throws(() => readAgentClientConfig({
    ...validEnv,
    TAPPROVED_IDEMPOTENCY_KEY: "short"
  }), /TAPPROVED_IDEMPOTENCY_KEY/);
  assert.throws(() => readAgentClientConfig({
    ...validEnv,
    TAPPROVED_AMOUNT_YOCTO: "01"
  }), /TAPPROVED_AMOUNT_YOCTO/);
  assert.throws(() => readAgentClientConfig({
    ...validEnv,
    TAPPROVED_AMOUNT_YOCTO: "0"
  }), /TAPPROVED_AMOUNT_YOCTO/);
  assert.throws(() => readAgentClientConfig({
    ...validEnv,
    TAPPROVED_RECIPIENT_ID: "bad account"
  }), /TAPPROVED_RECIPIENT_ID/);
});

test("submits one authenticated payment request with the same explicit idempotency key", async () => {
  const config = readAgentClientConfig(validEnv);
  let observed;
  const result = await submitAgentPayment(config, {
    fetchImpl: async (url, options) => {
      observed = { url: url.toString(), options };
      return {
        status: 202,
        async json() {
          return {
            agent_id: "manex-agent.testnet",
            idempotency_key: validEnv.TAPPROVED_IDEMPOTENCY_KEY,
            state: "submitted",
            replayed: false,
            transaction_hash: "request-transaction",
            payment: { id: "17", status: "pending" }
          };
        }
      };
    }
  });

  assert.equal(observed.url, "http://127.0.0.1:3000/v1/payment-requests");
  assert.equal(observed.options.method, "POST");
  assert.equal(observed.options.headers.authorization, `Bearer ${validEnv.AGENT_API_TOKEN}`);
  assert.equal(observed.options.headers["content-type"], "application/json");
  assert.equal(observed.options.headers["idempotency-key"], validEnv.TAPPROVED_IDEMPOTENCY_KEY);
  assert.deepEqual(JSON.parse(observed.options.body), config.payment);
  assert.equal(result.http_status, 202);
  assert.equal(result.payment.id, "17");
});

test("returns the relay's stable error code and never retries automatically", async () => {
  const config = readAgentClientConfig(validEnv);
  let calls = 0;
  await assert.rejects(
    submitAgentPayment(config, {
      fetchImpl: async () => {
        calls += 1;
        return { status: 409, async json() { return { error: "idempotency_conflict" }; } };
      }
    }),
    (error) => error instanceof AgentRelayError &&
      error.code === "idempotency_conflict" && error.status === 409
  );
  assert.equal(calls, 1);
});

test("does not rotate the idempotency key or retry after a network failure", async () => {
  const config = readAgentClientConfig(validEnv);
  let calls = 0;
  await assert.rejects(
    submitAgentPayment(config, {
      fetchImpl: async () => {
        calls += 1;
        throw new Error("socket closed");
      }
    }),
    (error) => error.code === "relay_unreachable"
  );
  assert.equal(calls, 1);
  assert.equal(config.idempotencyKey, validEnv.TAPPROVED_IDEMPOTENCY_KEY);
});
