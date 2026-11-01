# Contract stages

## A1: policy initialization

The one-time initializer stores the owner, registered agent, 32-byte Ed25519
device public key, testnet network identifier, exact yoctoNEAR limits, and
recipient allowlist. The deploying predecessor becomes the owner.

## A2: spend requests and authorization state

The registered agent is the only account allowed to call `request_spend`.
Each request must have a positive amount, an allowlisted recipient, and an
amount no greater than the hard per-payment limit.

Requests at or below the soft limit enter `approved` automatically. Requests
above the soft limit enter `pending` and require the later hardware-signature
stage. Both paths reserve the amount against the UTC-day cap immediately.
This prevents an outstanding approval from being used to over-commit the
daily budget.

Only one payment may be active at a time. Each request receives a monotonically
increasing ID used as its nonce and expires five minutes after creation.
Anyone may call `expire_payment` after expiry. Expiry releases the reservation
from the UTC-day bucket in which the request was created, including when the
request crosses midnight.

The contract exposes `get_payment`, `get_active_payment`, and
`get_daily_usage` views. Amounts are returned as JSON `U128` values to avoid
JavaScript number precision loss.

## Important A2 boundary

A2 creates authorization state only. It does not transfer NEAR, mark a payment
as paid, or implement hardware signature verification. An `approved` status
means authorization has passed policy checks; it does not mean funds moved.
A later stage will verify the device's domain-separated signature and execute
the transfer. Transfer success/failure callbacks will finalize the state and
settle or release the reservation.

## Invariants

- Mainnet is rejected; this project is testnet-only.
- Only the registered agent can create spend requests.
- The recipient allowlist applies to every request.
- The hard per-payment cap cannot be bypassed by hardware approval.
- The daily cap counts reserved amounts, including pending approvals.
- A payment cannot be requested while another payment is active.
- An expired payment cannot be revived; its reservation is released once.
- No request method performs a transfer in this stage.

## Local verification

```sh
cd contract
cargo test
cargo build --target wasm32-unknown-unknown --release
```
