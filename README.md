# Tapproved

**AI agents cannot spend above their routine limit without a physical approval.**

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
5. The contract transfers NEAR from its own account and a private callback records `paid` or `failed`. Expiry and owner cancellation release reservations.

The contract is the policy authority. The relay is currently read-only and does not yet orchestrate this complete flow.

## Current project status

| Component | Current status |
|---|---|
| NEAR contract policy and spend lifecycle | Implemented; Rust tests and Wasm build in CI |
| Hardware Ed25519 verification and transfer callback | Implemented |
| Testnet deployment | User-confirmed deployed and tested using NEAR CLI; see [deployment status](docs/TESTNET-DEPLOYMENT.md) |
| ESP32 approval firmware | Implemented prototype; PlatformIO build in CI |
| Approval protocol v1 | Documented with deterministic fixture |
| Relay | Read-only HTTP endpoints for health, policy and active payment |
| Local simulator | Implemented; uses an ephemeral key not registered on-chain |
| Agent transaction orchestration | Not implemented |
| Serial relay-to-device bridge | Not implemented |
| Dashboard | Not implemented |
| Independent security audit | Not performed |

The first recorded hardware-gated testnet payment is documented in [the hardware approval milestone](docs/TESTNET-HARDWARE-APPROVAL-MILESTONE.md). That test used the contract account itself as the recipient, so it does not independently prove settlement to an external recipient.

## Architecture

- **Contract:** `contract/src/lib.rs` owns policy, payment state, reservations, signature verification, transfer promises and callbacks.
- **Firmware:** `firmware/src/main.cpp` validates the configured contract/network, reconstructs the v1 message, waits for a physical button press and signs with the device Ed25519 key.
- **Relay:** `relay/server.js` exposes read-only HTTP endpoints. `relay/near-rpc.js` queries NEAR views.
- **Protocol:** `docs/APPROVAL-PROTOCOL.md` defines the exact signed byte sequence. `protocol/v1-vector.json` is a deterministic interoperability fixture.
- **Simulator:** `relay/simulator.js` locally demonstrates encoding and signing with a temporary keypair. It cannot authorize an on-chain payment.

## Repository setup and checks

Requirements: Node.js 22+, Rust stable with `wasm32-unknown-unknown`, and PlatformIO Core 6.1.18.

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

Run the read-only relay from the repository root:

```sh
npm start
```

The relay defaults to `https://rpc.testnet.near.org` and `manextech.testnet`. Local overrides are documented in `.env.example`; the application does not automatically load that file, so export the variables in your shell or use your preferred environment loader.

Run the local-only simulator:

```sh
npm run simulate
```

CI runs Node syntax/tests, Rust contract tests plus a release Wasm build, and an ESP32 PlatformIO build.

## Key policy and limitations

- The contract account is the treasury: transfers are made from the contract's NEAR balance, not from the agent's own wallet.
- Only one payment may be active at a time.
- Payment requests expire after five minutes. Expiry is permissionless but requires someone to call `expire_payment`; there is no automated expiry keeper yet.
- Payment history is capped at 1,000 retained records. The oldest terminal records are pruned when a new record is inserted at capacity.
- Daily usage is currently held in a vector and searched linearly. This data structure is not yet bounded or optimized for long-running deployments.
- The daily reservation remains counted after successful payment as consumed daily capacity. Failed, expired and cancelled payments release their reservation.
- Spending limits are initialized at deployment; there are currently no owner methods to change the soft, hard or daily limits.
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
