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

The amount is reserved against the UTC-day bucket at request time. A request at or below the soft limit enters `approved`; a request above the soft limit and at or below the hard limit enters `pending`. Each payment receives a sequential ID, which is also used as its nonce, and expires five minutes after creation.

Only one payment may be active at a time. This deliberately simple model limits throughput.

## Execution and settlement

### Automatically approved payment

The agent or another caller can invoke `execute_approved_spend(payment_id)` for the active `approved` payment. The contract changes its status to `processing`, initiates a NEAR transfer from the contract account to the recipient, and schedules the private `on_transfer_result` callback.

### Hardware-approved payment

A caller submits `approve_spend(payment_id, signature)` for the active `pending` payment. The contract reconstructs the canonical v1 message from stored payment data, contract account ID and network ID, then verifies the 64-byte Ed25519 signature against the registered 32-byte device public key. On success, it marks the payment `processing`, records hardware approval and initiates the transfer.

The relay or caller cannot substitute recipient, amount, nonce or expiry in the message accepted by the contract: those fields are reconstructed from contract state. See [APPROVAL-PROTOCOL.md](APPROVAL-PROTOCOL.md).

### Callback

The private callback records `paid` when the transfer promise succeeds. On failure it records `failed` and releases the original daily reservation. In either case it clears the active payment.

A `paid` payment's reservation remains in the UTC-day usage total and therefore counts as consumed daily capacity.

## Expiry, cancellation and pause

- `expire_payment` is permissionless after the payment's expiry timestamp. It changes an active `pending` or `approved` payment to `expired`, releases its reservation from the original UTC-day bucket and clears the active payment.
- `cancel_payment` is owner-only and can cancel an active `pending` or `approved` payment. It releases the reservation and clears the active payment.
- `pause` and `unpause` are owner-only and control whether new spend requests can be created. They do not cancel an existing payment or prevent settlement of an already authorized payment.
- There is no automated expiry keeper in the current repository. Until expiry is called or the payment is otherwise settled/cancelled, it can block new requests.

## Owner controls

The owner can pause/unpause spending, cancel an eligible active payment, rotate the device public key, replace the registered agent, and add/remove allowlisted recipients. The allowlist cannot be made empty. There is no owner method to alter soft, hard or daily limits.

## Payment history and storage

Payment records are stored in a `LookupMap` and looked up by ID. The contract retains at most 1,000 records. When full, insertion prunes oldest terminal records (`paid`, `failed`, `expired` or `cancelled`). It refuses insertion if the oldest record is not terminal or the retention index is inconsistent.

Daily accounting is currently a `Vec<DailyUsage>`. Reads and updates search it linearly by UTC day, and entries are not pruned. This is a known long-running storage and gas-efficiency issue for future work.

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
- `get_daily_usage(utc_day)`

The JSON views wrap u64 and u128 values using NEAR SDK `U64` and `U128` types to preserve integer precision for JavaScript clients.

## Local verification

From the repository root:

```sh
cd contract
cargo test
cargo build --target wasm32-unknown-unknown --release
```

CI performs both commands on pull requests and pushes to `main`.
