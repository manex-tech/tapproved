# Tapproved: Master Development Checklist

**Purpose:** Track the work required to take Tapproved from a working hardware-backed NEAR prototype to a complete, demonstrable AI-agent spending authorization system.

**Working rule:** Execute one task at a time. Inspect the actual repository state before changing it, make focused changes, run relevant tests, verify evidence, and record the result before advancing. A task is not complete merely because code was written or a command was attempted.

**Last verified source revision:** `1b95c4ab0fa63638948ef46c7f5d9e310cca003a` (2026-11-02)  
**Canonical network:** NEAR Testnet  
**Canonical contract/treasury:** `manextech.testnet`  
**Registered agent:** `manex-agent.testnet`

## Operating rules

- Work strictly one task at a time. Do not skip ahead.
- Before editing, inspect the current branch, commit, working tree and relevant source.
- For each task, record implementation, tests, verification evidence and remaining limitations.
- Distinguish complete, partially complete, blocked and not started work.
- Do not claim a test passed without actual output or a successful CI result.
- No deployment, initialization, transaction signing, payment, transfer, publishing, force-pushing, merging or hackathon submission without explicit approval for that action.
- Never deploy the current keyed 90-day daily-accounting storage layout over the existing `manextech.testnet` deployment. It requires a fresh account unless a separately designed and verified migration is implemented.
- Keep testnet-only limitations explicit. Tapproved is not independently audited and is not production-ready.

## Current checkpoint

**Active task: C2 secure agent authentication.**

The disposable B10 lab firmware branch was merged as PR #26, but the lab account is no longer the target architecture. Development is consolidated around the canonical Testnet contract `manextech.testnet` and registered agent `manex-agent.testnet`. Do not initialize, deploy over, or transfer funds from the canonical contract during implementation. The existing deployed contract's storage-layout compatibility must be assessed before any final redeployment decision.

B10 empirical callback-gas validation is deferred until the final deployment/testing stage. Its 30 TGas callback allocation and recovery implementation remain in the contract; actual Testnet receipt gas evidence is still outstanding.

**C1 completed:** [Relay architecture and trust boundaries](RELAY-ARCHITECTURE.md) defines the agent, relay, signer, contract, serial bridge and ESP32 boundaries; API contract; secret configuration; lifecycle and failure invariants. This is a design baseline, not a claim that these components are implemented.

`main` remains at `1b95c4ab0fa63638948ef46c7f5d9e310cca003a`; the current implementation branch is `feat/phase-c-relay-foundation`.

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

- Use only the disposable Testnet account `contract.tapproved-b10-lab.testnet` for this experiment, not `manextech.testnet`.
- Verify the exact Wasm SHA-256 and source commit before deployment.
- Review initializer arguments, especially owner, agent, 32-byte device public key, soft/hard/daily limits, allowlist and network.
- Check treasury balance and storage metrics before any test payment. Do not assume 1 NEAR is sufficient for all transfers and costs.
- Obtain explicit approval before deploying, initializing, signing or sending any payment.
- Measure callback receipt gas from actual Testnet transaction receipts. Record transfer receipt outcome, callback receipt outcome, gas burnt and remaining margin against 30 TGas.
- Do not use timeout-based release or blindly retry a transfer. The reconciliation boolean is an owner attestation, not on-chain proof.

## Phase C: Relay and backend orchestration

- [x] **C1.** Design relay/backend architecture and trust boundaries. Documented in [RELAY-ARCHITECTURE.md](RELAY-ARCHITECTURE.md); implementation boundaries and security invariants reviewed against current source.
- [ ] **C2.** Implement secure agent authentication.
- [ ] **C3.** Submit agent spending requests.
- [ ] **C4.** Submit contract transactions through a controlled signer flow.
- [ ] **C5.** Execute automatically approved payments.
- [ ] **C6.** Track pending hardware approvals.
- [ ] **C7.** Implement ESP32 serial communication.
- [ ] **C8.** Submit hardware signatures to the contract.
- [ ] **C9.** Track transaction and payment status.
- [ ] **C10.** Monitor payment expiry.
- [ ] **C11.** Handle interruption and failure recovery.
- [ ] **C12.** Implement structured logs and error handling.
- [ ] **C13.** Add automated integration tests.
- [ ] Implement application-level request idempotency keys so transport retries do not create duplicate logical payments.

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
| 2026-11-02 | C1 relay architecture | Added `docs/RELAY-ARCHITECTURE.md` on `feat/phase-c-relay-foundation`; design reviewed against current relay, contract, protocol and firmware source. No runtime code or on-chain state changed. |
