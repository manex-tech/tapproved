import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { encodeApprovalMessage, verifyApprovalSignature } from "./protocol.js";

const fixture = JSON.parse(await readFile(new URL("../protocol/v1-vector.json", import.meta.url), "utf8"));

test("v1 encoder exactly matches the shared byte fixture", () => {
  const message = encodeApprovalMessage(fixture.inputs);
  assert.equal(message.toString("hex"), fixture.message_hex);
  assert.equal(message.length, 103);
});

test("v1 Ed25519 signature verifies against the shared fixture", () => {
  assert.equal(verifyApprovalSignature(fixture.inputs, fixture.public_key_hex, fixture.signature_hex), true);
});

test("signature rejects a modified amount", () => {
  const changed = { ...fixture.inputs, amount_yocto: "123456789012345678901234567891" };
  assert.equal(verifyApprovalSignature(changed, fixture.public_key_hex, fixture.signature_hex), false);
});

test("encoder rejects values outside unsigned integer ranges", () => {
  assert.throws(() => encodeApprovalMessage({ ...fixture.inputs, amount_yocto: "-1" }), /outside u128/);
  assert.throws(() => encodeApprovalMessage({ ...fixture.inputs, payment_id: "18446744073709551616" }), /outside u64/);
});
