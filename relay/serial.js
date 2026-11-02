import { randomUUID } from "node:crypto";
import { SerialPort } from "serialport";
import { DEFAULT_CONTRACT_ID } from "./near-rpc.js";

export const DEFAULT_SERIAL_BAUD_RATE = 115200;
export const DEFAULT_APPROVAL_TIMEOUT_MS = 35_000;
export const MAX_SERIAL_FRAME_BYTES = 2048;
export const CANONICAL_DEVICE_AGENT_ID = "manex-agent.testnet";

export class SerialBridgeError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "SerialBridgeError";
    this.code = code;
  }
}

function decimalString(value, field, { positive = false } = {}) {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
    throw new SerialBridgeError("invalid_payment_context", `${field} must be a decimal string`);
  }
  const parsed = BigInt(value);
  if (positive && parsed === 0n) {
    throw new SerialBridgeError("invalid_payment_context", `${field} must be greater than zero`);
  }
  return value;
}

export function buildDeviceApprovalFrame(payment, requestId) {
  if (!payment || typeof payment !== "object" || Array.isArray(payment)) {
    throw new SerialBridgeError("invalid_payment_context");
  }
  if (typeof requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) {
    throw new SerialBridgeError("invalid_request_id");
  }
  if (payment.status !== "pending") {
    throw new SerialBridgeError("payment_not_pending");
  }
  if (payment.agent_id !== CANONICAL_DEVICE_AGENT_ID) {
    throw new SerialBridgeError("unexpected_agent");
  }
  if (typeof payment.recipient_id !== "string" ||
      !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(payment.recipient_id) ||
      payment.recipient_id.length > 64) {
    throw new SerialBridgeError("invalid_payment_context", "recipient_id is invalid");
  }

  return {
    frame_version: 1,
    request_id: requestId,
    contract_id: DEFAULT_CONTRACT_ID,
    network_id: "testnet",
    payment_id: decimalString(payment.id, "payment_id", { positive: true }),
    recipient_id: payment.recipient_id,
    amount_yocto: decimalString(payment.amount_yocto, "amount_yocto", { positive: true }),
    nonce: decimalString(payment.nonce, "nonce"),
    expires_at_ns: decimalString(payment.expires_at_ns, "expires_at_ns", { positive: true })
  };
}

/**
 * One outstanding approval request is allowed. The bridge sends one bounded
 * newline-delimited JSON frame and accepts only a validated signed response.
 * Informational text emitted by the current ESP32 prototype is ignored.
 */
export function createSerialBridge(options = {}) {
  const path = options.path ?? process.env.SERIAL_PORT;
  const baudRate = options.baudRate ?? Number(process.env.SERIAL_BAUD_RATE ?? DEFAULT_SERIAL_BAUD_RATE);
  const timeoutMs = options.timeoutMs ?? Number(process.env.SERIAL_APPROVAL_TIMEOUT_MS ?? DEFAULT_APPROVAL_TIMEOUT_MS);
  const portFactory = options.portFactory ?? ((config) => new SerialPort(config));

  if (typeof path !== "string" || path.length === 0) {
    throw new SerialBridgeError("serial_port_not_configured");
  }
  if (!Number.isInteger(baudRate) || baudRate < 1200 || baudRate > 2_000_000) {
    throw new SerialBridgeError("invalid_serial_baud_rate");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120_000) {
    throw new SerialBridgeError("invalid_serial_timeout");
  }

  let port = null;
  let connected = false;
  let incoming = "";
  let pending = null;

  function rejectPending(error) {
    if (!pending) return;
    const current = pending;
    pending = null;
    clearTimeout(current.timer);
    current.reject(error);
  }

  function handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      rejectPending(new SerialBridgeError("invalid_device_response"));
      return;
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) return;
    if (message.status === "signed") {
      if (message.frame_version !== 1 ||
          typeof message.request_id !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(message.request_id) ||
          typeof message.public_key_hex !== "string" ||
          !/^[0-9a-f]{64}$/i.test(message.public_key_hex) ||
          typeof message.signature_hex !== "string" ||
          !/^[0-9a-f]{128}$/i.test(message.signature_hex)) {
        rejectPending(new SerialBridgeError("invalid_device_signature_frame"));
        return;
      }
      if (!pending || message.request_id !== pending.requestId) return;
      const current = pending;
      pending = null;
      clearTimeout(current.timer);
      current.resolve({
        public_key_hex: message.public_key_hex.toLowerCase(),
        signature_hex: message.signature_hex.toLowerCase()
      });
      return;
    }
    if (message.frame_version !== 1 ||
        typeof message.request_id !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(message.request_id) ||
        !pending || message.request_id !== pending.requestId) return;
    if (typeof message.error === "string") {
      rejectPending(new SerialBridgeError("device_error", message.error));
      return;
    }
    if (message.status === "rejected_or_timed_out") {
      rejectPending(new SerialBridgeError("device_rejected_or_timed_out"));
    }
  }

  function onData(chunk) {
    incoming += Buffer.from(chunk).toString("utf8");
    while (true) {
      const newline = incoming.indexOf("\n");
      if (newline < 0) {
        if (Buffer.byteLength(incoming, "utf8") > MAX_SERIAL_FRAME_BYTES) {
          incoming = "";
          rejectPending(new SerialBridgeError("serial_frame_too_large"));
        }
        return;
      }
      const line = incoming.slice(0, newline).replace(/\r$/, "");
      incoming = incoming.slice(newline + 1);
      if (Buffer.byteLength(line, "utf8") > MAX_SERIAL_FRAME_BYTES) {
        rejectPending(new SerialBridgeError("serial_frame_too_large"));
      } else {
        handleLine(line);
      }
    }
  }

  function onPortError(error) {
    connected = false;
    rejectPending(new SerialBridgeError("serial_port_error", error?.message || "serial port error"));
  }

  function onPortClose() {
    connected = false;
    incoming = "";
    rejectPending(new SerialBridgeError("serial_port_closed"));
  }

  async function connect() {
    if (connected) return;
    if (port) throw new SerialBridgeError("serial_port_not_ready");
    port = portFactory({ path, baudRate, autoOpen: false });
    port.on("data", onData);
    port.on("error", onPortError);
    port.on("close", onPortClose);

    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve();
      };
      port.once("open", () => finish());
      port.open((error) => finish(error));
    }).catch((error) => {
      port = null;
      connected = false;
      throw new SerialBridgeError("serial_port_open_failed", error?.message || "could not open serial port");
    });
    connected = true;
  }

  async function disconnect() {
    rejectPending(new SerialBridgeError("serial_port_disconnected"));
    const current = port;
    port = null;
    connected = false;
    incoming = "";
    if (!current || !current.isOpen) return;
    await new Promise((resolve) => current.close(() => resolve()));
  }

  function requestApproval(payment) {
    if (!connected || !port?.isOpen) {
      return Promise.reject(new SerialBridgeError("serial_port_not_connected"));
    }
    if (pending) {
      return Promise.reject(new SerialBridgeError("approval_already_in_progress"));
    }

    const requestId = randomUUID();
    const frame = buildDeviceApprovalFrame(payment, requestId);
    const encoded = Buffer.from(JSON.stringify(frame) + "\n", "utf8");
    if (encoded.length > MAX_SERIAL_FRAME_BYTES) {
      return Promise.reject(new SerialBridgeError("serial_frame_too_large"));
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        rejectPending(new SerialBridgeError("device_approval_timeout"));
      }, timeoutMs);
      pending = { resolve, reject, timer, requestId };
      port.write(encoded, (error) => {
        if (error) rejectPending(new SerialBridgeError("serial_write_failed", error.message));
      });
    });
  }

  return Object.freeze({
    connect,
    disconnect,
    requestApproval,
    get connected() { return connected; },
    get pending() { return pending !== null; },
    get path() { return path; }
  });
}
