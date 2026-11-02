const DEFAULT_RPC_URL = "https://rpc.testnet.near.org";
const DEFAULT_CONTRACT_ID = "manextech.testnet";

function configuration(env = process.env) {
  const rpcUrl = env.NEAR_RPC_URL || DEFAULT_RPC_URL;
  const contractId = env.NEAR_CONTRACT_ID || DEFAULT_CONTRACT_ID;
  if (!rpcUrl.startsWith("https://")) throw new Error("NEAR_RPC_URL must use HTTPS");
  if (!/^[a-z0-9._-]+$/.test(contractId) || !contractId.endsWith(".testnet")) {
    throw new Error("NEAR_CONTRACT_ID must be a valid testnet account ID");
  }
  return { rpcUrl, contractId };
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

export { DEFAULT_RPC_URL, DEFAULT_CONTRACT_ID };


function executionStatus(status) {
  if (!status || typeof status !== "object") return "unknown";
  if (Object.hasOwn(status, "Failure")) return "failure";
  if (Object.hasOwn(status, "SuccessValue")) return "success";
  if (Object.hasOwn(status, "SuccessReceiptId")) return "success_receipt";
  return "unknown";
}

function decimalMetric(value) {
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

/**
 * Read a final or in-progress NEAR transaction and its receipt outcomes.
 * The returned shape is intentionally sanitized; raw logs/proofs are omitted.
 */
export async function getTransactionStatus(transactionHash, signerAccountId, options = {}) {
  if (typeof transactionHash !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(transactionHash)) {
    throw new TypeError("transaction hash must be a valid base58 NEAR hash");
  }
  if (typeof signerAccountId !== "string" || !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(signerAccountId)) {
    throw new TypeError("signer account ID is invalid");
  }
  const { rpcUrl } = configuration(options.env);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
  const response = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "tapproved-relay",
      method: "tx",
      params: {
        tx_hash: transactionHash,
        sender_account_id: signerAccountId
      }
    }),
    signal: AbortSignal.timeout(10000)
  });
  if (!response.ok) throw new Error(`NEAR RPC HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.error) throw new Error(`NEAR RPC error: ${payload.error.message || "unknown error"}`);
  const result = payload.result;
  if (!result || typeof result !== "object" ||
      result.transaction?.hash !== transactionHash ||
      !result.transaction_outcome?.outcome ||
      !Array.isArray(result.receipts_outcome)) {
    throw new Error("NEAR RPC returned an invalid transaction status");
  }

  const transactionState = executionStatus(result.transaction_outcome.outcome.status);
  const receipts = result.receipts_outcome.map((receipt) => ({
    receipt_id: typeof receipt?.id === "string" ? receipt.id : null,
    executor_id: typeof receipt?.outcome?.executor_id === "string" ? receipt.outcome.executor_id : null,
    status: executionStatus(receipt?.outcome?.status),
    gas_burnt: decimalMetric(receipt?.outcome?.gas_burnt),
    tokens_burnt: decimalMetric(receipt?.outcome?.tokens_burnt)
  }));
  const failed = transactionState === "failure" || receipts.some((receipt) => receipt.status === "failure");
  const final = result.final_execution_status === "FINAL";
  const allReceiptsKnown = receipts.every((receipt) => receipt.status !== "unknown");
  const state = failed ? "failed" : final && allReceiptsKnown ? "success" : "pending";

  return {
    transaction_hash: transactionHash,
    signer_id: result.transaction.signer_id ?? signerAccountId,
    receiver_id: result.transaction.receiver_id ?? null,
    final_execution_status: typeof result.final_execution_status === "string"
      ? result.final_execution_status
      : "UNKNOWN",
    state,
    transaction: {
      status: transactionState,
      gas_burnt: decimalMetric(result.transaction_outcome.outcome.gas_burnt),
      tokens_burnt: decimalMetric(result.transaction_outcome.outcome.tokens_burnt)
    },
    receipts
  };
}
