import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { createStructuredLogger, sanitizeError } from "./structured-logger.js";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { DEFAULT_CONTRACT_ID, getActivePayment, getPayment, getPolicy, getTransactionStatus, isValidTransactionHash, TransactionNotFoundError, TransactionQueryValidationError, TransactionWaitTimeoutError, callViewMethod } from "./near-rpc.js";
import { createAgentAuthenticator, resolveAgentApiToken } from "./auth.js";
import { createNearAgentSigner, createNearApprovalSigner, createNearExpirySigner } from "./near-signer.js";
import { createPaymentExpiryMonitor, readExpiryMonitorInterval } from "./expiry-service.js";
import { createRecoveryService, readRecoveryInterval } from "./recovery-service.js";
import { createSerialBridge } from "./serial.js";
import { createApprovalProcessor } from "./approval-service.js";
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
const PAYMENT_STATUSES = new Set(["pending", "approved", "processing", "paid", "failed", "expired", "cancelled"]);

function executionStatusKind(status) {
  if (status === "NotStarted") return "not_started";
  if (status === "Started") return "in_progress";
  if (status && typeof status === "object" && status.Failure !== undefined) return "failed";
  if (status && typeof status === "object" &&
      (status.SuccessValue !== undefined || status.SuccessReceiptId !== undefined)) return "success";
  return "unknown";
}

function transactionStatusResponse(result) {
  const receipts = Array.isArray(result.receipts_outcome) ? result.receipts_outcome : [];
  const transactionOutcome = result.transaction_outcome?.outcome;
  return {
    transaction_hash: result.transaction.hash,
    contract_id: DEFAULT_CONTRACT_ID,
    signer_id: result.transaction.signer_id,
    receiver_id: result.transaction.receiver_id,
    method_names: Array.isArray(result.transaction.actions)
      ? result.transaction.actions.flatMap((action) =>
        action?.FunctionCall?.method_name ? [action.FunctionCall.method_name] : [])
      : [],
    final_execution_status: result.final_execution_status ?? "NONE",
    execution_state: executionStatusKind(result.status),
    transaction_outcome: transactionOutcome ? {
      block_hash: result.transaction_outcome.block_hash ?? null,
      gas_burnt: String(transactionOutcome.gas_burnt ?? "0"),
      tokens_burnt: String(transactionOutcome.tokens_burnt ?? "0"),
      status: executionStatusKind(transactionOutcome.status),
      logs: Array.isArray(transactionOutcome.logs) ? transactionOutcome.logs : [],
      receipt_ids: Array.isArray(transactionOutcome.receipt_ids) ? transactionOutcome.receipt_ids : []
    } : null,
    receipts: receipts.map((receipt) => ({
      receipt_id: receipt.id,
      block_hash: receipt.block_hash ?? null,
      executor_id: receipt.outcome?.executor_id ?? null,
      gas_burnt: String(receipt.outcome?.gas_burnt ?? "0"),
      tokens_burnt: String(receipt.outcome?.tokens_burnt ?? "0"),
      status: executionStatusKind(receipt.outcome?.status),
      receipt_ids: Array.isArray(receipt.outcome?.receipt_ids) ? receipt.outcome.receipt_ids : [],
      logs: Array.isArray(receipt.outcome?.logs) ? receipt.outcome.logs : []
    })),
    receipt_count: receipts.length,
    receipts_finalized: result.final_execution_status === "FINAL"
  };
}

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

const DASHBOARD_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../dashboard");

async function serveDashboardFile(response, filename, contentType) {
  try {
    const fullPath = resolve(DASHBOARD_DIR, filename);
    const content = await readFile(fullPath);
    response.writeHead(200, {
      "content-type": contentType,
      "cache-control": "no-cache"
    });
    response.end(content);
  } catch {
    send(response, 404, { error: "not_found" });
  }
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
let cachedDashboardSummary = null;
let lastSummaryTimestamp = 0;
const localPlaygroundPayments = [];
let localActivePayment = null;

async function fetchDashboardSummary() {
  const now = Date.now();
  if (cachedDashboardSummary && now - lastSummaryTimestamp < 5000) {
    return cachedDashboardSummary;
  }

  let ports = [];
  try {
    const { SerialPort } = await import("serialport");
    ports = await SerialPort.list();
  } catch {
    ports = [];
  }
  const configuredPort = process.env.SERIAL_PORT || null;
  const isConnected = configuredPort
    ? ports.some((p) => (p.path || "").toLowerCase() === configuredPort.toLowerCase())
    : false;

  const currentDay = Math.floor(now / 86400000);
  const [policy, storageMetrics, activePayment, dailyUsage] = await Promise.all([
    getPolicy().catch(() => cachedDashboardSummary?.policy || null),
    callViewMethod("get_storage_metrics").catch(() => cachedDashboardSummary?.storage_metrics || null),
    getActivePayment().catch(() => null),
    callViewMethod("get_daily_usage", { utc_day: currentDay }).catch(() => null)
  ]);

  let payments = [];
  const knownPayments = new Map((cachedDashboardSummary?.payments || []).map((p) => [String(p.id), p]));
  if (policy?.next_payment_id) {
    const nextId = Number(policy.next_payment_id);
    const startId = Math.max(1, nextId - 15);
    const paymentPromises = [];
    for (let id = startId; id < nextId; id++) {
      const existing = knownPayments.get(String(id));
      if (existing && ["paid", "failed", "expired", "cancelled"].includes(existing.status)) {
        paymentPromises.push(Promise.resolve(existing));
      } else {
        paymentPromises.push(getPayment(String(id)).catch(() => existing || null));
      }
    }
    const results = await Promise.all(paymentPromises);
    payments = results.filter(Boolean).reverse();
  }

  const combinedPayments = [...localPlaygroundPayments, ...payments];
  const seenIds = new Set();
  const finalPayments = [];
  for (const p of combinedPayments) {
    if (p && !seenIds.has(String(p.id))) {
      seenIds.add(String(p.id));
      finalPayments.push(p);
    }
  }

  cachedDashboardSummary = {
    network: "testnet",
    contract_id: DEFAULT_CONTRACT_ID,
    policy,
    storage_metrics: storageMetrics,
    active_payment: localActivePayment || activePayment,
    daily_usage: dailyUsage,
    payments: finalPayments,
    hardware_status: {
      configured_port: configuredPort,
      connected: isConnected,
      available_ports: ports.map((p) => ({ path: p.path, manufacturer: p.manufacturer || "Generic" })),
      baud_rate: Number(process.env.SERIAL_BAUD_RATE || 115200),
      button_gpio: "GPIO25"
    },
    timestamp_ms: now
  };
  lastSummaryTimestamp = now;
  return cachedDashboardSummary;
}

export function createRelayServer(options = {}) {
  const authenticate = options.authenticate ??
    createAgentAuthenticator({ token: options.agentApiToken ?? process.env.AGENT_API_TOKEN });
  const agentId = options.agentId ?? DEFAULT_AGENT_ID;
  const idempotencyStore = options.idempotencyStore;
  const submitPayment = options.submitPayment;
  const processHardwareApproval = options.processHardwareApproval;
  const reconcileRecovery = options.reconcileRecovery;
  const readActivePayment = options.getActivePayment ?? getActivePayment;
  const readPayment = options.getPayment ?? getPayment;
  const readTransactionStatus = options.getTransactionStatus ?? getTransactionStatus;
  const logger = options.logger ?? createStructuredLogger();
  const readPolicy = options.getPolicy ?? getPolicy;

  return createServer(async (request, response) => {
    const requestId = randomUUID();
    const startedAt = Date.now();
    response.setHeader("x-request-id", requestId);
    response.once("finish", () => {
      const rawPath = (request.url ?? "/").split("?")[0];
      const staticRoutes = new Set([
        "/", "/dashboard", "/dashboard/styles.css", "/dashboard/app.js", "/dashboard/dashboard-service.js", "/dashboard/media-studio", "/dashboard/media-studio.html",
        "/health", "/v1/hardware-status", "/v1/dashboard-summary", "/v1/playground/hardware-trigger", "/v1/playground/routine-trigger", "/v1/payment-requests", "/v1/pending-approvals",
        "/v1/approvals/process", "/v1/recovery/reconcile", "/policy", "/active-payment"
      ]);
      const route = staticRoutes.has(rawPath) ? rawPath
        : /^\/v1\/transactions\/[^/]+$/.test(rawPath) ? "/v1/transactions/:hash"
        : /^\/v1\/payments\/[0-9]+$/.test(rawPath) ? "/v1/payments/:paymentId"
        : "/unmatched";
      const fields = {
        request_id: requestId,
        method: request.method ?? "UNKNOWN",
        route,
        status: response.statusCode,
        duration_ms: Date.now() - startedAt
      };
      if (response.statusCode >= 500) logger.error("http.request.failed", fields);
      else if (response.statusCode >= 400) logger.warn("http.request.rejected", fields);
      else logger.info("http.request.completed", fields);
    });
    let pathname;
    let requestUrl;
    try {
      requestUrl = new URL(request.url ?? "/", "http://localhost");
      pathname = requestUrl.pathname;
    } catch {
      send(response, 400, { error: "invalid_request_url" });
      return;
    }

    if (request.method === "GET" && pathname === "/health") {
      send(response, 200, { name: "tapproved", status: "ok", network: "testnet" });
      return;
    }

    if (request.method === "GET" && pathname === "/v1/hardware-status") {
      let ports = [];
      try {
        const { SerialPort } = await import("serialport");
        ports = await SerialPort.list();
      } catch {
        ports = [];
      }
      const configuredPort = process.env.SERIAL_PORT || null;
      const isConnected = configuredPort ? ports.some((p) => (p.path || "").toLowerCase() === configuredPort.toLowerCase()) : false;
      send(response, 200, {
        configured_port: configuredPort,
        connected: isConnected,
        available_ports: ports.map((p) => ({ path: p.path, manufacturer: p.manufacturer || "Generic" })),
        baud_rate: Number(process.env.SERIAL_BAUD_RATE || 115200),
        button_gpio: "GPIO25",
        contract_id: DEFAULT_CONTRACT_ID
      });
      return;
    }

    if (request.method === "GET") {
      if (pathname === "/" || pathname === "/dashboard" || pathname === "/dashboard/index.html") {
        await serveDashboardFile(response, "index.html", "text/html; charset=utf-8");
        return;
      }
      if (pathname === "/dashboard/styles.css" || pathname === "/styles.css") {
        await serveDashboardFile(response, "styles.css", "text/css; charset=utf-8");
        return;
      }
      if (pathname === "/dashboard/app.js" || pathname === "/app.js") {
        await serveDashboardFile(response, "app.js", "application/javascript; charset=utf-8");
        return;
      }
      if (pathname === "/dashboard/dashboard-service.js" || pathname === "/dashboard-service.js") {
        await serveDashboardFile(response, "dashboard-service.js", "application/javascript; charset=utf-8");
        return;
      }
      if (pathname === "/dashboard/media-studio" || pathname === "/dashboard/media-studio.html") {
        await serveDashboardFile(response, "media-studio.html", "text/html; charset=utf-8");
        return;
      }
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
          send(response, 400, { error: "invalid_payment_request" });
        }
        return;
      }

      try {
        if (cachedDashboardSummary?.policy?.allowed_recipients &&
            Array.isArray(cachedDashboardSummary.policy.allowed_recipients) &&
            !cachedDashboardSummary.policy.allowed_recipients.includes(payment.recipient_id)) {
          send(response, 400, { error: "recipient_not_allowlisted" });
          return;
        }
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
        if (activePayment && (activePayment.agent_id !== agentId || !PAYMENT_STATUSES.has(activePayment.status))) {
          throw new Error("unexpected active payment record");
        }
        const pending = activePayment?.status === "pending" ? activePayment : null;
        send(response, 200, {
          network: "testnet",
          contract_id: DEFAULT_CONTRACT_ID,
          approval_required: pending !== null,
          payment: pending,
          approval_request: pending ? {
            contract_id: DEFAULT_CONTRACT_ID,
            network_id: "testnet",
            payment_id: pending.id,
            recipient_id: pending.recipient_id,
            amount_yocto: pending.amount_yocto,
            nonce: pending.nonce,
            expires_at_ns: pending.expires_at_ns
          } : null
        });
      } catch {
        send(response, 502, { error: "near_rpc_failed" });
      }
      return;
    }


    if (request.method === "POST" && pathname === "/v1/playground/routine-trigger") {
      const paidRecord = {
        id: String(Date.now()).slice(-6),
        agent_id: "manex-agent.testnet",
        recipient_id: "manex-agent.testnet",
        amount_yocto: "1000000000000000000000",
        status: "paid",
        nonce: "1",
        created_at_ns: String(BigInt(Date.now()) * 1_000_000n),
        hardware_approved: false
      };
      localPlaygroundPayments.unshift(paidRecord);
      lastSummaryTimestamp = 0;
      send(response, 200, paidRecord);
      return;
    }

    if (request.method === "POST" && pathname === "/v1/playground/hardware-trigger") {
      const configuredPort = process.env.SERIAL_PORT || "COM11";
      const baudRate = Number(process.env.SERIAL_BAUD_RATE || 115200);
      let bridge = null;
      try {
        bridge = createSerialBridge({ path: configuredPort, baudRate, timeoutMs: 35000 });
        await bridge.connect();
        await new Promise((r) => setTimeout(r, 800));
        const testPayment = {
          id: String(Date.now()).slice(-6),
          status: "pending",
          agent_id: "manex-agent.testnet",
          recipient_id: "manex-agent.testnet",
          amount_yocto: "50000000000000000000000",
          nonce: "1",
          expires_at_ns: String(BigInt(Date.now() + 300_000) * 1_000_000n)
        };
        localActivePayment = testPayment;
        lastSummaryTimestamp = 0;
        const sig = await bridge.requestApproval(testPayment);
        localActivePayment = null;
        const paidRecord = {
          id: testPayment.id,
          agent_id: testPayment.agent_id,
          recipient_id: testPayment.recipient_id,
          amount_yocto: testPayment.amount_yocto,
          status: "paid",
          nonce: testPayment.nonce,
          created_at_ns: String(BigInt(Date.now()) * 1_000_000n),
          hardware_approved: true,
          public_key_hex: sig.public_key_hex,
          signature_hex: sig.signature_hex
        };
        localPlaygroundPayments.unshift(paidRecord);
        lastSummaryTimestamp = 0;
        send(response, 200, paidRecord);
      } catch (err) {
        localActivePayment = null;
        lastSummaryTimestamp = 0;
        send(response, 500, { error: err.code || err.message });
      } finally {
        if (bridge) {
          try { await bridge.disconnect(); } catch {}
        }
      }
      return;
    }

    if (request.method === "POST" && pathname === "/v1/approvals/process") {
      if (!authenticate(request)) {
        send(response, 401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
        return;
      }
      if (typeof processHardwareApproval !== "function") {
        send(response, 503, { error: "hardware_approval_not_configured" });
        return;
      }
      try {
        const result = await processHardwareApproval();
        send(response, 200, result);
      } catch (error) {
        const code = typeof error?.code === "string" && /^[a-z0-9_]{1,64}$/.test(error.code)
          ? error.code
          : "hardware_approval_failed";
        const status = code === "approval_already_in_progress" ? 409 : 502;
        send(response, status, { error: code });
      }
      return;
    }

    if (request.method === "POST" && pathname === "/v1/recovery/reconcile") {
      if (!authenticate(request)) {
        send(response, 401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
        return;
      }
      if (typeof reconcileRecovery !== "function") {
        send(response, 503, { error: "recovery_not_configured" });
        return;
      }
      try {
        send(response, 200, await reconcileRecovery());
      } catch {
        send(response, 502, { error: "recovery_reconciliation_failed" });
      }
      return;
    }

    const transactionMatch = request.method === "GET"
      ? pathname.match(/^\/v1\/transactions\/([^/]+)$/)
      : null;
    if (transactionMatch) {
      if (!authenticate(request)) {
        send(response, 401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
        return;
      }
      if (!isValidTransactionHash(transactionMatch[1])) {
        send(response, 400, { error: "invalid_transaction_hash" });
        return;
      }
      const waitUntil = requestUrl.searchParams.get("wait_until") ?? "NONE";
      try {
        const result = await readTransactionStatus(transactionMatch[1], {
          env: {
            NEAR_CONTRACT_ID: DEFAULT_CONTRACT_ID,
            NEAR_SIGNER_ACCOUNT_ID: DEFAULT_AGENT_ID
          },
          waitUntil
        });
        const payload = transactionStatusResponse(result);
        send(response, payload.receipts_finalized ? 200 : 202, payload);
      } catch (error) {
        if (error instanceof TransactionQueryValidationError) {
          send(response, 400, { error: error.code });
        } else if (error instanceof TransactionNotFoundError) {
          send(response, 404, { error: error.code });
        } else if (error instanceof TransactionWaitTimeoutError) {
          send(response, 202, {
            transaction_hash: transactionMatch[1],
            final_execution_status: "UNKNOWN",
            requested_wait_until: waitUntil,
            execution_state: "in_progress",
            receipts: [],
            receipt_count: 0,
            receipts_finalized: false
          });
        } else {
          send(response, 502, { error: "near_rpc_failed" });
        }
      }
      return;
    }

    const paymentMatch = request.method === "GET"
      ? pathname.match(/^\/v1\/payments\/([0-9]+)$/)
      : null;
    if (paymentMatch) {
      if (!authenticate(request)) {
        send(response, 401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
        return;
      }
      try {
        const paymentId = paymentMatch[1];
        const payment = await readPayment(paymentId, { env: { NEAR_CONTRACT_ID: DEFAULT_CONTRACT_ID } });
        if (!payment || payment.id !== paymentId || payment.agent_id !== agentId) {
          send(response, 404, { error: "payment_not_found" });
          return;
        }
        if (!PAYMENT_STATUSES.has(payment.status)) throw new Error("unknown contract payment status");
        const approvalRequired = payment.status === "pending";
        const terminal = ["paid", "failed", "expired", "cancelled"].includes(payment.status);
        send(response, 200, {
          network: "testnet",
          contract_id: DEFAULT_CONTRACT_ID,
          approval_required: approvalRequired,
          terminal,
          payment
        });
      } catch (error) {
        if (error instanceof RangeError || error instanceof TypeError) {
          send(response, 400, { error: "invalid_payment_id" });
        } else {
          send(response, 502, { error: "near_rpc_failed" });
        }
      }
      return;
    }

    if (request.method !== "GET") {
      send(response, 405, { error: "method_not_allowed" }, { allow: "GET, POST" });
      return;
    }

    try {
      if (pathname === "/v1/dashboard-summary") {
        const summary = await fetchDashboardSummary();
        send(response, 200, summary);
        return;
      }
      if (pathname === "/policy") {
        let policy = cachedDashboardSummary?.policy;
        if (!policy) {
          try {
            policy = await readPolicy();
          } catch {
            policy = cachedDashboardSummary?.policy || null;
          }
        }
        if (!policy) {
          policy = await readPolicy();
        }
        send(response, 200, { network: "testnet", policy });
        return;
      }
      if (pathname === "/active-payment") {
        let payment;
        try {
          payment = await getActivePayment();
        } catch {
          payment = cachedDashboardSummary?.active_payment ?? null;
        }
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
  const logger = createStructuredLogger();
  const port = Number(process.env.PORT ?? 3000);
  const storePath = process.env.TAPPROVED_IDEMPOTENCY_PATH ?? ".tapproved/idempotency.json";
  const idempotencyStore = new JsonIdempotencyStore(storePath);
  let submitPayment;

  try {
    const signer = await createNearAgentSigner();
    submitPayment = signer.requestSpend;
    logger.info("signer.agent.ready", { component: "near-agent" });
  } catch (error) {
    logger.error("signer.agent.unavailable", { component: "near-agent", ...sanitizeError(error, "agent_signer_unavailable") });
  }

  let processHardwareApproval;
  let serialBridge;
  let expiryMonitor;
  let recoveryService;
  try {
    const approvalSigner = await createNearApprovalSigner();
    serialBridge = createSerialBridge();
    processHardwareApproval = createApprovalProcessor({ approvalSigner, serialBridge, operationStore: idempotencyStore });
    logger.info("signer.approval.ready", { component: "hardware-approval" });
  } catch (error) {
    logger.error("signer.approval.unavailable", { component: "hardware-approval", ...sanitizeError(error, "approval_signer_unavailable") });
  }

  try {
    const expirySigner = await createNearExpirySigner();
    expiryMonitor = createPaymentExpiryMonitor({
      expirySigner,
      operationStore: idempotencyStore,
      intervalMs: readExpiryMonitorInterval(),
      onResult: (result) => {
        if (["expired", "submitted_unconfirmed"].includes(result?.state)) {
          logger.info("expiry.monitor.result", { component: "expiry-monitor", state: result.state, payment_id: result.payment_id });
        }
      },
      onError: (error) => {
        logger.error("expiry.monitor.failed", { component: "expiry-monitor", ...sanitizeError(error, "expiry_monitor_failed") });
      }
    });
    expiryMonitor.start();
    logger.info("expiry.monitor.enabled", { component: "expiry-monitor" });
  } catch (error) {
    logger.error("expiry.monitor.unavailable", { component: "expiry-monitor", ...sanitizeError(error, "expiry_monitor_unavailable") });
  }

  try {
    const [unresolvedRequests, unresolvedOperations] = await Promise.all([
      idempotencyStore.listUnresolvedPaymentRequests(DEFAULT_AGENT_ID),
      idempotencyStore.listUnresolvedOperations(DEFAULT_AGENT_ID)
    ]);
    const signerConfigured = [
      process.env.NEAR_SIGNER_PRIVATE_KEY,
      process.env.NEAR_APPROVAL_SIGNER_PRIVATE_KEY,
      process.env.NEAR_EXPIRY_SIGNER_PRIVATE_KEY
    ].some((value) => typeof value === "string" && value.length > 0);
    if (!signerConfigured && unresolvedRequests.length === 0 && unresolvedOperations.length === 0) {
      logger.info("recovery.monitor.skipped", {
        component: "recovery-monitor",
        reason: "read_only_mode_no_recovery_work"
      });
    } else {
      recoveryService = createRecoveryService({
      store: idempotencyStore,
      intervalMs: readRecoveryInterval(),
      onResult: (result) => {
        if (result?.state === "manual_review_required") {
          logger.warn("recovery.manual_review_required", { component: "recovery-monitor", state: result.state });
        }
      },
      onError: (error) => {
        logger.error("recovery.monitor.failed", { component: "recovery-monitor", ...sanitizeError(error, "recovery_monitor_failed") });
      }
    });
      recoveryService.start();
      logger.info("recovery.monitor.enabled", { component: "recovery-monitor" });
    }
  } catch (error) {
    logger.error("recovery.monitor.unavailable", { component: "recovery-monitor", ...sanitizeError(error, "recovery_monitor_unavailable") });
  }

  const { token: agentApiToken, development: devTokenActive } = resolveAgentApiToken();
  if (devTokenActive) {
    logger.info("auth.dev_token_active", {
      component: "auth",
      note: "AGENT_API_TOKEN not set in environment; using local development token for dashboard and testing"
    });
  }

  if (!submitPayment) {
    logger.info("relay.telemetry_mode", {
      component: "startup",
      note: "No NEAR signer private key configured. Relay is running in live dashboard and read-only telemetry mode on NEAR Testnet (manextech.testnet)."
    });
  }

  const server = createRelayServer({
    agentApiToken,
    idempotencyStore,
    submitPayment,
    processHardwareApproval,
    reconcileRecovery: recoveryService?.reconcileOnce,
    logger
  });
  server.on("close", () => {
    if (serialBridge) void serialBridge.disconnect();
    if (expiryMonitor) expiryMonitor.stop();
    if (recoveryService) recoveryService.stop();
  });
  server.listen(port, () => {
    logger.info("relay.listening", { component: "http-server" });
  });
}

if (isMain) {
  startRelay().catch((error) => {
    createStructuredLogger().error("relay.startup.failed", { component: "startup", ...sanitizeError(error, "relay_startup_failed") });
    process.exitCode = 1;
  });
}
