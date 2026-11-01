import { createPublicKey, verify } from "node:crypto";

const DOMAIN = Buffer.from([0x54,0x41,0x50,0x50,0x52,0x4f,0x56,0x45,0x44,0x00,0x01]);
const U128_MAX = (1n << 128n) - 1n;

function lengthPrefixedUtf8(value, field) {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${field} must be a non-empty string`);
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > 0xffffffff) throw new RangeError(`${field} is too long`);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(bytes.length);
  return Buffer.concat([length, bytes]);
}

function unsigned(value, bits, field) {
  let n;
  try { n = BigInt(value); } catch { throw new TypeError(`${field} must be an unsigned integer`); }
  const max = (1n << BigInt(bits)) - 1n;
  if (n < 0n || n > max) throw new RangeError(`${field} is outside u${bits}`);
  const out = Buffer.alloc(bits / 8);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

export function encodeApprovalMessage(payment) {
  if (!payment || typeof payment !== "object") throw new TypeError("payment must be an object");
  return Buffer.concat([
    DOMAIN,
    lengthPrefixedUtf8(payment.contract_id, "contract_id"),
    lengthPrefixedUtf8(payment.network_id, "network_id"),
    unsigned(payment.payment_id, 64, "payment_id"),
    lengthPrefixedUtf8(payment.recipient_id, "recipient_id"),
    unsigned(payment.amount_yocto, 128, "amount_yocto"),
    unsigned(payment.nonce, 64, "nonce"),
    unsigned(payment.expires_at_ns, 64, "expires_at_ns")
  ]);
}

export function verifyApprovalSignature(payment, publicKeyHex, signatureHex) {
  if (!/^[0-9a-f]{64}$/i.test(publicKeyHex)) throw new TypeError("public key must be 32-byte hex");
  if (!/^[0-9a-f]{128}$/i.test(signatureHex)) throw new TypeError("signature must be 64-byte hex");
  const raw = Buffer.from(publicKeyHex, "hex");
  const derPrefix = Buffer.from("302a300506032b6570032100", "hex");
  const key = createPublicKey({ key: Buffer.concat([derPrefix, raw]), format: "der", type: "spki" });
  return verify(null, encodeApprovalMessage(payment), key, Buffer.from(signatureHex, "hex"));
}

export { U128_MAX };
