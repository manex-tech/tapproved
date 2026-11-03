const DEFAULT_RPC_URL = "https://rpc.testnet.near.org";
const DEFAULT_CONTRACT_ID = "manextech.testnet";
const DEFAULT_NETWORK_ID = "testnet";
const DEFAULT_SIGNER_ACCOUNT_ID = "manex-agent.testnet";
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const TRANSACTION_WAIT_UNTIL = new Set(["NONE", "INCLUDED", "EXECUTED_OPTIMISTIC", "INCLUDED_FINAL", "EXECUTED", "FINAL"]);
const TAPPROVED_METHODS = new Set(["request_spend", "execute_approved_spend", "approve_spend", "expire_payment"]);

async function fetchReadOnlyRpc(fetchImpl, rpcUrl, payload, requestId) {
  let response;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    response = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: requestId, ...payload }),
      signal: AbortSignal.timeout(10000)
    });
    if (response.status !== 429 || attempt === 3) return response;

    const retryAfter = Number(response.headers?.get?.("retry-after"));
    const delayMs = Number.isFinite(retryAfter) && retryAfter >= 0
      ? Math.min(retryAfter * 1000, 15000)
      : Math.min(1000 * (2 ** attempt), 8000);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return response;
}

/**
 * Preserve unsafe JSON integer tokens before JSON.parse rounds them to an
 * IEEE-754 Number. NEAR views may expose legacy u64 fields as raw JSON
 * numbers; converting those tokens to decimal strings keeps timestamps exact.
 */
function parseJsonPreservingLargeIntegers(source) {
  let output = "";
  let index = 0;
  let inString = false;
  let escaped = false;

  while (index < source.length) {
    const character = source[index];

    if (inString) {
      output += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      index += 1;
      continue;
    }

    if (character === '"') {
      inString = true;
      output += character;
      index += 1;
      continue;
    }

    if (character === "-" || (character >= "0" && character <= "9")) {
      const start = index;
      if (source[index] === "-") index += 1;
      while (index < source.length && source[index] >= "0" && source[index] <= "9") {
        index += 1;
      }
      if (source[index] === ".") {
        index += 1;
        while (index < source.length && source[index] >= "0" && source[index] <= "9") {
          index += 1;
        }
      }
      if (source[index] === "e" || source[index] === "E") {
        index += 1;
        if (source[index] === "+" || source[index] === "-") index += 1;
        while (index < source.length && source[index] >= "0" && source[index] <= "9") {
          index += 1;
        }
      }

      const token = source.slice(start, index);
      if (/^-?[0-9]+$/.test(token)) {
        const integer = BigInt(token);
        const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
        const minSafe = BigInt(Number.MIN_SAFE_INTEGER);
        output += integer > maxSafe || integer < minSafe ? JSON.stringify(token) : token;
      } else {
        output += token;
      }
      continue;
    }

    output += character;
    index += 1;
  }

  return JSON.parse(output);
}

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

/**
 * Read a single finalized block header so every preflight query can be pinned
 * to the same immutable state snapshot.
 */
export async function getFinalizedBlock(options = {}) {
  const { rpcUrl } = configuration(options.env);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
  const response = await fetchReadOnlyRpc(fetchImpl, rpcUrl, {
    method: "block",
    params: { finality: "final" }
  }, "tapproved-finalized-block");
  if (!response.ok) throw new Error(`NEAR RPC HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.error) {
    throw new Error(`NEAR RPC error: ${payload.error.message || "unknown error"}`);
  }
  const header = payload.result?.header;
  if (!header || !Number.isSafeInteger(header.height) ||
      typeof header.hash !== "string" || header.hash.length < 32 ||
      typeof header.timestamp_nanosec !== "string" ||
      !/^[0-9]+$/.test(header.timestamp_nanosec)) {
    throw new Error("NEAR RPC returned an invalid finalized block header");
  }
  return {
    height: header.height,
    hash: header.hash,
    timestamp_nanosec: header.timestamp_nanosec
  };
}

/** Read account balance, deployed code hash and storage at a fixed block. */
export async function getAccountView(options = {}) {
  const { rpcUrl, contractId } = configuration(options.env);
  if (options.blockId !== undefined &&
      !(typeof options.blockId === "string" && options.blockId.length > 0)) {
    throw new TypeError("blockId must be a non-empty block hash");
  }
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
  const params = {
    request_type: "view_account",
    account_id: contractId,
    ...(options.blockId ? { block_id: options.blockId } : { finality: "final" })
  };
  const response = await fetchReadOnlyRpc(fetchImpl, rpcUrl, {
    method: "query",
    params
  }, "tapproved-account-preflight");
  if (!response.ok) throw new Error(`NEAR RPC HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.error) {
    throw new Error(`NEAR RPC error: ${payload.error.message || "unknown error"}`);
  }
  const result = payload.result;
  if (!result || typeof result !== "object" ||
      typeof result.amount !== "string" || !/^[0-9]+$/.test(result.amount) ||
      typeof result.locked !== "string" || !/^[0-9]+$/.test(result.locked) ||
      typeof result.code_hash !== "string" ||
      !Number.isSafeInteger(result.storage_usage) || result.storage_usage < 0) {
    throw new Error("NEAR RPC returned an invalid account view");
  }
  return result;
}

export async function callViewMethod(methodName, args = {}, options = {}) {
  if (!/^[a-z][a-z0-9_]*$/.test(methodName)) throw new TypeError("invalid view method name");
  const { rpcUrl, contractId } = configuration(options.env);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
  const argsBase64 = Buffer.from(JSON.stringify(args), "utf8").toString("base64");
  const response = await fetchReadOnlyRpc(fetchImpl, rpcUrl, {
    method: "query",
    params: {
      request_type: "call_function",
      ...(options.blockId ? { block_id: options.blockId } : { finality: "final" }),
      account_id: contractId,
      method_name: methodName,
      args_base64: argsBase64
    }
  }, "tapproved-relay");
  if (!response.ok) throw new Error(`NEAR RPC HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.error) throw new Error(`NEAR RPC error: ${payload.error.message || "unknown error"}`);
  if (!Array.isArray(payload.result?.result)) throw new Error("NEAR RPC returned an invalid call_function result");
  return parseJsonPreservingLargeIntegers(Buffer.from(payload.result.result).toString("utf8"));
}

export async function getPolicy(options) {
  return callViewMethod("get_policy", {}, options);
}

export async function getActivePayment(options) {
  return callViewMethod("get_active_payment", {}, options);
}

export async function getDailyUsage(utcDay, options = {}) {
  if ((typeof utcDay !== "number" && typeof utcDay !== "string") ||
      !/^[0-9]+$/.test(String(utcDay))) {
    throw new TypeError("UTC day must be a non-negative integer");
  }
  const day = BigInt(utcDay);
  if (day > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("UTC day exceeds the safe JSON integer range");
  }
  return callViewMethod("get_daily_usage", { utc_day: Number(day) }, options);
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
  const block = await getFinalizedBlock(options);
  return block.timestamp_nanosec;
}
