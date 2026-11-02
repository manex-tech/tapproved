# ESP32 firmware

Target: ESP32-WROOM-32 (PlatformIO board `esp32dev`), Arduino framework.

## Canonical deployment

The only supported firmware environment targets the canonical NEAR Testnet deployment:

- Contract: `manextech.testnet`
- Network: `testnet`
- Approval button: GPIO25
- Serial baud rate: 115200
- Serial framing: newline-delimited JSON, maximum input frame 2,048 bytes

The contract ID (`manextech.testnet`) and network ID (`testnet`) are fixed compile-time constants in `src/main.cpp`; the contract ID is not exposed as a build-flag override. If the canonical deployment changes, update the source constants deliberately, rebuild and flash the firmware, then verify the device signs the exact contract and network values used by the relay and contract.

## Build and flash

Install PlatformIO Core, then run from this directory:

```sh
pio run -e esp32dev
pio run -e esp32dev --target upload
pio device monitor --baud 115200
```

Wire a normally-open push button between GPIO25 and GND. The input uses the internal pull-up. Never connect 5 V to an ESP32 GPIO.

The relay sends one UTF-8 JSON object per serial line with `frame_version: 1`, a fresh UUID v4 `request_id`, and the fields `contract_id`, `network_id`, `agent_id`, `status`, `payment_id`, `recipient_id`, `amount_yocto`, `nonce`, and `expires_at_ns`. The firmware independently requires `agent_id: manex-agent.testnet`, `status: pending`, a syntactically valid 2–64 character recipient account, positive payment ID/amount/expiry, and canonical decimal integer strings within protocol bounds. The device echoes the frame version and request ID in every correlated signed, rejected, or device-error response. The request ID is transport metadata and is not included in the Ed25519 approval message. Integer values are decimal strings. The firmware uses a fixed-size input buffer, rejects oversized frames, encodes the v1 payload itself, waits for the physical button, and signs with Ed25519. Amounts are converted into 16 little-endian bytes without floating point or compiler-specific 128-bit integers.

The device may print human-readable prompt lines while waiting. Its machine-readable result is one JSON line containing `frame_version` and the matching `request_id`: a signed response additionally contains `public_key_hex` and `signature_hex`, or the device returns a correlated rejection/error status. The relay ignores prompt text and accepts only a correctly shaped response for the active request.

## Key handling warning

On first boot, the ESP32 hardware RNG generates a 32-byte seed, stored in Preferences/NVS. The public key is printed for testnet registration. The private seed is never printed.

This is a development prototype, not hardened key custody. The seed is stored in ordinary NVS. Flash encryption, secure boot, debug-port lockdown, tamper resistance, authenticated request transport, and a trusted display are not configured. Do not use real funds or production keys.

## Approval UI limitation

Payment details are printed to USB serial and GPIO25 requires a physical button press. Serial output is not a trusted display: a compromised host or relay could misrepresent the request. Do not use this as a blind-signing production device. A dedicated trusted display and authenticated device-to-relay transport are required before production.

The firmware rejects requests whose contract ID or network ID does not exactly match its compiled configuration. The contract remains authoritative for policy, expiry, nonce, and signature validity.
