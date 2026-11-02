# Tapproved approval protocol v1

This document defines the exact byte sequence signed by the registered Ed25519 device key. The contract reconstructs the message from stored payment state; a relay must never be trusted to supply the message fields used for on-chain verification.

## Encoding

The byte sequence is concatenated in this exact order:

1. Domain separator: ASCII `TAPPROVED`, followed by byte `0x00`, followed by version byte `0x01`.
2. Contract account ID: UTF-8 bytes prefixed by a 4-byte unsigned little-endian byte length.
3. Network ID: UTF-8 bytes prefixed by a 4-byte unsigned little-endian byte length.
4. Payment ID: unsigned 64-bit little-endian integer.
5. Recipient account ID: UTF-8 bytes prefixed by a 4-byte unsigned little-endian byte length.
6. Amount: unsigned 128-bit little-endian integer in yoctoNEAR.
7. Nonce: unsigned 64-bit little-endian integer.
8. Expiry: unsigned 64-bit little-endian block timestamp in nanoseconds.

No JSON serialization, separators, null terminators for strings, floating-point amounts, or display-formatted NEAR amounts are included.

## Shared test vector

`protocol/v1-vector.json` is the normative deterministic interoperability fixture. It contains the input fields, expected encoded bytes, public key, and Ed25519 signature. The corresponding private seed is deliberately not committed. The fixture deliberately uses the deterministic test account `tapproved.testnet`; this is protocol test data, not the deployed contract ID. The live deployment and firmware/relay configuration use `manextech.testnet`.

The Node test suite verifies both byte-for-byte encoding and Ed25519 signature verification, then confirms that changing the amount invalidates the signature. Firmware and contract tests must consume this same fixture.

## Security requirements

- Sign only data obtained from the contract's payment record and verify that the contract ID and network match the configured deployment.
- Show the recipient and amount to the human before accepting physical approval. A serial-only prototype is not suitable for blind signing in production.
- Never log, transmit, or commit the private key.
- The relay transports requests and signatures; it is not an authority.
- The v1 format is immutable. Any incompatible change requires a new domain version and fixture.
