import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { DEFAULT_CONTRACT_ID, getActivePayment, getPolicy } from "./near-rpc.js";
import { createAgentAuthenticator } from "./auth.js";
import { createNearAgentSigner } from "./near-signer.js";
import {
  IdempotencyConflictError,
  IdempotencyStoreError,
  JsonIdempotencyStore,
  submitIdempotentPaymentRequest,
  validateIdempotencyKey,
  validatePaymentRequest
} from "./payment-requests.js";

const MAX_REQUEST_BODY_BYTES = 4096;
const DEFAULT_AGENT_ID = "manex-agent.testnet";

class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function send(response, status, payload, extraHeaders = {}) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...extraHeaders
  });
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request) {
  const contentType = request.headers["content-type"]?.split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new HttpError(415, "content_type_must_be_application_json");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BODY_BYTES) {
      throw new HttpError(413, "request_body_too_large");
    }
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("body must be an object");
    }
    return body;
  } catch {
    throw new HttpError(400, "invalid_json_body");
  }
}

function paymentRequestResponse(record, replayed) {
  return {
    agent_id: record.agent_id,
    idempotency_key: record.idempotency_key,
    state: record.state,
    replayed,
    transaction_hash: record.result?.transaction_hash ?? null,
    execution_transaction_hash: record.result?.execution_transaction_hash ?? null,
    payment: record.result?.payment ?? null
  };
}

/**
 * Create an injectable relay HTTP server. Mutating payment submission remains
 * disabled unless both a persistent idempotency store and a trusted submit
 * adapter are supplied by the controlled signer integration.
 */
export function createRelayServer(options = {}) {
  const authenticate = options.authenticate ??
    createAgentAuthenticator({ token: options.agentApiToken ?? process.env.AGENT_API_TOKEN });
  const agentId = options.agentId ?? DEFAULT_AGENT_ID;
  const idempotencyStore = options.idempotencyStore;
  const submitPayment = options.submitPayment;
  const readActivePayment = options.getActivePayment ?? getActivePayment;

  return createServer(async (request, response) => {
    let pathname;
    try {
      pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    } catch {
      send(response, 400, { error: "invalid_request_url" });
      return;
    }

    if (request.method === "GET" && pathname === "/health") {
      send(response, 200, { name: "tapproved", status: "ok", network: "testnet" });
      return;
    }

    if (request.method === "POST" && pathname === "/v1/payment-requests") {
      if (!authenticate(request)) {
        send(response, 401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
        return;
      }
      if (!idempotencyStore || typeof submitPayment !== "function") {
        send(response, 503, { error: "payment_submission_not_configured" });
        return;
      }

      let body;
      let key;
      let payment;
      try {
        body = await readJsonBody(request);
        key = validateIdempotencyKey(request.headers["idempotency-key"]);
        payment = validatePaymentRequest(body);
      } catch (error) {
        if (error instanceof HttpError) {
          send(response, error.status, { error: error.code });
        } else {
          send(response, 400, { error: "invalid_payment_request", message: error.message });
        }
        return;
      }

      try {
        const result = await submitIdempotentPaymentRequest({
          store: idempotencyStore,
          agentId,
          idempotencyKey: key,
          payment,
          submit: submitPayment
        });
        const status = result.record.state === "submitted" ? (result.replayed ? 200 : 202) : 202;
        send(response, status, paymentRequestResponse(result.record, result.replayed));
      } catch (error) {
        if (error instanceof IdempotencyConflictError) {
          send(response, 409, { error: error.code });
          return;
        }
        if (error instanceof IdempotencyStoreError) {
          send(response, 503, { error: error.code });
          return;
        }

        // A signer/RPC exception may occur after a transaction was broadcast.
        // Return the persisted state, never tell the client to submit a new key.
        try {
          const record = await idempotencyStore.get(agentId, key);
          if (record) {
            send(response, 202, {
              ...paymentRequestResponse(record, false),
              outcome: "unknown",
              instruction: "Retry only with the same Idempotency-Key; do not create a new request key."
            });
            return;
          }
        } catch {
          // Fall through to a generic service error if the journal is unavailable.
        }
        send(response, 503, { error: "payment_submission_unavailable" });
      }
      return;
    }

    if (request.method === "GET" && pathname === "/v1/pending-approvals") {
      if (!authenticate(request)) {
        send(response, 401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
        return;
      }
      try {
        const activePayment = await readActivePayment({ env: { NEAR_CONTRACT_ID: DEFAULT_CONTRACT_ID } });
        if (activePayment && activePayment.agent_id !== agentId) throw new Error("unexpected active payment agent");
        const pending = activePayment?.status === "pending" ? activePayment : null;
        send(response, 200, {
          network: "testnet",
          contract_id: DEFAULT_CONTRACT_ID,
          approval_required: pending !== null,
          payment: pending
        });
      } catch {
        send(response, 502, { error: "near_rpc_failed" });
      }
      return;
    }

    if (request.method !== "GET") {
      send(response, 405, { error: "method_not_allowed" }, { allow: "GET, POST" });
      return;
    }

    try {
      if (pathname === "/policy") {
        const policy = await getPolicy();
        send(response, 200, { network: "testnet", policy });
        return;
      }
      if (pathname === "/active-payment") {
        const payment = await getActivePayment();
        send(response, 200, { network: "testnet", payment });
        return;
      }
      send(response, 404, { error: "not_found" });
    } catch {
      send(response, 502, { error: "near_rpc_failed" });
    }
  });
}

const isMain = process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

async function startRelay() {
  const port = Number(process.env.PORT ?? 3000);
  const storePath = process.env.TAPPROVED_IDEMPOTENCY_PATH ?? ".tapproved/idempotency.json";
  const idempotencyStore = new JsonIdempotencyStore(storePath);
  let submitPayment;

  try {
    const signer = await createNearAgentSigner();
    submitPayment = signer.requestSpend;
    console.log("Restricted NEAR agent signer verified for manex-agent.testnet.");
  } catch (error) {
    console.error(`NEAR agent signer unavailable; payment submissions disabled: ${error.message}`);
  }

  const server = createRelayServer({ idempotencyStore, submitPayment });
  server.listen(port, () => {
    console.log(`Tapproved testnet relay listening on port ${port}`);
  });
}

if (isMain) {
  startRelay().catch((error) => {
    console.error(`Tapproved relay startup failed: ${error.message}`);
    process.exitCode = 1;
  });
}
