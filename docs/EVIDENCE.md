# Tapproved implementation and evidence matrix

This page is an evidence index for reviewers. It distinguishes source code, automated checks, live NEAR Testnet transactions, and physical-device demonstration. A source file or passing mock test is not presented as proof of a live deployment.

## Implementation map

| Component | Implementation in this repository | What it does |
|---|---|---|
| NEAR smart contract | [`contract/src/lib.rs`](../contract/src/lib.rs) | Rust contract for treasury policy, recipient allowlisting, soft/hard/daily limits, payment lifecycle, Ed25519 verification, NEAR transfer promises, and settlement callbacks. |
| Relay/API | [`relay/server.js`](../relay/server.js), [`relay/approval-service.js`](../relay/approval-service.js), [`relay/near-signer.js`](../relay/near-signer.js), [`relay/serial.js`](../relay/serial.js) | Authenticated HTTP API, NEAR RPC/signing orchestration, hardware approval flow, serial transport, expiry and recovery services. |
| ESP32 firmware | [`firmware/src/main.cpp`](../firmware/src/main.cpp), [`firmware/include/`](../firmware/include/), [firmware guide](../firmware/README.md) | ESP32-WROOM-32 firmware; validates approval frames, waits for GPIO25 physical approval, and signs the canonical payload with Ed25519. |
| Agent SDK | [`sdk/index.js`](../sdk/index.js), [`sdk/index.d.ts`](../sdk/index.d.ts) | JavaScript client and TypeScript declarations for policy reads, payment requests, and payment-resolution handling. |
| Agent examples | [`examples/agent-request.js`](../examples/agent-request.js), [`examples/autonomous-agent.js`](../examples/autonomous-agent.js) | Testnet-oriented request example and a separate deterministic local autonomous lifecycle simulation. |
| Operator dashboard | [`dashboard/index.html`](../dashboard/index.html), [`dashboard/app.js`](../dashboard/app.js), [`dashboard/dashboard-service.js`](../dashboard/dashboard-service.js) | Local web dashboard for treasury telemetry, payment activity, pending approvals, and owner command generation. |

## Automated CI coverage

The workflow is [`.github/workflows/ci.yml`](../.github/workflows/ci.yml). It defines separate jobs; it is not contract-only CI.

| CI job | Checks performed | Evidence boundary |
|---|---|---|
| `node` | Installs locked dependencies, runs `npm run check`, runs the no-`.env` autonomous demo, and starts the relay without signer credentials to check its health endpoint. | Node.js tests and a local relay smoke test; not a live payment. |
| `contract` | Runs `cargo test`, builds the release Wasm target, and uploads the Wasm plus checksum. | Contract tests and reproducible build; not proof of a new deployment. |
| `firmware` | Runs host-side C++ tests for amount formatting, NVS record policy, zeroizing buffers, request-ID guard, protocol vector parity, and button state machine; builds the ESP32 firmware with PlatformIO and uploads the binary plus checksum. | Firmware source tests and compilation; the CI runner does not have a physical ESP32 attached. |
| `near-cli-readonly` | Installs pinned near-cli-rs and runs read-only Testnet views for policy, daily usage, a payment record, and storage metrics. | Live read-only RPC inspection; it does not submit a transaction or spend Testnet funds. |

A green workflow run should be checked on the commit being reviewed. The workflow definition documents intended coverage; it is not itself proof that a particular commit's run passed.

## Live NEAR Testnet evidence

- **Contract deployment:** [deployment transaction](https://explorer.testnet.near.org/transactions/4psHQnNteqE8SR6g9dBnSeu4smnpt3hDqXjFkzU3kzkU); deployed contract account: [`manextech.testnet`](https://explorer.testnet.near.org/accounts/manextech.testnet).
- **Registered agent account:** [`manex-agent.testnet`](https://explorer.testnet.near.org/accounts/manex-agent.testnet).
- **Routine payment request, ID 10:** [request transaction](https://explorer.testnet.near.org/transactions/GtxfhED8E3VZmH8Av9G3riuLo24bcFfPmJAVMLKLxDaS).
- **Routine payment settlement, ID 10:** [execution and settlement transaction](https://explorer.testnet.near.org/transactions/EpGEwmDAQs8mJddqiC95y4hMYVmd7XFU7UCRHUTM5EC1).
- **Hardware-gated request, ID 11:** [pending request transaction](https://explorer.testnet.near.org/transactions/7zkK6JNuwp7qFcNf4CTcH2UFiVco8JnvdY7hzuECjU25). This transaction proves creation of a pending elevated payment, not its hardware approval or settlement.
- **Hardware-approved payment, ID 3:** [hardware milestone report](TESTNET-HARDWARE-APPROVAL-MILESTONE.md). The report records the ESP32 signature, registered public-key match, physical GPIO25 approval, contract acceptance, and final `paid` state. Important limitation: the recipient was the treasury account itself, not an independent merchant.

## Physical demonstration

The [public demo video on X](https://x.com/manextech/status/2120119706447143052) shows the agent request, physical ESP32 button interaction, and Testnet explorer confirmation. The accompanying [hardware milestone report](TESTNET-HARDWARE-APPROVAL-MILESTONE.md) records the payment ID and on-chain state used to substantiate the hardware approval path.

## What is not claimed

- The autonomous quickstart command `npm run agent:autonomous` is a deterministic **local simulation**. It uses an in-process relay and local policy/payment adapter; it is not a live Testnet transaction.
- The dashboard is a locally launched application, not a permanently hosted production service.
- CI firmware tests and builds run without a physical ESP32. Physical approval evidence comes from the separately documented hardware milestone and demo.
- The hardware milestone's recipient was the treasury account itself. It does not establish an independent merchant payment.
- The prototype is Testnet-only and unaudited. The ESP32 seed is stored in ordinary NVS; flash encryption, secure boot, debug-port hardening, authenticated device transport, and a trusted display are not configured.
- No mainnet deployment, independent security audit, or production readiness is claimed.

## Reviewer quick path

1. Read the [implementation map](#implementation-map) to locate each component.
2. Inspect the CI workflow and verify the actual run status for the commit under review.
3. Open the routine-payment request and settlement transactions.
4. Open the hardware milestone report and public demo video.
5. Read the [ESP32 security assessment](ESP32-SECURITY-ASSESSMENT.md) and [threat model](SECURITY-THREAT-MODEL.md) for the explicit security limitations.
