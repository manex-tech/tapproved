# Tapproved: NEAR AI Agent Hackathon Submission & Architecture

> **Hardware-Backed Spending Authorization for Autonomous AI Agents on NEAR**

## 1. Executive Summary

Autonomous AI agents are increasingly entrusted with on-chain resources, but granting an agent uncontrolled access to a private key creates unacceptable systemic risk. If an agent hallucinates, suffers prompt injection, or has its credentials compromised, the entire treasury can be drained instantly.

**Tapproved solves this fundamental bottleneck.** It establishes a dual-tier authorization architecture:
1. **Autonomous Operations**: Routine, low-risk payments (`<= soft_limit_yocto`) within policy limits and to allowlisted recipients execute automatically without human drag.
2. **Hardware-Gated Security**: High-value transactions (`> soft_limit_yocto` and `<= hard_limit_yocto`) enter a strict `pending` state and physically require human approval on an ESP32 hardware token (via physical button press on GPIO25). The ESP32 signs the canonical approval payload with an isolated Ed25519 keypair, which the NEAR smart contract cryptographically verifies before executing any transfer.

---

## 2. Baseline vs. Hackathon Advancements

Tapproved started as an experimental prototype. During the hackathon, we transformed it into an enterprise-grade, demonstrable, end-to-end authorization infrastructure:

| Component | Baseline State | Hackathon Advancements |
|---|---|---|
| **NEAR Contract** | Monolithic state with unindexed vector payments vulnerable to unbounded gas limits; incompatible legacy state on Testnet. | Migrated in-place on live Testnet `manextech.testnet` using guarded private migration; refactored to $O(1)$ `LookupMap` storage; implemented NEP-297 standard event emission (`payment_requested`, `payment_approved`, `payment_paid`); implemented `get_storage_metrics` staking monitor. |
| **End-to-End Testnet Execution** | Unexercised callback settlement on Testnet. | Successfully executed and settled Payment #4 on NEAR Testnet (`0.001 NEAR` to `manex-agent.testnet`) via atomic Promise callback `on_transfer_result`. Verified balance increases and reservation reconciliation on-chain. |
| **ESP32 Firmware** | Basic serial prototype targeting wrong contract. | Re-aligned to `manextech.testnet`; extracted testable C++ encoder with byte-for-byte protocol test vector parity; implemented debounced hardware button state machine (held-at-arrival rejection); implemented volatile scope-bound zeroizing memory buffers. |
| **AI Agent SDK** | Basic one-off request script. | Built production-grade JavaScript/TypeScript SDK (`sdk/index.js`, `sdk/index.d.ts`) with typed error hierarchy (`AuthenticationError`, `PolicyViolationError`, `IdempotencyConflictError`), URL normalization, and `waitForPaymentResolution` with pending-approval event hooks. |
| **Autonomous Agent Demo** | None. | Created `examples/autonomous-agent.js` demonstrating autonomous routine payments, high-value payment hardware gating, and automated policy violation rejection. |
| **Monitoring Dashboard** | Non-existent (`dashboard/.gitkeep`). | Built high-contrast monochrome hacker terminal monitoring dashboard (`dashboard/`) with live NEAR Testnet RPC integration, daily spend progress bar, real-time pending approval alert, payment history, owner management command generator, and transaction receipt explorer. |
| **Security & Threats** | Ad-hoc documentation. | Produced formal Threat Model & Blast Radius Analysis (`docs/SECURITY-THREAT-MODEL.md`) analyzing agent-key theft, hardware-key extraction, replay resistance, relay compromise, and storage exhaustion. |

---

## 3. Canonical On-Chain Testnet Evidence

All components run live on **NEAR Testnet**:

- **Contract Account & Treasury**: [`manextech.testnet`](https://explorer.testnet.near.org/accounts/manextech.testnet)
- **Registered Agent Account**: [`manex-agent.testnet`](https://explorer.testnet.near.org/accounts/manex-agent.testnet)
- **Deployed Contract Code Hash**: `Amp87jC1DCJjyA5bsmfEpFQzuqu72Cw7NSLRNk8uh3R5`
- **Contract Code Deployment Tx**: [`4psHQnNteqE8SR6g9dBnSeu4smnpt3hDqXjFkzU3kzkU`](https://explorer.testnet.near.org/transactions/4psHQnNteqE8SR6g9dBnSeu4smnpt3hDqXjFkzU3kzkU)
- **In-Place State Migration Tx**: [`4AXh7BECjmMy2X7JCmS8G3UdXbXvJMNzJNDrj6Cq87Sh`](https://explorer.testnet.near.org/transactions/4AXh7BECjmMy2X7JCmS8G3UdXbXvJMNzJNDrj6Cq87Sh)
- **Recipient Allowlist Expansion Tx**: [`CTT3bGrY1pzw276BTwVotsoP9A9WpnzGj8z5tTXtafDp`](https://explorer.testnet.near.org/transactions/CTT3bGrY1pzw276BTwVotsoP9A9WpnzGj8z5tTXtafDp)
- **Live Automatic Payment Request (ID #4) Tx**: [`6FY3y24tZ21Yb8vgDsHkMQU8qqYCuo6ESeJoybLUTFUu`](https://explorer.testnet.near.org/transactions/6FY3y24tZ21Yb8vgDsHkMQU8qqYCuo6ESeJoybLUTFUu)
- **Automatic Execution & Promise Settlement Tx**: [`C5fZ7UW8TW3nSwv8EhD4gh8GdmUpMdqvCjHAGA1fkUNi`](https://explorer.testnet.near.org/transactions/C5fZ7UW8TW3nSwv8EhD4gh8GdmUpMdqvCjHAGA1fkUNi)
- **First Hardware-Gated Payment (ID #3) Documented**: [`docs/TESTNET-HARDWARE-APPROVAL-MILESTONE.md`](TESTNET-HARDWARE-APPROVAL-MILESTONE.md)

---

## 4. Reproducible Demonstration Runbook

### Prerequisites
- Node.js >= 22.22.2
- Git

### 1. Verify Test Suite & Integrity
```bash
git clone https://github.com/manex-tech/tapproved.git
cd tapproved
npm ci
npm run check
```
*Executes all 169 Node test assertions, syntax checks across SDK, relay, examples, and dashboard.*

### 2. Run the Autonomous Agent Demo
```bash
npm run agent:autonomous
```
*Demonstrates the AI agent inspecting live on-chain policy, requesting routine spends, handling high-value hardware gating, and reacting to policy violations.*

### 3. Launch the Live Dashboard
```bash
npm start
```
*Open `http://localhost:3000/dashboard` in any web browser to view real-time treasury balances, daily spending quota, payment history, and owner administrative controls.*

---

## 5. Submission Metadata JSON

The formal hackathon submission metadata is codified in `docs/submission.json`:

```json
{
  "project_name": "Tapproved",
  "tagline": "Hardware-backed spending authorization for AI agents on NEAR",
  "track": "AI Agents & Security Infrastructure",
  "repository": "https://github.com/manex-tech/tapproved",
  "license": "MIT",
  "network": "testnet",
  "canonical_contract": "manextech.testnet",
  "registered_agent": "manex-agent.testnet",
  "hardware_platform": "ESP32-WROOM-32 (GPIO25)",
  "cryptography": "Ed25519",
  "verified_transactions": {
    "migration": "4AXh7BECjmMy2X7JCmS8G3UdXbXvJMNzJNDrj6Cq87Sh",
    "automatic_payment_request": "6FY3y24tZ21Yb8vgDsHkMQU8qqYCuo6ESeJoybLUTFUu",
    "automatic_payment_settlement": "C5fZ7UW8TW3nSwv8EhD4gh8GdmUpMdqvCjHAGA1fkUNi"
  }
}
```
