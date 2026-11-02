import { pathToFileURL } from "node:url";

const U128_MAX = (1n << 128n) - 1n;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._~-]{16,128}$/;
const ACCOUNT_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

export class AgentRelayError extends Error {
  constructor(code, status = null) {
    super(code);
    this.name = "AgentRelayError";
    this.code = code;
    this.status = status;
  }
}

function validRelayUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new AgentRelayError("invalid_relay_url");
  }
  const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
  if (!["https:", "http:"].includes(url.protocol) ||
      (url.protocol === "http:" && !localHosts.has(url.hostname)) ||
      url.username || url.password || url.search || url.hash) {
    throw new AgentRelayError("relay_url_must_use_https");
  }
  return url.toString().replace(/\/$/, "");
}

export function readAgentClientConfig(env = process.env) {
  const relayUrl = validRelayUrl(env.TAPPROVED_RELAY_URL || "http://127.0.0.1:3000");
  const token = env.AGENT_API_TOKEN;
  if (typeof token !== "string" || token.length < 32 || !/^[A-Za-z0-9._~-]+$/.test(token)) {
    throw new AgentRelayError("AGENT_API_TOKEN_must_be_at_least_32_url_safe_characters");
  }

  const idempotencyKey = env.TAPPROVED_IDEMPOTENCY_KEY;
  if (typeof idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(idempotencyKey)) {
    throw new AgentRelayError("TAPPROVED_IDEMPOTENCY_KEY_must_be_16_to_128_url_safe_characters");
  }

  const recipientId = env.TAPPROVED_RECIPIENT_ID;
  if (typeof recipientId !== "string" || recipientId.length < 2 ||
      recipientId.length > 64 || !ACCOUNT_ID.test(recipientId)) {
    throw new AgentRelayError("TAPPROVED_RECIPIENT_ID_must_be_a_valid_near_account");
  }

  const amountYocto = env.TAPPROVED_AMOUNT_YOCTO;
  if (typeof amountYocto !== "string" || !/^(0|[1-9][0-9]*)$/.test(amountYocto) ||
      BigInt(amountYocto) <= 0n || BigInt(amountYocto) > U128_MAX) {
    throw new AgentRelayError("TAPPROVED_AMOUNT_YOCTO_must_be_a_positive_canonical_u128");
  }

  return Object.freeze({
    relayUrl,
    token,
    idempotencyKey,
    payment: Object.freeze({
      recipient_id: recipientId,
      amount_yocto: amountYocto
    })
  });
}

/**
 * Submit one agent payment request to the authenticated relay.
 * This client never retries and never changes the idempotency key.
 */
export async function submitAgentPayment(config, options = {}) {
  if (!config || typeof config !== "object") {
    throw new AgentRelayError("invalid_agent_client_config");
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new AgentRelayError("fetch_unavailable");
  }

  let response;
  try {
    response = await fetchImpl(new URL("/v1/payment-requests", config.relayUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.token}`,
        "content-type": "application/json",
        "idempotency-key": config.idempotencyKey
      },
      body: JSON.stringify(config.payment),
      signal: options.signal
    });
  } catch {
    throw new AgentRelayError("relay_unreachable");
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw new AgentRelayError("invalid_relay_response", response.status);
  }
  if (![200, 202].includes(response.status) || !body || typeof body !== "object") {
    throw new AgentRelayError(
      typeof body?.error === "string" ? body.error : "relay_request_rejected",
      response.status
    );
  }
  return Object.freeze({ http_status: response.status, ...body });
}

async function main() {
  const config = readAgentClientConfig();
  const result = await submitAgentPayment(config);
  // The idempotency key is intentionally not printed. On uncertain outcomes,
  // retain the configured key and never generate a replacement automatically.
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`Tapproved agent request failed: ${error.code || "agent_request_failed"}\n`);
    process.exitCode = 1;
  });
}
