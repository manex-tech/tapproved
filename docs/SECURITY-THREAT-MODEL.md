# Tapproved Security Threat Model & Defense-in-Depth Analysis

This document provides the formal security analysis, trust boundaries, threat models, and failure-mode mitigations for the Tapproved hardware-backed payment authorization system.

---

## 1. System Architecture & Trust Boundaries

The system comprises five distinct architectural trust domains:

1. **NEAR Smart Contract (`manextech.testnet`)**: The authoritative root of trust. Enforces treasury custody, daily accounting, policy limits, recipient allowlists, cryptographic verification, and atomic Promise-based settlement.
2. **Physical Hardware Token (ESP32-WROOM-32)**: Isolated signing environment. Holds the Ed25519 device private key, requires physical GPIO25 button actuation, and reconstructs the canonical approval message before signing.
3. **AI Agent (`manex-agent.testnet`)**: Semi-trusted initiator. Authenticated via dedicated NEAR keypair and relay bearer token; restricted strictly by on-chain policy.
4. **Relay Orchestrator (Node.js)**: Untrusted transport and keeper coordinator. Coordinates serial communication with the ESP32 and broadcasts transactions; cannot mutate amounts, recipients, or bypass contract checks.
5. **Contract Owner (`manextech.testnet`)**: Administrative governance authority. Configures policies, allowlists, and emergency pause controls.

```
       +---------------------------------------------+
       |           AI Agent (Semi-trusted)           |
       +---------------------------------------------+
                              |
                     requestPayment()
                              v
       +---------------------------------------------+
       |             Relay (Untrusted)               |
       +---------------------------------------------+
                |                           |
         Serial Frame                  NEAR RPC
                v                           v
+-------------------------------+   +------------------------------------+
|  ESP32 Hardware (Isolated)    |   | NEAR Contract (Authoritative Root) |
|  - Physical Button (GPIO25)   |   | - Spending Limits (Soft/Hard/Daily)|
|  - Ed25519 Signing Engine     |   | - Recipient Allowlist              |
+-------------------------------+   | - State Machine & Settlement       |
                                    +------------------------------------+
```

---

## 2. Threat Analysis & Blast-Radius Mitigation

### H2. Agent-Key Compromise

- **Threat Scenario**: An attacker gains full access to the AI agent's private key (`manex-agent.testnet`) or API bearer token.
- **Attacker Capabilities**:
  - Can initiate payment requests up to `soft_limit_yocto` (0.01 NEAR) without human interaction.
  - Can initiate high-value requests (up to `hard_limit_yocto` = 0.1 NEAR), but these remain locked in `pending` status.
- **Contract Guardrails & Blast Radius Containment**:
  - **Allowlist Bound**: The attacker cannot exfiltrate funds to an arbitrary account; payments can ONLY be sent to accounts explicitly approved in `allowed_recipients`.
  - **Per-Payment Soft Limit Bound**: Any request exceeding `soft_limit_yocto` requires the physical ESP32 button press.
  - **Daily Quota Bound**: Cumulative spending across all requests within a UTC day is strictly capped by `daily_limit_yocto` (0.5 NEAR). Any request exceeding remaining quota panics with `"request exceeds remaining UTC daily limit"`.
  - **Maximum Theoretical Loss**: Bounded to the remaining daily limit for that day, payable only to already approved partner accounts.
- **Incident Response**:
  - Owner calls `pause()` to immediately freeze all agent spending.
  - Owner calls `set_agent(new_agent_account)` to rebind the agent role to a fresh keypair.

---

### H3. Hardware-Key Extraction

- **Threat Scenario**: An attacker physically extracts the Ed25519 private seed from ESP32 flash memory or debug probes.
- **Attacker Capabilities**:
  - Can generate valid Ed25519 signatures for arbitrary messages offline.
- **Contract Guardrails**:
  - **Pre-condition Enforcement**: The contract's `approve_spend` method checks that an active payment is currently in `PaymentStatus::Pending`. A signature cannot conjure a payment out of thin air.
  - **Agent Authorization Required**: A payment can only enter `pending` status if first created by the registered agent.
  - **Policy & Recipient Bounds**: Even if the hardware key is possessed, the payment parameters (amount, recipient) were already validated against the allowlist and hard limit when requested.
  - **Expiry Enforcement**: Signatures are rejected if `env::block_timestamp() > payment.expires_at_ns`.
- **Mitigation & Recovery**:
  - Owner calls `rotate_device_key(new_public_key)`. The contract atomically updates `device_public_key`, immediately invalidating all signatures produced by the compromised key while preserving existing pending payments.

---

### H4. Malicious Recipient & Request Manipulation

- **Threat Scenario**: A prompt-injection attack or malicious dependency tricks the agent into transferring funds to an attacker-controlled address.
- **Contract Guardrails**:
  - **On-chain Allowlist**: The contract enforces `self.allowed_recipients.contains(&recipient_id)`. Non-allowlisted recipients panic with `"recipient is not allowlisted"`.
  - **Account ID Validation**: NEAR account IDs are validated to conform to NEAR syntax (2–64 characters, lowercase alphanumeric with separators).
  - **Zero & Overflow Prevention**: Amount must be strictly greater than 0 and fit within unsigned 128-bit integer bounds. Arithmetic operations utilize `checked_add` and `checked_mul` to prevent overflow.

---

### H5. Replay and Signature-Substitution Attacks

- **Threat Scenario**: An attacker captures a valid hardware signature from network traffic or transaction logs and attempts to replay it for another payment, on a different contract, or on a different network (e.g. mainnet vs testnet).
- **Contract Guardrails**:
  - **Canonical Message Binding**: The hardware signature covers a deterministic binary encoding:
    ```
    b"TAPPROVED_V1" ||
    u64_le(payment_id) ||
    u16_le(len(recipient)) || recipient_bytes ||
    u128_le(amount_yocto) ||
    u64_le(nonce) ||
    u64_le(expires_at_ns) ||
    u16_le(len(contract_id)) || contract_id_bytes ||
    u16_le(len(network_id)) || network_id_bytes
    ```
  - **Domain Separation**: Binding `contract_id` and `network_id` guarantees signatures generated for `manextech.testnet` on `testnet` cannot be replayed on `mainnet` or against another treasury contract.
  - **One-time Nonce**: `nonce` matches `payment.id`. Once approved, status shifts to `Processing` and then `Paid`. Replaying the signature triggers `"payment is not pending hardware approval"`.
  - **Single Active Payment Invariant**: Only one active payment is permitted at any time (`active_payment_id`). Overlapping concurrent approvals are structurally rejected.

---

### H6. Relay Compromise

- **Threat Scenario**: The intermediary Node.js relay server is breached.
- **Attacker Capabilities**:
  - Can delay, drop, or refuse to forward requests (Denial of Service), and can view transaction metadata and requests.
  - Holds the agent's restricted NEAR FunctionCall key. A compromised relay can invoke `request_spend` and `execute_approved_spend` for allowlisted recipients at or below `soft_limit_yocto`, autonomously spending up to the remaining UTC daily cap.
  - Can submit an elevated request, but it remains pending and cannot be settled without a valid ESP32 Ed25519 signature.
- **Three-key split and contract guardrails**:
  - **Agent request/execute key:** restricted to `request_spend` and `execute_approved_spend` on `manextech.testnet`. It cannot call owner governance methods or approve elevated payments.
  - **Approval broadcaster key:** restricted to `approve_spend`. The relay validates the registered device public key and Ed25519 signature before broadcasting; the contract independently verifies that signature against the pending payment. Possession of this NEAR key alone cannot forge device approval.
  - **Expiry keeper key:** restricted to `expire_payment`; it cannot request, execute, or approve payments.
  - The **owner governance key** is separate and is not held by the relay. The ESP32 Ed25519 device key is also separate from all three relay NEAR keys.
  - If the relay tampers with amounts or recipients in the serial payload, the device signature will not match the contract's stored payment parameters and `approve_spend` fails.
  - Stalled payments expire via `expires_at_ns` and reservations are released back to the daily spending limit.

---

### H7. Owner-Account Compromise

- **Threat Scenario**: The administrative keypair (`manextech.testnet`) is compromised.
- **Attacker Capabilities**:
  - Can pause/unpause, update limits, add recipients, or rotate keys.
- **Mitigation & Hardening Recommendations**:
  - Use a Multi-Signature DAO account (e.g. SputnikDAO / AstraDAO) as the contract `owner_id` for production mainnet deployments.
  - Never store owner private keys in configuration files, CI runners, or plaintext disks.

---

## 3. Storage Exhaustion & Staking Headroom (H9)

The contract state must remain resilient against storage-exhaustion griefing:

1. **Pruning Architecture**:
   - `LookupMap` (prefix `b"p"`) provides $O(1)$ access without storing unbounded collections in a single state record.
   - Daily usage is keyed by UTC day in `LookupMap` (prefix `b"d"`). Records older than `MAX_RETAINED_DAILY_DAYS` (90 days) are pruned during new requests when they have no outstanding reservations.
   - `MAX_ALLOWED_RECIPIENTS` is strictly capped at 100 entries.
2. **Storage Staking Metrics**:
   - `get_storage_metrics()` dynamically calculates `storage_usage_bytes * storage_byte_cost` and reports available headroom.
   - On NEAR Testnet, `manextech.testnet` maintains ~5.98 NEAR total balance against ~3.56 NEAR required storage stake, ensuring over 2.42 NEAR of operational headroom.

---

## 4. Emergency Procedures & Runbooks (H8)

### Emergency Pause
To halt all agent spending immediately:
```bash
near contract call-function as-transaction manextech.testnet pause json-args '{}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as manextech.testnet network-config testnet sign-with-keychain send
```

### Emergency Unpause
To restore normal operations:
```bash
near contract call-function as-transaction manextech.testnet unpause json-args '{}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as manextech.testnet network-config testnet sign-with-keychain send
```

### Stale Payment Expiry
If a payment expires without human intervention:
```bash
near contract call-function as-transaction manextech.testnet expire_payment json-args '{}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as manex-agent.testnet network-config testnet sign-with-keychain send
```

---

## 5. Residual Risks & Future Work (H10)

1. **Hardware Prototype Notice**: The current ESP32-WROOM-32 implementation serves as a functional demonstration prototype. Production deployments should incorporate a Common Criteria EAL6+ secure element (e.g. ATECC608A / SE050) with hardware-enforced private key non-exportability.
2. **Blind signing / display trust**: The current ESP32 has no trusted display. Payment details are printed over USB serial to a host-controlled machine; a compromised host can misrepresent recipient or amount while the operator presses GPIO25. A tamper-resistant OLED/e-Paper display directly driven by the microcontroller, with a trusted rendering path, is required for What-You-See-Is-What-You-Sign (WYSIWYS).
3. **Formal Verification**: While unit tests cover 100% of state transitions and edge cases, mathematical formal verification (e.g. via Certora or K-Framework) is recommended prior to mainnet treasury management.
