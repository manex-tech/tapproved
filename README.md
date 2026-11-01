# Tapproved

**AI agents can't spend big without your tap.**

Tapproved is a hardware-backed spending approval system for AI agents on NEAR. Agents can spend within an on-chain policy; payments requiring human approval wait for a physical ESP32 button press and a device signature.

Built for **NEAR HACKATHON**. Tracks: **AI Security & Defense** and **Agent Economy**. **Testnet only.**

## Problem

AI agents can initiate financial actions faster than a human can review them. Wallet permissions alone do not provide a clear, enforceable boundary between routine spending and exceptional payments. A compromised or misconfigured agent can therefore create outsized financial risk. Tapproved adds an on-chain spending policy and a physical approval step for payments above a configured soft limit.

## Approach

A NEAR contract enforces per-transaction and daily spending limits, recipient restrictions, and payment state. Routine payments within policy can proceed automatically. Payments above the soft limit require a signature from a registered hardware approval device. The relay coordinates requests, while the contract remains authoritative for policy enforcement and settlement.

## Project status

All components are planned. No component is represented as implemented or audited at this stage.

| Component | Status |
|---|---|
| On-chain spending policy contract | Planned |
| Relay payment routes | Planned |
| ESP32 device signing | Planned |
| Local simulator | Planned |
| Scripted agent | Planned |
| NEAR AI Cloud agent | Planned |
| Dashboard | Planned |

## Origin

This repository started on **2026-11-01**. The concept grew out of the attendance prototype at https://github.com/manex-tech/near-tap. **No code was carried over** from that repository.

## Development disclosure

Code in this repository is being developed with AI assistance. The project author reviews and directs the implementation. AI assistance does not constitute an independent security review or audit.

## Known limitations

- Blind signing remains a limitation until the device can display and let the user verify transaction details.
- The device signing key may be extractable unless appropriate hardware and flash protections are configured.
- The project is for NEAR testnet only; mainnet use is out of scope.
- The contract, firmware, relay and overall system have not been independently audited.

## License

MIT. See [LICENSE](LICENSE).
