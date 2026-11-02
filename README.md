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

The contract is the policy authority. The relay authenticates agent requests, persists idempotency state and submits `request_spend` through a restricted agent FunctionCall key. When the contract auto-approves a request, the relay also calls `execute_approved_spend` and reads the resulting contract payment state. Hardware approval delivery and full lifecycle tracking remain under development.

## Current project status

| Component | Current status |
|---|---|
| NEAR contract policy and spend lifecycle | Implemented; Rust tests and Wasm build in CI |
| Hardware Ed25519 verification and transfer callback | Implemented |
| Testnet deployment | User-confirmed deployed and tested using NEAR CLI; see [deployment status](docs/TESTNET-DEPLOYMENT.md) |
| ESP32 approval firmware | Implemented prototype; PlatformIO build in CI |
| Approval protocol v1 | Documented with deterministic fixture |
| Relay | Authenticated payment-request API, persistent idempotency journal and restricted signer for `request_spend` plus auto-approved `execute_approved_spend`; hardware approval and lifecycle tracking remain incomplete |
| Local simulator | Implemented; uses an ephemeral key not registered on-chain |
| Agent transaction orchestration | `request_spend` and automatic `execute_approved_spend` submission implemented; recovery remains incomplete |
| Serial relay-to-device bridge | Not implemented |
| Dashboard | Not implemented |
| Independent security audit | Not performed |

The first recorded hardware-gated testnet payment is documented in [the hardware approval milestone](docs/TESTNET-HARDWARE-APPROVAL-MILESTONE.md). That test used the contract account itself as the recipient, so it does not independently prove settlement to an external recipient.

## Architecture

- **Contract:** `contract/src/lib.rs` owns policy, payment state, reservations, signature verification, transfer promises and callbacks.
- **Firmware:** `firmware/src/main.cpp` validates the configured contract/network, reconstructs the v1 message, waits for a physical button press and signs with the device Ed25519 key.
- **Relay:** `relay/server.js` exposes health/read views, authenticated `POST /v1/payment-requests` and `GET /v1/pending-approvals` for the active contract-pending payment; `relay/payment-requests.js` validates requests and persists idempotency; `relay/near-signer.js` verifies and uses a narrowly scoped agent FunctionCall key. `relay/near-rpc.js` queries NEAR views.
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

Set a high-entropy `AGENT_API_TOKEN` and provide `NEAR_SIGNER_PRIVATE_KEY` only if a dedicated, already-registered FunctionCall key exists on `manex-agent.testnet`. That key must be restricted to receiver `manextech.testnet`, methods `request_spend` and `execute_approved_spend` only, and a finite allowance no greater than 5 NEAR. Do not use a FullAccess key. The relay verifies this permission against the live Testnet access-key list and refuses broader keys. Keep `.env` local; it is git-ignored.

Start the relay:

```sh
npm start
```

The relay loads `.env` automatically and defaults to `https://rpc.testnet.near.org`, `manextech.testnet` and `manex-agent.testnet`. If signer configuration or access-key verification fails, the HTTP service starts without payment submission and `POST /v1/payment-requests` returns `503`. No key is created or modified by the relay.

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
