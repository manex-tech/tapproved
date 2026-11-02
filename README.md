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

The contract is the policy authority. The relay authenticates agent requests, persists idempotency state and submits `request_spend` through a restricted agent FunctionCall key. When the contract auto-approves a request, the relay also calls `execute_approved_spend` and reads the resulting contract payment state. Pending hardware approvals are exposed through an authenticated contract-backed poll, and individual payment states can be queried by payment ID. The relay returns a device-ready approval context but does not yet transport it to the ESP32.

## Current project status

| Component | Current status |
|---|---|
| NEAR contract policy and spend lifecycle | Implemented; Rust tests and Wasm build in CI |
| Hardware Ed25519 verification and transfer callback | Implemented |
| Testnet deployment | User-confirmed deployed and tested using NEAR CLI; see [deployment status](docs/TESTNET-DEPLOYMENT.md) |
| ESP32 approval firmware | Implemented prototype; PlatformIO build in CI |
| Approval protocol v1 | Documented with deterministic fixture |
| Relay | Authenticated payment-request API, persistent idempotency journal, restricted signer, pending-approval polling, payment status reads and authenticated hardware approval; transaction status and receipt tracking are implemented with explicit finality states |
| Local simulator | Implemented; uses an ephemeral key not registered on-chain |
| Agent transaction orchestration | `request_spend` and automatic `execute_approved_spend` submission implemented; recovery remains incomplete |
| Serial relay-to-device bridge | Bounded newline-delimited USB serial transport, ESP32 frame parser and one-cycle approval/signature submission are implemented; transaction and receipt status API now provides explicit finality and receipt outcomes |
| Dashboard | Not implemented |
| Independent security audit | Not performed |

The first recorded hardware-gated testnet payment is documented in [the hardware approval milestone](docs/TESTNET-HARDWARE-APPROVAL-MILESTONE.md). That test used the contract account itself as the recipient, so it does not independently prove settlement to an external recipient.

## Relay approval-tracking API

All routes below require the configured bearer token except `GET /health`.

- `GET /v1/pending-approvals` returns the active payment only when the contract status is exactly `pending`. Its `approval_request` contains the canonical contract ID and network ID plus the contract-derived payment ID, recipient, exact yoctoNEAR amount, nonce and expiry timestamp. It returns `approval_required: false` and null payment/request fields when no hardware approval is pending.
- `GET /v1/payments/:paymentId` reads the requested payment from the contract and returns its current lifecycle status. The response distinguishes pending approval from terminal `paid`, `failed`, `expired` and `cancelled` states. Missing or foreign-agent payment records are not exposed.
- `GET /v1/transactions/:hash` queries NEAR transaction execution and receipt outcomes for the canonical agent signer. Use `?wait_until=FINAL` to wait for final receipts; incomplete transactions return HTTP 202 for polling. The response omits raw transaction arguments and signatures.
- Both endpoints are read-only. They do not approve, expire, execute or transfer funds. Contract state remains authoritative.\n- `POST /v1/approvals/process` starts one explicit hardware-approval cycle: it reads the current contract-pending payment, sends it over the configured serial bridge, verifies the returned key against the on-chain device key and checks the v1 Ed25519 signature locally before submitting `approve_spend`. It does not accept caller-supplied payment fields.

The pending-approval API returns contract-derived fields. C7 adds a bounded newline-delimited USB serial transport at 115200 baud with a 2,048-byte frame limit and 35-second default approval timeout. It permits one outstanding approval and does not automatically retry a physical approval. C8 adds an authenticated `POST /v1/approvals/process` one-cycle operation. The relay checks the returned public key against `get_policy.device_public_key`, verifies the canonical v1 signature, and submits `approve_spend` using a separate FunctionCall key restricted to that method. It never retries an ambiguous approval submission automatically.

## Architecture

- **Contract:** `contract/src/lib.rs` owns policy, payment state, reservations, signature verification, transfer promises and callbacks.
- **Firmware:** `firmware/src/main.cpp` validates the configured contract/network, reconstructs the v1 message, waits for a physical button press and signs with the device Ed25519 key.
- **Relay:** `relay/server.js` exposes authenticated payment, approval and status APIs; `relay/payment-requests.js` validates requests and persists idempotency; `relay/near-signer.js` and `relay/approval-service.js` enforce separate least-privilege request/execution and hardware-approval keys. `relay/near-rpc.js` queries NEAR views and transaction receipt status; `relay/serial.js` provides bounded, one-at-a-time USB serial approval transport.
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

Set a high-entropy `AGENT_API_TOKEN` and provide `NEAR_SIGNER_PRIVATE_KEY` only if a dedicated, already-registered FunctionCall key exists on `manex-agent.testnet`. That key must be restricted to receiver `manextech.testnet`, methods `request_spend` and `execute_approved_spend` only, and a finite allowance no greater than 5 NEAR. Set `NEAR_APPROVAL_SIGNER_PRIVATE_KEY` to a second Ed25519 FunctionCall key on `manex-agent.testnet`, restricted to receiver `manextech.testnet` and method `approve_spend` only, with a finite allowance no greater than 5 NEAR. Do not use a FullAccess key. The relay verifies this permission against the live Testnet access-key list and refuses broader keys. Keep `.env` local; it is git-ignored. For the ESP32 USB serial transport, set `SERIAL_PORT` to the local device path (for example `/dev/ttyUSB0` on Linux or `COM7` on Windows). The default baud rate is 115200 and the approval response timeout is 35 seconds.

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
- [Local simulator](docs/SIMULATOR.md)

## License

MIT. See [LICENSE](LICENSE).
