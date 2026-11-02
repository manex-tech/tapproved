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
  const requestId = "123e4567-e89b-42d3-a456-426614174000";
  assert.deepEqual(buildDeviceApprovalFrame(payment, requestId), {
    frame_version: 1,
    request_id: requestId,
    contract_id: "manextech.testnet",
    network_id: "testnet",
    agent_id: "manex-agent.testnet",
    status: "pending",
    payment_id: "15",
    recipient_id: "merchant.testnet",
    amount_yocto: "1000000000000000000000",
    nonce: "15",
    expires_at_ns: "1793519712345678901"
  });
});

test("refuses non-pending, wrong-agent and malformed payment contexts", () => {
  assert.throws(() => buildDeviceApprovalFrame(payment), /invalid_request_id/);
  assert.throws(() => buildDeviceApprovalFrame(payment, "not-a-uuid"), /invalid_request_id/);
  assert.throws(() => buildDeviceApprovalFrame({ ...payment, status: "approved" }, "123e4567-e89b-42d3-a456-426614174000"), /payment_not_pending/);
  assert.throws(() => buildDeviceApprovalFrame({ ...payment, agent_id: "other.testnet" }, "123e4567-e89b-42d3-a456-426614174000"), /unexpected_agent/);
  assert.throws(() => buildDeviceApprovalFrame({ ...payment, amount_yocto: 1 }, "123e4567-e89b-42d3-a456-426614174000"), /amount_yocto/);
  assert.throws(() => buildDeviceApprovalFrame({ ...payment, expires_at_ns: "0" }, "123e4567-e89b-42d3-a456-426614174000"), /expires_at_ns/);
  assert.throws(() => buildDeviceApprovalFrame({ ...payment, recipient_id: "a" }, "123e4567-e89b-42d3-a456-426614174000"), /recipient_id/);
  assert.throws(() => buildDeviceApprovalFrame({ ...payment, id: "015" }, "123e4567-e89b-42d3-a456-426614174000"), /canonical decimal/);
  assert.throws(() => buildDeviceApprovalFrame({ ...payment, nonce: "01" }, "123e4567-e89b-42d3-a456-426614174000"), /canonical decimal/);
  assert.throws(() => buildDeviceApprovalFrame({ ...payment, amount_yocto: "0" }, "123e4567-e89b-42d3-a456-426614174000"), /greater than zero/);
  assert.throws(() => buildDeviceApprovalFrame({ ...payment, id: "18446744073709551616" }, "123e4567-e89b-42d3-a456-426614174000"), /integer range/);
  assert.throws(() => buildDeviceApprovalFrame({ ...payment, amount_yocto: "340282366920938463463374607431768211456" }, "123e4567-e89b-42d3-a456-426614174000"), /integer range/);
});

test("opens the configured serial port and handles fragmented signed JSON after text output", async () => {
  const { bridge, port } = makeBridge();
  await bridge.connect();
  assert.equal(bridge.connected, true);
  assert.deepEqual(port.config, { path: "COM7", baudRate: 115200, autoOpen: false });

  port.onWrite = () => {
    const request = JSON.parse(port.writes[0].toString("utf8"));
    const response = JSON.stringify({ ...signed, frame_version: 1, request_id: request.request_id }) + "\r\n";
    port.receive("ESP32 approval prompt\r\n" + response.slice(0, 37));
    port.receive(response.slice(37));
  };

  const result = await bridge.requestApproval(payment);
  assert.deepEqual(result, {
    public_key_hex: "a".repeat(64),
    signature_hex: "b".repeat(128)
  });
  const frame = JSON.parse(port.writes[0].toString("utf8"));
  assert.deepEqual(frame, buildDeviceApprovalFrame(payment, frame.request_id));
  assert.equal(frame.frame_version, 1);
  assert.match(frame.request_id, /^[0-9a-f-]{36}$/i);
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
  port.onWrite = (data) => {
    const request = JSON.parse(data.toString("utf8"));
    port.receive(JSON.stringify({ frame_version: 1, request_id: request.request_id, status: "rejected_or_timed_out" }) + "\n");
  };
  await assert.rejects(bridge.requestApproval(payment), /device_rejected_or_timed_out/);

  port.onWrite = (data) => {
    const request = JSON.parse(data.toString("utf8"));
    port.receive(JSON.stringify({
      frame_version: 1,
      request_id: request.request_id,
      status: "signed",
      public_key_hex: "bad",
      signature_hex: "b".repeat(128)
    }) + "\n");
  };
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

test("ignores a late response for a previous request while a new request is pending", async () => {
  const { bridge, port } = makeBridge();
  await bridge.connect();
  const firstPending = bridge.requestApproval(payment);
  const firstRequest = JSON.parse(port.writes[0].toString("utf8"));
  await bridge.disconnect();
  await assert.rejects(firstPending, /serial_port_disconnected/);

  await bridge.connect();
  const secondPending = bridge.requestApproval(payment);
  const secondRequest = JSON.parse(port.writes[1].toString("utf8"));
  assert.notEqual(firstRequest.request_id, secondRequest.request_id);

  port.receive(JSON.stringify({
    frame_version: 1,
    request_id: firstRequest.request_id,
    error: "late_device_error"
  }) + "\n");
  assert.equal(bridge.pending, true);
  port.receive(JSON.stringify({
    ...signed,
    frame_version: 1,
    request_id: firstRequest.request_id
  }) + "\n");
  assert.equal(bridge.pending, true);

  port.receive(JSON.stringify({
    ...signed,
    frame_version: 1,
    request_id: secondRequest.request_id
  }) + "\n");
  const result = await secondPending;
  assert.equal(result.signature_hex, signed.signature_hex);
  await bridge.disconnect();
});

test("rejects a correlated device error response and clears the pending request", async () => {
  const { bridge, port } = makeBridge();
  await bridge.connect();
  port.onWrite = (data) => {
    const request = JSON.parse(data.toString("utf8"));
    port.receive(JSON.stringify({
      frame_version: 1,
      request_id: request.request_id,
      error: "invalid_or_wrong_network_request"
    }) + "\n");
  };
  await assert.rejects(
    bridge.requestApproval(payment),
    (error) => error.code === "device_error" && error.message === "invalid_or_wrong_network_request"
  );
  assert.equal(bridge.pending, false);
  await bridge.disconnect();
});

test("approval timeout clears pending state and ignores the late timed-out response", async () => {
  const { bridge, port } = makeBridge({ timeoutMs: 1000 });
  await bridge.connect();
  const timedOut = bridge.requestApproval(payment);
  const expiredRequest = JSON.parse(port.writes[0].toString("utf8"));
  await assert.rejects(timedOut, (error) => error.code === "device_approval_timeout");
  assert.equal(bridge.pending, false);

  const next = bridge.requestApproval(payment);
  const nextRequest = JSON.parse(port.writes[1].toString("utf8"));
  port.receive(JSON.stringify({
    ...signed,
    frame_version: 1,
    request_id: expiredRequest.request_id
  }) + "\n");
  assert.equal(bridge.pending, true);
  port.receive(JSON.stringify({
    ...signed,
    frame_version: 1,
    request_id: nextRequest.request_id
  }) + "\n");
  const result = await next;
  assert.equal(result.signature_hex, signed.signature_hex);
  await bridge.disconnect();
});

test("discards an incomplete response frame across disconnect and reconnect", async () => {
  const { bridge, port } = makeBridge();
  await bridge.connect();

  const interrupted = bridge.requestApproval(payment);
  const firstRequest = JSON.parse(port.writes[0].toString("utf8"));
  port.receive(`{"frame_version":1,"request_id":"${firstRequest.request_id}"`);
  await bridge.disconnect();
  await assert.rejects(interrupted, /serial_port_disconnected/);

  await bridge.connect();
  const next = bridge.requestApproval(payment);
  const nextRequest = JSON.parse(port.writes[1].toString("utf8"));

  // This is the tail of the old, interrupted response. It must not be
  // concatenated with the new connection's input or complete a pending call.
  port.receive(`,"status":"signed","public_key_hex":"${signed.public_key_hex}","signature_hex":"${signed.signature_hex}"}\n`);
  assert.equal(bridge.pending, true);

  port.receive(JSON.stringify({
    ...signed,
    frame_version: 1,
    request_id: nextRequest.request_id
  }) + "\n");
  const result = await next;
  assert.equal(result.signature_hex, signed.signature_hex);
  await bridge.disconnect();
});
