import { DEFAULT_CONTRACT_ID, getActivePayment, getPayment, getPolicy } from "./near-rpc.js";
import { CANONICAL_AGENT_ID } from "./near-signer.js";
import { buildDeviceApprovalFrame, SerialBridgeError } from "./serial.js";
import { verifyApprovalSignature } from "./protocol.js";

export class HardwareApprovalError extends Error {
  constructor(status, code, message = code) {
    super(message);
    this.name = "HardwareApprovalError";
    this.status = status;
    this.code = code;
  }
}

function devicePublicKeyHex(policy) {
  if (!policy || policy.agent_id !== CANONICAL_AGENT_ID || policy.network_id !== "testnet") {
    throw new HardwareApprovalError(502, "invalid_contract_policy");
  }
  const bytes = policy.device_public_key;
  if (!Array.isArray(bytes) || bytes.length !== 32 ||
      bytes.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
    throw new HardwareApprovalError(502, "invalid_contract_device_key");
  }
  return Buffer.from(bytes).toString("hex");
}

function mapSerialError(error) {
  if (!(error instanceof SerialBridgeError)) {
    return new HardwareApprovalError(502, "serial_bridge_failed");
  }
  if (["serial_port_not_configured", "serial_port_not_connected", "serial_port_open_failed"].includes(error.code)) {
    return new HardwareApprovalError(503, error.code);
  }
  if (error.code === "approval_already_in_progress") {
    return new HardwareApprovalError(409, error.code);
  }
  if (error.code === "device_approval_timeout") {
    return new HardwareApprovalError(504, error.code);
  }
  if (error.code === "device_rejected_or_timed_out") {
    return new HardwareApprovalError(409, error.code);
  }
  return new HardwareApprovalError(502, error.code);
}

/**
 * Coordinates one physical approval. Payment context and the device public key
 * are read from the canonical contract; the caller supplies only a payment ID.
 * The contract independently verifies the signature again in approve_spend.
 */
export function createHardwareApprovalService(options = {}) {
  const env = options.env ?? process.env;
  const rpcOptions = { env, fetchImpl: options.fetchImpl };
  const agentId = options.agentId ?? CANONICAL_AGENT_ID;
  const serialBridge = options.serialBridge;
  const readActivePayment = options.getActivePayment ?? getActivePayment;
  const readPolicy = options.getPolicy ?? getPolicy;
  const readPayment = options.getPayment ?? getPayment;
  const submitApproval = options.approveSpend;

  async function approvePayment(paymentId) {
    if (typeof paymentId !== "string" || !/^[1-9][0-9]*$/.test(paymentId) ||
        BigInt(paymentId) > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new HardwareApprovalError(400, "invalid_payment_id");
    }
    if (!serialBridge || typeof serialBridge.requestApproval !== "function") {
      throw new HardwareApprovalError(503, "serial_bridge_not_configured");
    }
    if (typeof submitApproval !== "function") {
      throw new HardwareApprovalError(503, "hardware_approval_signer_not_configured");
    }

    let activePayment;
    let policy;
    try {
      [activePayment, policy] = await Promise.all([
        readActivePayment(rpcOptions),
        readPolicy(rpcOptions)
      ]);
    } catch {
      throw new HardwareApprovalError(502, "near_rpc_failed");
    }

    if (!activePayment || activePayment.id !== paymentId || activePayment.agent_id !== agentId) {
      throw new HardwareApprovalError(404, "active_payment_not_found");
    }
    if (activePayment.status !== "pending" || activePayment.hardware_approved !== false) {
      throw new HardwareApprovalError(409, "payment_not_pending");
    }

    const frame = buildDeviceApprovalFrame(activePayment);
    const expectedPublicKey = devicePublicKeyHex(policy);
    let deviceResponse;
    try {
      deviceResponse = await serialBridge.requestApproval(activePayment);
    } catch (error) {
      throw mapSerialError(error);
    }

    if (deviceResponse?.public_key_hex !== expectedPublicKey) {
      throw new HardwareApprovalError(403, "unexpected_device_public_key");
    }
    let signatureValid = false;
    try {
      signatureValid = verifyApprovalSignature(frame, expectedPublicKey, deviceResponse.signature_hex);
    } catch {
      signatureValid = false;
    }
    if (!signatureValid) {
      throw new HardwareApprovalError(422, "invalid_hardware_signature");
    }

    try {
      const result = await submitApproval(paymentId, deviceResponse.signature_hex);
      return {
        outcome: "submitted",
        payment_id: paymentId,
        transaction_hash: result.transaction_hash,
        payment: result.payment
      };
    } catch {
      // The transaction may have been broadcast before the RPC response failed.
      // Re-read contract state, but never automatically submit the signature again.
      let latestPayment = null;
      try {
        latestPayment = await readPayment(paymentId, rpcOptions);
      } catch {
        // Keep the result explicitly unknown if the read is also unavailable.
      }
      return {
        outcome: "unknown",
        payment_id: paymentId,
        transaction_hash: null,
        payment: latestPayment,
        instruction: "Do not resubmit this approval. Poll GET /v1/payments/:paymentId to observe contract state."
      };
    }
  }

  return Object.freeze({ approvePayment });
}

export { DEFAULT_CONTRACT_ID };
