import {
  CANONICAL_AGENT_ID,
  CANONICAL_CONTRACT_ID
} from "./near-signer.js";
import {
  getActivePayment,
  getLatestBlockTimestampNs,
  getPayment
} from "./near-rpc.js";

export const DEFAULT_EXPIRY_MONITOR_INTERVAL_MS = 15_000;
export const MIN_EXPIRY_MONITOR_INTERVAL_MS = 1_000;
export const MAX_EXPIRY_MONITOR_INTERVAL_MS = 3_600_000;

export function readExpiryMonitorInterval(env = process.env) {
  const raw = env.EXPIRY_MONITOR_INTERVAL_MS;
  if (raw === undefined || raw === "") return DEFAULT_EXPIRY_MONITOR_INTERVAL_MS;
  if (typeof raw !== "string" || !/^[0-9]+$/.test(raw)) {
    throw new TypeError("EXPIRY_MONITOR_INTERVAL_MS must be a decimal integer");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) ||
      value < MIN_EXPIRY_MONITOR_INTERVAL_MS ||
      value > MAX_EXPIRY_MONITOR_INTERVAL_MS) {
    throw new RangeError("EXPIRY_MONITOR_INTERVAL_MS must be between 1000 and 3600000");
  }
  return value;
}

/**
 * Permissionless contract expiry keeper. The relay uses finalized chain time,
 * never its host clock. It makes at most one submission attempt per payment
 * per process; an ambiguous signer failure is not blindly retried.
 */
export function createPaymentExpiryMonitor(options = {}) {
  const env = options.env ?? process.env;
  const expirySigner = options.expirySigner;
  if (!expirySigner || typeof expirySigner.expirePayment !== "function") {
    throw new TypeError("a restricted expiry signer is required");
  }
  const readActive = options.getActivePayment ?? getActivePayment;
  const readBlockTime = options.getLatestBlockTimestampNs ?? getLatestBlockTimestampNs;
  const readPayment = options.getPayment ?? getPayment;
  const intervalMs = options.intervalMs ?? readExpiryMonitorInterval(env);
  if (!Number.isSafeInteger(intervalMs) ||
      intervalMs < MIN_EXPIRY_MONITOR_INTERVAL_MS ||
      intervalMs > MAX_EXPIRY_MONITOR_INTERVAL_MS) {
    throw new RangeError("expiry monitor interval is outside the allowed range");
  }
  const onResult = options.onResult ?? (() => {});
  const onError = options.onError ?? (() => {});
  let running = null;
  let timer = null;
  let lastAttemptedPaymentId = null;

  async function runOnce() {
    if (running) return { state: "already_running" };
    running = (async () => {
      const active = await readActive({
        env: { ...env, NEAR_CONTRACT_ID: CANONICAL_CONTRACT_ID }
      });
      if (!active) return { state: "idle" };
      if (active.agent_id !== CANONICAL_AGENT_ID ||
          typeof active.id !== "string" || !/^[0-9]+$/.test(active.id) ||
          typeof active.expires_at_ns !== "string" || !/^[0-9]+$/.test(active.expires_at_ns)) {
        throw new Error("active payment has invalid canonical expiry context");
      }
      if (active.status !== "pending" && active.status !== "approved") {
        return { state: "not_expirable", payment_id: active.id, payment_status: active.status };
      }
      if (lastAttemptedPaymentId === active.id) {
        return { state: "attempt_suppressed", payment_id: active.id };
      }

      const blockTimestampNs = await readBlockTime({
        env: { ...env, NEAR_CONTRACT_ID: CANONICAL_CONTRACT_ID }
      });
      if (typeof blockTimestampNs !== "string" || !/^[0-9]+$/.test(blockTimestampNs)) {
        throw new Error("finalized NEAR block timestamp is invalid");
      }
      if (BigInt(blockTimestampNs) <= BigInt(active.expires_at_ns)) {
        return {
          state: "not_due",
          payment_id: active.id,
          expires_at_ns: active.expires_at_ns,
          chain_timestamp_ns: blockTimestampNs
        };
      }

      // Set before broadcasting. If the RPC outcome becomes ambiguous, do not
      // submit a second expiry transaction for this payment in this process.
      lastAttemptedPaymentId = active.id;
      const submitted = await expirySigner.expirePayment(active.id);
      let confirmedPayment = null;
      try {
        confirmedPayment = await readPayment(active.id, {
          env: { ...env, NEAR_CONTRACT_ID: CANONICAL_CONTRACT_ID }
        });
      } catch {
        return {
          state: "submitted_unconfirmed",
          payment_id: active.id,
          transaction_hash: submitted.transaction_hash
        };
      }
      if (!confirmedPayment ||
          confirmedPayment.id !== active.id ||
          confirmedPayment.agent_id !== CANONICAL_AGENT_ID ||
          confirmedPayment.status !== "expired") {
        return {
          state: "submitted_unconfirmed",
          payment_id: active.id,
          transaction_hash: submitted.transaction_hash
        };
      }
      return {
        state: "expired",
        payment_id: active.id,
        transaction_hash: submitted.transaction_hash,
        payment: confirmedPayment
      };
    })();

    try {
      return await running;
    } finally {
      running = null;
    }
  }

  function start() {
    if (timer) return stop;
    const tick = () => {
      void runOnce().then(onResult).catch(onError);
    };
    tick();
    timer = setInterval(tick, intervalMs);
    timer.unref?.();
    return stop;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return Object.freeze({ runOnce, start, stop, intervalMs });
}
