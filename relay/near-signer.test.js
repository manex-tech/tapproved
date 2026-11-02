import test from "node:test";
import assert from "node:assert/strict";
import {
  CANONICAL_AGENT_ID,
  CANONICAL_CONTRACT_ID,
  MAX_SIGNER_ALLOWANCE_YOCTO,
  SignerConfigurationError,
  createNearAgentSigner,
  readSignerConfiguration,
  validateAgentFunctionCallKey
} from "./near-signer.js";

const secret = "ed25519:unit-test-private-key";
const publicKey = "ed25519:unit-test-public-key";
const env = {
  NEAR_NETWORK: "testnet",
  NEAR_CONTRACT_ID: CANONICAL_CONTRACT_ID,
  NEAR_SIGNER_ACCOUNT_ID: CANONICAL_AGENT_ID,
  NEAR_RPC_URL: "https://rpc.testnet.near.org",
  NEAR_SIGNER_PRIVATE_KEY: secret
};

function accessKey(permission) {
  return {
    keys: [{
      public_key: publicKey,
      access_key: { nonce: 7, permission }
    }]
  };
}

const restrictedPermission = {
  FunctionCall: {
    receiver_id: CANONICAL_CONTRACT_ID,
    method_names: ["request_spend", "execute_approved_spend"],
    allowance: "1000000000000000000000000"
  }
};

test("signer configuration is locked to canonical testnet contract and agent", () => {
  assert.deepEqual(readSignerConfiguration(env), {
    networkId: "testnet",
    contractId: CANONICAL_CONTRACT_ID,
    agentId: CANONICAL_AGENT_ID,
    rpcUrl: "https://rpc.testnet.near.org",
    privateKey: secret
  });
  for (const override of [
    { NEAR_NETWORK: "mainnet" },
    { NEAR_CONTRACT_ID: "other.testnet" },
    { NEAR_SIGNER_ACCOUNT_ID: "other.testnet" },
    { NEAR_RPC_URL: "http://localhost:3030" },
    { NEAR_SIGNER_PRIVATE_KEY: "secp256k1:wrong-curve" },
    { NEAR_SIGNER_PRIVATE_KEY: undefined }
  ]) {
    assert.throws(
      () => readSignerConfiguration({ ...env, ...override }),
      SignerConfigurationError
    );
  }
});

test("accepts only the exact request_spend function-call key with finite allowance", () => {
  const result = validateAgentFunctionCallKey(
    accessKey(restrictedPermission),
    publicKey,
    CANONICAL_CONTRACT_ID
  );
  assert.deepEqual(result, {
    public_key: publicKey,
    receiver_id: CANONICAL_CONTRACT_ID,
    method_names: ["request_spend", "execute_approved_spend"],
    allowance_yocto: "1000000000000000000000000"
  });
});

test("rejects full-access, wrong receiver, unrestricted or over-scoped keys", () => {
  const invalidPermissions = [
    "FullAccess",
    { FunctionCall: { ...restrictedPermission.FunctionCall, receiver_id: "other.testnet" } },
    { FunctionCall: { ...restrictedPermission.FunctionCall, method_names: [] } },
    { FunctionCall: { ...restrictedPermission.FunctionCall, method_names: ["request_spend", "transfer"] } },
    { FunctionCall: { ...restrictedPermission.FunctionCall, allowance: null } },
    { FunctionCall: { ...restrictedPermission.FunctionCall, allowance: "0" } },
    { FunctionCall: { ...restrictedPermission.FunctionCall, allowance: (MAX_SIGNER_ALLOWANCE_YOCTO + 1n).toString() } }
  ];
  for (const permission of invalidPermissions) {
    assert.throws(
      () => validateAgentFunctionCallKey(accessKey(permission), publicKey, CANONICAL_CONTRACT_ID),
      SignerConfigurationError
    );
  }
});

test("rejects missing and duplicate signer public keys", () => {
  assert.throws(
    () => validateAgentFunctionCallKey({ keys: [] }, publicKey, CANONICAL_CONTRACT_ID),
    /not registered exactly once/
  );
  assert.throws(
    () => validateAgentFunctionCallKey({
      keys: [
        { public_key: publicKey, access_key: { permission: restrictedPermission } },
        { public_key: publicKey, access_key: { permission: restrictedPermission } }
      ]
    }, publicKey, CANONICAL_CONTRACT_ID),
    /not registered exactly once/
  );
});

test("creates a signer and calls only request_spend with zero deposit", async () => {
  let captured;
  let calls = 0;
  class MockProvider {
    constructor(config) { this.config = config; }
  }
  class MockAccount {
    constructor(accountId, provider, privateKey) {
      this.accountId = accountId;
      this.provider = provider;
      this.privateKey = privateKey;
    }
    async getAccessKeyList() {
      return accessKey(restrictedPermission);
    }
    async callFunctionRaw(args) {
      calls += 1;
      captured = args;
      const payment = {
        id: "42",
        agent_id: CANONICAL_AGENT_ID,
        recipient_id: "merchant.testnet",
        amount_yocto: "123456789",
        nonce: "42",
        expires_at_ns: "1793519712345678901",
        status: "pending",
        hardware_approved: false
      };
      return {
        status: {
          SuccessValue: Buffer.from(JSON.stringify(payment)).toString("base64")
        },
        transaction_outcome: { id: "finalized-transaction-hash" }
      };
    }
  }
  const signer = await createNearAgentSigner({
    env,
    sdk: {
      Account: MockAccount,
      JsonRpcProvider: MockProvider,
      KeyPair: {
        fromString(value) {
          assert.equal(value, secret);
          return { getPublicKey: () => ({ toString: () => publicKey }) };
        }
      },
      teraToGas(value) {
        assert.equal(value, "30");
        return 30_000_000_000_000n;
      }
    }
  });

  const result = await signer.requestSpend({
    recipient_id: "merchant.testnet",
    amount_yocto: "123456789"
  });

  assert.equal(calls, 1);
  assert.equal(captured.methodName, "request_spend");
  assert.deepEqual(captured.args, {
    recipient_id: "merchant.testnet",
    amount_yocto: "123456789"
  });
  assert.equal(captured.gas, 30_000_000_000_000n);
  assert.equal(captured.deposit, 0n);
  assert.equal(captured.waitUntil, "FINAL");
  assert.equal(result.transaction_hash, "finalized-transaction-hash");
  assert.equal(result.payment.id, "42");
  assert.equal(signer.signerAccountId, CANONICAL_AGENT_ID);
});

test("refuses to submit when the configured key is not least-privilege", async () => {
  let submitted = false;
  class MockProvider {}
  class MockAccount {
    async getAccessKeyList() {
      return accessKey("FullAccess");
    }
    async callFunctionRaw() {
      submitted = true;
      throw new Error("should not be called");
    }
  }
  await assert.rejects(createNearAgentSigner({
    env,
    sdk: {
      Account: MockAccount,
      JsonRpcProvider: MockProvider,
      KeyPair: { fromString: () => ({ getPublicKey: () => ({ toString: () => publicKey }) }) },
      teraToGas: () => 30_000_000_000_000n
    }
  }), SignerConfigurationError);
  assert.equal(submitted, false);
});


test("automatically executes an approved payment and reads its final contract state", async () => {
  const calls = [];
  class MockProvider {}
  class MockAccount {
    async getAccessKeyList() { return accessKey(restrictedPermission); }
    async callFunctionRaw(args) {
      calls.push(args);
      if (args.methodName === "request_spend") {
        const payment = {
          id: "43",
          agent_id: CANONICAL_AGENT_ID,
          recipient_id: "merchant.testnet",
          amount_yocto: "123456789",
          nonce: "43",
          expires_at_ns: "1793519712345678901",
          status: "approved",
          hardware_approved: false
        };
        return {
          status: { SuccessValue: Buffer.from(JSON.stringify(payment)).toString("base64") },
          transaction_outcome: { id: "request-transaction-hash" }
        };
      }
      assert.equal(args.methodName, "execute_approved_spend");
      assert.deepEqual(args.args, { payment_id: 43 });
      return { status: { SuccessValue: "" }, transaction_outcome: { id: "execution-transaction-hash" } };
    }
  }
  const signer = await createNearAgentSigner({
    env,
    sdk: {
      Account: MockAccount,
      JsonRpcProvider: MockProvider,
      KeyPair: { fromString: () => ({ getPublicKey: () => ({ toString: () => publicKey }) }) },
      teraToGas: () => 30_000_000_000_000n
    },
    getPayment: async (id, options) => {
      assert.equal(id, "43");
      assert.equal(options.env, env);
      return {
        id: "43",
        agent_id: CANONICAL_AGENT_ID,
        recipient_id: "merchant.testnet",
        amount_yocto: "123456789",
        nonce: "43",
        created_at_ns: "1793519412345678901",
        expires_at_ns: "1793519712345678901",
        status: "paid",
        hardware_approved: false
      };
    }
  });
  const result = await signer.requestSpend({
    recipient_id: "merchant.testnet",
    amount_yocto: "123456789"
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].methodName, "request_spend");
  assert.equal(calls[1].methodName, "execute_approved_spend");
  assert.equal(calls[1].deposit, 0n);
  assert.equal(result.transaction_hash, "request-transaction-hash");
  assert.equal(result.execution_transaction_hash, "execution-transaction-hash");
  assert.equal(result.payment.status, "paid");
});

test("does not execute payments that require physical approval", async () => {
  let calls = 0;
  class MockProvider {}
  class MockAccount {
    async getAccessKeyList() { return accessKey(restrictedPermission); }
    async callFunctionRaw() {
      calls += 1;
      const payment = {
        id: "44", agent_id: CANONICAL_AGENT_ID,
        recipient_id: "merchant.testnet", amount_yocto: "123456789",
        nonce: "44", expires_at_ns: "1793519712345678901",
        status: "pending", hardware_approved: false
      };
      return {
        status: { SuccessValue: Buffer.from(JSON.stringify(payment)).toString("base64") },
        transaction_outcome: { id: "pending-request-hash" }
      };
    }
  }
  const signer = await createNearAgentSigner({
    env,
    sdk: {
      Account: MockAccount,
      JsonRpcProvider: MockProvider,
      KeyPair: { fromString: () => ({ getPublicKey: () => ({ toString: () => publicKey }) }) },
      teraToGas: () => 30_000_000_000_000n
    }
  });
  const result = await signer.requestSpend({
    recipient_id: "merchant.testnet",
    amount_yocto: "123456789"
  });
  assert.equal(calls, 1);
  assert.equal(result.payment.status, "pending");
  assert.equal(result.execution_transaction_hash, null);
});
