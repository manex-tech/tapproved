# NEAR testnet deployment status

## Canonical configuration

| Role | Account / value |
|---|---|
| Network | `testnet` |
| Contract and treasury | `manextech.testnet` |
| Registered agent | `manex-agent.testnet` |
| Default RPC | `https://rpc.testnet.near.org` |

The project owner confirmed that the replacement Tapproved contract was deployed to `manextech.testnet` and tested using NEAR CLI. This is the canonical deployment used by the current firmware and relay configuration.

This record intentionally does not invent a transaction hash, block height, deployment timestamp or Wasm checksum. Those values are not recorded in the repository's current deployment evidence.

## Historical account-state incident

An earlier attempt to use `manextech.testnet` encountered incompatible pre-existing `presence` state. Tapproved view calls failed to deserialize that state. The current repository does not contain an in-place migration entry point; the incompatible migration implementation was removed. The resolution confirmed by the project owner was deployment of a replacement contract followed by NEAR CLI testing.

Do not follow older instructions that suggest calling a migration method. There is no such method in the current contract ABI.

## Configuration locations

- `firmware/src/main.cpp`: compile-time `CONFIGURED_CONTRACT_ID` and `CONFIGURED_NETWORK_ID`.
- `relay/near-rpc.js`: default contract and RPC URL; environment overrides are validated.
- `.env.example`: local environment-variable reference.

The firmware rejects a request whose contract or network differs from its compiled constants. The relay accepts only HTTPS RPC URLs and testnet account IDs.

## Verification checklist for a future redeployment

Before any future deployment or account change:

1. Build the release Wasm from the intended commit.
2. Record the Wasm SHA-256 checksum.
3. Confirm the target account and network.
4. Review initializer arguments, especially owner, agent, device key, limits and allowlist.
5. Deploy and initialize only with explicit operator approval.
6. Query `get_policy` and verify every field.
7. Confirm the firmware and relay configuration match the deployed account/network.
8. Run a controlled testnet payment and verify the terminal payment view and transfer callback.

Deployment and on-chain transactions require explicit operator approval. This document is a status record, not authorization to deploy.
