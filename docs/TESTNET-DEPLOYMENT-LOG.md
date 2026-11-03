# Testnet deployment and state migration log

**Contract account:** `manextech.testnet`  
**Agent account:** `manex-agent.testnet`  
**Network:** NEAR testnet  
**Log date:** 2026-11-01  
**Status:** Deployment and incompatible-state migration completed; functional payment testing remains outstanding.

> Timestamp note: the deployment and migration were reported by the operator on 2026-11-01. Exact transaction block timestamps, transaction hashes, and block heights were not included in the captured console reports. They are deliberately marked as unavailable rather than inferred. GitHub commit and CI timestamps below are exact UTC timestamps supplied by GitHub.

## Event timeline

| Date / timestamp (UTC) | Event | Evidence / result |
|---|---|---|
| 2026-11-01 (time not captured) | Pre-migration storage backup created and reviewed | `pre-migration-storage-backup.json` contained the old `STATE`, 11 `presence$...` records, and 7 `presence_name:...` records. The backup was retained outside the repository; it is not committed because it contains legacy user data. |
| 2026-11-01 (time not captured) | Local WASM checksum checked | Operator confirmed the local WASM matched SHA-256 `18aa9527b3867a6c6ac4a2ae42eeb6f4ac9a6cdfb0eeb7fdfa193ef6ffd24b22`. |
| 2026-11-01 (time not captured) | Contract WASM deployed without initialization | Operator reported successful deployment to `manextech.testnet` using `without-init-call`. |
| 2026-11-01 (time not captured) | Guarded incompatible-state migration executed | Operator reported `migrate_from_incompatible_state` succeeded, signed as `manextech.testnet`. Migration is one-shot and writes marker `tapproved:migration:incompatible-state:v1 = completed`. |
| 2026-11-01 (time not captured) | Policy view verified | `get_policy` returned owner `manextech.testnet`, agent `manex-agent.testnet`, network `testnet`, expected ESP32 public key, soft limit 0.01 NEAR, hard limit 0.1 NEAR, daily limit 0.5 NEAR, allowed recipient `manextech.testnet`, `paused=false`, and `next_payment_id=1`. |
| 2026-11-01 (time not captured) | Active payment view verified | `get_active_payment` returned `null`. |
| 2026-11-01 (time not captured) | Post-migration storage inspected | Raw storage showed the new `STATE`, all 11 `presence$...` records, all 7 `presence_name:...` records, and the completed migration marker. |

## Build and source provenance

- Repository: [manex-tech/tapproved](https://github.com/manex-tech/tapproved)
- Source branch: `main`
- Source commit: [`09b7c3ff3ce6989ebc528b5e288157487ef1fd42`](https://github.com/manex-tech/tapproved/commit/09b7c3ff3ce6989ebc528b5e288157487ef1fd42)
- Source commit timestamp: **2026-11-01T12:54:26Z**
- CI workflow run: [run #28](https://github.com/manex-tech/tapproved/actions/runs/41308691090)
- CI result: **completed / success**
- Artifact: `tapproved-contract-wasm`
- GitHub artifact ZIP SHA-256 digest: `de5db5b126e2700e820cc77fd3641b887b09a4082854ce0e0097c54844a4bedd`
- Extracted WASM SHA-256: `18aa9527b3867a6c6ac4a2ae42eeb6f4ac9a6cdfb0eeb7fdfa193ef6ffd24b22`

## Migration behavior and data preservation

The old `STATE` value was incompatible with Tapproved's Borsh state layout. The guarded `migrate_from_incompatible_state` initializer used `#[init(ignore_state)]` to bypass deserialization of that incompatible state and write a fresh Tapproved state. It did not import or convert the old presence application data.

The post-migration raw storage inspection showed:

| Record | Before | After |
|---|---:|---:|
| Main `STATE` | 1 incompatible record | 1 Tapproved state record |
| `presence$...` | 11 | 11 |
| `presence_name:...` | 7 | 7 |
| Migration marker | absent | 1, value `completed` |

The old presence records remain in storage but are not part of Tapproved's new state model. The raw backup file is intentionally not stored in this repository.

## Current verification boundary

**Verified from operator-provided console output:** deployment reported successful; migration reported successful; policy view returned the expected configuration; active payment view returned `null`; post-migration storage retained all 18 legacy records and showed the migration marker.

**Not yet verified / still outstanding:**

- Exact deployment and migration transaction hashes, block heights, and block timestamps.
- Independent RPC/indexer verification of the transaction receipts.
- End-to-end spend request, ESP32 signature submission, on-chain signature verification, NEAR transfer, and callback outcome.
- Transfer failure and reservation-release behavior under integration testing.

No mainnet deployment or mainnet transaction is part of this log. Continue testing on testnet only.
