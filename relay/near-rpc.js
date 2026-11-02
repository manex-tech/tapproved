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
