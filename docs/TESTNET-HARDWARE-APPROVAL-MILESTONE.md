# Testnet milestone: first end-to-end ESP32 hardware approval

**Result: successful on NEAR testnet.** Tapproved completed its first verified hardware-gated payment: an agent-created payment remained pending until the registered ESP32 physically authorized it, the contract accepted the Ed25519 signature, and the transfer callback recorded the payment as paid.

This milestone was reached through iterative implementation, debugging, deployment recovery, firmware configuration, and on-device testing. This document records both the result and the work required to get there.

## Verified outcome

Network: NEAR testnet  
Contract and recipient: `manextech.testnet`  
Agent: `manex-agent.testnet`  
Hardware: ESP32 development board with the registered Ed25519 public key  
Payment ID: `3`  
Amount: `0.02 NEAR` (`20000000000000000000000` yoctoNEAR)  
Nonce: `3`  
Final status: `paid`  
Hardware approval flag: `true`

The final `get_payment(3)` view returned:

```json
{
  "agent_id": "manex-agent.testnet",
  "amount_yocto": "20000000000000000000000",
  "created_at_ns": 1793540628319661741,
  "expires_at_ns": 1793540928319661741,
  "hardware_approved": true,
  "id": 3,
  "nonce": 3,
  "recipient_id": "manextech.testnet",
  "status": "paid"
}
```

The ESP32 returned `status: signed`. Its public key was:

```
a5529e95ff0180ca709661d902ecc000f9688a069aa635e8d98f58cba3195bad
```

That public key matched the device key registered in the contract. The resulting signature was submitted to `approve_spend`; the contract accepted it, set `hardware_approved` to true, initiated the transfer, and the asynchronous callback ultimately recorded `status: paid`.

## What this demonstrates

The hardware-gated path crossed the complete application boundary:

1. The registered agent requested a spend of 0.02 NEAR.
2. The on-chain policy placed the payment in `pending`, because it exceeded the 0.01 NEAR soft limit while remaining below the 0.1 NEAR hard limit.
3. The payment record supplied the exact payment ID, recipient, amount, nonce, and expiry used to construct the approval request.
4. The ESP32 reconstructed the documented canonical approval message and required a physical press of GPIO25 before signing.
5. The device emitted a signature and its public key. The public key matched the contract's registered device key.
6. The signature was submitted to `approve_spend`.
7. The contract verified the signature and initiated settlement.
8. The transfer callback completed and `get_payment(3)` showed `paid` with `hardware_approved: true`.

This is materially more than a firmware demo or an off-chain signature check: the contract itself accepted the registered device's signature and the payment state reached its successful terminal status.

## The struggle behind the milestone

### 1. The contract account contained incompatible historical state

The intended contract account, `manextech.testnet`, was not fresh. Its storage contained a prior `presence` state and related `presence_name` records. After deploying the Tapproved WASM, read-only calls failed with a Borsh state deserialization error.

The WASM checksum was checked against the local build. The problem was not a mismatched artifact; it was the account's existing state layout. Calling ordinary initialization was not a valid recovery path because the account was already initialized.

A guarded, one-time migration entry point was implemented. It required the contract account itself to authorize the call, replaced the incompatible main state with a fresh Tapproved state, recorded a migration marker, and left unrelated historical storage keys intact. The old presence records were not imported. The migration was executed and the new policy state was inspected.

### 2. A payment expired during early testing

The first low-value software-approved payment did not complete because its approval window expired. That attempt did not establish successful settlement. A subsequent software-approved payment completed, validating the ordinary approval and transfer-callback path before moving to hardware authorization.

### 3. The firmware initially targeted the wrong contract account

The firmware's configured contract ID was `tapproved.testnet`, while the actual deployed contract was `manextech.testnet`. The configuration had to be corrected and the firmware rebuilt/flashed. The existing device key was preserved because its public key was already registered on-chain.

### 4. The physical approval path had to match the contract byte-for-byte

The device and contract must agree on the canonical message, including the domain separator, length-prefixed strings, little-endian integer encodings, payment nonce, and expiry. The ESP32 was tested over serial at 115200 baud. It displayed the payment details and waited for the physical GPIO25 button press before returning a signature.

The device signature was then submitted to the deployed contract rather than treated as proof of success by itself. The final on-chain payment view provided the settlement evidence.

## Earlier software-path validation

Before the hardware-gated test, payment ID `2` completed through the software-approved route for 0.001 NEAR. Its final status was `paid` with `hardware_approved: false`. This gave us a baseline for the contract's non-hardware path.

Payment ID `3` then exercised the hardware-required route at 0.02 NEAR and finished with `paid` and `hardware_approved: true`.

## Scope and limitations

This milestone was performed on **NEAR testnet only**. Payment ID 3 used `manextech.testnet` as both the contract account and recipient. It therefore validates the hardware signature verification, policy transition, promise initiation, and successful callback path, but it does **not** independently demonstrate settlement to an external recipient account.

The prototype is not production-ready and has not been independently audited. The ESP32's ordinary NVS key storage is not equivalent to a certified secure element. Flash encryption, secure boot, debug-port hardening, authenticated device transport, and a trusted transaction display remain important security considerations. The serial display is not a trusted display against a compromised host or relay.

No mainnet deployment or mainnet transaction is part of this milestone.

## Why this matters

Tapproved's central claim is that an AI agent can operate within an on-chain spending policy, while a payment above the routine threshold cannot proceed until a human physically approves it through a registered device.

On testnet, we have now demonstrated that complete hardware approval path through to the contract's `paid` state. The work included recovering an account with incompatible legacy state, safely initializing the new contract state, validating the software path, correcting firmware configuration, matching the cryptographic protocol, and finally verifying the device signature and settlement on-chain.

The result is a concrete milestone for the project, not a claim that the system is audited or ready for real funds.
