# Device-key rotation procedure

**Scope:** Testnet operator procedure for replacing the Ed25519 key registered by the Tapproved contract. This document describes the supported contract operation and firmware behavior; it does not authorize an on-chain transaction or physical device modification.

## Current behavior

- The contract exposes owner-only `rotate_device_key(device_public_key: Vec<u8>)`.
- The replacement public key must contain exactly 32 bytes.
- `get_policy` returns the currently registered `device_public_key`.
- The firmware creates a random 32-byte seed only when its NVS seed record is absent. It does not expose a runtime key-rotation command.
- On startup the firmware derives and prints the public key. During approval it reloads the seed from NVS, derives the public key again and checks it against the startup identity before signing.
- Rotating the contract key immediately invalidates signatures from the previous key. Rotation does not cancel or rewrite an active payment.

## Safe operator sequence

1. Stop new payment requests at the relay/application layer. If operationally appropriate, the owner may pause the contract to prevent new requests while the change is prepared.
2. Read `get_active_payment`. Do not rotate while a payment is pending hardware approval. Complete or owner-cancel a pending/approved payment first. If a payment is processing, wait for the final transfer and callback outcome; do not infer the outcome from elapsed time or reconcile an ambiguous transfer.
3. Prepare a replacement ESP32 with a fresh NVS identity. The safest path is a replacement/spare board whose NVS seed record is absent. On first boot, the firmware generates a new seed and prints the corresponding public key. For reuse of an existing board, the current firmware has no in-place rotation command; any full flash erase and firmware reflash must be a separately reviewed, explicitly approved hardware operation. Do not copy or transmit the private seed.
4. Record the new public key from the device output. It must be exactly 32 bytes, represented as 64 hexadecimal characters. Convert those bytes to the JSON byte array expected by the contract's `Vec<u8>` argument. Never submit the private seed.
5. Verify the intended owner account and canonical contract `manextech.testnet`. The owner submits `rotate_device_key` with the new 32-byte public-key array. This is an on-chain state change and requires explicit operator approval.
6. Read `get_policy` at finalized state and compare every returned public-key byte with the replacement device's public key. Do not resume approvals if they differ.
7. With separate explicit approval for any test transaction, run a controlled pending-payment approval using the replacement device. Verify that the contract reaches the expected state and that the signature is attributable to the new key.
8. Retire the old device. Its old seed remains sensitive even after the contract stops accepting signatures from it. Follow an approved physical data-erasure or secure-retirement process; ordinary NVS is not encrypted by the current project configuration. Resume request intake and unpause the contract only after verification.

## Failure and recovery

- If the new key is not confirmed by `get_policy`, keep approval processing disabled. Do not guess whether the rotation transaction succeeded.
- If the new device fails before the contract is rotated, continue using the old device and retry preparation with a different replacement device.
- If the contract has been rotated but the replacement device is unavailable, the owner must deliberately rotate to another verified public key. This is a separate on-chain action and requires explicit approval.
- Do not rotate back to a key suspected of compromise.
- A pending payment signed by the old key cannot be approved after rotation. This is why the active-payment check and drain step are mandatory.

## Verification covered by automated tests

The contract test suite verifies that the owner can rotate the key, a non-owner cannot rotate it, invalid key lengths are rejected, the new key can approve a pending payment after rotation, and a signature from the previous key is rejected after rotation. These are deterministic unit tests, not evidence of a live Testnet rotation or physical ESP32 provisioning.

## Security boundary

The contract stores only the public key. The device seed remains in ordinary ESP32 NVS. This procedure does not enable NVS encryption, Flash Encryption, Secure Boot or debug-interface lockdown. Review [ESP32-SECURITY-ASSESSMENT.md](ESP32-SECURITY-ASSESSMENT.md) before production use.
