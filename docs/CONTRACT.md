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

Policy validation rejects invalid key length, invalid limit relationships, an empty recipient allowlist and unsupported network configuration. Amounts are yoctoNEAR and exposed through JSON `U128` wrappers.

The current contract does not expose owner methods to change the three spending limits or network identifier after initialization.

## Request authorization

Only the registered agent may call `request_spend`. The contract rejects requests when paused, when another payment is active, for zero amounts, above the hard limit, or to a recipient outside the allowlist.

The amount is reserved against its creation UTC day at request time. The daily limit is enforced against committed spend plus outstanding reservations. A request at or below the soft limit enters `approved`; a request above the soft limit and at or below the hard limit enters `pending`. Each payment receives a sequential ID, which is also used as its nonce, and expires five minutes after creation.

Only one payment may be active at a time. This deliberately simple model limits throughput.

## Execution and settlement

### Automatically approved payment

The agent or another caller can invoke `execute_approved_spend(payment_id)` for the active `approved` payment. The contract changes its status to `processing`, initiates a NEAR transfer from the contract account to the recipient, and schedules the private `on_transfer_result` callback.

### Hardware-approved payment

A caller submits `approve_spend(payment_id, signature)` for the active `pending` payment. The contract reconstructs the canonical v1 message from stored payment data, contract account ID and network ID, then verifies the 64-byte Ed25519 signature against the registered 32-byte device public key. On success, it marks the payment `processing`, records hardware approval and initiates the transfer.

The relay or caller cannot substitute recipient, amount, nonce or expiry in the message accepted by the contract: those fields are reconstructed from contract state. See [APPROVAL-PROTOCOL.md](APPROVAL-PROTOCOL.md).

### Callback

The private callback records `paid` when the transfer promise succeeds and atomically moves the amount from `reserved_yocto` to `spent_yocto` in the payment's original UTC-day record. On failure it records `failed` and releases the original daily reservation without increasing spent usage. In either case it clears the active payment.

Daily usage reports committed spend and outstanding reservations separately. The daily limit is enforced against their checked sum. Successful payments continue consuming that day's capacity; failed, expired and cancelled payments release capacity.

## Expiry, cancellation and pause

- `expire_payment` is permissionless after the payment's expiry timestamp. It changes an active `pending` or `approved` payment to `expired`, releases its reservation from the original UTC-day bucket and clears the active payment.
- `cancel_payment` is owner-only and can cancel an active `pending` or `approved` payment. It releases the reservation and clears the active payment.
- `pause` and `unpause` are owner-only and control whether new spend requests can be created. They do not cancel an existing payment or prevent settlement of an already authorized payment.
- There is no automated expiry keeper in the current repository. Until expiry is called or the payment is otherwise settled/cancelled, it can block new requests.

## Owner controls

The owner can pause/unpause spending, cancel an eligible active payment, rotate the device public key, replace the registered agent, and add/remove allowlisted recipients. The allowlist cannot be made empty. There is no owner method to alter soft, hard or daily limits.

## Payment history and storage

Payment records are stored in a `LookupMap` and looked up by ID. The contract retains at most 1,000 records. When full, insertion prunes oldest terminal records (`paid`, `failed`, `expired` or `cancelled`). It refuses insertion if the oldest record is not terminal or the retention index is inconsistent.

Daily accounting uses a `LookupMap` keyed by UTC day for direct record access and a bounded index of retained day keys. It retains the most recent 90 UTC-day records, pruning older records when a new spending request is created. The index is capped at 90 entries. Historical queries older than the retention window return zero usage because those records have been pruned. The index is sorted and checked against the map when a day is updated; inconsistent state fails closed.

Each record separates `spent_yocto` from `reserved_yocto`. `get_daily_usage(utc_day)` returns `spent_yocto`, `reserved_yocto`, their sum as `used_yocto`, `remaining_yocto`, and `daily_limit_yocto`. A successful settlement moves the payment amount from reserved to spent; failure, expiry and cancellation subtract it from reserved. All additions and subtractions use checked arithmetic.

The current persistent state layout is not compatible with earlier contract layouts. Do not assume an in-place migration exists. A change to Borsh state layout requires a deliberate upgrade/redeployment plan and verified state handling.

## Payment states

`pending` → `processing` → `paid` or `failed`

`approved` → `processing` → `paid` or `failed`

`pending` or `approved` → `expired` or `cancelled`

`processing` is not eligible for expiry or owner cancellation. Failed, expired and cancelled payments release their reservations. Paid payments retain the reservation as consumed daily capacity.

## Events and views

The contract emits `EVENT_JSON` logs for payment requested, approved, paid, failed, cancelled and expired events. Approval events distinguish automatic and hardware approval.

Read methods include:

- `get_policy()`
- `get_payment(payment_id)`
- `get_active_payment()`
- `get_daily_usage(utc_day)` returns separate spent/reserved values, total used, remaining capacity and the configured daily limit. Historical day records are retained for 90 UTC days.

The JSON views wrap u64 and u128 values using NEAR SDK `U64` and `U128` types to preserve integer precision for JavaScript clients.

## Local verification

From the repository root:

```sh
cd contract
cargo test
cargo build --target wasm32-unknown-unknown --release
```

CI performs both commands on pull requests and pushes to `main`.
