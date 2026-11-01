# Tapproved

**AI agents can't spend big without your tap.**

Tapproved is a hardware-backed spending approval system for AI agents on NEAR. Agents can spend within an on-chain policy; payments requiring human approval wait for a physical ESP32 button press and a device signature.

Built for **NEAR HACKATHON**. Tracks: **AI Security & Defense** and **Agent Economy**. **Testnet only.**

## Problem

AI agents can initiate financial actions faster than a human can review them. Wallet permissions alone do not provide a clear, enforceable boundary between routine spending and exceptional payments. A compromised or misconfigured agent can therefore create outsized financial risk. Tapproved adds an on-chain spending policy and a physical approval step for payments above a configured soft limit.

## Approach

A NEAR contract enforces per-transaction and daily spending limits, recipient restrictions, and payment state. Routine payments within policy can proceed automatically. Payments above the soft limit require a signature from a registered hardware approval device. The relay coordinates requests, while the contract remains authoritative for policy enforcement and settlement.

## Project status

The project is under active development. The contract's first three implementation stages are merged into `main`, and the main-branch GitHub Actions checks have passed. The contract has been deployed to NEAR testnet at `manextech.testnet`. Its prior `presence` state was incompatible with Tapproved's Borsh state and caused view calls to panic; this PR adds a guarded recovery path and regression coverage. The migration is not considered complete until CI passes and the guarded migration is explicitly executed and verified.

| Component | Status |
|---|---|
| On-chain policy initialization and validation | Implemented; CI passing |
| Spend requests, limits, reservations and expiry | Implemented; CI passing |
| Device signature verification and transfer callbacks | Implemented; CI passing |
| Contract deployment to NEAR testnet | Not yet deployed |
| ESP32 firmware and physical approval flow | Next implementation stage |
| Relay payment integration | Scaffold only |
| Local simulator | Planned |
| Scripted AI agent | Planned |
| NEAR AI Cloud agent | Planned |
| Dashboard | Planned |

### Validation status

GitHub Actions currently runs the Rust contract tests, builds the contract for `wasm32-unknown-unknown`, and checks the Node.js relay syntax. The latest main-branch workflow completed successfully.

The current contract test suite is not a substitute for end-to-end testing. Signature interoperability vectors, transfer success/failure integration tests, and full device-to-contract testing remain outstanding. The project has not been independently audited.

## Testnet deployment incident: incompatible prior state

The intended architecture remains `manextech.testnet` as Tapproved's permanent contract and owner account, with `manex-agent.testnet` as its registered agent. The contract account was not fresh: raw storage showed a `STATE` value beginning with the Borsh string `presence`, alongside unrelated `presence# Tapproved

**AI agents can't spend big without your tap.**

Tapproved is a hardware-backed spending approval system for AI agents on NEAR. Agents can spend within an on-chain policy; payments requiring human approval wait for a physical ESP32 button press and a device signature.

Built for **NEAR HACKATHON**. Tracks: **AI Security & Defense** and **Agent Economy**. **Testnet only.**

## Problem

AI agents can initiate financial actions faster than a human can review them. Wallet permissions alone do not provide a clear, enforceable boundary between routine spending and exceptional payments. A compromised or misconfigured agent can therefore create outsized financial risk. Tapproved adds an on-chain spending policy and a physical approval step for payments above a configured soft limit.

## Approach

A NEAR contract enforces per-transaction and daily spending limits, recipient restrictions, and payment state. Routine payments within policy can proceed automatically. Payments above the soft limit require a signature from a registered hardware approval device. The relay coordinates requests, while the contract remains authoritative for policy enforcement and settlement.

## Project status

The project is under active development. The contract's first three implementation stages are merged into `main`, and the main-branch GitHub Actions checks have passed. The contract has been deployed to NEAR testnet at `manextech.testnet`. Its prior `presence` state was incompatible with Tapproved's Borsh state and caused view calls to panic; this PR adds a guarded recovery path and regression coverage. The migration is not considered complete until CI passes and the guarded migration is explicitly executed and verified.

| Component | Status |
|---|---|
| On-chain policy initialization and validation | Implemented; CI passing |
| Spend requests, limits, reservations and expiry | Implemented; CI passing |
| Device signature verification and transfer callbacks | Implemented; CI passing |
| Contract deployment to NEAR testnet | Not yet deployed |
| ESP32 firmware and physical approval flow | Next implementation stage |
| Relay payment integration | Scaffold only |
| Local simulator | Planned |
| Scripted AI agent | Planned |
| NEAR AI Cloud agent | Planned |
| Dashboard | Planned |

### Validation status

GitHub Actions currently runs the Rust contract tests, builds the contract for `wasm32-unknown-unknown`, and checks the Node.js relay syntax. The latest main-branch workflow completed successfully.

The current contract test suite is not a substitute for end-to-end testing. Signature interoperability vectors, transfer success/failure integration tests, and full device-to-contract testing remain outstanding. The project has not been independently audited.

 and `presence_name:` keys. After the Tapproved WASM was deployed, `get_policy` and `get_active_payment` both failed with `Cannot deserialize the contract state`.

This was a state-layout incompatibility, not a WASM checksum mismatch. The deployed WASM checksum matched the locally built artifact. Calling ordinary `new` was also incorrect because NEAR reported that the account was already initialized.

This PR adds `migrate_from_incompatible_state`, using NEAR SDK's `#[init(ignore_state)]` to replace only the incompatible main contract state. It leaves unrelated storage keys intact, requires the contract account itself to authorize the transaction, and records a separate one-time migration marker. It creates a fresh Tapproved policy; it does not import the old `presence` data or old contract logic.

**Operational warning:** retain the raw storage dump. Do not call ordinary `new` again. Do not invoke migration until this PR passes CI, the resulting WASM checksum is verified, and the initialization arguments are reviewed. After migration, verify `get_policy` and `get_active_payment` through read-only calls before requesting any spend. Testnet only.

## Origin

This repository started on **2026-11-01**. The concept grew out of the attendance prototype at https://github.com/manex-tech/near-tap. **No code was carried over** from that repository.

## Development disclosure

Code in this repository is being developed with AI assistance. The project author reviews and directs the implementation. AI assistance does not constitute an independent security review or audit.

## Known limitations

- Blind signing remains a limitation until the device can display and let the user verify transaction details.
- The device signing key may be extractable unless appropriate hardware and flash protections are configured.
- The project is for NEAR testnet only; mainnet use is out of scope.
- The contract, firmware, relay and overall system have not been independently audited.

## License

MIT. See [LICENSE](LICENSE).
