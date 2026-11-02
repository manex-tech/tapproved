import { getActivePayment } from "./near-rpc.js";
import { CANONICAL_AGENT_ID, HardwareApprovalError } from "./near-signer.js";

export class ApprovalProcessingError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "ApprovalProcessingError";
    this.code = code;
  }
}

/**
 * Run one explicit hardware-approval cycle. There is no background retry:
 * the caller must re-observe contract state before requesting another cycle.
 */
export function createApprovalProcessor(options = {}) {
  const readActivePayment = options.getActivePayment ?? getActivePayment;
  const serialBridge = options.serialBridge;
  const approvalSigner = options.approvalSigner;
  const operationStore = options.operationStore;
  const env = options.env ?? process.env;
  let inFlight = false;

  if (!serialBridge || typeof serialBridge.connect !== "function" ||
      typeof serialBridge.requestApproval !== "function") {
    throw new TypeError("a configured serial bridge is required");
  }
  if (!approvalSigner || typeof approvalSigner.approveSpend !== "function") {
    throw new TypeError("a hardware-approval signer is required");
  }
  if (!operationStore ||
      typeof operationStore.getOperation !== "function" ||
      typeof operationStore.beginOperation !== "function" ||
      typeof operationStore.completeOperation !== "function" ||
      typeof operationStore.markOperationUncertain !== "function" ||
      typeof operationStore.rejectOperation !== "function" ||
      typeof operationStore.confirmOperation !== "function") {
    throw new TypeError("a durable payment operation store is required");
  }

  return async function processPendingApproval() {
    if (inFlight) throw new ApprovalProcessingError("approval_already_in_progress");
    inFlight = true;
    try {
      let payment;
      try {
        payment = await readActivePayment({ env, fetchImpl: options.fetchImpl });
      } catch {
        throw new ApprovalProcessingError("active_payment_read_failed");
      }
      if (!payment) return { state: "no_pending_approval" };
      if (payment.agent_id !== CANONICAL_AGENT_ID) {
        throw new ApprovalProcessingError("unexpected_payment_agent");
      }
      if (payment.status !== "pending") {
        return {
          state: "not_pending",
          payment_id: payment.id,
          payment_status: payment.status
        };
      }

      const previousOperation = await operationStore.getOperation(
        CANONICAL_AGENT_ID,
        payment.id,
        "approval"
      );
      if (previousOperation && previousOperation.state !== "rejected") {
        throw new ApprovalProcessingError("approval_recovery_required");
      }

      try {
        await serialBridge.connect();
      } catch {
        throw new ApprovalProcessingError("serial_connection_failed");
      }

      let signedResponse;
      try {
        signedResponse = await serialBridge.requestApproval(payment);
      } catch (error) {
        throw new ApprovalProcessingError(
          error?.code || "device_approval_failed"
        );
      }

      const attempt = await operationStore.beginOperation(
        CANONICAL_AGENT_ID,
        payment.id,
        "approval"
      );
      if (!attempt.created) {
        throw new ApprovalProcessingError("approval_recovery_required");
      }

      let submitted;
      try {
        submitted = await approvalSigner.approveSpend(payment, signedResponse);
      } catch (error) {
        const definitelyPreSubmit = error instanceof HardwareApprovalError &&
          !["approval_state_not_confirmed", "approval_transaction_hash_missing"].includes(error.code);
        try {
          if (definitelyPreSubmit) {
            await operationStore.rejectOperation(
              CANONICAL_AGENT_ID,
              payment.id,
              "approval",
              error.code
            );
          } else {
            await operationStore.markOperationUncertain(CANONICAL_AGENT_ID, payment.id, "approval");
          }
        } catch {
          // The durable submitting marker remains for startup reconciliation.
        }
        if (error instanceof HardwareApprovalError) {
          throw new ApprovalProcessingError(error.code);
        }
        // A signer/RPC error may occur after broadcast. Never retry here.
        throw new ApprovalProcessingError("approval_submission_outcome_unknown");
      }

      try {
        await operationStore.completeOperation(
          CANONICAL_AGENT_ID,
          payment.id,
          "approval",
          submitted.transaction_hash
        );
        const observedStatus = submitted.payment?.status;
        if (["processing", "paid", "failed", "expired", "cancelled"].includes(observedStatus)) {
          await operationStore.confirmOperation(
            CANONICAL_AGENT_ID,
            payment.id,
            "approval",
            observedStatus
          );
        }
      } catch {
        // The transaction may already be final. Startup recovery re-reads get_payment.
      }

      return {
        state: "submitted",
        payment_id: payment.id,
        transaction_hash: submitted.transaction_hash,
        payment: submitted.payment ?? null
      };
    } finally {
      inFlight = false;
    }
  };
}
