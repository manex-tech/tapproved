import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign as signMessage } from "node:crypto";
import { encodeApprovalMessage } from "./protocol.js";
import {
  HardwareApprovalError,
  createHardwareApprovalService
} from "./hardware-approval.js";

const payment = {
  id: "42",
  agent_id: "manex-agent.testnet",
  recipient_id: "merchant.testnet",
  amount_yocto: "123456789",
  nonce: "42",
  created_at_ns: "1793519412345678901",
  expires_at_ns: "1793519712345678901",
  status: "pending",
  hardware_approved: false
};

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicKeyHex = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
const policy = {
  agent_id: "manex-agent.testnet",
  network_id: "testnet",
  device_public_key: Array.from(Buffer.from(publicKeyHex, "hex"))
};
const frame = {
  contract_id: "manextech.testnet",
  network_id: "testnet",
  payment_id: payment.id,
  recipient_id: payment.recipient_id,
  amount_yocto: payment.amount_yocto,
  nonce: payment.nonce,
  expires_at_ns: payment.expires_at_ns
};
const signatureHex = signMessage(null, encodeApprovalMessage(frame), privateKey).toString("hex");

function createService(overrides = {}) {
  const calls = { serial: 0, submit: 0 };
  const service = createHardwareApprovalService({
    env: { NEAR_CONTRACT_ID: "manextech.testnet" },
    serialBridge: {
      async requestApproval(received) {
        calls.serial += 1;
        assert.deepEqual(received, payment);
        return { public_key_hex: publicKeyHex, signature_hex: signatureHex };
      }
    },
    getActivePayment: async () => payment,
    getPolicy: async () => policy,
    approveSpend: async (id, signature) => {
      calls.submit += 1;
      assert.equal(id, payment.id);
      assert.equal(signature, signatureHex);
      return {
        transaction_hash: "approval-transaction-hash",
        payment: { ...payment, status: "processing", hardware_approved: true }
      };
    },
    ...overrides
  });
  return { service, calls };
}

test("verifies the registered device signature and submits approve_spend", async () => {
  const { service, calls } = createService();
  const result = await service.approvePayment(payment.id);
  assert.equal(calls.serial, 1);
  assert.equal(calls.submit, 1);
  assert.deepEqual(result, {
    outcome: "submitted",
    payment_id: payment.id,
    transaction_hash: "approval-transaction-hash",
    payment: { ...payment, status: "processing", hardware_approved: true }
  });
});

test("rejects missing, foreign or non-pending active payments before prompting the device", async () => {
  const missing = createService({ getActivePayment: async () => null });
  await assert.rejects(
    missing.service.approvePayment(payment.id),
    (error) => error instanceof HardwareApprovalError && error.status === 404
  );
  assert.equal(missing.calls.serial, 0);

  const foreign = createService({
    getActivePayment: async () => ({ ...payment, agent_id: "other.testnet" })
  });
  await assert.rejects(
    foreign.service.approvePayment(payment.id),
    (error) => error instanceof HardwareApprovalError && error.status === 404
  );
  assert.equal(foreign.calls.serial, 0);

  const resolved = createService({
    getActivePayment: async () => ({ ...payment, status: "processing", hardware_approved: true })
  });
  await assert.rejects(
    resolved.service.approvePayment(payment.id),
    (error) => error instanceof HardwareApprovalError && error.status === 409
  );
  assert.equal(resolved.calls.serial, 0);
});

test("rejects a device key mismatch and an invalid signature without contract submission", async () => {
  const wrongKey = createService({
    serialBridge: {
      async requestApproval() {
        return { public_key_hex: "11".repeat(32), signature_hex: signatureHex };
      }
    }
  });
  await assert.rejects(
    wrongKey.service.approvePayment(payment.id),
    (error) => error instanceof HardwareApprovalError && error.code === "unexpected_device_public_key"
  );
  assert.equal(wrongKey.calls.submit, 0);

  const invalidSignature = createService({
    serialBridge: {
      async requestApproval() {
        return { public_key_hex: publicKeyHex, signature_hex: "00".repeat(64) };
      }
    }
  });
  await assert.rejects(
    invalidSignature.service.approvePayment(payment.id),
    (error) => error instanceof HardwareApprovalError && error.code === "invalid_hardware_signature"
  );
  assert.equal(invalidSignature.calls.submit, 0);
});

test("rejects malformed contract device keys and invalid payment IDs", async () => {
  const malformedPolicy = createService({
    getPolicy: async () => ({ ...policy, device_public_key: [1, 2, 3] })
  });
  await assert.rejects(
    malformedPolicy.service.approvePayment(payment.id),
    (error) => error instanceof HardwareApprovalError && error.code === "invalid_contract_device_key"
  );
  assert.equal(malformedPolicy.calls.serial, 0);

  const { service } = createService();
  await assert.rejects(service.approvePayment("0"), /invalid_payment_id/);
  await assert.rejects(service.approvePayment("9007199254740992"), /invalid_payment_id/);
});

test("maps a disconnected serial bridge without attempting a contract call", async () => {
  const disconnected = createService({
    serialBridge: {
      async requestApproval() {
        const error = new Error("port is not connected");
        error.name = "SerialBridgeError";
        error.code = "serial_port_not_connected";
        throw error;
      }
    }
  });
  await assert.rejects(
    disconnected.service.approvePayment(payment.id),
    (error) => error instanceof HardwareApprovalError && error.status === 503
  );
  assert.equal(disconnected.calls.submit, 0);
});

test("keeps a broadcast-uncertain approval in an explicit unknown state without retry", async () => {
  let submissions = 0;
  const { service } = createService({
    approveSpend: async () => {
      submissions += 1;
      throw new Error("RPC response lost after broadcast");
    },
    getPayment: async () => payment
  });
  const first = await service.approvePayment(payment.id);
  assert.equal(first.outcome, "unknown");
  assert.equal(first.payment.status, "pending");
  assert.match(first.instruction, /Do not resubmit/);
  assert.equal(submissions, 1);
});
