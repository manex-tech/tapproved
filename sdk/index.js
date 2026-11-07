import { randomUUID } from "node:crypto";

const U128_MAX = (1n << 128n) - 1n;
const ACCOUNT_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._~-]{16,128}$/;

export class TapprovedError extends Error {
  constructor(message, code, status = null, details = null) {
    super(message);
    this.name = "TapprovedError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class AuthenticationError extends TapprovedError {
  constructor(message = "Authentication failed", details = null) {
    super(message, "authentication_failed", 401, details);
    this.name = "AuthenticationError";
  }
}

export class PolicyViolationError extends TapprovedError {
  constructor(message, code = "policy_violation", details = null) {
    super(message, code, 400, details);
    this.name = "PolicyViolationError";
  }
}

export class IdempotencyConflictError extends TapprovedError {
  constructor(message = "Idempotency key was previously used with different parameters", details = null) {
    super(message, "idempotency_conflict", 409, details);
    this.name = "IdempotencyConflictError";
  }
}

export class PaymentTerminalError extends TapprovedError {
  constructor(payment) {
    const status = payment?.status ?? "unknown";
    super(`Payment ${payment?.id ?? "unknown"} reached non-successful terminal status: ${status}`, `payment_${status}`, 200, { payment });
    this.name = "PaymentTerminalError";
    this.payment = payment;
  }
}

export class TimeoutError extends TapprovedError {
  constructor(message = "Operation timed out") {
    super(message, "timeout", null);
    this.name = "TimeoutError";
  }
}

export class RelayConnectionError extends TapprovedError {
  constructor(message = "Failed to communicate with Tapproved relay", originalError = null) {
    super(message, "relay_connection_error", null, { originalError: originalError?.message });
    this.name = "RelayConnectionError";
  }
}

function normalizeUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TapprovedError("Invalid relay URL", "invalid_relay_url");
  }
  const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
  if (!["https:", "http:"].includes(url.protocol) ||
      (url.protocol === "http:" && !localHosts.has(url.hostname)) ||
      url.username || url.password || url.search || url.hash) {
    throw new TapprovedError("Relay URL must use HTTPS (except localhost)", "insecure_relay_url");
  }
  return url.toString().replace(/\/$/, "");
}

/**
 * Generate a cryptographically random, compliant idempotency key.
 */
export function generateIdempotencyKey(prefix = "req") {
  return `${prefix}-${randomUUID().replace(/-/g, "")}`;
}

/**
 * High-level AI Agent SDK client for Tapproved authorization infrastructure.
 */
export class TapprovedClient {
  #relayUrl;
  #token;
  #fetch;

  /**
   * @param {Object} options
   * @param {string} options.relayUrl Base URL of Tapproved relay (e.g. "https://relay.tapproved.net" or "http://127.0.0.1:3000")
   * @param {string} options.token Bearer API authentication token for agent
   * @param {Function} [options.fetchImpl] Custom fetch implementation (defaults to globalThis.fetch)
   */
  constructor(options = {}) {
    if (!options || typeof options !== "object") {
      throw new TypeError("TapprovedClient options must be an object");
    }
    this.#relayUrl = normalizeUrl(options.relayUrl || "http://127.0.0.1:3000");

    const token = options.token;
    if (typeof token !== "string" || token.length < 32 || !/^[A-Za-z0-9._~-]+$/.test(token)) {
      throw new AuthenticationError("Agent token must be at least 32 URL-safe characters");
    }
    this.#token = token;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    if (typeof this.#fetch !== "function") {
      throw new TapprovedError("fetch implementation is not available in runtime environment", "fetch_unavailable");
    }
  }

  get relayUrl() {
    return this.#relayUrl;
  }

  async #request(endpoint, { method = "GET", body = null, headers = {}, signal = null } = {}) {
    const url = new URL(endpoint, this.#relayUrl);
    const requestHeaders = {
      authorization: `Bearer ${this.#token}`,
      accept: "application/json",
      ...headers
    };
    if (body !== null) {
      requestHeaders["content-type"] = "application/json";
    }

    let response;
    try {
      response = await this.#fetch(url, {
        method,
        headers: requestHeaders,
        body: body !== null ? JSON.stringify(body) : undefined,
        signal
      });
    } catch (err) {
      if (err.name === "AbortError") throw err;
      throw new RelayConnectionError(`Relay request to ${endpoint} failed: ${err.message}`, err);
    }

    let responseBody = null;
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      try {
        responseBody = await response.json();
      } catch (err) {
        throw new TapprovedError(`Invalid JSON returned from relay for ${endpoint}`, "invalid_json_response", response.status);
      }
    } else {
      const text = await response.text();
      responseBody = { raw: text };
    }

    if (!response.ok) {
      const errorCode = responseBody?.error ?? "relay_error";
      const message = typeof responseBody?.error === "string" ? responseBody.error : `Request failed with HTTP ${response.status}`;

      if (response.status === 401) {
        throw new AuthenticationError(message, responseBody);
      }
      if (response.status === 409) {
        throw new IdempotencyConflictError(message, responseBody);
      }
      if (response.status === 400) {
        throw new PolicyViolationError(message, errorCode, responseBody);
      }
      throw new TapprovedError(message, errorCode, response.status, responseBody);
    }

    return responseBody;
  }

  /**
   * Check relay health status.
   */
  async getHealth({ signal } = {}) {
    return await this.#request("/health", { signal });
  }

  /**
   * Retrieve current on-chain spending policy and limits.
   */
  async getPolicy({ signal } = {}) {
    const data = await this.#request("/policy", { signal });
    return data?.policy ?? data;
  }

  /**
   * Retrieve currently active pending or processing payment, if any.
   */
  async getActivePayment({ signal } = {}) {
    const data = await this.#request("/active-payment", { signal });
    return data?.payment ?? null;
  }

  /**
   * Check if there are any payments pending physical hardware approval.
   */
  async getPendingApprovals({ signal } = {}) {
    return await this.#request("/v1/pending-approvals", { signal });
  }

  /**
   * Submit a payment request on behalf of the registered agent.
   *
   * @param {Object} params
   * @param {string} params.recipientId The NEAR account ID of the destination
   * @param {string|bigint} params.amountYocto Payment amount in yoctoNEAR
   * @param {string} [params.idempotencyKey] Unique key to guarantee idempotency. Auto-generated if omitted.
   * @param {AbortSignal} [options.signal]
   */
  async requestPayment({ recipientId, amountYocto, idempotencyKey = null }, { signal } = {}) {
    if (typeof recipientId !== "string" || recipientId.length < 2 || recipientId.length > 64 || !ACCOUNT_ID.test(recipientId)) {
      throw new PolicyViolationError("recipientId must be a valid NEAR account ID", "invalid_recipient_id");
    }

    const amountStr = typeof amountYocto === "bigint" ? amountYocto.toString() : String(amountYocto ?? "");
    if (!/^[0-9]+$/.test(amountStr)) {
      throw new PolicyViolationError("amountYocto must be a positive decimal string or bigint", "invalid_amount");
    }
    const amountBn = BigInt(amountStr);
    if (amountBn <= 0n || amountBn > U128_MAX) {
      throw new PolicyViolationError("amountYocto must be strictly greater than 0 and fit within u128", "amount_out_of_bounds");
    }

    const idKey = idempotencyKey || generateIdempotencyKey();
    if (typeof idKey !== "string" || !IDEMPOTENCY_KEY.test(idKey)) {
      throw new PolicyViolationError("idempotencyKey must contain 16 to 128 URL-safe characters", "invalid_idempotency_key");
    }

    return await this.#request("/v1/payment-requests", {
      method: "POST",
      headers: {
        "idempotency-key": idKey
      },
      body: {
        recipient_id: recipientId,
        amount_yocto: amountStr
      },
      signal
    });
  }

  /**
   * Fetch payment details by ID.
   *
   * @param {string|number|bigint} paymentId
   */
  async getPayment(paymentId, { signal } = {}) {
    const id = String(paymentId);
    if (!/^[0-9]+$/.test(id)) {
      throw new TapprovedError("paymentId must be a numeric integer", "invalid_payment_id");
    }
    const data = await this.#request(`/v1/payments/${id}`, { signal });
    return data?.payment ?? null;
  }

  /**
   * Query finality and outcome of a NEAR transaction.
   *
   * @param {string} hash
   */
  async getTransaction(hash, { signal } = {}) {
    if (typeof hash !== "string" || hash.length < 10) {
      throw new TapprovedError("transaction hash must be a valid non-empty string", "invalid_transaction_hash");
    }
    return await this.#request(`/v1/transactions/${encodeURIComponent(hash)}`, { signal });
  }

  /**
   * Poll a payment until it reaches a terminal status ('paid', 'failed', 'expired', 'cancelled').
   *
   * @param {string|number|bigint} paymentId
   * @param {Object} [options]
   * @param {number} [options.pollIntervalMs=1000] Interval between status checks
   * @param {number} [options.timeoutMs=60000] Overall timeout in milliseconds
   * @param {Function} [options.onPendingApproval] Callback fired if payment requires physical hardware approval
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<Object>} The resolved payment object with status 'paid'
   */
  async waitForPaymentResolution(paymentId, options = {}) {
    const pollIntervalMs = options.pollIntervalMs ?? 1000;
    const timeoutMs = options.timeoutMs ?? 60000;
    const onPendingApproval = options.onPendingApproval ?? null;
    const signal = options.signal ?? null;

    const startTime = Date.now();
    let notifiedPending = false;

    while (true) {
      if (signal?.aborted) {
        throw new TapprovedError("Polling aborted by signal", "aborted");
      }
      if (Date.now() - startTime > timeoutMs) {
        throw new TimeoutError(`Payment ${paymentId} did not reach terminal status within ${timeoutMs}ms`);
      }

      const payment = await this.getPayment(paymentId, { signal });
      if (!payment) {
        throw new TapprovedError(`Payment ${paymentId} not found`, "payment_not_found");
      }

      const status = payment.status;

      if (status === "pending" && !notifiedPending) {
        notifiedPending = true;
        if (typeof onPendingApproval === "function") {
          try {
            await onPendingApproval(payment);
          } catch (err) {
            // Callback errors do not abort polling
          }
        }
      }

      if (status === "paid") {
        return payment;
      }

      if (["failed", "expired", "cancelled"].includes(status)) {
        throw new PaymentTerminalError(payment);
      }

      // Still in progress ('pending', 'approved', 'processing')
      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
  }
}
