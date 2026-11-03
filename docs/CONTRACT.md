# NEAR contract

The contract is the policy authority and holds the treasury balance used for transfers. It is deployed on NEAR testnet at `manextech.testnet`. The registered agent is `manex-agent.testnet`. The owner is the account that initialized the contract; confirm the live value with `get_policy`.

## Initialization and policy

The one-time `new` initializer stores:

- owner account (the initializing predecessor)
- registered agent account
- 32-byte Ed25519 device public key
- network identifier
- soft per-payment limit
- hard per-payment limit
- UTC daily spending limit
- non-empty recipient allowlist

Policy validation rejects invalid key length, invalid limit relationships, an empty recipient allowlist, an allowlist larger than 100 accounts and unsupported network configuration. Amounts are yoctoNEAR and exposed through JSON `U128` wrappers.

The owner can atomically update soft, hard and daily limits through `update_spending_limits`. The complete new policy is validated before any value is changed. A lower daily limit is rejected if it would fall below any retained day's committed spend plus outstanding reservations. The network identifier remains fixed.

The owner can replace the registered 32-byte Ed25519 device public key with `rotate_device_key`. The method rejects non-owner callers and invalid key lengths. Rotation takes effect immediately: signatures from the previous device key are no longer accepted, while pending payment state is not automatically cancelled. Drain pending approvals before rotating. See [DEVICE-KEY-ROTATION.md](DEVICE-KEY-ROTATION.md) for the operator sequence. No live rotation is implied by these source-level tests.

## Request authorization

Only the registered agent may call `request_spend`. The contract rejects requests when paused, when another payment is active, for zero amounts, above the hard limit, or to a recipient outside the allowlist.

The amount is reserved against its creation UTC day at request time. The daily limit is enforced against committed spend plus outstanding reservations. A request at or below the soft limit enters `approved`; a request above the soft limit and at or below the hard limit enters `pending`. Each payment receives a sequential ID, which is also used as its nonce, and expires five minutes after creation.

Only one payment may be active at a time. This deliberately simple model limits throughput. When a new otherwise-valid request arrives, an expired active `pending` or `approved` payment is automatically expired and its original-day reservation is released before the new request proceeds. An active `processing` payment is never auto-expired. The contract does not deduplicate a logical agent request after an earlier payment reaches a terminal state; the future agent/relay API must provide request idempotency keys so transport retries do not create a second payment.

## Execution and settlement

### Automatically approved payment

The agent or another caller can invoke `execute_approved_spend(payment_id)` for the active `approved` payment. The contract changes its status to `processing`, initiates a NEAR transfer from the contract account to the recipient, and schedules the private `on_transfer_result` callback.

### Hardware-approved payment

A caller submits `approve_spend(payment_id, signature)` for the active `pending` payment. The contract reconstructs the canonical v1 message from stored payment data, contract account ID and network ID, then verifies the 64-byte Ed25519 signature against the registered 32-byte device public key. On success, it marks the payment `processing`, records hardware approval and initiates the transfer.

The relay or caller cannot substitute recipient, amount, nonce or expiry in the message accepted by the contract: those fields are reconstructed from contract state. See [APPROVAL-PROTOCOL.md](APPROVAL-PROTOCOL.md).

### Callback and recovery

The private callback records `paid` when the transfer promise succeeds. On failure it records `failed` and releases the original daily reservation. In either case it clears the active payment. The callback receives a fixed 30 TGas allocation. A contract unit test measures callback execution against this budget, but this is not a substitute for empirical testnet receipt-gas validation.

If the callback receipt itself fails, the payment can remain in `processing` with its reservation locked and the active-payment gate engaged. There is no trustless way for the contract to query the outcome of an earlier transfer receipt after its callback has failed. The owner-only `reconcile_processing_payment(payment_id, transfer_succeeded)` method provides an explicit recovery path. It can settle the reservation as `paid` or release it as `failed`, but the boolean is an owner attestation, not an on-chain proof.

**Mandatory reconciliation procedure:** do not call this method merely because time has elapsed or because the callback is missing. Independently inspect the final NEAR transfer receipt and the callback receipt using a trusted RPC/explorer. Invoke reconciliation only after the transfer outcome is final and the callback receipt is confirmed failed. If the transfer succeeded, pass `true`; if the transfer failed, pass `false`. If the outcome is ambiguous, leave the payment in `processing` and keep the reservation locked. A mistaken owner attestation can cause accounting inconsistency or duplicate-payment risk. This is an operational trust boundary and must be disclosed to treasury operators.

The 30 TGas allocation is a conservative increase over the previous 10 TGas allocation. The callback's simulated unit-test gas use is checked against the budget. **Empirical testnet gas validation remains outstanding** and must be completed against a deployed build before production use.
On success, the amount moves from `reserved_yocto` to `spent_yocto`; the combined total remains charged against that original UTC day's limit. Failed, expired and cancelled payments release the reservation without increasing spent usage.

## Expiry, cancellation and pause

- `expire_payment` is permissionless after the payment's expiry timestamp. It changes an active `pending` or `approved` payment to `expired`, releases its reservation from the original UTC-day bucket and clears the active payment.
- `cancel_payment` is owner-only and can cancel an active `pending` or `approved` payment. It releases the reservation and clears the active payment.
- `pause` and `unpause` are owner-only and control whether new spend requests can be created. They do not cancel an existing payment or prevent settlement of an already authorized payment.
- `expire_payment` remains permissionless for external cleanup, but a subsequent valid `request_spend` also expires a stale active `pending` or `approved` payment atomically. A stale `processing` payment is not expired. It remains blocked until the owner reconciles it after independently verifying the final transfer and callback receipts.

## Owner controls

The owner can pause/unpause spending, cancel an eligible active payment, rotate the device public key, replace the registered agent, atomically update spending limits, and add/remove allowlisted recipients. The allowlist must contain 1–100 accounts.

## Payment history and storage

Payment records are stored in a `LookupMap` and looked up by ID. The contract retains at most 1,000 records. When full, insertion prunes oldest terminal records (`paid`, `failed`, `expired` or `cancelled`). It refuses insertion if the oldest record is not terminal or the retention index is inconsistent.

Daily accounting uses a `LookupMap` keyed by UTC day for constant-time record lookup, plus a bounded day index. Each record tracks `spent_yocto` and `reserved_yocto` separately; the daily cap is enforced against their checked sum. Successful settlement moves the amount from reserved to spent. Failed, expired and cancelled payments release the reservation from the payment's original UTC day, including when expiry occurs after midnight. The contract retains the current UTC day and the preceding 89 days (90 day buckets maximum), pruning older records during a new request. Records with outstanding reservations are never pruned; if the bounded index cannot safely make room, the new request fails closed. The `get_daily_usage(utc_day)` view returns `spent_yocto`, `reserved_yocto`, `used_yocto` (their sum), `remaining_yocto` and `daily_limit_yocto`. Queries for records outside the retention window return zero usage.

The pre-keyed Tapproved deployment on `manextech.testnet` stores daily usage as a `Vec<LegacyDailyUsageV1>`. The current source includes a one-time, private `migrate()` initializer using `#[init(ignore_state)]` to read that exact legacy Borsh layout and return the new state. It preserves the existing policy fields, payment counters, active-payment ID and existing payment `LookupMap` prefix `p`; existing payment records are not rewritten. It converts each legacy daily total into `spent_yocto` plus `reserved_yocto`: the active payment amount remains reserved, and the remainder is committed spend. This matches the legacy behavior, where successful payments remained charged in the old daily total and failed/expired/cancelled payments had already released their reservations.

The migration retains the current 90-day window and the original day of an older active reservation, rejects malformed/inconsistent legacy records, and records a one-time state-version marker. A fresh account is not required for this known deployed layout. Stop request traffic, upgrade the Wasm on `manextech.testnet`, call `migrate` once using the contract account key, and verify policy, payment and daily-usage views before resuming relay traffic. Never call `new` on the existing account. See [the Testnet deployment migration runbook](TESTNET-DEPLOYMENT.md).

## Payment states

`pending` → `processing` → `paid` or `failed`

`approved` → `processing` → `paid` or `failed`

`pending` or `approved` → `expired` or `cancelled`

`processing` is not eligible for expiry or cancellation. If its callback receipt fails, the owner can reconcile it only after independently verifying the final transfer outcome. Failed, expired and cancelled payments release their reservations. Paid payments move the amount from reserved usage into spent usage, preserving the same daily-cap consumption.

## Events and views

The contract emits `EVENT_JSON` logs for payment requested, approved, paid, failed, cancelled and expired events. Approval events distinguish automatic and hardware approval.

Read methods include:

- `get_policy()`
- `get_payment(payment_id)`
- `get_active_payment()`
- `get_daily_usage(utc_day)` returns separate spent and reserved values, total used, remaining capacity and the configured daily limit. Historical records are retained for 90 UTC days.

The contract emits NEP-297-style `EVENT_JSON` envelopes under standard `tapproved`, event schema version `1.1.0`. Payment events include payment ID, agent, recipient, yocto amount, nonce, creation/expiry timestamps, event timestamp, resulting status and hardware-approval flag. `payment_approved` distinguishes `automatic` and `hardware`; hardware approval reports the resulting `processing` state because transfer execution begins in the same receipt. Terminal event names and status fields identify `paid`, `failed`, `expired` and `cancelled`. `policy_limits_updated` records the owner and previous/current limits. `payment_reconciled` records owner-directed recovery and the final status. All u64/u128 event values are serialized as decimal strings.

Read methods also include `get_storage_metrics()`, which reports storage usage, current byte cost, required storage stake, account balance and estimated balance headroom. This is an observability view, not a substitute for maintaining sufficient treasury balance.

The JSON views wrap u64 and u128 values using NEAR SDK `U64` and `U128` types to preserve integer precision for JavaScript clients.

## Local verification

From the repository root:

```sh
cd contract
cargo test
cargo build --target wasm32-unknown-unknown --release
```

CI performs both commands on pull requests and pushes to `main`.
