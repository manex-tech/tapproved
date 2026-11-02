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

Wire a normally-open push button between GPIO25 and GND. The input uses the internal pull-up. Never connect 5 V to an ESP32 GPIO. Approval requires a stable released state, then a fresh stable press and stable release; each transition is debounced for 50 ms. If the button is already held when a request arrives, the operator must release it first and then perform a new press/release cycle.

The relay sends one UTF-8 JSON object per serial line with `frame_version: 1`, a fresh UUID v4 `request_id`, and the fields `contract_id`, `network_id`, `agent_id`, `status`, `payment_id`, `recipient_id`, `amount_yocto`, `nonce`, and `expires_at_ns`. The firmware independently requires `agent_id: manex-agent.testnet`, `status: pending`, a syntactically valid 2–64 character recipient account, positive payment ID/amount/expiry, and canonical decimal integer strings within protocol bounds. The device echoes the frame version and request ID in every correlated signed, rejected, or device-error response. The request ID is transport metadata and is not included in the Ed25519 approval message. Integer values are decimal strings. The firmware uses a fixed-size input buffer, rejects oversized frames, encodes the v1 payload itself through the shared testable C++ protocol encoder, waits for the physical button, and signs with Ed25519. CI runs that exact encoder against `protocol/v1-vector.json` byte for byte. Amounts are converted into 16 little-endian bytes without floating point or compiler-specific 128-bit integers.

The approval summary converts yoctoNEAR to NEAR using integer string arithmetic only, without floating point, and also prints the exact original yoctoNEAR value. This avoids rounding while making ordinary amounts easier to inspect. The device may print human-readable prompt lines while waiting. Its machine-readable result is one JSON line containing `frame_version` and the matching `request_id`: a signed response additionally contains `public_key_hex` and `signature_hex`, or the device returns a correlated rejection/error status. The relay checks expiry using the latest finalized NEAR block timestamp before and after the physical interaction. The ESP32 has no trusted chain clock and does not perform local expiry decisions; the contract rechecks expiry at approval and remains authoritative. The relay ignores prompt text and accepts only a correctly shaped response for the active request. The summary remains informational only: USB serial is host-controlled, not a trusted display, and a compromised host could misrepresent it.

## Key handling warning

On first boot only, the ESP32 hardware RNG generates a 32-byte seed and stores it in Preferences/NVS. On later boots, the firmware requires an existing seed record to be exactly 32 bytes and checks that the read returns all 32 bytes. A present but malformed or unreadable record causes startup to fail closed; the firmware does not silently replace the device identity. Recovery or key rotation must be an explicit operator procedure. The public key is printed for testnet registration. The private seed is not held in a global variable: it is loaded into a scope-bound zeroizing buffer at startup only to derive the public key, then reloaded after a fresh physical approval and zeroized when signing completes or fails. The derived key is checked against the startup identity before signing. This reduces RAM exposure but does not make ordinary NVS encrypted or prevent runtime physical/debug extraction.

This is a development prototype, not hardened key custody. The seed is stored in ordinary NVS. Flash encryption, secure boot, debug-port lockdown, tamper resistance, authenticated request transport, and a trusted display are not configured. Do not use real funds or production keys.

## Reset, disconnection and power-loss behavior

The relay rejects an in-flight approval when the serial port closes, clears its partial incoming response buffer, and uses a fresh request ID after reconnect. Late responses for an earlier request are ignored. The relay test suite covers disconnect during an approval, an incomplete response frame across reconnect, and stale response suppression.

The ESP32 request-ID replay window is volatile RAM state. A device reset clears that window and discards any incomplete serial input or in-flight button wait. The NVS Ed25519 seed is persistent: a complete 32-byte record is loaded again on the next boot, preserving the device identity. If power is lost before any key record exists, the next boot may perform first-boot generation. If a key record exists but is incomplete or has the wrong length, startup fails closed and does not silently replace it. Host tests model these record-policy outcomes and reset the volatile request-ID guard.

These are deterministic host/relay tests, not physical brownout, flash-write interruption or cable-pull experiments. Actual ESP32 reset and power-cut validation remains a separate hardware test. The USB-to-UART bridge may not provide the firmware with a reliable indication that the host application disconnected; the relay still rejects stale or uncorrelated responses.

## Approval UI limitation

Payment details are printed to USB serial and GPIO25 requires a physical button press. Serial output is not a trusted display: a compromised host or relay could misrepresent the request. Do not use this as a blind-signing production device. A dedicated trusted display and authenticated device-to-relay transport are required before production.

The firmware rejects requests whose contract ID or network ID does not exactly match its compiled configuration. The contract remains authoritative for policy, expiry, nonce, and signature validity.
