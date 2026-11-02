# D1 firmware, contract and approval-protocol audit

**Audit baseline:** `main` at `14d9b5b7337347b2f5bdefc2d9b3461aab28012f`  
**Scope:** Source-level comparison of the ESP32 firmware, NEAR contract, protocol v1 specification, relay serial bridge and existing automated tests.  
**Outcome:** The canonical v1 message construction is consistent across the three implementations by source inspection, and the contract has meaningful signature/replay/expiry tests. The firmware remains a prototype with material approval-intent, input-validation, key-lifecycle and interoperability-test gaps. This is not an independent security audit.

## 1. Source inventory

| Component | Source |
|---|---|
| ESP32 implementation | `firmware/src/main.cpp` |
| Firmware build/dependencies | `firmware/platformio.ini` |
| Firmware operator documentation | `firmware/README.md` |
| Protocol specification | `docs/APPROVAL-PROTOCOL.md` |
| Normative deterministic vector | `protocol/v1-vector.json` |
| Contract implementation | `contract/src/lib.rs` |
| Relay encoder and verifier | `relay/protocol.js` |
| Relay-to-device framing | `relay/serial.js` |
| Relay approval orchestration | `relay/approval-service.js` |
| Relay protocol tests | `relay/protocol.test.js` |
| Contract protocol tests | `contract/src/lib.rs`, test module |

## 2. Compatibility matrix

| Protocol element | Specification / contract | Firmware | Relay | Result |
|---|---|---|---|---|
| Domain separator | ASCII `TAPPROVED\0\x01` | Same 11 bytes | Same 11 bytes | Match |
| Contract ID | UTF-8 with u32 little-endian length; contract uses current account ID | Request value must equal compiled `manextech.testnet` | Supplies canonical contract ID | Match for canonical deployment |
| Network ID | UTF-8 with u32 little-endian length; contract uses stored `testnet` | Must equal compiled `testnet` | Supplies `testnet` | Match |
| Payment ID | u64 little-endian | Decimal parser then u64 LE | u64 LE encoder | Match |
| Recipient | UTF-8 with u32 little-endian length | Same | Same | Match |
| Amount | u128 little-endian yoctoNEAR | Decimal-to-16-byte LE conversion | BigInt-to-u128 LE | Match |
| Nonce | u64 little-endian | Decimal parser then u64 LE | u64 LE encoder | Match |
| Expiry | u64 little-endian nanoseconds | Decimal parser then u64 LE | u64 LE encoder | Match |
| Signature | Ed25519 over exact byte sequence | Ed25519 library signs encoded buffer | Node verifies signature shape/bytes | Contract is final verifier |
| Fixture | `protocol/v1-vector.json` | No automated firmware fixture consumer found in repository | Byte and signature tests consume fixture | Firmware coverage gap |

The relay frame is not itself the signed message. It contains the fields from which firmware constructs the v1 message. The relay fixes contract/network configuration in `buildDeviceApprovalFrame`; firmware independently rejects values that differ from its compiled configuration. The contract reconstructs the message from stored payment state and does not trust relay-provided message bytes.

## 3. Findings

### D1-01 — No shared-vector test executes the firmware encoder
**Severity: High (interoperability regression risk)**

Evidence:
- `relay/protocol.test.js` loads `protocol/v1-vector.json` and checks exact message bytes, signature verification and amount tampering.
- Contract tests in `contract/src/lib.rs` include `protocol_v1_vector_signature_is_accepted`, plus tests binding the signature to payment ID, recipient, nonce, expiry, amount, contract ID and device key.
- The firmware CI job only runs `pio run -e esp32dev`; no firmware unit/native test or fixture-consuming test appears in the repository.
- `firmware/src/main.cpp::encodeApproval` is therefore compile-checked but not demonstrated byte-for-byte against the normative fixture by automated CI.

**Required follow-through:** Add a testable firmware encoder boundary and a deterministic test that consumes the exact shared fixture. Do not change the fixture merely to make a test pass.

### D1-02 — A held or bouncing button can authorize a newly received request
**Severity: High (physical-intent ambiguity)**

Evidence:
- `firmware/src/main.cpp` configures GPIO25 as `INPUT_PULLUP`.
- `handleRequest` immediately polls for LOW after printing the request. It sets `pressed = true` on any LOW sample, then waits for HIGH and signs.
- There is no pre-request requirement to observe a stable released state, no edge requirement, and no debounce state machine.

A button already held when a request arrives can satisfy the current loop without a new post-display press. Contact bounce can also be interpreted as a press. The printed instruction says “Press and release”, but the code does not enforce a fresh intentional press.

**Required follow-through:** Implement a bounded, debounced press-release state machine. Require stable release before arming and a fresh stable press followed by stable release. Preserve timeout and rejection behavior. Cover held-at-arrival, bounce, short press, valid press-release and timeout cases.

### D1-03 — Device-side expiry is not enforced
**Severity: Medium (stale approval UX; contract remains authoritative)**

Evidence:
- Firmware encodes and displays `expires_at_ns` but does not compare it to a trusted time source.
- Contract `approve_spend` rejects when `env::block_timestamp() > payment.expires_at_ns`.
- Relay expiry monitoring is separate and uses finalized NEAR block time.

The firmware currently cannot establish expiry from its own clock. This is not a contract bypass because the contract checks expiry before accepting the signature. A local wall-clock check must not be added unless its time source and trust model are explicitly defined.

**Required follow-through:** Define how the device learns trusted finalized-chain time or an authenticated freshness signal. Until then, make the limitation explicit and rely on contract enforcement; do not pretend an ESP32 uptime counter is block time.

### D1-04 — The displayed amount is raw yoctoNEAR
**Severity: Medium (human-verification quality)**

Evidence:
- `handleRequest` prints `Amount: <amount> yoctoNEAR`.
- It prints recipient and payment ID, but no formatted NEAR denomination or clear confirmation summary.
- Firmware README acknowledges that USB serial is not a trusted display.

The amount is exact but difficult for a human to inspect. The display path is also controlled by the host/relay and cannot protect against a compromised host presenting different details from the signed payload.

**Required follow-through:** Provide an unambiguous human-readable amount conversion without floating point, retain the exact raw amount where useful, and document that serial is not trusted. A trusted display is a separate hardware/security requirement; formatting alone does not solve display authenticity.

### D1-05 — Private seed remains resident in RAM after signing
**Severity: High (key exposure window)**

Evidence:
- `private_seed` is a global 32-byte array.
- `loadOrCreateKey` loads or generates the seed and leaves it in that global buffer.
- `handleRequest` clears the signature and message buffers after signing but does not clear the seed.
- No explicit zeroization is performed at shutdown/reset boundaries (and reset behavior is not a substitute for a designed key-lifecycle control).

**Required follow-through:** Review the crypto library's signing API and implement the strongest practical key-buffer lifecycle supported by the platform, without accidentally erasing the persistent NVS key. Document residual RAM/debug extraction risks. This finding belongs with the key-custody work in D10/D11.

### D1-06 — Unexpected NVS seed length silently causes key replacement
**Severity: High (device identity/key continuity risk)**

Evidence:
- `loadOrCreateKey` reads `getBytesLength`.
- If the stored length equals 32 bytes, it loads the existing seed.
- For every other length, it generates and stores a new seed instead of failing closed or distinguishing first boot from corrupted/incompatible state.

If an existing key record is corrupted or has an unexpected length, the device silently rotates its identity. The new public key may no longer match the key registered in the contract, and a user may not recognize the identity change.

**Required follow-through:** Distinguish absent key from malformed existing key. First boot may generate once; a present but invalid record should fail closed and require an explicit recovery/rotation procedure. Never overwrite a malformed existing key silently.

### D1-07 — Firmware request validation is narrower than the full payment schema
**Severity: Medium (defense-in-depth and UX)**

Evidence:
- Firmware `encodeApproval` validates contract ID, network ID, numeric encoding/ranges and non-empty strings.
- It does not validate the payment status, agent ID, recipient account syntax/length, or a positive payment ID/amount/expiry as explicit semantic rules.
- Relay `buildDeviceApprovalFrame` validates `status === "pending"`, canonical agent ID, recipient account syntax/length and positive payment ID/amount/expiry before serializing.
- The frame does not carry agent ID or status to firmware.

The relay currently provides these checks, and the contract remains authoritative for payment state and signature validity. Firmware should still reject malformed or semantically invalid frames as a defense-in-depth boundary. Agent identity/status cannot be independently checked by firmware with the current frame contract.

**Required follow-through:** Define the minimum device-side request schema and whether agent/status fields should be included in a future serial protocol revision. Validate account ID syntax and semantic numeric constraints locally. Any incompatible frame change needs explicit versioning and coordinated relay/firmware tests.

### D1-08 — Firmware parser accepts decimal strings with leading zeros
**Severity: Low (canonical-input consistency)**

Evidence:
- `parseU64` and `parseU128LE` accept any non-empty sequence of decimal digits, including leading zeros.
- Relay currently emits canonical decimal strings from NEAR JSON values.
- Leading zeros encode the same integer and therefore do not create a signature ambiguity, but stricter canonical parsing would make the device protocol less permissive.

**Required follow-through:** Decide and test whether decimal frame fields require canonical decimal form (`0` or nonzero digit followed by digits). Do not change the signed binary encoding.

### D1-09 — Firmware error and timeout paths do not consistently clear sensitive working buffers
**Severity: Medium (memory hygiene)**

Evidence:
- After successful signing, signature and message buffers are cleared.
- Early returns from JSON/encoding rejection and the 30-second physical-approval timeout do not clear the stack message buffer.
- The private seed remains resident as described in D1-05.

The message is not a secret key, but consistent cleanup reduces residual sensitive transaction data and makes the lifecycle easier to reason about. Signature buffer cleanup should also be guaranteed on every exit path after allocation.

**Required follow-through:** Use scoped cleanup or a single cleanup path for message/signature buffers, and test all rejection/timeout exits where practical.

## 4. Existing protections confirmed

1. The contract requires the payment to be the active payment and in `Pending` state before hardware approval.
2. The contract rejects approval after expiry.
3. The contract requires a 64-byte signature and 32-byte registered public key.
4. The contract reconstructs v1 bytes from stored payment state, current contract account ID and stored network ID.
5. Contract tests cover the shared v1 signature, actual ESP32 signature acceptance, field tampering, wrong contract ID, wrong device key, expiry and replay/repeated approval rejection.
6. Relay serial transport bounds newline-delimited frames, validates response key/signature hex lengths, enforces one outstanding request and applies a timeout.
7. Firmware has a fixed 2,048-byte serial line buffer and a 512-byte encoded-message bound. The canonical message is well below that bound for the configured account identifiers.

## 5. Scope allocation to later Phase D tasks

| Finding | Follow-through task |
|---|---|
| D1-01 shared-vector firmware test | D7 |
| D1-02 fresh debounced physical press | D6 |
| D1-03 trusted expiry/freshness model | D8, subject to explicit time-source design |
| D1-04 readable amount and approval presentation | D5 |
| D1-05 RAM key lifecycle | D10 / D11 |
| D1-06 fail-closed NVS identity handling | D10 / D12 |
| D1-07 semantic frame validation/versioning | D4 / D8 |
| D1-08 canonical decimal parsing | D4 / D8 |
| D1-09 cleanup on all exits | D9 / D10 |

## 6. Audit conclusion

The source-level protocol encodings agree on the documented Tapproved v1 field order and byte representation. The relay and contract have deterministic interoperability coverage, and contract authorization remains the final authority for payment state, expiry, registered-key verification and replay prevention.

The firmware is not yet equivalent in assurance to those boundaries. The most important firmware gaps are the absence of an automated shared-vector test, acceptance of a button already held when a request arrives, silent key replacement when an existing NVS record has an unexpected length, and incomplete RAM key cleanup. The serial approval display is not trusted, and the device currently has no trusted chain-time source for local expiry decisions.

D1 is an audit deliverable, not a claim that these gaps are fixed. Address each gap in its assigned Phase D implementation task, with focused tests and CI evidence. No deployment, signing, flashing or on-chain transaction is part of this audit.
