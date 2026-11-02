import { Account, JsonRpcProvider, KeyPair, teraToGas } from "near-api-js";
import { validatePaymentRequest } from "./payment-requests.js";
import { getPayment } from "./near-rpc.js";

export const CANONICAL_NETWORK = "testnet";
export const CANONICAL_CONTRACT_ID = "manextech.testnet";
export const CANONICAL_AGENT_ID = "manex-agent.testnet";
export const REQUEST_SPEND_METHODS = Object.freeze(["request_spend", "execute_approved_spend"]);
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
  const rpcUrl = env.NEAR_RPC_URL || "https://rpc.testnet.near.org";
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
export function validateAgentFunctionCallKey(accessKeyList, expectedPublicKey, contractId) {
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
      methodNames.length !== REQUEST_SPEND_METHODS.length ||
      methodNames.some((method, index) => method !== REQUEST_SPEND_METHODS[index])) {
    throw new SignerConfigurationError("agent signer key must be restricted to request_spend and execute_approved_spend only");
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

  const provider = new sdk.JsonRpcProvider({ url: config.rpcUrl });
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
      gas: sdk.teraToGas("30"),
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
