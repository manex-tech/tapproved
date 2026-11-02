import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  SerialBridgeError,
  buildDeviceApprovalFrame,
  createSerialBridge
} from "./serial.js";

const payment = {
  id: "15",
  agent_id: "manex-agent.testnet",
  recipient_id: "merchant.testnet",
  amount_yocto: "1000000000000000000000",
  nonce: "15",
  expires_at_ns: "1793519712345678901",
  status: "pending"
};

const signed = {
  status: "signed",
  public_key_hex: "a".repeat(64),
  signature_hex: "b".repeat(128)
};

class FakeSerialPort extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.isOpen = false;
    this.writes = [];
    this.onWrite = null;
  }
  open(callback) {
    this.isOpen = true;
    queueMicrotask(() => {
      this.emit("open");
      callback?.();
    });
  }
  write(data, callback) {
    this.writes.push(Buffer.from(data));
    callback?.();
    this.onWrite?.(Buffer.from(data));
    return true;
  }
  close(callback) {
    this.isOpen = false;
    this.emit("close");
    callback?.();
  }
  receive(data) {
    this.emit("data", Buffer.from(data));
  }
}

function makeBridge(options = {}) {
  const fakePort = new FakeSerialPort(null);
  const bridge = createSerialBridge({
    path: "COM7",
    portFactory: (config) => {
      fakePort.config = config;
      return fakePort;
    },
    ...options
  });
  return { bridge, port: fakePort };
}

test("builds the exact canonical device frame from a pending contract payment", () => {
  assert.deepEqual(buildDeviceApprovalFrame(payment), {
    contract_id: "manextech.testnet",
    network_id: "testnet",
    payment_id: "15",
    recipient_id: "merchant.testnet",
    amount_yocto: "1000000000000000000000",
    nonce: "15",
    expires_at_ns: "1793519712345678901"
  });
});

test("refuses non-pending, wrong-agent and malformed payment contexts", () => {
  assert.throws(() => buildDeviceApprovalFrame({ ...payment, status: "approved" }), /payment_not_pending/);
  assert.throws(() => buildDeviceApprovalFrame({ ...payment, agent_id: "other.testnet" }), /unexpected_agent/);
  assert.throws(() => buildDeviceApprovalFrame({ ...payment, amount_yocto: 1 }), /amount_yocto/);
  assert.throws(() => buildDeviceApprovalFrame({ ...payment, expires_at_ns: "0" }), /expires_at_ns/);
});

test("opens the configured serial port and handles fragmented signed JSON after text output", async () => {
  const { bridge, port } = makeBridge();
  await bridge.connect();
  assert.equal(bridge.connected, true);
  assert.deepEqual(port.config, { path: "COM7", baudRate: 115200, autoOpen: false });

  port.onWrite = () => {
    const response = JSON.stringify(signed) + "\r\n";
    port.receive("ESP32 approval prompt\r\n" + response.slice(0, 37));
    port.receive(response.slice(37));
  };

  const result = await bridge.requestApproval(payment);
  assert.deepEqual(result, {
    public_key_hex: "a".repeat(64),
    signature_hex: "b".repeat(128)
  });
  const frame = JSON.parse(port.writes[0].toString("utf8"));
  assert.deepEqual(frame, buildDeviceApprovalFrame(payment));
  await bridge.disconnect();
  assert.equal(bridge.connected, false);
});

test("rejects concurrent approval requests", async () => {
  const { bridge, port } = makeBridge();
  await bridge.connect();
  const first = bridge.requestApproval(payment);
  await assert.rejects(bridge.requestApproval(payment), (error) =>
    error instanceof SerialBridgeError && error.code === "approval_already_in_progress"
  );
  await bridge.disconnect();
  await assert.rejects(first, /serial_port_disconnected/);
  assert.equal(port.isOpen, false);
});

test("rejects device timeout/rejection responses and malformed signatures", async () => {
  const { bridge, port } = makeBridge();
  await bridge.connect();
  port.onWrite = () => port.receive(JSON.stringify({ status: "rejected_or_timed_out" }) + "\n");
  await assert.rejects(bridge.requestApproval(payment), /device_rejected_or_timed_out/);

  port.onWrite = () => port.receive(JSON.stringify({
    status: "signed",
    public_key_hex: "bad",
    signature_hex: "b".repeat(128)
  }) + "\n");
  await assert.rejects(bridge.requestApproval(payment), /invalid_device_signature_frame/);
  await bridge.disconnect();
});

test("rejects serial frame overflow and port disconnection while waiting", async () => {
  const { bridge, port } = makeBridge();
  await bridge.connect();
  port.onWrite = () => port.receive("x".repeat(2049));
  await assert.rejects(bridge.requestApproval(payment), /serial_frame_too_large/);

  port.onWrite = () => {};
  const pending = bridge.requestApproval(payment);
  port.emit("close");
  await assert.rejects(pending, /serial_port_closed/);
  await bridge.disconnect();
});

test("validates serial configuration before creating a port", () => {
  assert.throws(() => createSerialBridge({ path: "" }), /serial_port_not_configured/);
  assert.throws(() => createSerialBridge({ path: "COM7", baudRate: 0 }), /invalid_serial_baud_rate/);
  assert.throws(() => createSerialBridge({ path: "COM7", timeoutMs: 10 }), /invalid_serial_timeout/);
});
