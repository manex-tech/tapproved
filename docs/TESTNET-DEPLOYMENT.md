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

The canonical account is the replacement Tapproved deployment and uses the pre-keyed daily-accounting Borsh layout, where `daily_usage` is a `Vec<LegacyDailyUsageV1>`. The current source now includes a one-time `migrate()` initializer for this exact layout. It preserves the existing account, owner, agent, device public key, policy limits, allowlist, pause state, payment counters, active payment and payment `LookupMap` (prefix `p`). It converts legacy daily totals into separate committed spend and outstanding reservation records in a new `LookupMap` (prefix `d`). This is an in-place migration; a fresh account is not required for the documented pre-keyed deployment.

The migration is deliberately fail-closed. It checks the active payment record and its daily reservation, rejects duplicate/future day records and inconsistent active state, preserves the active payment's reservation, and prunes only old daily records outside the 90-day window when they have no active reservation. A state-version marker prevents a second migration. The migration must be called once immediately after the Wasm upgrade, using the `manextech.testnet` account key because the method is private. Do not call `new` on the existing account. See the migration runbook below and [the contract migration notes](CONTRACT.md).

## Historical account-state incident

An earlier, superseded deployment attempt encountered incompatible pre-existing `presence` state. That historical layout is not the target of the current migration. The owner resolved that incident by deploying the replacement Tapproved contract to `manextech.testnet` and testing it with NEAR CLI. The new `migrate()` method applies only to the subsequent, documented change from the replacement deployment's Vec-based daily accounting to keyed daily accounting; it is not a migration from the old `presence` contract.

## Configuration locations

- `firmware/src/main.cpp`: compile-time `CONFIGURED_CONTRACT_ID` and `CONFIGURED_NETWORK_ID`.
- `relay/near-rpc.js`: default contract and RPC URL; environment overrides are validated.
- `.env.example`: local environment-variable reference.

The firmware rejects a request whose contract or network differs from its compiled constants. The relay accepts only HTTPS RPC URLs and testnet account IDs.

## In-place upgrade and migration runbook

Use this sequence for the pre-keyed Vec-based deployment on `manextech.testnet`:

1. Stop the relay and all agent request sources. Do not permit a new payment request during the upgrade window.
2. Record the current `get_policy`, `get_active_payment`, relevant `get_payment` records and `get_daily_usage` results. Separately query the account with NEAR RPC `view_account` at finality `final` and record `amount`, `locked` and `storage_usage`; the pre-migration deployed ABI does not include the later `get_storage_metrics` view. Confirm the active payment and its daily reservation are consistent, and that the account has enough available balance for storage growth from the new keyed daily records. Do not attempt to reconcile an ambiguous `processing` payment.
3. Build the release Wasm from the reviewed commit and record its SHA-256. Confirm that the artifact contains the `migrate` entry point and the expected state-version marker logic.
4. Upgrade the code on the existing `manextech.testnet` account. Do not call `new`.
5. Immediately call `migrate` once, signed by the `manextech.testnet` account key. The method is private and intentionally only accepts a call whose predecessor is the contract account itself.
6. Verify `get_policy` is unchanged, `get_active_payment` and retained `get_payment` records are unchanged, and `get_daily_usage` returns the new spent/reserved/used/remaining fields with the expected values.
7. Only after those checks pass, restore relay and agent traffic.

The migration is atomic at the NEAR receipt level. If the migration call fails, its state writes roll back; do not send ordinary application calls against the upgraded code until the migration succeeds or the previous Wasm has been restored. Keep the prior Wasm artifact available for rollback. The migration method is intentionally one-time and the marker is written by both `new` and `migrate`.

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
