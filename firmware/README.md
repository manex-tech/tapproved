# ESP32 firmware prototype

Target: ESP32-WROOM-32 (PlatformIO board `esp32dev`), Arduino framework.

## Canonical deployment

The firmware is compiled for the Tapproved NEAR testnet deployment:

- Contract: `manextech.testnet`
- Network: `testnet`
- Approval button: GPIO25

The contract ID and network ID are compile-time constants in `src/main.cpp`. If the canonical deployment changes, update those constants, rebuild and flash the firmware, then verify the device signs the exact contract and network values used by the relay and contract.

## Disposable B10 lab deployment

A separate PlatformIO environment targets the disposable B10 validation contract. It inherits the canonical ESP32 board, framework, dependencies, and base build flags, while overriding only the compiled contract ID.

- Contract: `contract.tapproved-b10-lab.testnet`
- Network: `testnet`
- Approval button: GPIO25

Build the lab firmware from this directory:

```sh
pio run -e esp32dev-lab
```

Build the canonical firmware explicitly:

```sh
pio run -e esp32dev
```

**Important:** Never upload the lab firmware for use with the canonical `manextech.testnet` deployment. Verify the selected environment before every upload. To upload the lab build, explicitly use `pio run -e esp32dev-lab --target upload`; to upload the canonical build, use `pio run -e esp32dev --target upload`.

Switching build environments does not erase or regenerate the existing device key in NVS. Both builds use the same firmware key-storage namespace and seed key. The contract ID is a compile-time setting and is not stored in NVS.

## Build and flash

Install PlatformIO Core, then run from this directory:

```sh
pio run
pio run --target upload
pio device monitor --baud 115200
```

Wire a normally-open push button between GPIO25 and GND. The input uses the internal pull-up. Never connect 5 V to an ESP32 GPIO.

Send one JSON object per serial line with fields `contract_id`, `network_id`, `payment_id`, `recipient_id`, `amount_yocto`, `nonce`, and `expires_at_ns`. Integer values must be decimal strings. The firmware encodes the v1 payload itself, waits for the physical button, and signs with Ed25519. Amounts are converted into 16 little-endian bytes without floating point or compiler-specific 128-bit integers.

## Key handling warning

On first boot, the ESP32 hardware RNG generates a 32-byte seed, stored in Preferences/NVS. The public key is printed for testnet registration. The private seed is never printed.

This is a development prototype, not hardened key custody. The seed is stored in ordinary NVS. Flash encryption, secure boot, debug-port lockdown, tamper resistance, authenticated request transport, and a trusted display are not configured. Do not use real funds or production keys.

## Approval UI limitation

Payment details are printed to USB serial and GPIO25 requires a physical button press. Serial output is not a trusted display: a compromised host or relay could misrepresent the request. Do not use this as a blind-signing production device. A dedicated trusted display and authenticated device-to-relay transport are required before production.

The firmware rejects requests whose contract ID or network ID does not exactly match its compiled configuration. The contract remains authoritative for policy, expiry, nonce, and signature validity.
