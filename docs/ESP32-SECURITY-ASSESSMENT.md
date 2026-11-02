# ESP32 security assessment

**Assessment date:** 2026-11-02  
**Target:** Generic PlatformIO esp32dev environment, intended ESP32-WROOM-32 module  
**Status:** Source-level assessment only. No chip revision, eFuse state, flash encryption state, secure-boot state or debug-port state has been read from physical hardware.

## Current source configuration

- firmware/platformio.ini selects the generic esp32dev target and Arduino framework.
- The firmware stores the 32-byte Ed25519 seed in Preferences/NVS.
- No NVS encryption key partition or NVS-encryption configuration is present in this repository.
- No explicit Secure Boot, Flash Encryption, signed bootloader, signed application or production partition-table configuration is present.
- No code or manufacturing procedure verifies or disables JTAG, ROM UART download mode or other debug/download paths.
- The source uses a fail-closed NVS key-record policy. It creates a seed only when the record is absent and refuses to overwrite a malformed existing record.
- The private seed is no longer a global. It is held in scope-bound zeroizing buffers while deriving the public key at startup and only reloaded after a fresh physical approval immediately before signing. The derived public key is compared with the startup identity before signing.
- These software changes reduce exposure but do not protect the seed from physical flash readout when flash encryption is off, or from runtime/debug extraction while the seed is in RAM.

## Silicon-revision dependency

The module name alone is insufficient to select a secure-boot procedure. The exact ESP32 silicon revision and eFuse capabilities must be identified on the target board before selecting a secure-boot mode. Espressif documents Secure Boot V1 for original ESP32 revisions before ECO3 and Secure Boot V2 for ESP32 v3.0 onwards. Do not assume the generic PlatformIO esp32dev target identifies the exact revision.

## Recommended production hardening profile

1. Identify the exact SoC model/revision, flash size and current eFuse summary using read-only tooling on each hardware revision. Record the results before selecting security configuration.
2. Build a reproducible production firmware and bootloader configuration with Secure Boot appropriate to the identified silicon revision.
3. Enable Flash Encryption in Release Mode with a unique per-device encryption key. Do not use one shared encryption key across devices.
4. Use Secure Boot and Flash Encryption together. Validate the complete boot chain, partition table, application image, NVS storage and update/recovery process before production.
5. Review JTAG, ROM UART download mode, BASIC ROM interpreter and flash download encryption/decryption settings. Disable only interfaces not required by the approved manufacturing and recovery process.
6. Maintain offline custody of image-signing keys. Define per-device provisioning, recovery, firmware update and key-rotation procedures before production.
7. Perform an explicit eFuse change review and obtain separate approval before any irreversible fuse programming.

## Irreversible-operation boundary

This repository change does not enable Secure Boot, Flash Encryption, JTAG disablement, UART download-mode disablement or any eFuse setting. These operations can permanently restrict reflashing/debugging and can render a development board unrecoverable if the bootloader, signing keys, partition table or recovery process is wrong. No espefuse, idf.py efuse-*, bootloader flash or production-mode encryption command is authorized by this assessment.

## Remaining limitations

- Preferences/NVS data is not treated as encrypted by this project configuration.
- A zeroizing RAM buffer reduces the time the private seed remains resident, but the seed is still present in RAM during signing.
- There is no secure element, tamper response or trusted display.
- The actual security posture cannot be confirmed until the physical board's silicon revision and eFuse state are inspected.

## References

- Espressif ESP32 Security Overview: https://docs.espressif.com/projects/esp-idf/en/stable/esp32/security/security.html
- Espressif ESP32 Secure Boot V1: https://docs.espressif.com/projects/esp-idf/en/latest/esp32/security/secure-boot-v1.html
- Espressif ESP32 Flash Encryption: https://docs.espressif.com/projects/esp-idf/en/latest/esp32/security/flash-encryption.html
