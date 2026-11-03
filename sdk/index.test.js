import test from "node:test";
import assert from "node:assert/strict";
import {
  TapprovedClient,
  TapprovedError,
  AuthenticationError,
  PolicyViolationError,
  IdempotencyConflictError,
  PaymentTerminalError,
  TimeoutError,
  RelayConnectionError,
  generateIdempotencyKey
} from "./index.js";

const VALID_TOKEN = "a".repeat(32);
const VALID_RELAY_URL = "http://127.0.0.1:3000";

function createMockFetch(router) {
  return async (url, options = {}) => {
    const urlObj = new URL(url);
    const path = urlObj.pathname;
    const method = options.method ?? "GET";
    const handler = router[`${method} ${path}`] ?? router[path];
    if (!handler) {
      return new Response(JSON.stringify({ error: "not_found" }), {
        status: 404,
        headers: { "content-type": "application/json" }
      });
    }
    return await handler(urlObj, options);
  };
}

test("TapprovedClient initialization", async (t) => {
  await t.test("initializes successfully with valid options", () => {
    const client = new TapprovedClient({
      relayUrl: "http://127.0.0.1:3000",
      token: VALID_TOKEN
    });
    assert.equal(client.relayUrl, "http://127.0.0.1:3000");
  });

  await t.test("rejects invalid or short tokens", () => {
    assert.throws(
      () => new TapprovedClient({ relayUrl: VALID_RELAY_URL, token: "too_short" }),
      (err) => err instanceof AuthenticationError && err.code === "authentication_failed"
    );
  });

  await t.test("rejects insecure remote HTTP URLs", () => {
    assert.throws(
      () => new TapprovedClient({ relayUrl: "http://remote-host.com", token: VALID_TOKEN }),
      (err) => err instanceof TapprovedError && err.code === "insecure_relay_url"
    );
  });

  await t.test("allows HTTPS URLs", () => {
    const client = new TapprovedClient({
      relayUrl: "https://relay.tapproved.net",
      token: VALID_TOKEN
    });
    assert.equal(client.relayUrl, "https://relay.tapproved.net");
  });
});

test("TapprovedClient.generateIdempotencyKey", () => {
  const key = generateIdempotencyKey("test-agent");
  assert.match(key, /^test-agent-[a-f0-9]{32}$/);
  assert.ok(key.length >= 16 && key.length <= 128);
});

test("TapprovedClient.requestPayment", async (t) => {
  await t.test("validates input parameters before making request", async () => {
    const client = new TapprovedClient({ relayUrl: VALID_RELAY_URL, token: VALID_TOKEN });

    await assert.rejects(
      client.requestPayment({ recipientId: "bad account!", amountYocto: "100" }),
      (err) => err instanceof PolicyViolationError && err.code === "invalid_recipient_id"
    );

    await assert.rejects(
      client.requestPayment({ recipientId: "merchant.testnet", amountYocto: "0" }),
      (err) => err instanceof PolicyViolationError && err.code === "amount_out_of_bounds"
    );

    await assert.rejects(
      client.requestPayment({ recipientId: "merchant.testnet", amountYocto: "-500" }),
      (err) => err instanceof PolicyViolationError && err.code === "invalid_amount"
    );
  });

  await t.test("sends valid request and returns response", async () => {
    const mockFetch = createMockFetch({
      "POST /v1/payment-requests": async (_url, options) => {
        assert.equal(options.headers.authorization, `Bearer ${VALID_TOKEN}`);
        assert.ok(options.headers["idempotency-key"]);
        const body = JSON.parse(options.body);
        assert.equal(body.recipient_id, "merchant.testnet");
        assert.equal(body.amount_yocto, "1000000000000000000000");

        return new Response(JSON.stringify({
          agent_id: "manex-agent.testnet",
          idempotency_key: options.headers["idempotency-key"],
          state: "completed",
          replayed: false,
          payment: {
            id: "5",
            status: "approved"
          }
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
    });

    const client = new TapprovedClient({
      relayUrl: VALID_RELAY_URL,
      token: VALID_TOKEN,
      fetchImpl: mockFetch
    });

    const res = await client.requestPayment({
      recipientId: "merchant.testnet",
      amountYocto: "1000000000000000000000"
    });

    assert.equal(res.state, "completed");
    assert.equal(res.payment.id, "5");
  });

  await t.test("handles 409 idempotency conflict", async () => {
    const mockFetch = createMockFetch({
      "POST /v1/payment-requests": async () => {
        return new Response(JSON.stringify({
          error: "idempotency_conflict"
        }), { status: 409, headers: { "content-type": "application/json" } });
      }
    });

    const client = new TapprovedClient({
      relayUrl: VALID_RELAY_URL,
      token: VALID_TOKEN,
      fetchImpl: mockFetch
    });

    await assert.rejects(
      client.requestPayment({
        recipientId: "merchant.testnet",
        amountYocto: "100",
        idempotencyKey: "reused-key-12345678"
      }),
      (err) => err instanceof IdempotencyConflictError && err.status === 409
    );
  });
});

test("TapprovedClient view methods", async (t) => {
  const mockFetch = createMockFetch({
    "GET /policy": async () => {
      return new Response(JSON.stringify({
        agent_id: "manex-agent.testnet",
        soft_limit_yocto: "10000",
        hard_limit_yocto: "100000"
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
    "GET /active-payment": async () => {
      return new Response(JSON.stringify({
        payment: { id: "4", status: "approved" }
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
    "GET /v1/payments/4": async () => {
      return new Response(JSON.stringify({
        payment: { id: "4", status: "paid" }
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
    "GET /v1/transactions/4psHQnNteqE8SR6g9dBnSeu4smnpt3hDqXjFkzU3kzkU": async () => {
      return new Response(JSON.stringify({
        status: "FINAL",
        receipts: []
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
  });

  const client = new TapprovedClient({
    relayUrl: VALID_RELAY_URL,
    token: VALID_TOKEN,
    fetchImpl: mockFetch
  });

  const policy = await client.getPolicy();
  assert.equal(policy.agent_id, "manex-agent.testnet");

  const active = await client.getActivePayment();
  assert.equal(active.id, "4");

  const payment = await client.getPayment(4);
  assert.equal(payment.status, "paid");

  const tx = await client.getTransaction("4psHQnNteqE8SR6g9dBnSeu4smnpt3hDqXjFkzU3kzkU");
  assert.equal(tx.status, "FINAL");
});

test("TapprovedClient.waitForPaymentResolution", async (t) => {
  await t.test("resolves immediately when payment is paid", async () => {
    const mockFetch = createMockFetch({
      "GET /v1/payments/4": async () => {
        return new Response(JSON.stringify({
          payment: { id: "4", status: "paid" }
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
    });

    const client = new TapprovedClient({
      relayUrl: VALID_RELAY_URL,
      token: VALID_TOKEN,
      fetchImpl: mockFetch
    });

    const res = await client.waitForPaymentResolution(4, { timeoutMs: 1000 });
    assert.equal(res.status, "paid");
  });

  await t.test("fires onPendingApproval callback when encountering pending status", async () => {
    let callCount = 0;
    let pendingNotified = false;

    const mockFetch = createMockFetch({
      "GET /v1/payments/5": async () => {
        callCount++;
        const status = callCount === 1 ? "pending" : "paid";
        return new Response(JSON.stringify({
          payment: { id: "5", status }
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
    });

    const client = new TapprovedClient({
      relayUrl: VALID_RELAY_URL,
      token: VALID_TOKEN,
      fetchImpl: mockFetch
    });

    const res = await client.waitForPaymentResolution(5, {
      pollIntervalMs: 10,
      timeoutMs: 1000,
      onPendingApproval: (payment) => {
        assert.equal(payment.id, "5");
        pendingNotified = true;
      }
    });

    assert.equal(res.status, "paid");
    assert.equal(pendingNotified, true);
  });

  await t.test("rejects with PaymentTerminalError if payment expires or fails", async () => {
    const mockFetch = createMockFetch({
      "GET /v1/payments/6": async () => {
        return new Response(JSON.stringify({
          payment: { id: "6", status: "expired" }
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
    });

    const client = new TapprovedClient({
      relayUrl: VALID_RELAY_URL,
      token: VALID_TOKEN,
      fetchImpl: mockFetch
    });

    await assert.rejects(
      client.waitForPaymentResolution(6, { timeoutMs: 1000 }),
      (err) => err instanceof PaymentTerminalError && err.code === "payment_expired"
    );
  });

  await t.test("throws TimeoutError when polling exceeds timeout", async () => {
    const mockFetch = createMockFetch({
      "GET /v1/payments/7": async () => {
        return new Response(JSON.stringify({
          payment: { id: "7", status: "processing" }
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
    });

    const client = new TapprovedClient({
      relayUrl: VALID_RELAY_URL,
      token: VALID_TOKEN,
      fetchImpl: mockFetch
    });

    await assert.rejects(
      client.waitForPaymentResolution(7, { pollIntervalMs: 20, timeoutMs: 50 }),
      (err) => err instanceof TimeoutError
    );
  });
});
