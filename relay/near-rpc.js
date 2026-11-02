const DEFAULT_RPC_URL = "https://rpc.testnet.near.org";
const DEFAULT_CONTRACT_ID = "manextech.testnet";
const DEFAULT_NETWORK_ID = "testnet";
const DEFAULT_SIGNER_ACCOUNT_ID = "manex-agent.testnet";
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const TRANSACTION_WAIT_UNTIL = new Set(["NONE", "INCLUDED", "EXECUTED_OPTIMISTIC", "INCLUDED_FINAL", "EXECUTED", "FINAL"]);
const TAPPROVED_METHODS = new Set(["request_spend", "execute_approved_spend", "approve_spend", "expire_payment"]);

function configuration(env = process.env) {
  const networkId = env.NEAR_NETWORK || DEFAULT_NETWORK_ID;
  const rpcUrl = env.NEAR_RPC_URL || DEFAULT_RPC_URL;
  const contractId = env.NEAR_CONTRACT_ID || DEFAULT_CONTRACT_ID;
  const signerAccountId = env.NEAR_SIGNER_ACCOUNT_ID || DEFAULT_SIGNER_ACCOUNT_ID;
  if (networkId !== DEFAULT_NETWORK_ID) throw new Error("NEAR_NETWORK must be testnet");
  if (contractId !== DEFAULT_CONTRACT_ID) throw new Error("NEAR_CONTRACT_ID must be manextech.testnet");
  if (signerAccountId !== DEFAULT_SIGNER_ACCOUNT_ID) {
    throw new Error("NEAR_SIGNER_ACCOUNT_ID must be manex-agent.testnet");
  }
  if (typeof rpcUrl !== "string" || !rpcUrl.startsWith("https://")) throw new Error("NEAR_RPC_URL must use HTTPS");
  return { networkId, rpcUrl, contractId, signerAccountId };
}

export async function callViewMethod(methodName, args = {}, options = {}) {
  if (!/^[a-z][a-z0-9_]*$/.test(methodName)) throw new TypeError("invalid view method name");
  const { rpcUrl, contractId } = configuration(options.env);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
  const argsBase64 = Buffer.from(JSON.stringify(args), "utf8").toString("base64");
  const response = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "tapproved-relay",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: contractId,
        method_name: methodName,
        args_base64: argsBase64
      }
    }),
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error(`NEAR RPC HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.error) throw new Error(`NEAR RPC error: ${payload.error.message || "unknown error"}`);
  if (!Array.isArray(payload.result?.result)) throw new Error("NEAR RPC returned an invalid call_function result");
  return JSON.parse(Buffer.from(payload.result.result).toString("utf8"));
}

export async function getPolicy(options) {
  return callViewMethod("get_policy", {}, options);
}

export async function getActivePayment(options) {
  return callViewMethod("get_active_payment", {}, options);
}

export async function getPayment(paymentId, options) {
  if (typeof paymentId !== "string" || !/^[0-9]+$/.test(paymentId)) {
    throw new TypeError("payment ID must be a decimal string");
  }
  const numericId = BigInt(paymentId);
  if (numericId > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("payment ID exceeds the safe JSON integer range");
  }
  return callViewMethod("get_payment", { payment_id: Number(numericId) }, options);
}


export class TransactionQueryValidationError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = "TransactionQueryValidationError";
    this.code = code;
  }
}

export class TransactionNotFoundError extends Error {
  constructor() {
    super("NEAR transaction was not found for the canonical signer");
    this.name = "TransactionNotFoundError";
    this.code = "transaction_not_found";
  }
}

export class TransactionWaitTimeoutError extends Error {
  constructor() {
    super("NEAR transaction has not reached the requested execution milestone");
    this.name = "TransactionWaitTimeoutError";
    this.code = "transaction_wait_timeout";
  }
}

function isTransactionHash(value) {
  if (typeof value !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(value)) return false;
  let decoded = 0n;
  for (const character of value) {
    const digit = BASE58_ALPHABET.indexOf(character);
    if (digit < 0) return false;
    decoded = decoded * 58n + BigInt(digit);
  }
  let decodedBytes = 0;
  while (decoded > 0n) {
    decoded >>= 8n;
    decodedBytes += 1;
  }
  const leadingZeroBytes = value.match(/^1*/)?.[0].length ?? 0;
  return decodedBytes + leadingZeroBytes === 32;
}

export function isValidTransactionHash(value) {
  return isTransactionHash(value);
}

export async function getTransactionStatus(transactionHash, options = {}) {
  if (!isTransactionHash(transactionHash)) {
    throw new TransactionQueryValidationError("invalid_transaction_hash", "transaction hash must be a base58-encoded 32-byte hash");
  }
  const waitUntil = options.waitUntil ?? "NONE";
  if (!TRANSACTION_WAIT_UNTIL.has(waitUntil)) {
    throw new TransactionQueryValidationError("invalid_wait_until", "invalid NEAR transaction wait_until value");
  }

  const { rpcUrl, signerAccountId, contractId } = configuration(options.env);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
  const response = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "tapproved-transaction-status",
      method: "tx",
      params: {
        tx_hash: transactionHash,
        sender_account_id: signerAccountId,
        wait_until: waitUntil
      }
    }),
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error(`NEAR RPC HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.error) {
    const message = String(payload.error.message ?? "unknown NEAR RPC error");
    const causeName = String(payload.error.cause?.name ?? payload.error.name ?? "");
    const errorDetails = `${causeName} ${message}`;
    if (/UNKNOWN_TRANSACTION|unknown transaction|transaction.*(not found|does not exist|doesn't exist)|not found.*transaction/i.test(errorDetails)) {
      throw new TransactionNotFoundError();
    }
    if (/TIMEOUT_ERROR|timed out|timeout/i.test(errorDetails)) {
      throw new TransactionWaitTimeoutError();
    }
    throw new Error(`NEAR RPC error: ${message}`);
  }
  const result = payload.result;
  const methods = Array.isArray(result?.transaction?.actions)
    ? result.transaction.actions.flatMap((action) => action?.FunctionCall?.method_name ? [action.FunctionCall.method_name] : [])
    : [];
  if (!result || typeof result !== "object" ||
      result.transaction?.hash !== transactionHash ||
      result.transaction?.signer_id !== signerAccountId ||
      result.transaction?.receiver_id !== contractId ||
      !Array.isArray(result.transaction?.actions) || result.transaction.actions.length !== 1 ||
      methods.length !== 1 || !TAPPROVED_METHODS.has(methods[0]) ||
      !result.status) {
    throw new Error("NEAR RPC returned an invalid transaction status");
  }
  return result;
}

export { DEFAULT_RPC_URL, DEFAULT_CONTRACT_ID };

 
/**
 * Read the timestamp of the latest finalized NEAR block. Expiry decisions
 * must use chain time rather than the relay host clock.
 */
export async function getLatestBlockTimestampNs(options = {}) {
  const { rpcUrl } = configuration(options.env);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
  const response = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "tapproved-finalized-block-time",
      method: "block",
      params: { finality: "final" }
    }),
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error(`NEAR RPC HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.error) {
    throw new Error(`NEAR RPC error: ${payload.error.message || "unknown error"}`);
  }
  const timestamp = payload.result?.header?.timestamp_nanosec;
  if (typeof timestamp !== "string" || !/^[0-9]+$/.test(timestamp)) {
    throw new Error("NEAR RPC returned an invalid finalized block timestamp");
  }
  return timestamp;
}
