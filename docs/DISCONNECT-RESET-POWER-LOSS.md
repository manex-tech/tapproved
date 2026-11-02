# Disconnect, reset and power-loss recovery tests

**Scope:** Source-level and host-test coverage for the current ESP32 USB-serial approval path and NVS device-key record policy. This is not evidence of physical ESP32 fault-injection testing.

## Expected behavior and evidence

| Fault or restart point | Expected behavior | Automated evidence |
|---|---|---|
| USB serial disconnect while approval is pending | Reject the pending relay request, clear the partial input buffer and pending state, and do not accept a late response as the next request | `relay/serial.test.js` covers disconnect, stale response rejection and incomplete-frame clearing |
| ESP32 resets and the serial port closes unexpectedly | Reject the in-flight approval; a later explicit `connect()` can reopen the port; only a response with the new request UUID can complete the new request | `relay/serial.test.js` covers unexpected close, reconnect and old UUID rejection |
| ESP32 resets before returning a signature | Approval processor fails closed; it does not invoke the signer or create a submission operation | `relay/approval-service.test.js` covers a correlated `serial_port_closed` failure |
| Relay process restarts with a durable operation in an uncertain/submitting state | Do not request another physical signature or resubmit until the operation is reconciled against contract state | Existing approval-service recovery tests cover suppression of another device request while recovery is required |
| ESP32 resets with a complete 32-byte NVS seed intact | Load the same seed and derive the same device identity | `firmware/test/key_record_policy_test.cpp` models a successful write followed by reset and reload |
| NVS contains a present but truncated seed record | Fail closed; do not silently create a replacement key | `firmware/test/key_record_policy_test.cpp` tests every present record length from 0 through 31 bytes |
| Power is lost after the complete seed write but before public-key derivation | A subsequent boot can load the complete persisted seed | Host model in `firmware/test/key_record_policy_test.cpp` |
| NVS seed record is absent or fully erased | Firmware treats it as first boot and generates a new identity | Host model explicitly documents this behavior; the new key will not match the contract until an owner-approved rotation is completed |

## Recovery invariants

- A device reset or serial disconnect is not an approval. No signature means the relay must not submit an approval transaction.
- The relay does not automatically retry a failed physical approval. A later attempt is a separate explicit invocation after the active contract payment and relay operation state have been re-read.
- Request UUID history is volatile and resets on reboot. It is a transport-level duplicate guard, not durable payment replay protection. Contract payment status, nonce and signature verification remain authoritative.
- A complete persisted NVS seed preserves the device identity across reset. A malformed present seed record fails closed.
- An absent seed record is indistinguishable from first boot to the current firmware. If NVS is erased, the firmware may create a new unregistered identity. Do not register or rotate to that key without an explicit owner-approved operation.
- If a reset occurs after an approval transaction may have been broadcast, treat the outcome as ambiguous and reconcile finalized contract state. Never blindly resubmit or repeat the hardware approval.

## Verification boundary

CI runs host-compiled C++ policy/state tests, relay unit tests, contract tests and the ESP32 firmware build. The NVS tests model the record policy and do not emulate ESP-IDF Preferences, flash wear-leveling, brownout behavior or physical power interruption. No board was unplugged, reset, power-cycled, flashed or erased as part of this task.

Before relying on this behavior on hardware, perform a separately approved bench test with a controlled test payment and a documented power/USB interruption matrix. Never perform NVS erase or contract rotation without separate explicit approval.
