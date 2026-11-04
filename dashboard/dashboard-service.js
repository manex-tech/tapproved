/**
 * Pure formatting and RPC decoding utilities for the Tapproved Dashboard.
 */

export const DEFAULT_CONTRACT_ID = "manextech.testnet";
export const DEFAULT_RPC_URL = "https://test.rpc.fastnear.com";
export const ONE_NEAR_YOCTO = 1_000_000_000_000_000_000_000_000n; // 10^24

/**
 * Format yoctoNEAR string or bigint into a human-readable NEAR decimal string.
 * Keeps up to maxDecimals decimal places without floating-point inaccuracy.
 */
export function formatYoctoNear(yoctoStrOrBigInt, maxDecimals = 4) {
  if (yoctoStrOrBigInt === null || yoctoStrOrBigInt === undefined) return "0 NEAR";
  const yocto = BigInt(yoctoStrOrBigInt.toString());
  const isNegative = yocto < 0n;
  const absYocto = isNegative ? -yocto : yocto;

  const whole = absYocto / ONE_NEAR_YOCTO;
  const fraction = absYocto % ONE_NEAR_YOCTO;

  let fractionStr = fraction.toString().padStart(24, "0");
  if (maxDecimals < 24) {
    fractionStr = fractionStr.slice(0, maxDecimals);
  }
  // Trim trailing zeros
  fractionStr = fractionStr.replace(/0+$/, "");

  const sign = isNegative ? "-" : "";
  if (fractionStr.length === 0) {
    return `${sign}${whole} NEAR`;
  }
  return `${sign}${whole}.${fractionStr} NEAR`;
}

/**
 * Convert human NEAR string (e.g. "0.01") to exact yoctoNEAR decimal string.
 */
export function parseNearToYocto(nearStr) {
  if (typeof nearStr !== "string" || !/^[0-9]+(\.[0-9]+)?$/.test(nearStr.trim())) {
    throw new TypeError("Invalid NEAR amount string");
  }
  const parts = nearStr.trim().split(".");
  const whole = BigInt(parts[0]);
  let fractionStr = (parts[1] || "").slice(0, 24).padEnd(24, "0");
  const fraction = BigInt(fractionStr);
  return (whole * ONE_NEAR_YOCTO + fraction).toString();
}

/**
 * Compute progress percentage for daily spending.
 */
export function computeQuotaPercentage(usedYocto, limitYocto) {
  const used = BigInt(usedYocto || "0");
  const limit = BigInt(limitYocto || "1");
  if (limit === 0n) return 100;
  const pct = Number((used * 10000n) / limit) / 100;
  return Math.min(100, Math.max(0, pct));
}

/**
 * Generate NEAR CLI rs command for adding an allowed recipient.
 */
export function generateAddRecipientCommand(contractId, recipientId) {
  return `near contract call-function as-transaction ${contractId} add_allowed_recipient json-args '{"recipient_id": "${recipientId}"}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as ${contractId} network-config testnet sign-with-keychain send`;
}

/**
 * Generate NEAR CLI rs command for removing an allowed recipient.
 */
export function generateRemoveRecipientCommand(contractId, recipientId) {
  return `near contract call-function as-transaction ${contractId} remove_allowed_recipient json-args '{"recipient_id": "${recipientId}"}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as ${contractId} network-config testnet sign-with-keychain send`;
}

/**
 * Generate NEAR CLI rs command for updating spending limits.
 */
export function generateUpdateLimitsCommand(contractId, softYocto, hardYocto, dailyYocto) {
  return `near contract call-function as-transaction ${contractId} update_spending_limits json-args '{"soft_limit_yocto": "${softYocto}", "hard_limit_yocto": "${hardYocto}", "daily_limit_yocto": "${dailyYocto}"}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as ${contractId} network-config testnet sign-with-keychain send`;
}

/**
 * Generate NEAR CLI rs command for pause/unpause.
 */
export function generatePauseCommand(contractId, pause = true) {
  const method = pause ? "pause" : "unpause";
  return `near contract call-function as-transaction ${contractId} ${method} json-args '{}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as ${contractId} network-config testnet sign-with-keychain send`;
}

/**
 * Universal base64 encoder (works in browsers and Node.js without Buffer).
 */
function toBase64(str) {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(str, "utf8").toString("base64");
  }
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return globalThis.btoa(binary);
}

/**
 * Universal byte-array decoder to UTF-8 string (works in browsers and Node.js without Buffer).
 */
function fromByteArray(byteArray) {
  if (typeof TextDecoder !== "undefined") {
    return new TextDecoder("utf-8").decode(new Uint8Array(byteArray));
  }
  if (typeof Buffer !== "undefined") {
    return Buffer.from(byteArray).toString("utf8");
  }
  return String.fromCharCode.apply(null, byteArray);
}

/**
 * Query a contract view method using standard JSON-RPC.
 */
export async function queryContractView(rpcUrl, contractId, method, args = {}, fetchImpl = globalThis.fetch) {
  const argsBase64 = toBase64(JSON.stringify(args));
  const response = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "tapproved-view",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "optimistic",
        account_id: contractId,
        method_name: method,
        args_base64: argsBase64
      }
    })
  });

  if (!response.ok) {
    throw new Error(`RPC HTTP error ${response.status}`);
  }

  const json = await response.json();
  if (json.error) {
    throw new Error(json.error.message || json.error.data || "RPC query error");
  }

  if (!json.result || !Array.isArray(json.result.result)) {
    throw new Error("Invalid RPC result format");
  }

  const resultStr = fromByteArray(json.result.result);
  return resultStr ? JSON.parse(resultStr) : null;
}
