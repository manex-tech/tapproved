# NEAR testnet deployment status

## Canonical configuration

| Role | Account / value |
|---|---|
| Network | `testnet` |
| Contract and treasury | `manextech.testnet` |
| Registered agent | `manex-agent.testnet` |
| Default RPC | `https://test.rpc.fastnear.com` |

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

1. Run the read-only preflight against the canonical Testnet RPC and save the output outside Git:
   `npm run testnet:preflight -- --output .tapproved/testnet-preflight.json`.
   The command pins account, protocol configuration and contract views to one finalized block; captures policy/device key/active payment and account storage; enumerates every retained payment ID when history is short and queries the daily buckets those payments touched plus today; for longer histories it reads the rolling 90-day window. It calculates expected migrated spent/reserved totals and storage headroom using the protocol's actual `storage_amount_per_byte`. It exits non-zero and marks the snapshot blocked if the deployed ABI, state or conservative storage funding estimate is inconsistent. It does not sign or submit transactions.
2. Stop the relay and all agent request sources. Do not permit a new payment request during the upgrade window.
3. Review the saved snapshot, especially `ready_for_upgrade`, `blockers`, active payment state, retained payment records, legacy daily totals and `storage_funding`. The storage section reads the Testnet protocol's `storage_amount_per_byte` at the same finalized block and conservatively estimates the new daily-map keys/values, retained-day index and one-time version marker. Proceed only when `storage_funding.sufficient_for_conservative_estimate` is true and there are no blockers. The pre-migration deployed ABI does not include the later `get_storage_metrics` view; independently review the account balance and estimate before signing. Do not attempt to reconcile an ambiguous `processing` payment.
4. Build the release Wasm from the reviewed commit and record its SHA-256. Confirm that the artifact contains the `migrate` entry point and the expected state-version marker logic.
5. Upgrade the code on the existing `manextech.testnet` account. Do not call `new`.
6. Immediately call `migrate` once, signed by the `manextech.testnet` account key. The method is private and intentionally only accepts a call whose predecessor is the contract account itself.
7. Verify `get_policy` is unchanged, `get_active_payment` and retained `get_payment` records are unchanged, and `get_daily_usage` returns the new spent/reserved/used/remaining fields with the expected values.
8. Only after those checks pass, restore relay and agent traffic.

The migration is atomic at the NEAR receipt level. If the migration call fails, its state writes roll back; do not send ordinary application calls against the upgraded code until the migration succeeds or the previous Wasm has been restored. Keep the prior Wasm artifact available for rollback. The migration method is intentionally one-time and the marker is written by both `new` and `migrate`.

## Same-account command sequence (near-cli-rs)

Run these commands from a local terminal where `near-cli-rs` is installed and the `manextech.testnet` account is available in the OS keychain. Do not paste or export its private key into a repository, CI job, chat or project `.env`.

1. Download a rollback copy of the currently deployed Wasm and inspect the deployed code hash:

   ```powershell
   near contract download-wasm manextech.testnet save-to-file .\manextech-before-tapproved-migration.wasm network-config testnet now
   near contract inspect manextech.testnet network-config testnet now
   Get-FileHash .\manextech-before-tapproved-migration.wasm -Algorithm SHA256
   ```

   Confirm the inspected code hash matches the preflight snapshot's `2fHedtF9t2M2Mjza8vBX3yaVeZ7gTzCmQP75WKhrBhSy` before proceeding. Keep the downloaded rollback Wasm unchanged.

2. Extract `tapproved_contract.wasm` from the deployment bundle and verify its SHA-256 is `2866c2491b6263c86b8bfae1bf4734e69c0a849c83dbc5c4326bac0cf23aec41`. Then upgrade code on the existing account, with no initializer:

   ```powershell
   near contract deploy manextech.testnet use-file .\tapproved_contract.wasm network-config testnet sign-with-keychain send
   ```

   Do not add `with-init-call`; specifically, do not call `new`.

3. Immediately call the one-time private migration, signed by the contract account itself:

   ```powershell
   near contract call-function as-transaction manextech.testnet migrate json-args '{}' prepaid-gas '100 Tgas' attached-deposit '0 NEAR' sign-as manextech.testnet network-config testnet sign-with-keychain send
   ```

   This call must be signed as `manextech.testnet`; a signer with a different account ID cannot pass the private-method check. Record both the deployment and migration transaction hashes and require successful final execution before running any ordinary contract views.

4. Verify the new state:

   ```powershell
   near contract call-function as-read-only manextech.testnet get_policy json-args '{}' network-config testnet now
   near contract call-function as-read-only manextech.testnet get_active_payment json-args '{}' network-config testnet now
   near contract call-function as-read-only manextech.testnet get_payment json-args '{"payment_id":1}' network-config testnet now
   near contract call-function as-read-only manextech.testnet get_payment json-args '{"payment_id":2}' network-config testnet now
   near contract call-function as-read-only manextech.testnet get_payment json-args '{"payment_id":3}' network-config testnet now
   near contract call-function as-read-only manextech.testnet get_daily_usage json-args '{"utc_day":20758}' network-config testnet now
   near contract call-function as-read-only manextech.testnet get_daily_usage json-args '{"utc_day":20760}' network-config testnet now
   ```

   Compare the owner, agent, 32-byte device key, limits, allowlist, pause state, next payment ID, statuses and payment records with the saved preflight. UTC day `20758` must show 0.021 NEAR spent, zero reserved and 0.021 NEAR used. The active payment must remain `null`. The current day bucket must show zero usage unless a new approved request has occurred (relay traffic should still be stopped).

5. Only after all checks pass, restart the relay. If the migration transaction fails, do not proceed to E2. Restore the old code using the saved backup if necessary:

   ```powershell
   near contract deploy manextech.testnet use-file .\manextech-before-tapproved-migration.wasm network-config testnet sign-with-keychain send
   ```

The commands above use the current near-cli-rs command structure documented by NEAR. See the [official NEAR CLI guide](https://github.com/near/near-cli-rs/blob/main/docs/GUIDE.en.md) for deploy, contract-call and Wasm-download syntax.

## E2 recipient prerequisite

The live preflight recorded the current allowlist as `["manextech.testnet"]`. This is sufficient for migration but does not authorize an external merchant. Before the automatic-payment demonstration, the owner must add a recipient account controlled by the project to the allowlist, verify it appears in `get_policy`, and then choose an amount no greater than the live soft limit (currently 0.01 NEAR) and within the remaining daily limit. Do not use the illustrative `merchant.testnet` value from `.env.example` unless it is actually added to the live allowlist and controlled for the test.

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


## Completed in-place migration and payment demonstration (2026-11-03)

The contract upgrade, state migration, allowlist addition, and automatic payment demonstration were executed and verified on NEAR Testnet:

1. **Contract Code Deployment:**
   - Account: `manextech.testnet`
   - Transaction ID: `4psHQnNteqE8SR6g9dBnSeu4smnpt3hDqXjFkzU3kzkU`
   - Deployed Code Hash: `Amp87jC1DCJjyA5bsmfEpFQzuqu72Cw7NSLRNk8uh3R5`
   - SHA-256 of Wasm: `9134050D1CD4E9D34987C331747ABCE2D462BEE30E97E475A8C0CEEE0B000FDC`

2. **State Migration Execution:**
   - Method: `migrate()` (private, predecessor `manextech.testnet`)
   - Transaction ID: `4AXh7BECjmMy2X7JCmS8G3UdXbXvJMNzJNDrj6Cq87Sh`
   - Gas burned: `0.309 Tgas`
   - Historical state preserved: Payments 1, 2, 3, day 20758 spend (0.021 NEAR), device key `A5529E95FF...`, policy limits.
   - Idempotency guard: verified; re-calling `migrate()` rejects with `"Smart contract panicked: Tapproved state migration has already been applied"`.

3. **Allowlist Expansion (E2 Prerequisite):**
   - Recipient added: `manex-agent.testnet`
   - Transaction ID: `CTT3bGrY1pzw276BTwVotsoP9A9WpnzGj8z5tTXtafDp`
   - Updated Allowlist: `["manextech.testnet", "manex-agent.testnet"]`

4. **Automatic Payment Request (E2, E3):**
   - Signer / Agent: `manex-agent.testnet`
   - Method: `request_spend`
   - Arguments: `{"recipient_id": "manex-agent.testnet", "amount_yocto": "1000000000000000000000"}` (0.001 NEAR)
   - Transaction ID: `6FY3y24tZ21Yb8vgDsHkMQU8qqYCuo6ESeJoybLUTFUu`
   - Assigned Payment ID: `4`, `status: "approved"`, `active_payment_id: 4`
   - Emitted Events: NEP-297 `payment_requested` and `payment_approved` (method: `automatic`)
   - Daily Usage (Day 20760): `reserved_yocto: 1000000000000000000000`, `spent_yocto: 0`, `remaining_yocto: 499000000000000000000000`

5. **Automatic Execution and Settlement (E4):**
   - Method: `execute_approved_spend(4)`
   - Transaction ID: `C5fZ7UW8TW3nSwv8EhD4gh8GdmUpMdqvCjHAGA1fkUNi`
   - Callback: `on_transfer_result(4)` settled `Promise::transfer`
   - Final Payment 4 Status: `"paid"`
   - Emitted Event: NEP-297 `payment_paid`
   - Active Payment: reset to `null`
   - Daily Usage (Day 20760): `reserved_yocto: 0`, `spent_yocto: 1000000000000000000000`
   - Recipient Balance: `manex-agent.testnet` balance increased from 0.999393 NEAR to 1.000136 NEAR
