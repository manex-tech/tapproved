import { CANONICAL_AGENT_ID, CANONICAL_CONTRACT_ID } from "./near-signer.js";
import { getActivePayment, getPayment } from "./near-rpc.js";

export const DEFAULT_RECOVERY_INTERVAL_MS = 30_000;
export const MIN_RECOVERY_INTERVAL_MS = 5_000;
export const MAX_RECOVERY_INTERVAL_MS = 3_600_000;

export function readRecoveryInterval(env = process.env) {
  const raw = env.RECOVERY_MONITOR_INTERVAL_MS;
  if (raw === undefined || raw === "") return DEFAULT_RECOVERY_INTERVAL_MS;
  if (typeof raw !== "string" || !/^[0-9]+$/.test(raw)) {
    throw new TypeError("RECOVERY_MONITOR_INTERVAL_MS must be a decimal integer");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) ||
      value < MIN_RECOVERY_INTERVAL_MS ||
      value > MAX_RECOVERY_INTERVAL_MS) {
    throw new RangeError("RECOVERY_MONITOR_INTERVAL_MS must be between 5000 and 3600000");
  }
  return value;
}

/**
 * Re-observe contract state after interruption. This service only reads chain
 * state and repairs local journal records; it never resubmits a transaction.
 */
export function createRecoveryService(options = {}) {
  const store = options.store;
  if (!store ||
      typeof store.listUnresolvedPaymentRequests !== "function" ||
      typeof store.reconcileSubmitted !== "function" ||
      typeof store.listUnresolvedOperations !== "function" ||
      typeof store.confirmOperation !== "function") {
    throw new TypeError("a recoverable idempotency store is required");
  }
  const agentId = options.agentId ?? CANONICAL_AGENT_ID;
  if (agentId !== CANONICAL_AGENT_ID) throw new TypeError("recovery agent must be canonical");
  const env = options.env ?? process.env;
  const rpcEnv = {
    NEAR_CONTRACT_ID: CANONICAL_CONTRACT_ID,
    ...(env.NEAR_RPC_URL ? { NEAR_RPC_URL: env.NEAR_RPC_URL } : {})
  };
  const readActive = options.getActivePayment ?? getActivePayment;
  const readPayment = options.getPayment ?? getPayment;
  const intervalMs = options.intervalMs ?? readRecoveryInterval(env);
  if (!Number.isSafeInteger(intervalMs) ||
      intervalMs < MIN_RECOVERY_INTERVAL_MS ||
      intervalMs > MAX_RECOVERY_INTERVAL_MS) {
    throw new RangeError("recovery monitor interval is outside the allowed range");
  }
  const onResult = options.onResult ?? (() => {});
  const onError = options.onError ?? (() => {});
  let running = null;
  let timer = null;

  async function reconcileOnce() {
    if (running) return { state: "already_running" };
    running = (async () => {
      const [unresolvedRequests, unresolvedOperations, activePayment] = await Promise.all([
        store.listUnresolvedPaymentRequests(agentId),
        store.listUnresolvedOperations(agentId),
        readActive({ env: rpcEnv })
      ]);

      let reconciledRequests = 0;
      let requestRecoveryState = unresolvedRequests.length === 0 ? "none_pending" : "manual_review";
      if (activePayment &&
          activePayment.agent_id === agentId &&
          typeof activePayment.id === "string" &&
          /^[0-9]+$/.test(activePayment.id)) {
        const matches = unresolvedRequests.filter((record) =>
          record.payment?.recipient_id === activePayment.recipient_id &&
          record.payment?.amount_yocto === activePayment.amount_yocto
        );
        if (matches.length === 1) {
          await store.reconcileSubmitted(agentId, matches[0].idempotency_key, activePayment);
          reconciledRequests = 1;
          requestRecoveryState = "reconciled";
        } else if (matches.length > 1) {
          requestRecoveryState = "ambiguous_match";
        } else if (unresolvedRequests.length === 0) {
          requestRecoveryState = "none_pending";
        } else {
          requestRecoveryState = "active_payment_unmatched";
        }
      } else if (unresolvedRequests.length > 0) {
        requestRecoveryState = "no_active_payment_manual_review";
      }

      let confirmedOperations = 0;
      let unresolvedOperationCount = 0;
      for (const operation of unresolvedOperations) {
        let payment;
        try {
          payment = await readPayment(operation.payment_id, { env: rpcEnv });
        } catch {
          unresolvedOperationCount += 1;
          continue;
        }
        if (!payment || payment.id !== operation.payment_id || payment.agent_id !== agentId) {
          unresolvedOperationCount += 1;
          continue;
        }
        const terminalOrAdvanced = ["processing", "paid", "failed", "expired", "cancelled"].includes(payment.status);
        if (!terminalOrAdvanced) {
          unresolvedOperationCount += 1;
          continue;
        }
        await store.confirmOperation(
          agentId,
          operation.payment_id,
          operation.kind,
          payment.status
        );
        confirmedOperations += 1;
      }

      const unresolvedRequestsRemaining =
        (await store.listUnresolvedPaymentRequests(agentId)).length;
      const unresolvedOperationsRemaining =
        (await store.listUnresolvedOperations(agentId)).length;
      const hasUnresolved = unresolvedRequestsRemaining > 0 || unresolvedOperationsRemaining > 0;
      return {
        state: hasUnresolved ? "manual_review_required" : "reconciled",
        request_recovery: requestRecoveryState,
        reconciled_payment_requests: reconciledRequests,
        unresolved_payment_requests: unresolvedRequestsRemaining,
        confirmed_operations: confirmedOperations,
        unresolved_operations: unresolvedOperationsRemaining
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
      void reconcileOnce().then(onResult).catch(onError);
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

  return Object.freeze({ reconcileOnce, start, stop, intervalMs });
}
