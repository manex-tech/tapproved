# Tapproved

[![NEAR Testnet](https://img.shields.io/badge/NEAR-Testnet-00EC97?logo=near&logoColor=black)](https://explorer.testnet.near.org/accounts/manextech.testnet)
[![Contract](https://img.shields.io/badge/Contract-manextech.testnet-blue)](https://explorer.testnet.near.org/accounts/manextech.testnet)
[![Agent](https://img.shields.io/badge/Agent-manex--agent.testnet-purple)](https://explorer.testnet.near.org/accounts/manex-agent.testnet)
[![CI Matrix](https://img.shields.io/badge/CI-Passing-success)](https://github.com/manex-tech/tapproved/actions)
[![License](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

> **Hardware-backed spending authorization for autonomous AI agents on NEAR.**  
> Routine payments execute automatically within strict policy limits; elevated payments require a physical button press on an ESP32 hardware device generating an Ed25519 signature.

---

## 1. Problem & Innovation

| The AI Agent Dilemma | The Tapproved Solution |
|---|---|
| **Full Custody (Unsafe)**: Granting an AI agent an unconstrained private key means prompt injections, hallucinated transactions, or leaked credentials can drain an entire treasury in seconds. | **Tiered On-Chain Policy**: Routine transactions (`<= soft_limit_yocto`) execute autonomously; high-value payments (`> soft_limit_yocto`) are locked in `pending` on-chain until physically authorized. |
| **Full Human-in-the-Loop (Slow)**: Forcing human confirmation for every micropayment destroys autonomy and creates operational friction. | **Autonomous Within Guardrails**: Agents spend freely within pre-configured per-payment and daily spending limits, paying only allowlisted partner accounts. |
| **Software Approvals (Vulnerable)**: Traditional 2FA and push notifications to smartphones or browsers are susceptible to phishing, session hijacking, and host compromise. | **Physical Hardware Isolation**: Ed25519 private keys reside on an isolated ESP32 device that signs only after a physical button press (GPIO25). |

---

## 2. System Architecture

```mermaid
sequenceDiagram
    autonumber
    actor User as Human Operator
    participant Agent as AI Agent (manex-agent.testnet)
    participant Relay as Node.js Relay Server
    participant ESP32 as ESP32 Hardware (GPIO25)
    participant Contract as NEAR Treasury (manextech.testnet)
    participant Recipient as Recipient Account

    Agent->>Relay: POST /v1/payment-requests (recipient, amount, idempotency_key)
    Relay->>Contract: request_spend(recipient, amount)

    alt Amount <= Soft Limit (Routine Spend)
        Contract-->>Contract: Assign status: approved (reserve daily spend)
        Relay->>Contract: execute_approved_spend(payment_id)
        Contract->>Recipient: Promise::transfer(amount)
        Contract-->>Contract: on_transfer_result (status: paid)
    else Amount > Soft Limit (High-Value Spend)
        Contract-->>Contract: Assign status: pending (lock active payment)
        Relay->>ESP32: Serial frame: Approval request details
        Note over ESP32: Waits for physical button actuation
        User->>ESP32: Press GPIO25 button
        ESP32-->>Relay: Serial frame: Ed25519 signature + public key
        Relay->>Contract: approve_spend(payment_id, signature)
        Contract-->>Contract: Verify Ed25519(sig, canonical_msg, device_key)
        Contract->>Recipient: Promise::transfer(amount)
        Contract-->>Contract: on_transfer_result (status: paid)
    end
```

---

## 3. Verified Live Testnet Evidence

Tapproved is deployed and fully verified on **NEAR Testnet**:

| Milestone | Entity / Transaction | Link / Hash |
|---|---|---|
| **Treasury Contract** | `manextech.testnet` | [NEAR Explorer](https://explorer.testnet.near.org/accounts/manextech.testnet) |
| **Registered Agent** | `manex-agent.testnet` | [NEAR Explorer](https://explorer.testnet.near.org/accounts/manex-agent.testnet) |
| **Contract Deployment** | Release Wasm Code Hash | `Amp87jC1DCJjyA5bsmfEpFQzuqu72Cw7NSLRNk8uh3R5` ([Tx](https://explorer.testnet.near.org/transactions/4psHQnNteqE8SR6g9dBnSeu4smnpt3hDqXjFkzU3kzkU)) |
| **In-Place State Migration** | Guarded `migrate()` | [Tx `4AXh7BEC...`](https://explorer.testnet.near.org/transactions/4AXh7BECjmMy2X7JCmS8G3UdXbXvJMNzJNDrj6Cq87Sh) (Gas: 0.309 Tgas) |
| **Allowlist Expansion** | `add_allowed_recipient` | [Tx `CTT3bGrY...`](https://explorer.testnet.near.org/transactions/CTT3bGrY1pzw276BTwVotsoP9A9WpnzGj8z5tTXtafDp) |
| **Autonomous Request #4** | `request_spend(0.001 NEAR)` | [Tx `6FY3y24t...`](https://explorer.testnet.near.org/transactions/6FY3y24tZ21Yb8vgDsHkMQU8qqYCuo6ESeJoybLUTFUu) |
| **Settlement & Callback #4** | `execute_approved_spend(4)` | [Tx `C5fZ7UW8...`](https://explorer.testnet.near.org/transactions/C5fZ7UW8TW3nSwv8EhD4gh8GdmUpMdqvCjHAGA1fkUNi) |
| **Hardware Approval #3** | First ESP32 Button Approval | [Milestone Report](docs/TESTNET-HARDWARE-APPROVAL-MILESTONE.md) |

---

## 4. 3-Minute Quickstart & Reproducibility

### Prerequisites
- Node.js >= 22.22.2
- Git

### 1. Install & Run Verification Test Suite
```bash
git clone https://github.com/manex-tech/tapproved.git
cd tapproved
npm ci
npm run check
```
*Runs all 169 Node test assertions, syntax checks across SDK, relay, examples, and dashboard.*

### 2. Run the Autonomous AI Agent Demo
```bash
npm run agent:autonomous
```
*Simulates the full agent lifecycle: inspects live on-chain policy, executes routine spending, handles high-value hardware gating, and recovers from policy rejections.*

### 3. Launch the Monitoring Dashboard
```bash
npm start
```
*Open `http://localhost:3000/dashboard` to view real-time treasury balances, daily quota progress, pending approval alerts, payment history, and owner administrative controls.*

---

## 5. AI Agent SDK

The official SDK (`sdk/index.js`, `sdk/index.d.ts`) provides clean, strongly-typed interfaces for agentic frameworks:

```javascript
import { TapprovedClient } from "tapproved/sdk";

const client = new TapprovedClient({
  relayUrl: "http://127.0.0.1:3000",
  token: process.env.AGENT_API_TOKEN
});

// 1. Inspect spending policy
const policy = await client.getPolicy();
console.log("Daily Limit:", policy.daily_limit_yocto);

// 2. Request an autonomous payment
const result = await client.requestPayment({
  recipientId: "merchant.testnet",
  amountYocto: "5000000000000000000000" // 0.005 NEAR
});

// 3. Await resolution with pending-approval notification hooks
const payment = await client.waitForPaymentResolution(result.payment.id, {
  onPendingApproval: (pending) => {
    console.log(`[ALERT] Payment ${pending.id} awaiting physical ESP32 button press!`);
  }
});
console.log("Settlement Status:", payment.status); // 'paid'
```

See the [Agent Integration Guide](docs/AGENT-INTEGRATION.md) for error hierarchies, typed definitions, and idempotency guarantees.

---

## 6. Real-Time Dashboard

The dashboard provides operators with complete situational awareness over agent activity:

- **Treasury Telemetry**: Live NEAR native balance, available balance, storage staking reserve, and storage headroom.
- **Daily Quota Progress**: Visual percentage bar tracking cumulative spend + reservations against `daily_limit_yocto`.
- **Active Pending Approval Banner**: Real-time pulsing alert with countdown timer whenever a high-value payment is awaiting physical ESP32 button confirmation.
- **Payment History Table**: Comprehensive log of all payments, showing amounts in readable NEAR and exact yoctoNEAR, statuses (`paid`, `approved`, `pending`, `expired`), timestamps, and hardware-signed badges.
- **Owner Governance Generator**: Interactive tool to generate executable `near-cli-rs` commands for emergency pause/unpause, allowlist management, and spending limit updates.
- **Transaction Explorer**: Query any NEAR transaction hash for execution receipts and finality status.

---

## 7. Security Architecture & Threat Model

| Threat Scenario | Defense & Mitigation | Documented In |
|---|---|---|
| **Agent Key Theft** | Blast radius is strictly capped by per-payment soft limit and daily spending limit. Attacker can only pay pre-approved allowlist recipients. Owner can freeze treasury via `pause()` or rebind agent key via `set_agent()`. | [Threat Model §2.1](docs/SECURITY-THREAT-MODEL.md) |
| **Hardware Key Extraction** | Signatures cannot conjure payments or bypass on-chain policy. Signatures are accepted only if a payment is already created by the agent in `pending` state and within the 5-minute expiry window. Owner can rotate device key atomically via `rotate_device_key()`. | [Threat Model §2.2](docs/SECURITY-THREAT-MODEL.md) |
| **Signature Replay** | The canonical payload cryptographically binds `payment_id`, `recipient_id`, `amount_yocto`, `nonce`, `expires_at_ns`, `contract_id`, and `network_id`. Signatures cannot be replayed on mainnet or across payments. | [Threat Model §2.4](docs/SECURITY-THREAT-MODEL.md) |
| **Relay Compromise** | Relay possesses zero spending authority. Tampering with serial payloads invalidates the Ed25519 signature on-chain. Stalled payments expire safely without loss of funds. | [Threat Model §2.5](docs/SECURITY-THREAT-MODEL.md) |
| **Storage Exhaustion** | Storage uses $O(1)$ `LookupMap` collections; daily usage is pruned after 90 days; allowlist is capped at 100 recipients; `get_storage_metrics` monitors available headroom (~2.42 NEAR). | [Threat Model §3](docs/SECURITY-THREAT-MODEL.md) |

---

## 8. Master Documentation Sitemap

- [NEAR Hackathon Submission & Architecture](docs/HACKATHON.md) — Comprehensive hackathon overview, innovation summary, and submission metadata.
- [Security Threat Model & Analysis](docs/SECURITY-THREAT-MODEL.md) — Formal trust boundaries, threat scenarios, and blast-radius mitigations.
- [AI Agent Integration Guide](docs/AGENT-INTEGRATION.md) — Complete SDK documentation, idempotency rules, and error codes.
- [Master Development Checklist](docs/MASTER-DEVELOPMENT-CHECKLIST.md) — Canonical task-by-task execution evidence, CI run URLs, and milestone logs.
- [Testnet Deployment Runbook](docs/TESTNET-DEPLOYMENT.md) — Exact operator runbook for contract deployment, state migration, and verification.
- [Hardware Approval Milestone](docs/TESTNET-HARDWARE-APPROVAL-MILESTONE.md) — Verified evidence of the first end-to-end physical ESP32 approval.
- [Approval Protocol v1](docs/APPROVAL-PROTOCOL.md) — Canonical binary serialization and deterministic Ed25519 test vectors.
- [ESP32 Security Assessment](docs/ESP32-SECURITY-ASSESSMENT.md) — Physical micro-controller security, NVS key storage, and memory zeroization.
- [Device Key Rotation](docs/DEVICE-KEY-ROTATION.md) — Operational runbook for zero-downtime hardware key rotation.

---

## 9. License

This project is licensed under the [MIT License](LICENSE).
