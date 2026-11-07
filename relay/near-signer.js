import { Account, JsonRpcProvider, KeyPair, teraToGas } from "near-api-js";
import { validatePaymentRequest } from "./payment-requests.js";
import { getPayment, getPolicy } from "./near-rpc.js";
import { verifyApprovalSignature } from "./protocol.js";

export const CANONICAL_NETWORK = "testnet";
export const CANONICAL_CONTRACT_ID = "manextech.testnet";
export const CANONICAL_AGENT_ID = "manex-agent.testnet";
export const REQUEST_SPEND_METHODS = Object.freeze(["request_spend", "execute_approved_spend"]);
export const APPROVE_SPEND_METHODS = Object.freeze(["approve_spend"]);
export const EXPIRE_PAYMENT_METHODS = Object.freeze(["expire_payment"]);
export const MAX_SIGNER_ALLOWANCE_YOCTO = 5n * 10n ** 24n;

export class SignerConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = "SignerConfigurationError";
    this.code = "signer_configuration_error";
  }
}

export function readSignerConfiguration(env = process.env) {
  const networkId = env.NEAR_NETWORK || CANONICAL_NETWORK;
  const contractId = env.NEAR_CONTRACT_ID || CANONICAL_CONTRACT_ID;
  const agentId = env.NEAR_SIGNER_ACCOUNT_ID || CANONICAL_AGENT_ID;
  const rpcUrl = env.NEAR_RPC_URL || "https://test.rpc.fastnear.com";
  const privateKey = env.NEAR_SIGNER_PRIVATE_KEY;

  if (networkId !== CANONICAL_NETWORK) {
    throw new SignerConfigurationError("NEAR_NETWORK must be testnet");
  }
  if (contractId !== CANONICAL_CONTRACT_ID) {
    throw new SignerConfigurationError("NEAR_CONTRACT_ID must be manextech.testnet");
  }
  if (agentId !== CANONICAL_AGENT_ID) {
    throw new SignerConfigurationError("NEAR_SIGNER_ACCOUNT_ID must be manex-agent.testnet");
  }
  if (typeof rpcUrl !== "string" || !rpcUrl.startsWith("https://")) {
    throw new SignerConfigurationError("NEAR_RPC_URL must use HTTPS");
  }
  if (typeof privateKey !== "string" || !privateKey.startsWith("ed25519:")) {
    throw new SignerConfigurationError("NEAR_SIGNER_PRIVATE_KEY must be an Ed25519 secret key");
  }
  return { networkId, contractId, agentId, rpcUrl, privateKey };
}

/**
 * Enforce least privilege for the relay's agent key. A full-access key, an
 * unrestricted function-call key, an over-scoped method list, an unlimited
 * allowance, or a key for another receiver is rejected.
 */
export function validateAgentFunctionCallKey(
  accessKeyList,
  expectedPublicKey,
  contractId,
  allowedMethods = REQUEST_SPEND_METHODS
) {
  if (!Array.isArray(accessKeyList?.keys)) {
    throw new SignerConfigurationError("agent access-key list response is invalid");
  }
  const matches = accessKeyList.keys.filter((entry) => entry?.public_key === expectedPublicKey);
  if (matches.length !== 1) {
    throw new SignerConfigurationError("configured signer key is not registered exactly once on the agent account");
  }
  const permission = matches[0]?.access_key?.permission;
  const functionCall = permission && typeof permission === "object" ? permission.FunctionCall : null;
  if (!functionCall) {
    throw new SignerConfigurationError("agent signer key must be a FunctionCall access key, never FullAccess");
  }
  if (functionCall.receiver_id !== contractId) {
    throw new SignerConfigurationError("agent signer key is scoped to a different contract");
  }
  const methodNames = functionCall.method_names;
  if (!Array.isArray(methodNames) ||
      methodNames.length !== allowedMethods.length ||
      methodNames.some((method, index) => method !== allowedMethods[index])) {
    throw new SignerConfigurationError(`agent signer key must be restricted to ${allowedMethods.join(" and ")} only`);
  }
  if (functionCall.allowance === null || functionCall.allowance === undefined) {
    throw new SignerConfigurationError("agent signer key must have a finite gas allowance");
  }
  let allowance;
  try {
    allowance = BigInt(functionCall.allowance);
  } catch {
    throw new SignerConfigurationError("agent signer key allowance is invalid");
  }
  if (allowance <= 0n || allowance > MAX_SIGNER_ALLOWANCE_YOCTO) {
    throw new SignerConfigurationError("agent signer key allowance must be positive and no greater than 5 NEAR");
  }
  return {
    public_key: expectedPublicKey,
    receiver_id: contractId,
    method_names: [...methodNames],
    allowance_yocto: allowance.toString()
  };
}

export function createResilientProvider(sdk, url) {
  const provider = new sdk.JsonRpcProvider({ url });
  if (typeof provider?.sendJsonRpc === "function") {
    const originalSend = provider.sendJsonRpc.bind(provider);
    provider.sendJsonRpc = async (method, params) => {
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          return await originalSend(method, params);
        } catch (err) {
          const isRateLimit = err?.cause === 429 ||
            (typeof err?.message === "string" && (err.message.includes("429") || err.message.includes("Rate limits exceeded")));
          if (isRateLimit && attempt < 4) {
            await new Promise((r) => setTimeout(r, 350 * (attempt + 1)));
            continue;
          }
          throw err;
        }
      }
    };
  }
  return provider;
}

function decodePaymentView(rawOutcome, expected) {
  const successValue = rawOutcome?.status?.SuccessValue;
  if (typeof successValue !== "string") {
    throw new Error("NEAR request_spend did not return a final SuccessValue");
  }

  let payment;
  try {
    payment = JSON.parse(Buffer.from(successValue, "base64").toString("utf8"));
  } catch {
    throw new Error("NEAR request_spend returned an invalid PaymentView");
  }

  if (!payment || typeof payment !== "object" ||
      payment.agent_id !== CANONICAL_AGENT_ID ||
      payment.recipient_id !== expected.recipient_id ||
      payment.amount_yocto !== expected.amount_yocto ||
      typeof payment.id !== "string" ||
      typeof payment.nonce !== "string" ||
      typeof payment.expires_at_ns !== "string" ||
      !["approved", "pending"].includes(payment.status)) {
    throw new Error("NEAR request_spend returned a PaymentView inconsistent with the submitted request");
  }

  const transactionHash = rawOutcome?.transaction_outcome?.id ??
    rawOutcome?.transaction?.hash;
  if (typeof transactionHash !== "string" || transactionHash.length === 0) {
    throw new Error("NEAR request_spend response did not include a transaction hash");
  }

  return { transaction_hash: transactionHash, payment };
}

export async function createNearAgentSigner(options = {}) {
  const env = options.env ?? process.env;
  const sdk = options.sdk ?? { Account, JsonRpcProvider, KeyPair, teraToGas };
  const config = readSignerConfiguration(env);

  let keyPair;
  try {
    keyPair = sdk.KeyPair.fromString(config.privateKey);
  } catch {
    throw new SignerConfigurationError("NEAR_SIGNER_PRIVATE_KEY could not be parsed");
  }

  const provider = createResilientProvider(sdk, config.rpcUrl);
  const account = new sdk.Account(config.agentId, provider, config.privateKey);

  let accessKeyList;
  try {
    accessKeyList = await account.getAccessKeyList();
  } catch {
    throw new SignerConfigurationError("could not verify agent signer access-key permissions");
  }
  const publicKey = keyPair.getPublicKey().toString();
  const verifiedKey = validateAgentFunctionCallKey(accessKeyList, publicKey, config.contractId);

  async function requestSpend(input) {
    const payment = validatePaymentRequest(input);
    const requestOutcome = await account.callFunctionRaw({
      contractId: config.contractId,
      methodName: "request_spend",
      args: {
        recipient_id: payment.recipient_id,
        amount_yocto: payment.amount_yocto
      },
      gas: sdk.teraToGas("30"),
      deposit: 0n,
      waitUntil: "FINAL"
    });
    const requested = decodePaymentView(requestOutcome, payment);
    if (requested.payment.status !== "approved") {
      return { ...requested, execution_transaction_hash: null };
    }

    const paymentId = BigInt(requested.payment.id);
    if (paymentId > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("payment ID exceeds the safe JSON integer range for execute_approved_spend");
    }
    const executionOutcome = await account.callFunctionRaw({
      contractId: config.contractId,
      methodName: "execute_approved_spend",
      args: { payment_id: Number(paymentId) },
      gas: sdk.teraToGas("50"),
      deposit: 0n,
      waitUntil: "FINAL"
    });
    const executionHash = executionOutcome?.transaction_outcome?.id ??
      executionOutcome?.transaction?.hash;
    if (typeof executionHash !== "string" || executionHash.length === 0) {
      throw new Error("NEAR execute_approved_spend did not return a transaction hash");
    }

    const settledPayment = await (options.getPayment ?? getPayment)(
      requested.payment.id,
      { env, fetchImpl: options.fetchImpl }
    );
    if (!settledPayment || settledPayment.id !== requested.payment.id ||
        settledPayment.recipient_id !== payment.recipient_id ||
        settledPayment.amount_yocto !== payment.amount_yocto) {
      throw new Error("NEAR get_payment returned a PaymentView inconsistent with the submitted request");
    }
    return {
      transaction_hash: requested.transaction_hash,
      execution_transaction_hash: executionHash,
      payment: settledPayment
    };
  }

  return Object.freeze({
    requestSpend,
    signerAccountId: config.agentId,
    contractId: config.contractId,
    networkId: config.networkId,
    publicKey: verifiedKey.public_key,
    permission: verifiedKey
  });
}


export class HardwareApprovalError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "HardwareApprovalError";
    this.code = code;
  }
}

/**
 * A separate FunctionCall key is used for hardware approvals. It can call
 * approve_spend only; it cannot create requests or execute auto-approved ones.
 */
export async function createNearApprovalSigner(options = {}) {
  const env = options.env ?? process.env;
  const approvalPrivateKey = env.NEAR_APPROVAL_SIGNER_PRIVATE_KEY;
  if (typeof approvalPrivateKey !== "string" || !approvalPrivateKey.startsWith("ed25519:")) {
    throw new SignerConfigurationError("NEAR_APPROVAL_SIGNER_PRIVATE_KEY must be an Ed25519 secret key");
  }
  const approvalEnv = { ...env, NEAR_SIGNER_PRIVATE_KEY: approvalPrivateKey };
  const config = readSignerConfiguration(approvalEnv);
  const sdk = options.sdk ?? { Account, JsonRpcProvider, KeyPair, teraToGas };

  let keyPair;
  try {
    keyPair = sdk.KeyPair.fromString(config.privateKey);
  } catch {
    throw new SignerConfigurationError("NEAR_APPROVAL_SIGNER_PRIVATE_KEY could not be parsed");
  }

  const provider = createResilientProvider(sdk, config.rpcUrl);
  const account = new sdk.Account(config.agentId, provider, config.privateKey);

  let accessKeyList;
  try {
    accessKeyList = await account.getAccessKeyList();
  } catch {
    throw new SignerConfigurationError("could not verify hardware-approval signer access-key permissions");
  }
  const publicKey = keyPair.getPublicKey().toString();
  const verifiedKey = validateAgentFunctionCallKey(
    accessKeyList,
    publicKey,
    config.contractId,
    APPROVE_SPEND_METHODS
  );

  async function approveSpend(payment, signedResponse) {
    if (!payment || typeof payment !== "object" || Array.isArray(payment) ||
        payment.status !== "pending" || payment.agent_id !== CANONICAL_AGENT_ID) {
      throw new HardwareApprovalError("payment_not_pending", "only the canonical agent's pending payment can be approved");
    }
    if (typeof payment.id !== "string" || !/^[0-9]+$/.test(payment.id) ||
        BigInt(payment.id) > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new HardwareApprovalError("invalid_payment_id");
    }
    if (typeof payment.recipient_id !== "string" ||
        typeof payment.amount_yocto !== "string" || !/^[0-9]+$/.test(payment.amount_yocto) ||
        typeof payment.nonce !== "string" || !/^[0-9]+$/.test(payment.nonce) ||
        typeof payment.expires_at_ns !== "string" || !/^[0-9]+$/.test(payment.expires_at_ns)) {
      throw new HardwareApprovalError("invalid_payment_context");
    }
    if (!signedResponse || typeof signedResponse !== "object") {
      throw new HardwareApprovalError("invalid_device_signature");
    }

    let policy;
    try {
      policy = await (options.getPolicy ?? getPolicy)({ env, fetchImpl: options.fetchImpl });
    } catch {
      throw new HardwareApprovalError("policy_read_failed");
    }
    const deviceKey = policy?.device_public_key;
    if (policy?.agent_id !== CANONICAL_AGENT_ID || policy?.network_id !== CANONICAL_NETWORK ||
        !Array.isArray(deviceKey) || deviceKey.length !== 32 ||
        deviceKey.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
      throw new HardwareApprovalError("invalid_contract_device_policy");
    }

    const expectedDeviceKeyHex = Buffer.from(deviceKey).toString("hex");
    if (typeof signedResponse.public_key_hex !== "string" ||
        signedResponse.public_key_hex.toLowerCase() !== expectedDeviceKeyHex) {
      throw new HardwareApprovalError("unregistered_device_key");
    }

    const signedMessage = {
      contract_id: config.contractId,
      network_id: config.networkId,
      payment_id: payment.id,
      recipient_id: payment.recipient_id,
      amount_yocto: payment.amount_yocto,
      nonce: payment.nonce,
      expires_at_ns: payment.expires_at_ns
    };
    let validSignature = false;
    try {
      validSignature = verifyApprovalSignature(
        signedMessage,
        signedResponse.public_key_hex,
        signedResponse.signature_hex
      );
    } catch {
      throw new HardwareApprovalError("invalid_device_signature");
    }
    if (!validSignature) {
      throw new HardwareApprovalError("invalid_device_signature");
    }

    let currentPayment;
    try {
      currentPayment = await (options.getPayment ?? getPayment)(
        payment.id,
        { env, fetchImpl: options.fetchImpl }
      );
    } catch {
      throw new HardwareApprovalError("payment_state_read_failed");
    }
    if (!currentPayment || currentPayment.id !== payment.id ||
        currentPayment.agent_id !== CANONICAL_AGENT_ID ||
        currentPayment.status !== "pending" ||
        currentPayment.recipient_id !== payment.recipient_id ||
        currentPayment.amount_yocto !== payment.amount_yocto ||
        currentPayment.nonce !== payment.nonce ||
        currentPayment.expires_at_ns !== payment.expires_at_ns) {
      throw new HardwareApprovalError("payment_no_longer_pending");
    }

    const signatureBytes = [...Buffer.from(signedResponse.signature_hex, "hex")];
    const outcome = await account.callFunctionRaw({
      contractId: config.contractId,
      methodName: "approve_spend",
      args: {
        payment_id: Number(BigInt(payment.id)),
        signature: signatureBytes
      },
      gas: sdk.teraToGas("50"),
      deposit: 0n,
      waitUntil: "FINAL"
    });
    const transactionHash = outcome?.transaction_outcome?.id ?? outcome?.transaction?.hash;
    if (typeof transactionHash !== "string" || transactionHash.length === 0) {
      throw new HardwareApprovalError("approval_transaction_hash_missing");
    }

    let updatedPayment = null;
    try {
      updatedPayment = await (options.getPayment ?? getPayment)(
        payment.id,
        { env, fetchImpl: options.fetchImpl }
      );
    } catch {
      // The transaction is final, but status observation belongs to C9.
    }
    if (updatedPayment && (
      updatedPayment.id !== payment.id ||
      updatedPayment.agent_id !== CANONICAL_AGENT_ID ||
      !["processing", "paid", "failed"].includes(updatedPayment.status)
    )) {
      throw new HardwareApprovalError("approval_state_not_confirmed");
    }

    return {
      transaction_hash: transactionHash,
      payment: updatedPayment
    };
  }

  return Object.freeze({
    approveSpend,
    signerAccountId: config.agentId,
    contractId: config.contractId,
    networkId: config.networkId,
    publicKey: verifiedKey.public_key,
    permission: verifiedKey
  });
}


/**
 * A third, isolated FunctionCall key lets the relay invoke only the
 * contract's permissionless expiry method. It cannot request, approve,
 * execute or transfer a payment.
 */
export async function createNearExpirySigner(options = {}) {
  const env = options.env ?? process.env;
  const expiryPrivateKey = env.NEAR_EXPIRY_SIGNER_PRIVATE_KEY;
  if (typeof expiryPrivateKey !== "string" || !expiryPrivateKey.startsWith("ed25519:")) {
    throw new SignerConfigurationError("NEAR_EXPIRY_SIGNER_PRIVATE_KEY must be an Ed25519 secret key");
  }
  const expiryEnv = { ...env, NEAR_SIGNER_PRIVATE_KEY: expiryPrivateKey };
  const config = readSignerConfiguration(expiryEnv);
  const sdk = options.sdk ?? { Account, JsonRpcProvider, KeyPair, teraToGas };

  let keyPair;
  try {
    keyPair = sdk.KeyPair.fromString(config.privateKey);
  } catch {
    throw new SignerConfigurationError("NEAR_EXPIRY_SIGNER_PRIVATE_KEY could not be parsed");
  }

  const provider = createResilientProvider(sdk, config.rpcUrl);
  const account = new sdk.Account(config.agentId, provider, config.privateKey);
  let accessKeyList;
  try {
    accessKeyList = await account.getAccessKeyList();
  } catch {
    throw new SignerConfigurationError("could not verify payment-expiry signer access-key permissions");
  }
  const publicKey = keyPair.getPublicKey().toString();
  const verifiedKey = validateAgentFunctionCallKey(
    accessKeyList,
    publicKey,
    config.contractId,
    EXPIRE_PAYMENT_METHODS
  );

  async function expirePayment(paymentId) {
    if (typeof paymentId !== "string" || !/^[0-9]+$/.test(paymentId) ||
        BigInt(paymentId) > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new TypeError("payment ID must be a safe decimal string");
    }
    const outcome = await account.callFunctionRaw({
      contractId: config.contractId,
      methodName: "expire_payment",
      args: { payment_id: Number(BigInt(paymentId)) },
      gas: sdk.teraToGas("30"),
      deposit: 0n,
      waitUntil: "FINAL"
    });
    const transactionHash = outcome?.transaction_outcome?.id ?? outcome?.transaction?.hash;
    if (typeof transactionHash !== "string" || transactionHash.length === 0) {
      throw new Error("NEAR expire_payment did not return a transaction hash");
    }
    return { transaction_hash: transactionHash, payment_id: paymentId };
  }

  return Object.freeze({
    expirePayment,
    signerAccountId: config.agentId,
    contractId: config.contractId,
    networkId: config.networkId,
    publicKey: verifiedKey.public_key,
    permission: verifiedKey
  });
}
