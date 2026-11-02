# Tapproved: Master Development Checklist

**Purpose:** Track the work required to take Tapproved from a working hardware-backed NEAR prototype to a complete, demonstrable AI-agent spending authorization system.

**Working rule:** Execute one task at a time. Inspect the actual repository state before changing it, make focused changes, run relevant tests, verify evidence, and record the result before advancing. A task is not complete merely because code was written or a command was attempted.

**Last inspected implementation revision:** `7e17c283b3686e110519cc76ac5047b08dd4dbd2` (E1 sample agent-to-relay integration merge, 2026-11-02)  
**Canonical network:** NEAR Testnet  
**Canonical contract/treasury:** `manextech.testnet`  
**Registered agent:** `manex-agent.testnet`

## Operating rules

- Work strictly one task at a time. Do not skip ahead.
- Before editing, inspect the current branch, commit, working tree and relevant source.
- For each task, record implementation, tests, verification evidence and remaining limitations.
- Distinguish complete, partially complete, blocked and not started work.
- Do not claim a test passed without actual output or a successful CI result.
- The user has authorized merging task PRs after source review and all required CI jobs pass. No deployment, initialization, on-chain transaction signing, payment, transfer, publishing, force-pushing or hackathon submission without explicit approval for that action.
- Never deploy the current keyed 90-day daily-accounting storage layout over the existing `manextech.testnet` deployment. It requires a fresh account unless a separately designed and verified migration is implemented.
- Keep testnet-only limitations explicit. Tapproved is not independently audited and is not production-ready.

## Current checkpoint

**Active task: E2 exercise an automatically approved payment. This requires explicit approval before any live Testnet payment request or transfer.**

**E1 completed:** PR [#59](https://github.com/manex-tech/tapproved/pull/59) merged as `7e17c283b3686e110519cc76ac5047b08dd4dbd2`; CI run [41523732632](https://github.com/manex-tech/tapproved/actions/runs/41523732632) passed all three jobs. Added `examples/agent-request.js`, a minimal authenticated client for `POST /v1/payment-requests`, with strict environment validation, HTTPS enforcement for non-loopback URLs, caller-supplied stable idempotency keys, and no automatic retries. Added five client tests; Node CI passed 130 tests with zero failures. Added `npm run agent:request`, optional `.env.example` fields and a README quickstart. No live payment request, NEAR transaction, signing or hardware interaction was performed. The next E2 task requires explicit approval for a live Testnet payment/transfer.

**D13 completed:** PR [#58](https://github.com/manex-tech/tapproved/pull/58) merged as `35132ff00d588b16b5f035d7cacb21847461abc7`; CI run [41522764615](https://github.com/manex-tech/tapproved/actions/runs/41522764615) passed Node, contract/Wasm and firmware jobs. Relay now releases a stale serial-port object after unexpected close so a later explicit reconnect works. Added tests for ESP32 reset during an in-flight approval, old UUID rejection after reconnect, fail-closed behavior without signature submission, and every truncated present NVS seed length from 0 through 31 bytes. Added [DISCONNECT-RESET-POWER-LOSS.md](DISCONNECT-RESET-POWER-LOSS.md). These are host/model and CI tests only; no physical USB unplug, board reset, power interruption, NVS erase or hardware test was performed.

**D12 completed:** PR [#56](https://github.com/manex-tech/tapproved/pull/56) merged as `b79b4d1112dd273d36ecde87e38cf9b595a92587`; CI run [41520953304](https://github.com/manex-tech/tapproved/actions/runs/41520953304) passed all three jobs. The contract suite passed 77 tests, including new cases proving that the owner-rotated key appears in `get_policy`, can approve an existing pending payment, and invalidates signatures from the previous key. Tests also confirm rotation preserves pending payment state and its daily reservation. Added [DEVICE-KEY-ROTATION.md](DEVICE-KEY-ROTATION.md), documenting the safe operator sequence and the need to drain pending approvals. No live Testnet rotation, payment, firmware flash, NVS erase or hardware modification was performed.

**D11 completed:** PR [#55](https://github.com/manex-tech/tapproved/pull/55) merged as `599b35f8f1b11c97f26e8142a0c9a5649a7af8ce`; CI run [41519115081](https://github.com/manex-tech/tapproved/actions/runs/41519115081) passed all three jobs: Node, contract tests/Wasm build and ESP32 firmware build. The global private seed was removed; firmware now uses scope-bound zeroizing buffers, reloads the NVS seed only after fresh physical approval, re-derives and checks the device identity before signing. Added [ESP32-SECURITY-ASSESSMENT.md](ESP32-SECURITY-ASSESSMENT.md), documenting the source-level posture, silicon-revision dependency, Secure Boot/Flash Encryption/NVS encryption distinctions, JTAG/UART download considerations and production gates. No hardware eFuse, flash-encryption, debug-interface configuration, firmware flashing or on-chain action was performed. Physical silicon/eFuse state remains uninspected; ordinary NVS is not encrypted by this change.

**D1 completed:** Source-level firmware, contract, protocol v1 and relay audit recorded in [FIRMWARE-PROTOCOL-AUDIT.md](FIRMWARE-PROTOCOL-AUDIT.md). PR [#45](https://github.com/manex-tech/tapproved/pull/45) merged as `c94d6440144e766d9fd1367973fb90944b43d164`. CI run [41505991730](https://github.com/manex-tech/tapproved/actions/runs/41505991730) passed firmware, Node and contract jobs. D1 identified nine findings and allocated implementation follow-through to D4–D12; the audit itself did not change firmware or contract behavior. D2 completed in PR [#46](https://github.com/manex-tech/tapproved/pull/46), merged as `78affc5526d7777619113481010d476536810223`. CI run [41508750251](https://github.com/manex-tech/tapproved/actions/runs/41508750251) passed Node tests, Rust contract tests/Wasm build and ESP32 firmware build. Relay RPC configuration now rejects noncanonical network, contract and signer IDs; firmware contract ID is no longer build-flag overridable. No device was flashed and no chain interaction occurred. D3 completed in PR [#47](https://github.com/manex-tech/tapproved/pull/47), merged as `a9f4dbb05cb4b937ac1a8d6d1066a739eadec01a`. CI run [41509575465](https://github.com/manex-tech/tapproved/actions/runs/41509575465) passed Node tests, Rust contract tests/Wasm build and ESP32 firmware build. The serial envelope now carries `frame_version: 1` and a per-attempt UUID v4 request ID; firmware echoes it and relay rejects stale responses. Hardware-level serial validation remains outstanding. D4 completed in PR [#48](https://github.com/manex-tech/tapproved/pull/48), merged as `57c33bc0960f6321d1a696f5eef9b4043c82b7c2`. CI run [41510304239](https://github.com/manex-tech/tapproved/actions/runs/41510304239) passed Node tests, Rust contract tests/Wasm build and ESP32 firmware build. The device frame now includes agent and pending status; relay and firmware enforce recipient syntax/length, positive fields, integer bounds and canonical decimal strings. Firmware flashing and physical serial tests remain outstanding.

The disposable B10 lab firmware branch was merged as PR #26, but the lab account is no longer the target architecture. Development is consolidated around the canonical Testnet contract `manextech.testnet` and registered agent `manex-agent.testnet`. Do not initialize, deploy over, or transfer funds from the canonical contract during implementation. The existing deployed contract's storage-layout compatibility must be assessed before any final redeployment decision.

B10 empirical callback-gas validation is deferred until the final deployment/testing stage. Its 30 TGas callback allocation and recovery implementation remain in the contract; actual Testnet receipt gas evidence is still outstanding.

**C1 completed:** [Relay architecture and trust boundaries](RELAY-ARCHITECTURE.md) defines the agent, relay, signer, contract, serial bridge and ESP32 boundaries; API contract; secret configuration; lifecycle and failure invariants. This is a design baseline, not a claim that these components are implemented.

PRs #27 and #29 delivered authenticated payment requests; PR #28 added durable idempotency; PR #30 added the restricted NEAR agent signer; PR #31 added automatic execution; PR #33 added pending-approval and payment-status reads; PR #35 completed bounded ESP32 serial transport and firmware framing; PR #38 added the one-cycle hardware approval flow and separate `approve_spend`-only signer; PR #40 added authenticated transaction and receipt status tracking; PR #41 completed finalized-chain-time expiry monitoring with a separate `expire_payment`-only signer; PR #42 completes C11 durable interruption recovery. Live approval and automatic expiry remain disabled until the owner provisions their respective restricted FunctionCall keys on `manex-agent.testnet`.

C10 is complete and merged in PR #41. CI run [41489165448](https://github.com/manex-tech/tapproved/actions/runs/41489165448) passed Node tests, Rust contract tests/Wasm build and ESP32 firmware build. The expiry keeper remains disabled in a live relay until the owner provisions the separate `expire_payment`-only FunctionCall key.

C11 is complete and merged in [PR #42](https://github.com/manex-tech/tapproved/pull/42) as `9f4b521d3611c25edcfd0e12e5b0087a98973bf9`. CI run [41494552737](https://github.com/manex-tech/tapproved/actions/runs/41494552737) passed the full Node test/syntax job, Rust contract tests and Wasm build, and ESP32 firmware build. Approval and expiry operation attempts are durably journaled before broadcast and reconciled against canonical `get_payment` state after restart. The authenticated `POST /v1/recovery/reconcile` endpoint is read-only with respect to chain state and only repairs the local journal. Ambiguous transactions are never automatically resubmitted. Interrupted payment-request records remain for manual review because the contract does not persist the HTTP idempotency key, so recipient/amount equality cannot prove attribution.

C12 is complete and merged in [PR #43](https://github.com/manex-tech/tapproved/pull/43) as `aa31efe8d50f94d397bee6f6fcef739bcfc204a0`. CI run [41499739171](https://github.com/manex-tech/tapproved/actions/runs/41499739171) passed all three jobs: 112 Node tests, Rust contract tests and Wasm build, and ESP32 firmware build. The relay now emits structured JSON lifecycle events, returns an `x-request-id` correlation header, logs allowlisted route/status/duration metadata, sanitizes error metadata and suppresses internal validation messages. Secrets, signatures, request bodies, query strings and raw exception details are excluded from logs. Logger failures cannot interrupt application control flow.\n\nC13 is complete and merged in [PR #44](https://github.com/manex-tech/tapproved/pull/44) as `774721d21b9c7244803274a690325f81d3b75058`. CI run [41503118181](https://github.com/manex-tech/tapproved/actions/runs/41503118181) passed all three jobs. The Node job passed 114 tests, including two new HTTP-level integration tests; Rust contract tests and the release Wasm build passed; and the ESP32 firmware build passed. The new suite composes the relay server, durable idempotency journal, approval processor and recovery service with deterministic in-memory adapters. It covers payment creation, approval, status reads, idempotent replay, successful recovery reconciliation, and ambiguous approval failure with retry suppression and manual-review recovery. No live RPC, hardware, signing key or on-chain transaction was used.

## Phase A: Repository consistency and documentation

- [x] **A1.** Verify and document the replacement contract deployment. User confirmed the replacement deployment to `manextech.testnet` and NEAR CLI testing. No transaction hash, block height or checksum was invented.
- [x] **A2.** Standardize canonical contract configuration across firmware, relay, README and environment example. Completed in PR #21.
- [x] **A3.** Repair and align README and technical documentation with implemented behavior and known limitations. CI passed.

## Phase B: Smart contract engineering

- [x] **B1.** Audit the current contract structure, authorization boundaries, lifecycle and known risks. No confirmed direct authorization bypass was found in source review; this is not a formal security audit.
- [x] **B2.** Review daily accounting and identify unbounded growth/linear lookup.
- [x] **B3.** Implement bounded, keyed daily accounting while preserving reservations. Completed in PR #22; uses spent and reserved accounting with a bounded 90-day index.
- [x] **B4.** Review payment expiry and stale active-payment handling. New valid requests auto-expire stale Pending/Approved payments; Processing payments are not timeout-expired.
- [x] **B5.** Review soft, hard and daily spending limits and test policy enforcement.
- [x] **B6.** Add owner-only atomic spending-limit updates with full validation and retained-usage guard.
- [x] **B7.** Review cancellation, expiry, transfer failure, settlement and reservation release.
- [x] **B8.** Bound payment retention and review storage management. Terminal-only pruning, maximum 1,000 retained payments, and storage metrics view.
- [x] **B9.** Review repeated requests and signature replay protection. Contract-level replay binding is tested; logical request idempotency remains a future relay/API responsibility.
- [ ] **B10.** Validate transfer callback gas and failure recovery empirically on Testnet. Code is merged: callback allocation increased to 30 TGas; unit test measures callback gas; owner-only `reconcile_processing_payment` supports carefully verified recovery. **Outstanding:** perform controlled Testnet transfer(s), inspect final transfer and callback receipts, and record actual callback gas burnt. Never reconcile an ambiguous transfer outcome.
- [x] **B11.** Review and test NEP-297-style lifecycle, policy-update and reconciliation events.
- [x] **B12.** Run contract tests, release Wasm build, checksum generation and full CI. Latest verified run: 75 Rust tests passed; Node, firmware and contract jobs succeeded.

### B10 safety requirements

- Do not create or use a disposable contract account. Perform empirical callback-gas validation only against the canonical `manextech.testnet` deployment after the final code and storage compatibility have been verified and the user explicitly approves the exact on-chain test.
- Verify the exact Wasm SHA-256 and source commit before deployment.
- Review initializer arguments, especially owner, agent, 32-byte device public key, soft/hard/daily limits, allowlist and network.
- Check treasury balance and storage metrics before any test payment. Do not assume 1 NEAR is sufficient for all transfers and costs.
- Obtain explicit approval before deploying, initializing, signing or sending any payment.
- Measure callback receipt gas from actual Testnet transaction receipts. Record transfer receipt outcome, callback receipt outcome, gas burnt and remaining margin against 30 TGas.
- Do not use timeout-based release or blindly retry a transfer. The reconciliation boolean is an owner attestation, not on-chain proof.

## Phase C: Relay and backend orchestration

- [x] **C1.** Design relay/backend architecture and trust boundaries. Documented in [RELAY-ARCHITECTURE.md](RELAY-ARCHITECTURE.md); implementation boundaries and security invariants reviewed against current source.
- [x] **C2.** Implement secure agent authentication. Bearer-token validation uses constant-time comparison; `POST /v1/payment-requests` enforces authentication, strict JSON and a bounded body. Merged in PRs #27 and #29.
- [x] **C3.** Submit agent spending requests. Authenticated `POST /v1/payment-requests` validates and submits the contract request with durable idempotency; merged in PR #29 and completed by the signer integration in PR #30.
- [x] **C4.** Submit contract transactions through a controlled signer flow. PR #30 verifies the live agent FunctionCall key is scoped to `manextech.testnet` and the exact approved method set; live key preflight still requires owner provisioning.
- [x] **C5.** Execute automatically approved payments. PR #31 calls `execute_approved_spend` only when the contract returns `approved`, then reads the contract payment record and persists both transaction hashes. Pending payments are not auto-executed.
- [x] **C6.** Track pending hardware approvals. PR #33 exposes the contract-derived pending approval context and authenticated `GET /v1/payments/:paymentId` lifecycle lookup. Node integration tests cover pending, active and terminal states, authentication, foreign-agent records, invalid IDs and RPC failures.
- [x] **C7.** Implement ESP32 serial communication. PR #35 adds bounded newline-delimited USB serial transport, one in-flight approval, timeout/disconnect handling, response-shape validation, and the ESP32 frame parser. CI run [41476447728](https://github.com/manex-tech/tapproved/actions/runs/41476447728) passed Node tests, Rust contract tests/Wasm build and ESP32 firmware build.
- [x] **C8.** Submit hardware signatures to the contract. PR #38 adds an authenticated one-cycle processor, separate `approve_spend`-only FunctionCall signer, on-chain device-key matching, canonical v1 local Ed25519 verification, pre-submit pending-payment recheck, and post-submit status read. CI run [41479361939](https://github.com/manex-tech/tapproved/actions/runs/41479361939) passed Node, Rust contract/Wasm and ESP32 firmware jobs. **Operational dependency:** owner must provision the separate approval FunctionCall key before the endpoint can be enabled in a live relay.
- [x] **C9.** Track transaction and payment status. PR #40 adds authenticated `GET /v1/transactions/:hash`, canonical signer/contract/method validation, explicit NEAR finality selection, receipt outcomes, gas/tokens burnt and logs. It omits raw transaction arguments/signatures and returns 202 until all receipts reach `FINAL`. CI run [41483795966](https://github.com/manex-tech/tapproved/actions/runs/41483795966) passed Node, Rust contract/Wasm and ESP32 firmware jobs.
- [x] **C10.** Monitor payment expiry. PR #41 adds a background keeper that compares the active payment expiry with finalized NEAR block time, then calls permissionless `expire_payment` through a separate FunctionCall key restricted to that method only. It confirms the contract reports `expired`, suppresses overlapping polls and never blindly retries an ambiguous submission within the same process. CI run [41489165448](https://github.com/manex-tech/tapproved/actions/runs/41489165448) passed Node tests, Rust contract tests/Wasm build and ESP32 firmware build.
- [x] **C11.** Handle interruption and failure recovery. PR #42 persists approval/expiry operation markers before broadcast, reconciles interrupted operations from canonical `get_payment` state on startup and periodically, and exposes authenticated read-only `POST /v1/recovery/reconcile`. Known typed pre-submit hardware/signature rejections may be retried; ambiguous submissions are never automatically resubmitted. Interrupted request records remain unresolved for manual review because the contract does not store the HTTP idempotency key and recipient/amount equality cannot prove attribution. CI run [41494552737](https://github.com/manex-tech/tapproved/actions/runs/41494552737) passed Node tests, Rust contract tests/Wasm build and ESP32 firmware build.
- [x] **C12.** Implement structured logs and error handling. PR #43 adds an allowlisted JSON logger, request correlation IDs, safe route templates, structured HTTP outcome events, sanitized startup/monitor error metadata and stable client validation errors. Tests cover redaction, error serialization, logger failure isolation, correlation headers and route/query privacy.
- [x] **C13.** Add automated integration tests. PR #44 adds `relay/integration.test.js` and includes it in `npm run check`. The HTTP-level tests cover authenticated payment creation, pending approval context, one hardware approval cycle, payment status, durable idempotent replay, successful recovery reconciliation, and ambiguous approval submission with durable uncertainty, retry suppression and manual-review recovery. CI run [41503118181](https://github.com/manex-tech/tapproved/actions/runs/41503118181) passed Node (114 tests), Rust contract tests/Wasm build and ESP32 firmware build.
- [x] Implement application-level request idempotency keys so transport retries do not create duplicate logical payments. PR #28 provides a durable single-process journal with restart persistence, conflict detection and fail-closed uncertain states; multi-instance deployments still require a shared transactional store.

## Phase D: Hardware security and firmware

- [x] **D1.** Audit the firmware against the contract and approval protocol. PR #45 merged as `c94d6440144e766d9fd1367973fb90944b43d164`; CI run [41505991730](https://github.com/manex-tech/tapproved/actions/runs/41505991730) passed all three jobs. Findings and follow-through allocation are documented in [FIRMWARE-PROTOCOL-AUDIT.md](FIRMWARE-PROTOCOL-AUDIT.md).
- [x] **D2.** Verify canonical contract/network configuration. PR #46 merged as `78affc5526d7777619113481010d476536810223`; CI run [41508750251](https://github.com/manex-tech/tapproved/actions/runs/41508750251) passed all three jobs. Relay RPC now enforces `testnet`, `manextech.testnet` and `manex-agent.testnet`; firmware contract/network constants are fixed in source with no contract build-flag override.
- [x] **D3.** Define reliable hardware communication framing and protocol. PR #47 merged as `a9f4dbb05cb4b937ac1a8d6d1066a739eadec01a`; CI run [41509575465](https://github.com/manex-tech/tapproved/actions/runs/41509575465) passed all three jobs. Added a versioned serial envelope, per-attempt UUID correlation, matching firmware responses, stale-response suppression and protocol documentation. Physical ESP32 serial testing remains outstanding.
- [x] **D4.** Receive and validate payment requests. PR #48 merged as `57c33bc0960f6321d1a696f5eef9b4043c82b7c2`; CI run [41510304239](https://github.com/manex-tech/tapproved/actions/runs/41510304239) passed all three jobs. The serial envelope now carries `agent_id` and `status`; relay and firmware validate canonical decimal integers, u64/u128 bounds, positive payment ID/amount/expiry, and 2–64 character NEAR recipient account syntax. Leading-zero forms are rejected. Physical ESP32 testing remains outstanding. D5 completed in PR [#49](https://github.com/manex-tech/tapproved/pull/49), merged as `1347b7ebf5e2017df335742da449191bab737516`. CI run [41511143294](https://github.com/manex-tech/tapproved/actions/runs/41511143294) passed Node, contract/Wasm and firmware jobs, including the new host-compiled C++ amount-formatting tests. The device now shows NEAR denomination and exact yoctoNEAR without floating-point rounding. The USB serial warning remains explicit because this is not a trusted display. D6 completed in PR [#50](https://github.com/manex-tech/tapproved/pull/50), merged as `5dde9974d82336ad98e3135bda96105d3d93ade5`. CI run [41511889313](https://github.com/manex-tech/tapproved/actions/runs/41511889313) passed Node, contract/Wasm and firmware jobs, including host-compiled state-machine tests for held-at-arrival, fresh press/release, short press, bounce and timer rollover. Actual GPIO25 hardware testing remains outstanding. D7 completed in PR [#51](https://github.com/manex-tech/tapproved/pull/51), merged as `fdad14fc8acd2848041287880f750747e97a23f4`. CI run [41512613016](https://github.com/manex-tech/tapproved/actions/runs/41512613016) passed Node, contract/Wasm and firmware jobs. The exact C++ encoder used by ESP32 firmware is now compiled in CI and compared byte-for-byte against `protocol/v1-vector.json`; negative numeric cases are also rejected. The deterministic fixture still uses `tapproved.testnet` by design; live firmware remains pinned to `manextech.testnet`. D8 completed in PR [#52](https://github.com/manex-tech/tapproved/pull/52), merged as `b4c3e3f8d7f5805de73ff32027418c7d8df50f5c`. CI run [41513987249](https://github.com/manex-tech/tapproved/actions/runs/41513987249) passed Node, contract/Wasm and firmware jobs. The approval processor now validates payment context and checks finalized NEAR block time before and after the physical approval; it fails closed when chain time is unavailable or expiry has passed. The ESP32 rejects the 32 most recently seen request IDs during the current boot. No ESP32 clock is treated as trusted; the contract remains the final expiry and replay authority.
- [x] **D5.** Present amount, recipient and payment ID clearly before approval. PR #49 merged as `1347b7ebf5e2017df335742da449191bab737516`; CI run [41511143294](https://github.com/manex-tech/tapproved/actions/runs/41511143294) passed all three jobs and the new host-compiled C++ formatter tests. Firmware displays the exact NEAR denomination plus original yoctoNEAR, recipient, payment ID, contract, network and expiry. Serial remains explicitly untrusted.
- [x] **D6.** Require intentional physical approval through GPIO25. PR #50 merged as `5dde9974d82336ad98e3135bda96105d3d93ade5`; CI run [41511889313](https://github.com/manex-tech/tapproved/actions/runs/41511889313) passed all three jobs. Firmware now requires stable release before arming, then a fresh stable press and release with 50 ms debounce; a button held at request arrival cannot approve. Host C++ tests cover held-at-arrival, short press, bounce, valid cycle and `millis()` rollover. Physical ESP32 validation remains outstanding.
- [x] **D7.** Sign only the canonical approval message. PR #51 merged as `fdad14fc8acd2848041287880f750747e97a23f4`; CI run [41512613016](https://github.com/manex-tech/tapproved/actions/runs/41512613016) passed all three jobs. Extracted the exact firmware encoder into a testable C++ header and added a host test that consumes the shared fixture and checks exact `message_hex` equality, plus leading-zero, zero-amount and u128-overflow rejection cases. No signed-message fields were changed.
- [x] **D8.** Reject expired, malformed and duplicate requests. PR #52 merged as `b4c3e3f8d7f5805de73ff32027418c7d8df50f5c`; CI run [41513987249](https://github.com/manex-tech/tapproved/actions/runs/41513987249) passed all three jobs. The relay validates active payment fields and checks finalized block time before and after device approval, matching the contract's strict `block_timestamp > expires_at_ns` rule. The ESP32 rejects recently repeated request IDs in a 32-entry volatile ring. No device clock is trusted; on-chain expiry/signature/state checks remain authoritative.
- [x] **D9.** Handle device errors and timeouts safely. PR #53 merged as `4099118039a2d343cfc2b8b5c27c6af801a0da31`; CI run [41514804700](https://github.com/manex-tech/tapproved/actions/runs/41514804700) passed all three jobs. Firmware message/signature working buffers use non-copyable scope-bound volatile zeroization, including malformed-frame, formatting-error, physical timeout and successful-signing exits. Relay tests cover correlated device errors, timeout clearing, no stale response acceptance and preserved no-retry behavior.
- [x] **D10.** Review private-key storage in ESP32 NVS. PR #54 merged as `7dcfabe5dda04d3a0c441fe00db4b8dfb55a6e72`; CI run [41515546257](https://github.com/manex-tech/tapproved/actions/runs/41515546257) passed all three jobs. NVS key generation now occurs only when the record is absent. Existing records must be exactly 32 bytes and fully readable; malformed or partial records fail closed without replacement. NVS/flash encryption and the global RAM key lifecycle remain separate hardening work.
- [x] **D11.** Evaluate secure boot, flash encryption and debug-interface hardening. PR #55 merged as `599b35f8f1b11c97f26e8142a0c9a5649a7af8ce`; CI run [41519115081](https://github.com/manex-tech/tapproved/actions/runs/41519115081) passed Node, contract/Wasm and firmware jobs. Removed the global private seed, introduced short-lived zeroizing key buffers and added a source-level ESP32 security assessment. No eFuses or hardware security settings were changed; physical silicon/eFuse inspection remains outstanding.
- [x] **D12.** Test device-key rotation. PR #56 merged as `b79b4d1112dd273d36ecde87e38cf9b595a92587`; CI run [41520953304](https://github.com/manex-tech/tapproved/actions/runs/41520953304) passed Node, contract/Wasm and firmware jobs. Contract tests verify owner rotation, new-key approval, previous-key rejection, updated `get_policy` output and preservation of pending payment/reservation state. Added `docs/DEVICE-KEY-ROTATION.md`. No live rotation or hardware change was performed.
- [x] **D13.** Test disconnection, reset and power-loss behavior. PR #58 merged as `35132ff00d588b16b5f035d7cacb21847461abc7`; CI run [41522764615](https://github.com/manex-tech/tapproved/actions/runs/41522764615) passed Node, contract/Wasm and firmware jobs. Added explicit serial reconnect after unexpected close, stale UUID rejection, relay fail-closed reset handling, and tests rejecting every truncated present NVS seed length. Added `docs/DISCONNECT-RESET-POWER-LOSS.md`. Physical USB/power-cycle testing remains outstanding.

## Phase E: End-to-end payment automation

- [x] **E1.** Connect an agent to the relay. PR #59 merged as `7e17c283b3686e110519cc76ac5047b08dd4dbd2`; CI run [41523732632](https://github.com/manex-tech/tapproved/actions/runs/41523732632) passed Node (130 tests, 0 failures), contract/Wasm and firmware jobs. Added a minimal authenticated Node agent client, explicit idempotency handling, environment configuration, tests, and README quickstart. No live payment request or transaction was performed.
- [ ] **E2.** Exercise an automatically approved payment.
- [ ] **E3.** Verify on-chain policy decisions.
- [ ] **E4.** Verify automatic execution and callback settlement.
- [ ] **E5.** Exercise a payment requiring hardware approval.
- [ ] **E6.** Deliver the pending request to the ESP32.
- [ ] **E7.** Approve through the physical button.
- [ ] **E8.** Verify the hardware signature on-chain.
- [ ] **E9.** Verify transfer and callback receipts.
- [ ] **E10.** Verify the intended external recipient receives funds.
- [ ] **E11.** Test rejected payments.
- [ ] **E12.** Test expired payments.
- [ ] **E13.** Test failed transfers and reservation release.
- [ ] **E14.** Test replay and duplicate-submission attempts.
- [ ] **E15.** Test multiple sequential payment cycles.

## Phase F: AI agent integration

- [ ] **F1.** Define a public integration interface.
- [ ] **F2.** Build a JavaScript/TypeScript SDK.
- [ ] **F3.** Expose spending-request methods.
- [ ] **F4.** Expose payment-status methods.
- [ ] **F5.** Add pending-approval notifications.
- [ ] **F6.** Handle terminal results and errors.
- [ ] **F7.** Provide agent integration examples.
- [ ] **F8.** Build a demo autonomous agent covering allowed and restricted spending.
- [ ] **F9.** Document integration, idempotency and error behavior.

## Phase G: Dashboard

- [ ] **G1.** Choose frontend architecture.
- [ ] **G2.** Implement wallet/contract connection.
- [ ] **G3.** Display treasury balance.
- [ ] **G4.** Display and manage spending policies.
- [ ] **G5.** Display registered agent information.
- [ ] **G6.** Display hardware/device status.
- [ ] **G7.** Display payment history.
- [ ] **G8.** Display pending approvals.
- [ ] **G9.** Display Paid, Failed, Expired and Cancelled states.
- [ ] **G10.** Implement owner management controls.
- [ ] **G11.** Display transaction status and actionable errors.
- [ ] **G12.** Add Testnet integration tests.

## Phase H: Security and reliability

- [ ] **H1.** Produce a contract threat model.
- [ ] **H2.** Analyze agent-key compromise.
- [ ] **H3.** Analyze hardware-key extraction.
- [ ] **H4.** Analyze malicious recipient and request manipulation.
- [ ] **H5.** Analyze replay and signature-substitution attacks.
- [ ] **H6.** Analyze relay compromise.
- [ ] **H7.** Analyze owner-account compromise.
- [ ] **H8.** Review pause and recovery procedures.
- [ ] **H9.** Review storage exhaustion and pruning behavior.
- [ ] **H10.** Document known limitations and residual risks.
- [ ] **H11.** Run the final automated security and regression suite.

## Phase I: NEAR Hackathon preparation

- [ ] **I1.** Verify public repository and documentation.
- [ ] **I2.** Clearly mark baseline and hackathon changes.
- [ ] **I3.** Prepare a reproducible Testnet demonstration.
- [ ] **I4.** Prepare the physical ESP32 demonstration.
- [ ] **I5.** Record the demo video.
- [ ] **I6.** Capture screenshots and supporting evidence.
- [ ] **I7.** Prepare technical architecture explanation.
- [ ] **I8.** Explain problem, solution and differentiation.
- [ ] **I9.** Recheck official hackathon requirements and deadline.
- [ ] **I10.** Prepare the submission JSON.
- [ ] **I11.** Review the exact submission payload and obtain explicit approval before submission.
- [ ] **I12.** Prepare an X announcement; obtain explicit approval before posting.

## Completion log

Update this section after each task with the date, commit/PR, tests run, evidence links and remaining limitations. Keep the current checkpoint at the top of this document synchronized with the log.

| Date | Task | Result / evidence |
|---|---|---|
| 2026-11-02 | E1 sample agent-to-relay integration | PR #59 merged as `7e17c283b3686e110519cc76ac5047b08dd4dbd2`; CI run [41523732632](https://github.com/manex-tech/tapproved/actions/runs/41523732632) passed all three jobs. Node suite passed 130/130. Added an authenticated agent request example, strict configuration validation, stable idempotency-key behavior, no automatic retries, npm command and README quickstart. No live payment request, NEAR transaction or hardware interaction was performed. |
| 2026-11-02 | D13 disconnect, reset and power-loss recovery | PR #58 merged as `35132ff00d588b16b5f035d7cacb21847461abc7`; CI run [41522764615](https://github.com/manex-tech/tapproved/actions/runs/41522764615) passed Node, contract/Wasm and firmware jobs. Relay can explicitly reconnect after unexpected serial close; reset/stale-response tests prove no signature submission without a completed device response; host NVS model rejects all truncated present seed lengths 0–31. Added `docs/DISCONNECT-RESET-POWER-LOSS.md`. No physical unplug, power-cycle, flash erase or board test was performed. |
| 2026-11-02 | D12 device-key rotation verification | PR #56 merged as `b79b4d1112dd273d36ecde87e38cf9b595a92587`; CI run [41520953304](https://github.com/manex-tech/tapproved/actions/runs/41520953304) passed Node, contract/Wasm and firmware jobs. Contract tests passed 77/77, including successful approval by the rotated key and rejection of the previous key; pending payment and reservation state were preserved. Added `docs/DEVICE-KEY-ROTATION.md`. No live Testnet rotation or hardware modification occurred. |
| 2026-11-02 | D11 ESP32 private-key RAM exposure and security hardening assessment | PR #55 merged as `599b35f8f1b11c97f26e8142a0c9a5649a7af8ce`; CI run [41519115081](https://github.com/manex-tech/tapproved/actions/runs/41519115081) passed Node, contract/Wasm and firmware jobs. Removed the global private seed, reloaded it only after fresh physical approval into scope-bound zeroizing buffers, verified key identity before signing, and added `docs/ESP32-SECURITY-ASSESSMENT.md`. No eFuse programming, flash-encryption activation, debug lockout, firmware flashing or on-chain action occurred. |
| 2026-11-02 | D10 ESP32 NVS key-record integrity | PR #54 merged as `7dcfabe5dda04d3a0c441fe00db4b8dfb55a6e72`; CI run [41515546257](https://github.com/manex-tech/tapproved/actions/runs/41515546257) passed Node, contract/Wasm and firmware jobs. Added fail-closed record policy and host tests for absent, valid and malformed seed records. |
| 2026-11-02 | D9 device errors, timeouts and buffer cleanup | PR #53 merged as `4099118039a2d343cfc2b8b5c27c6af801a0da31`; CI run [41514804700](https://github.com/manex-tech/tapproved/actions/runs/41514804700) passed Node, contract/Wasm and firmware jobs. Added scope-bound volatile zeroization and correlated error/timeout/stale-response tests. |
| 2026-11-02 | D8 expired, malformed and duplicate request rejection | PR #52 merged as `b4c3e3f8d7f5805de73ff32027418c7d8df50f5c`; CI run [41513987249](https://github.com/manex-tech/tapproved/actions/runs/41513987249) passed Node, contract/Wasm and firmware jobs. Added finalized-chain expiry checks before/after hardware approval, malformed context rejection and a 32-ID device replay window. |
| 2026-11-02 | D7 canonical firmware approval encoder | PR #51 merged as `fdad14fc8acd2848041287880f750747e97a23f4`; CI run [41512613016](https://github.com/manex-tech/tapproved/actions/runs/41512613016) passed Node, contract/Wasm and firmware jobs. Firmware C++ encoder matched the shared fixture byte-for-byte; invalid numeric inputs were rejected. |
| 2026-11-02 | D6 intentional GPIO25 approval | PR #50 merged as `5dde9974d82336ad98e3135bda96105d3d93ade5`; CI run [41511889313](https://github.com/manex-tech/tapproved/actions/runs/41511889313) passed Node, contract/Wasm and firmware jobs. Host C++ tests cover held-at-arrival, debounce, short press, bounce and timer rollover. Hardware validation pending. |
| 2026-11-02 | D5 approval amount and identity presentation | PR #49 merged as `1347b7ebf5e2017df335742da449191bab737516`; CI run [41511143294](https://github.com/manex-tech/tapproved/actions/runs/41511143294) passed Node, contract/Wasm and firmware jobs plus host-compiled C++ formatter tests. Integer-only conversion shows readable NEAR and exact yoctoNEAR. |
| 2026-11-02 | D4 payment request validation | PR #48 merged as `57c33bc0960f6321d1a696f5eef9b4043c82b7c2`; CI run [41510304239](https://github.com/manex-tech/tapproved/actions/runs/41510304239) passed Node, contract/Wasm and firmware jobs. Added device-side agent/status checks, account validation, positive/range checks and canonical decimal parsing. Hardware test pending. |
| 2026-11-02 | D3 reliable serial framing/protocol | PR #47 merged as `a9f4dbb05cb4b937ac1a8d6d1066a739eadec01a`; CI run [41509575465](https://github.com/manex-tech/tapproved/actions/runs/41509575465) passed Node, contract/Wasm and firmware jobs. Added versioned request/response envelope and stale-response correlation tests; hardware test pending. |
| 2026-11-02 | D2 canonical contract/network configuration | PR #46 merged as `78affc5526d7777619113481010d476536810223`; CI run [41508750251](https://github.com/manex-tech/tapproved/actions/runs/41508750251) passed Node, contract/Wasm and firmware jobs. Relay RPC and firmware now enforce the canonical testnet configuration. |
| 2026-11-02 | D1 firmware/protocol audit | PR #45 merged as `c94d6440144e766d9fd1367973fb90944b43d164`; CI run [41505991730](https://github.com/manex-tech/tapproved/actions/runs/41505991730) passed firmware, Node and contract jobs. Nine findings recorded with follow-through tasks. |
| 2026-11-02 | B10 implementation and B12 CI verification | PR #24 merged as `67884ca12b799a029d52f60e445600916dd29cce`; CI run [41430358558](https://github.com/manex-tech/tapproved/actions/runs/41430358558), 75 Rust tests passed; empirical Testnet callback-gas measurement deferred to final deployment validation. |
| 2026-11-02 | C1 relay architecture | Added `docs/RELAY-ARCHITECTURE.md`; design reviewed against current relay, contract, protocol and firmware source. |
| 2026-11-02 | C2 agent authentication | PR #27 merged as `cb13b5b1096c79caa8076c72e29a443b962e9f38`; CI run [41461878608](https://github.com/manex-tech/tapproved/actions/runs/41461878608) passed. PR #29 merged as `ef67015a13230e25dfd529a154eb39e9466156c4`; CI run [41464289588](https://github.com/manex-tech/tapproved/actions/runs/41464289588) passed Node, contract and firmware jobs. |
| 2026-11-02 | C3 idempotency foundation | PR #28 merged as `7500f6a965c06ede443551d2a2d67f5904f260f2`; CI run [41463199393](https://github.com/manex-tech/tapproved/actions/runs/41463199393) passed Node tests, 75 Rust contract tests, Wasm build and ESP32 build. |
| 2026-11-02 | C4 restricted NEAR agent signer | PR #30 merged as `826fc47c8dd91e9be04d08c3e70acb99cab11615`; CI run [41466515270](https://github.com/manex-tech/tapproved/actions/runs/41466515270) passed Node, contract and firmware jobs. Live signer preflight awaits owner-provisioned FunctionCall key. |
| 2026-11-02 | C5 automatic execution | PR #31 merged; CI run [41469780643](https://github.com/manex-tech/tapproved/actions/runs/41469780643) passed Node, 75 Rust tests, Wasm build and ESP32 firmware. |
| 2026-11-02 | C6 pending hardware-approval tracking | PR #33 merged as `59873cc671fa6c26a3b208b361d85c0635c5cd50`; CI run [41474877325](https://github.com/manex-tech/tapproved/actions/runs/41474877325) passed Node integration tests, Rust contract tests and Wasm build, and ESP32 firmware builds. Serial delivery remains C7. |

| 2026-11-02 | C7 ESP32 serial transport | PR #35 merged as `2466bca54d171d6f33bc1114ac62f5d7b4a469c5`; CI run [41476684542](https://github.com/manex-tech/tapproved/actions/runs/41476684542) passed Node, Rust contract/Wasm and canonical ESP32 firmware jobs. Added bounded USB serial transport and fixed-size firmware input framing. |
| 2026-11-02 | C8 hardware signature submission | PR #38 merged as `d809fabb183f72ab29520cede341da543e5c0e02`; CI run [41479361939](https://github.com/manex-tech/tapproved/actions/runs/41479361939) passed Node, Rust contract/Wasm and firmware jobs. Added a separate approval-only signer and authenticated one-cycle serial-to-contract flow. Live use awaits owner provisioning of the `approve_spend`-only FunctionCall key. |

| 2026-11-02 | C9 transaction and payment status | PR #40 merged as `a3ffdc562fbdaec2df3b2d66f839583697de2016`; CI run [41483795966](https://github.com/manex-tech/tapproved/actions/runs/41483795966) passed Node integration tests, Rust contract tests/Wasm build and canonical ESP32 firmware build. Added authenticated transaction finality and receipt status reads. |
| 2026-11-02 | C10 payment expiry monitoring | PR #41 merged as `07945758afe0bfa8cb78dbdbb1ff40cb534c0af5`; CI run [41489165448](https://github.com/manex-tech/tapproved/actions/runs/41489165448) passed Node tests, Rust contract tests/Wasm build and ESP32 firmware build. Added finalized-block-time monitoring and an isolated `expire_payment`-only FunctionCall signer. |
| 2026-11-02 | C11 interruption and failure recovery | PR #42 merged as `9f4b521d3611c25edcfd0e12e5b0087a98973bf9`; CI run [41494552737](https://github.com/manex-tech/tapproved/actions/runs/41494552737) passed Node tests, Rust contract tests/Wasm build and ESP32 firmware build. Added durable approval/expiry operation journaling, restart reconciliation, authenticated read-only manual reconciliation, and manual-review handling for unattributed interrupted payment requests. |
| 2026-11-02 | C12 structured logs and error handling | PR #43 merged as `aa31efe8d50f94d397bee6f6fcef739bcfc204a0`; CI run [41499739171](https://github.com/manex-tech/tapproved/actions/runs/41499739171) passed 112 Node tests, Rust contract tests/Wasm build and ESP32 firmware build. Added allowlisted JSON logs, request correlation IDs, route redaction, sanitized errors and logger failure isolation. |\n| 2026-11-02 | C13 automated integration tests | PR #44 merged as `774721d21b9c7244803274a690325f81d3b75058`; CI run [41503118181](https://github.com/manex-tech/tapproved/actions/runs/41503118181) passed 114 Node tests, Rust contract tests/Wasm build and ESP32 firmware build. Added HTTP-level payment/approval/recovery integration tests, including ambiguous approval failure and durable retry suppression. |
