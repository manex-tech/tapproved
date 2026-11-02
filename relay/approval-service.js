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
  const env = options.env ?? process.env;
  let inFlight = false;

  if (!serialBridge || typeof serialBridge.connect !== "function" ||
      typeof serialBridge.requestApproval !== "function") {
    throw new TypeError("a configured serial bridge is required");
  }
  if (!approvalSigner || typeof approvalSigner.approveSpend !== "function") {
    throw new TypeError("a hardware-approval signer is required");
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

      let submitted;
      try {
        submitted = await approvalSigner.approveSpend(payment, signedResponse);
      } catch (error) {
        if (error instanceof HardwareApprovalError) {
          throw new ApprovalProcessingError(error.code);
        }
        // A signer/RPC error may occur after broadcast. Never retry here.
        throw new ApprovalProcessingError("approval_submission_outcome_unknown");
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
