# Tapproved: Master Development Checklist

**Purpose:** Track the work required to take Tapproved from a working hardware-backed NEAR prototype to a complete, demonstrable AI-agent spending authorization system.

**Working rule:** Execute one task at a time. Inspect the actual repository state before changing it, make focused changes, run relevant tests, verify evidence, and record the result before advancing. A task is not complete merely because code was written or a command was attempted.

**Last inspected implementation revision:** `3ed993b5ec164f8143a0f81d3fe01256e19f9360` (2026-11-02)  
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

**Active task: C11 interruption and failure recovery.**

The disposable B10 lab firmware branch was merged as PR #26, but the lab account is no longer the target architecture. Development is consolidated around the canonical Testnet contract `manextech.testnet` and registered agent `manex-agent.testnet`. Do not initialize, deploy over, or transfer funds from the canonical contract during implementation. The existing deployed contract's storage-layout compatibility must be assessed before any final redeployment decision.

B10 empirical callback-gas validation is deferred until the final deployment/testing stage. Its 30 TGas callback allocation and recovery implementation remain in the contract; actual Testnet receipt gas evidence is still outstanding.

**C1 completed:** [Relay architecture and trust boundaries](RELAY-ARCHITECTURE.md) defines the agent, relay, signer, contract, serial bridge and ESP32 boundaries; API contract; secret configuration; lifecycle and failure invariants. This is a design baseline, not a claim that these components are implemented.

`main` is at `07945758afe0bfa8cb78dbdbb1ff40cb534c0af5`. PRs #27 and #29 delivered authenticated payment requests; PR #28 added durable idempotency; PR #30 added the restricted NEAR agent signer; PR #31 added automatic execution; PR #33 added pending-approval and payment-status reads; PR #35 completed bounded ESP32 serial transport and firmware framing; PR #38 added the one-cycle hardware approval flow and separate `approve_spend`-only signer; PR #40 added authenticated transaction and receipt status tracking; PR #41 completed finalized-chain-time expiry monitoring with a separate `expire_payment`-only signer. Live approval and automatic expiry remain disabled until the owner provisions their respective restricted FunctionCall keys on `manex-agent.testnet`.

C10 is complete and merged in PR #41. CI run [41489165448](https://github.com/manex-tech/tapproved/actions/runs/41489165448) passed Node tests, Rust contract tests/Wasm build and ESP32 firmware build. The expiry keeper remains disabled in a live relay until the owner provisions the separate `expire_payment`-only FunctionCall key.

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
- [x] **C10.** Monitor payment expiry. PR #41 adds a background keeper that compares the active payment expiry with finalized NEAR block time, then calls permissionless `expire_payment` through a separate FunctionCall key restricted to that method only. It confirms the contract reports `expired`, suppresses overlapping polls and never blindly retries an ambiguous submission within the same process. CI run [41489165448](https://github.com/manex-tech/tapproved/actions/runs/41489165448) passed Node tests, Rust contract tests/Wasm build and ESP32 firmware build. Restart-safe reconciliation remains C11.
- [ ] **C11.** Handle interruption and failure recovery. Persist approval and expiry operation markers before broadcasting; reconcile interrupted request submissions only when exactly one unresolved idempotency record matches the canonical active payment; reconcile approval/expiry operations from `get_payment`; provide authenticated manual reconciliation; preserve ambiguous/no-match cases for manual review. Never automatically resubmit an uncertain transaction. Verify restart, RPC outage, serial interruption, duplicate request and ambiguous-broadcast cases in CI.
- [ ] **C12.** Implement structured logs and error handling.
- [ ] **C13.** Add automated integration tests.
- [x] Implement application-level request idempotency keys so transport retries do not create duplicate logical payments. PR #28 provides a durable single-process journal with restart persistence, conflict detection and fail-closed uncertain states; multi-instance deployments still require a shared transactional store.

## Phase D: Hardware security and firmware

- [ ] **D1.** Audit the firmware against the contract and approval protocol.
- [ ] **D2.** Verify canonical contract/network configuration.
- [ ] **D3.** Define reliable hardware communication framing and protocol.
- [ ] **D4.** Receive and validate payment requests.
- [ ] **D5.** Present amount, recipient and payment ID clearly before approval.
- [ ] **D6.** Require intentional physical approval through GPIO25.
- [ ] **D7.** Sign only the canonical approval message.
- [ ] **D8.** Reject expired, malformed and duplicate requests.
- [ ] **D9.** Handle device errors and timeouts safely.
- [ ] **D10.** Review private-key storage in ESP32 NVS.
- [ ] **D11.** Evaluate secure boot, flash encryption and debug-interface hardening.
- [ ] **D12.** Test device-key rotation.
- [ ] **D13.** Test disconnection, reset and power-loss behavior.

## Phase E: End-to-end payment automation

- [ ] **E1.** Connect an agent to the relay.
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
