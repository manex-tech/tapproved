import test from "node:test";
import assert from "node:assert/strict";
import { AutonomousAgent } from "./autonomous-agent.js";

function createMockRouter(policyOverrides = {}) {
  const policy = {
    agent_id: "manex-agent.testnet",
    soft_limit_yocto: "10000000000000000000000",
    hard_limit_yocto: "100000000000000000000000",
    daily_limit_yocto: "500000000000000000000000",
    allowed_recipients: ["manextech.testnet", "manex-agent.testnet"],
    paused: false,
    next_payment_id: "10",
    ...policyOverrides
  };

  return async (url, options = {}) => {
    const path = url.pathname;
    const method = options.method ?? "GET";

    if (method === "GET" && path === "/policy") {
      return new Response(JSON.stringify(policy), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    if (method === "POST" && path === "/v1/payment-requests") {
      const body = JSON.parse(options.body);
      const recipient = body.recipient_id;
      const amount = BigInt(body.amount_yocto);

      if (!policy.allowed_recipients.includes(recipient)) {
        return new Response(JSON.stringify({ error: "recipient_not_allowlisted" }), {
          status: 400,
          headers: { "content-type": "application/json" }
        });
      }

      if (amount <= BigInt(policy.soft_limit_yocto)) {
        return new Response(JSON.stringify({
          agent_id: policy.agent_id,
          idempotency_key: options.headers["idempotency-key"],
          state: "completed",
          replayed: false,
          payment: {
            id: "10",
            status: "approved",
            amount_yocto: body.amount_yocto,
            recipient_id: recipient
          }
        }), { status: 200, headers: { "content-type": "application/json" } });
      }

      return new Response(JSON.stringify({
        agent_id: policy.agent_id,
        idempotency_key: options.headers["idempotency-key"],
        state: "processing",
        replayed: false,
        payment: {
          id: "11",
          status: "pending",
          amount_yocto: body.amount_yocto,
          recipient_id: recipient
        }
      }), { status: 202, headers: { "content-type": "application/json" } });
    }

    return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
  };
}

test("AutonomousAgent lifecycle demo", async () => {
  const logs = [];
  const mockLogger = {
    log: (msg) => logs.push(msg)
  };

  const agent = new AutonomousAgent({
    relayUrl: "http://127.0.0.1:3000",
    token: "a".repeat(32),
    logger: mockLogger,
    fetchImpl: createMockRouter()
  });

  const results = await agent.runLifecycleDemo({
    routineRecipient: "manex-agent.testnet",
    highValueRecipient: "manextech.testnet",
    restrictedRecipient: "hacker.testnet"
  });

  // Verify Scenario 1: Routine spending approved
  assert.equal(results.routine?.payment?.status, "approved");

  // Verify Scenario 2: High-value spending pending hardware approval
  assert.equal(results.highValue?.payment?.status, "pending");

  // Verify Scenario 3: Restricted recipient rejected
  assert.equal(results.restricted?.blocked, true);
  assert.equal(results.restricted?.code, "recipient_not_allowlisted");

  // Verify log outputs
  assert.ok(logs.some((l) => l.includes("Policy loaded")));
  assert.ok(logs.some((l) => l.includes("Physical button confirmation required")));
  assert.ok(logs.some((l) => l.includes("Successfully blocked by policy enforcement")));
});
