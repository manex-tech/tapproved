# Tapproved

**AI agents cannot spend above their routine limit without a physical approval.**

**Project tracking:** [Master Development Checklist](docs/MASTER-DEVELOPMENT-CHECKLIST.md) — canonical task-by-task progress, verification evidence and next checkpoint.

Tapproved is a testnet prototype for hardware-backed spending authorization on NEAR. A registered agent requests payments from a contract-controlled treasury. The contract enforces spending policy. Payments within the soft limit can be executed automatically; larger payments require an Ed25519 signature from a registered ESP32 device after a physical button press.

**Network:** NEAR testnet  
**Contract:** `manextech.testnet`  
**Agent:** `manex-agent.testnet`  
**Hardware:** ESP32-WROOM-32, approval button on GPIO25

This repository is under active development for the NEAR Hackathon. It is not audited and must not be used with production keys or real funds.

## How it works

1. The registered agent calls `request_spend` on the contract.
2. The contract checks that spending is not paused, no other payment is active, the recipient is allowlisted, the amount is positive and within the hard per-payment limit, and the UTC-day reservation remains within the daily limit.
3. Amounts at or below the soft limit become `approved`. Larger amounts become `pending`.
4. An automatically approved payment can be executed with `execute_approved_spend`. A pending payment requires the ESP32 to sign the canonical approval message after a physical GPIO25 press; the signature is submitted to `approve_spend`.
5. The contract transfers NEAR from its own account and a private callback records `paid` or `failed`. Expired pending/approved payments are also cleaned up when the next valid request arrives; owner cancellation releases eligible reservations.

The contract is the policy authority. The relay authenticates agent requests, persists idempotency state, submits `request_spend` through a restricted FunctionCall key and executes only contract-approved low-value payments. Pending hardware approvals travel over the bounded USB serial bridge to the ESP32; the relay verifies the returned device key and Ed25519 signature before submitting `approve_spend` through a separate approval-only key. Authenticated APIs expose payment state and transaction receipts. A separate expiry-only FunctionCall key lets a background monitor call the contract's permissionless `expire_payment` method after the finalized NEAR block time passes the payment expiry.

## Current project status

| Component | Current status |
|---|---|
| NEAR contract policy and spend lifecycle | Implemented; Rust tests and Wasm build in CI |
| Hardware Ed25519 verification and transfer callback | Implemented |
| Testnet deployment | User-confirmed deployed and tested using NEAR CLI; see [deployment status](docs/TESTNET-DEPLOYMENT.md) |
| ESP32 approval firmware | Implemented prototype; exact NEAR and yoctoNEAR approval summary, recipient/payment ID presentation, PlatformIO build and host-compiled amount-format tests in CI; D1 source audit completed with nine findings allocated to Phase D follow-through |
| Firmware/protocol audit | [D1 audit report](docs/FIRMWARE-PROTOCOL-AUDIT.md); findings are not yet fixes |
| Approval protocol v1 | Documented with deterministic fixture |
| Relay | Authenticated payment, approval, transaction and recovery APIs; RPC configuration locked to `testnet`, `manextech.testnet` and `manex-agent.testnet`; durable request/operation journal; separate least-privilege request, approval and expiry signers; bounded ESP32 serial bridge; transaction receipt polling; finalized-chain-time expiry and restart-recovery monitors; HTTP-level integration coverage for payment, hardware approval, idempotency and recovery flows |
| Local simulator | Implemented; uses an ephemeral key not registered on-chain |
| Agent transaction orchestration | `request_spend`, automatic `execute_approved_spend`, and durable restart recovery for approval/expiry operations implemented; uncertain request attribution is retained for manual review |
| Serial relay-to-device bridge | Bounded newline-delimited USB serial transport with versioned UUID-correlated request/response frames, ESP32 frame parser validates the canonical agent, pending status, recipient account syntax, positive bounded integers and canonical decimal encodings; one-cycle approval/signature submission is implemented; transaction and receipt status API now provides explicit finality and receipt outcomes |
| Dashboard | Not implemented |
| Independent security audit | Not performed |

The first recorded hardware-gated testnet payment is documented in [the hardware approval milestone](docs/TESTNET-HARDWARE-APPROVAL-MILESTONE.md). That test used the contract account itself as the recipient, so it does not independently prove settlement to an external recipient.

## Relay approval-tracking API

All routes below require the configured bearer token except `GET /health`.

- `GET /v1/pending-approvals` returns the active payment only when the contract status is exactly `pending`. Its `approval_request` contains the canonical contract ID and network ID plus the contract-derived payment ID, recipient, exact yoctoNEAR amount, nonce and expiry timestamp. It returns `approval_required: false` and null payment/request fields when no hardware approval is pending.
- `GET /v1/payments/:paymentId` reads the requested payment from the contract and returns its current lifecycle status. The response distinguishes pending approval from terminal `paid`, `failed`, `expired` and `cancelled` states. Missing or foreign-agent payment records are not exposed.
- `GET /v1/transactions/:hash` queries NEAR transaction execution and receipt outcomes for the canonical agent signer. The default `wait_until=NONE` returns the current state immediately. Use `?wait_until=FINAL` to wait up to the RPC node's finality timeout for all receipts; incomplete or timed-out transactions return HTTP 202 for polling. The response omits raw transaction arguments and signatures.
- The three `GET` routes are read-only. They do not approve, expire, execute or transfer funds. Contract state remains authoritative.
- `POST /v1/approvals/process` starts one explicit hardware-approval cycle: it reads the current contract-pending payment, sends it over the configured serial bridge, verifies the returned key against the on-chain device key and checks the v1 Ed25519 signature locally before submitting `approve_spend`. It does not accept caller-supplied payment fields.
- `POST /v1/recovery/reconcile` runs an authenticated, read-only reconciliation pass. It checks unresolved approval/expiry operations against canonical `get_payment` state and repairs journal state only. It does not broadcast or retry transactions. Interrupted payment-request submissions remain unresolved for manual review because the contract does not store the HTTP idempotency key; recipient/amount equality is not sufficient proof of attribution.

The pending-approval API returns contract-derived fields. C7 adds a bounded newline-delimited USB serial transport at 115200 baud with a 2,048-byte frame limit and 35-second default approval timeout. It permits one outstanding approval and does not automatically retry a physical approval. C8 adds an authenticated `POST /v1/approvals/process` one-cycle operation. The relay checks the returned public key against `get_policy.device_public_key`, verifies the canonical v1 signature, and submits `approve_spend` using a separate FunctionCall key restricted to that method. It never retries an ambiguous approval submission automatically.

C10 adds a background expiry keeper. It compares the active payment's `expires_at_ns` with the latest finalized NEAR block timestamp, then calls the contract's permissionless `expire_payment` method only for an expired `pending` or `approved` payment. A third FunctionCall key is restricted to `expire_payment` only. The contract rechecks expiry, releases the original reservation and clears the active payment. C11 adds durable approval/expiry operation markers, startup and periodic reconciliation against canonical contract state, and an authenticated manual reconciliation endpoint. A known pre-submit hardware/signature rejection can be retried; an ambiguous broadcast is never automatically resubmitted. Interrupted payment-request records remain for manual review because the contract does not persist the HTTP idempotency key, so recipient/amount matching cannot safely identify the originating request. `RECOVERY_MONITOR_INTERVAL_MS` defaults to 30000 and accepts values from 5000 through 3600000.

C12 adds structured JSON relay logs with UTC timestamps, severity, stable event names, per-request correlation IDs and request duration/status. Every HTTP response includes an `x-request-id` header. Logs use an explicit field allowlist and route templates; authorization headers, tokens, private keys, signatures, request bodies, query strings, raw exception messages and stack traces are excluded. Validation errors return stable public error codes rather than internal exception text. Logger sink failures are contained so logging cannot interrupt payment or recovery control flow.

C13 adds `relay/integration.test.js`, an HTTP-level integration suite that composes the relay server, durable idempotency journal, approval processor and recovery service with deterministic in-memory contract, signer and serial adapters. It verifies authenticated payment creation, pending hardware-approval context, a single approval cycle, payment status reads, durable idempotent replay and successful reconciliation. A separate failure-path test verifies that an ambiguous approval submission is journaled as uncertain, is not resubmitted on retry, and remains visible for manual recovery. These tests do not use live NEAR RPC, hardware, signing keys or on-chain transactions.

## Architecture

- **Contract:** `contract/src/lib.rs` owns policy, payment state, reservations, signature verification, transfer promises and callbacks.
- **Firmware:** `firmware/src/main.cpp` validates the configured contract/network, reconstructs the v1 message, waits for a physical button press and signs with the device Ed25519 key.
- **Relay:** `relay/server.js` exposes authenticated payment, approval and status APIs; `relay/payment-requests.js` validates requests and persists idempotency; `relay/near-signer.js` and `relay/approval-service.js` enforce separate least-privilege request/execution and hardware-approval keys. `relay/near-rpc.js` queries NEAR views and transaction receipt status; `relay/serial.js` provides bounded, one-at-a-time USB serial approval transport; `relay/recovery-service.js` reconciles interrupted journal operations from canonical contract state without transaction resubmission. `relay/structured-logger.js` emits allowlisted JSON events and sanitized error metadata.
- **Protocol:** `docs/APPROVAL-PROTOCOL.md` defines the exact signed byte sequence. `protocol/v1-vector.json` is a deterministic interoperability fixture.
- **Simulator:** `relay/simulator.js` locally demonstrates encoding and signing with a temporary keypair. It cannot authorize an on-chain payment.

## Repository setup and checks

Requirements: Node.js 22.22.2 or newer, Rust stable with `wasm32-unknown-unknown`, and PlatformIO Core 6.1.18.

Install Node dependencies and run checks:

```sh
npm ci
npm run check
```

Run contract tests and build the deployable Wasm:

```sh
cd contract
cargo test
cargo build --target wasm32-unknown-unknown --release
```

Build the ESP32 firmware:

```sh
cd firmware
pio run
```

Configure the relay from the repository root:

```sh
cp .env.example .env
```

Set a high-entropy `AGENT_API_TOKEN` and provide `NEAR_SIGNER_PRIVATE_KEY` only if a dedicated, already-registered FunctionCall key exists on `manex-agent.testnet`. That key must be restricted to receiver `manextech.testnet`, methods `request_spend` and `execute_approved_spend` only, and a finite allowance no greater than 5 NEAR. Set `NEAR_APPROVAL_SIGNER_PRIVATE_KEY` to a second Ed25519 FunctionCall key on `manex-agent.testnet`, restricted to receiver `manextech.testnet` and method `approve_spend` only, with a finite allowance no greater than 5 NEAR. Set `NEAR_EXPIRY_SIGNER_PRIVATE_KEY` to a third, separate Ed25519 FunctionCall key restricted to receiver `manextech.testnet` and method `expire_payment` only, also with a finite allowance no greater than 5 NEAR. `EXPIRY_MONITOR_INTERVAL_MS` defaults to 15000 and accepts values from 1000 through 3600000. `RECOVERY_MONITOR_INTERVAL_MS` defaults to 30000 and accepts values from 5000 through 3600000. Do not use a FullAccess key. The relay verifies this permission against the live Testnet access-key list and refuses broader keys. Keep `.env` local; it is git-ignored. For the ESP32 USB serial transport, set `SERIAL_PORT` to the local device path (for example `/dev/ttyUSB0` on Linux or `COM7` on Windows). The default baud rate is 115200 and the approval response timeout is 35 seconds.

Start the relay:

```sh
npm start
```

The relay loads `.env` automatically and defaults to `https://rpc.testnet.near.org`, `manextech.testnet` and `manex-agent.testnet`. If either signer configuration or access-key verification fails, the HTTP service starts with the corresponding operation disabled. `POST /v1/payment-requests` returns `503` if the request/execution signer is unavailable; `POST /v1/approvals/process` returns `503` if the approval signer or serial port is unavailable. The owner must provision both restricted keys separately; the relay never creates or modifies keys.

Run the local-only simulator:

```sh
npm run simulate
```

CI runs Node syntax/tests, Rust contract tests plus a release Wasm build, and an ESP32 PlatformIO build.

## Key policy and limitations

- The contract account is the treasury: transfers are made from the contract's NEAR balance, not from the agent's own wallet.
- Only one payment may be active at a time.
- Payment requests expire after five minutes. `expire_payment` is permissionless, and a subsequent valid request automatically expires a stale pending/approved payment. Processing payments cannot be auto-expired.
- Payment history is capped at 1,000 retained records. The oldest terminal records are pruned when a new record is inserted at capacity.
- Daily usage is keyed by UTC day and retains at most 90 day records. The view separates committed spend from outstanding reservations and reports used and remaining capacity; the daily limit applies to spent plus reserved.
- Successful settlement moves the amount from reserved to spent. Failed, expired and cancelled payments release the reservation. Older daily records are pruned on a new request, but records with outstanding reservations are never discarded.
- The owner can atomically update soft, hard and daily limits; reductions below any retained day's spent-plus-reserved usage are rejected. The recipient allowlist is capped at 100 accounts.
- Firmware stores the Ed25519 seed in ordinary ESP32 NVS. Secure boot, flash encryption, debug-port hardening, authenticated device transport and a trusted display are not configured.
- Serial output is not a trusted display. A compromised host or relay could misrepresent the payment details shown to the operator.
- The hardware milestone used the contract account as recipient. External-recipient settlement and broader end-to-end automation still need explicit testing.
- The project has not undergone an independent security audit. Testnet only.

## Documentation

- [Contract behavior and invariants](docs/CONTRACT.md)
- [Testnet deployment status](docs/TESTNET-DEPLOYMENT.md)
- [Hardware approval milestone](docs/TESTNET-HARDWARE-APPROVAL-MILESTONE.md)
- [Approval protocol v1](docs/APPROVAL-PROTOCOL.md)
- [Firmware and protocol audit](docs/FIRMWARE-PROTOCOL-AUDIT.md)
- [Local simulator](docs/SIMULATOR.md)

## License

MIT. See [LICENSE](LICENSE).
