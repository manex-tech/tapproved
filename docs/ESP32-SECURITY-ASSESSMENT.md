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

The module name alone is insufficient to select a secure-boot procedure. The exact ESP32 silicon revision and eFuse capabilities must be identified on the target board before selecting a secure-boot mode. Espressif's current ESP32 eFuse reference distinguishes `ABS_DONE_0` (Secure Boot V1) and `ABS_DONE_1` (Secure Boot V2); the ESP32 Secure Boot V2 support is revision-dependent (ESP32 v3.0/ECO3 and later). Do not assume the generic PlatformIO `esp32dev` target identifies the exact revision. The eFuse summary must be read before choosing a compatible configuration.

## Recommended production hardening profile

1. Identify the exact SoC model/revision, flash size and current eFuse summary using read-only tooling on each hardware revision. Record the results before selecting security configuration.
2. Resolve the framework constraint before designing production Secure Boot: this repository currently builds with PlatformIO's Arduino framework. Espressif's FAQ says Secure Boot is not enabled directly in the Arduino development environment; Arduino must be integrated as an ESP-IDF component. Plan and test that framework/build-system migration before claiming a Secure Boot-capable production build.
3. Build a reproducible production firmware and bootloader configuration with Secure Boot appropriate to the identified silicon revision.
4. Enable Flash Encryption in Release Mode with a unique per-device encryption key. Do not use one shared encryption key across devices.
5. Use Secure Boot and Flash Encryption together. Validate the complete boot chain, partition table, application image, NVS storage and update/recovery process before production.
6. Treat NVS encryption as a separate feature. Espressif documents NVS encryption as requiring its own configuration and key-protection scheme; Flash Encryption alone does not mean every NVS entry is encrypted. Validate the Preferences/NVS storage path with an encrypted NVS partition and key partition in the chosen ESP-IDF integration.
7. Review JTAG, ROM UART download mode, BASIC ROM interpreter and flash download encryption/decryption settings. Espressif documents security-feature-dependent debug/download restrictions; inspect exact eFuse effects for this original ESP32 target and preserve an approved recovery/update path.
8. Maintain offline custody of image-signing keys. Define per-device provisioning, recovery, firmware update and key-rotation procedures before production.
9. Perform an explicit eFuse change review and obtain separate approval before any irreversible fuse programming.

## Irreversible-operation boundary

This repository change does not enable Secure Boot, Flash Encryption, JTAG disablement, UART download-mode disablement or any eFuse setting. These operations can permanently restrict reflashing/debugging and can render a development board unrecoverable if the bootloader, signing keys, partition table or recovery process is wrong. No espefuse, idf.py efuse-*, bootloader flash or production-mode encryption command is authorized by this assessment.

## Remaining limitations

- Preferences/NVS data is not treated as encrypted by this project configuration.
- A zeroizing RAM buffer reduces the time the private seed remains resident, but the seed is still present in RAM during signing.
- There is no secure element, tamper response or trusted display.
- The actual security posture cannot be confirmed until the physical board's silicon revision and eFuse state are inspected.

## References

- [Espressif Documentation Center](https://documentation.espressif.com/en/documentList): current document discovery portal; select the exact ESP32 product and ESP-IDF version before applying a procedure.
- [ESP-IDF User Guide for ESP32](https://documentation.espressif.com/projects/esp-idf/en/latest/esp32/index.html): target-specific framework documentation.
- [ESP32 eFuse API reference](https://documentation.espressif.com/projects/esp-idf/en/latest/esp32/api-reference/system/efuse.html): identifies Secure Boot V1/V2 eFuse state and other security controls.
- [ESP-IDF ESP32 eFuse reference, v5.2.8](https://documentation.espressif.com/projects/esp-idf/en/v5.2.8/esp32/api-reference/system/efuse.html): explicit ESP32 `ABS_DONE_0` and `ABS_DONE_1` fields.
- [Espressif ESP-FAQ handbook](https://documentation.espressif.com/api/resource/path/docs/projects/esp-faq/en/latest/esp-faq-en-master.pdf): see the Arduino Secure Boot compatibility answer and the ESP32 JTAG/UART download-mode notes.
- [Espressif Flash Encryption overview](https://documentation.espressif.com/projects/esp-iot-solution/en/latest/security_solution/flash_encryption.html): explains the complementary roles of Flash Encryption and Secure Boot, and states that NVS encryption is a separate feature.
- [ESP-IDF NVS Encryption documentation (ESP32-C6 guide)](https://documentation.espressif.com/projects/esp-idf/en/latest/esp32c6/index.html): illustrates NVS key partitions and the separate NVS encryption configuration. Treat this as conceptual reference only; use the exact ESP32 target's guide for implementation.
