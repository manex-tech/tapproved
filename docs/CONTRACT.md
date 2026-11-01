# Contract initialization

A1 establishes the initial on-chain spending policy. It deliberately does not
implement payment requests, approval verification, transfers, or daily usage
accounting; those belong to later contract stages.

## Constructor

The contract exposes the one-time initializer:

- `agent_id`: NEAR account permitted to request spends in a later stage.
- `device_public_key`: exactly 32 raw Ed25519 public-key bytes.
- `soft_limit_yocto`: amount above which hardware approval will be required.
- `hard_limit_yocto`: absolute per-payment ceiling.
- `daily_limit_yocto`: absolute UTC-day spending ceiling.
- `allowed_recipients`: non-empty recipient allowlist.
- `network_id`: currently restricted to `testnet`.

The predecessor account that deploys and initializes the contract becomes
`owner_id`. Amounts use NEAR SDK's JSON `U128` wrapper to avoid JavaScript
number precision loss.

## Initialization invariants

- The device key must contain exactly 32 bytes.
- The soft limit must be positive and no greater than the hard limit.
- The daily limit must be at least the hard limit.
- The recipient allowlist cannot be empty.
- Only the NEAR testnet network identifier is accepted.
- The initial policy is unpaused and the first payment identifier is 1.
- The initializer is one-time through NEAR's `#[init]` guard.

## Read method

`get_policy` returns the persisted policy. It does not expose a mutation path.

## Not implemented in A1

No spend request, signature verification, nonce/replay handling, payment state
machine, daily-cap reservation, NEAR transfer, owner administration, or device
key rotation is implemented yet. The public key is stored as raw bytes; its
Ed25519 verification and canonical signing payload are subsequent work.

## Local verification

From the repository root:

```sh
cd contract
cargo test
cargo build --target wasm32-unknown-unknown --release
```
