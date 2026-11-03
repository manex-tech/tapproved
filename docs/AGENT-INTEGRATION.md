# AI Agent Integration Guide

This guide covers integrating autonomous AI agents with the Tapproved hardware-backed payment authorization infrastructure on NEAR.

## 1. Overview

Tapproved allows AI agents to autonomously request payments from an on-chain smart contract treasury (`manextech.testnet`) through an authenticated relay:

- **Routine spending (`<= soft_limit_yocto`)**: When an agent requests a payment within configured policy limits and to an allowlisted recipient, the contract automatically approves and executes the payment.
- **High-value spending (`> soft_limit_yocto` and `<= hard_limit_yocto`)**: The payment is marked as `pending` and cannot proceed until a human operator physically approves it by pressing the button on the registered ESP32 hardware device (GPIO25), generating an Ed25519 signature.
- **Restricted spending**: Amounts above `hard_limit_yocto`, recipients not in the allowlist, daily limit overflows, or attempts while the contract is paused fail closed immediately.

---

## 2. JavaScript / TypeScript SDK

The official SDK is located in `sdk/index.js` (with complete TypeScript types in `sdk/index.d.ts`).

### Initialization

```javascript
import { TapprovedClient } from "tapproved/sdk";

const client = new TapprovedClient({
  relayUrl: process.env.TAPPROVED_RELAY_URL || "https://relay.tapproved.net",
  token: process.env.AGENT_API_TOKEN // Must be at least 32 URL-safe characters
});
```

### Checking On-Chain Spending Policy

Before requesting spends, agents can query current policy and budget constraints:

```javascript
const policy = await client.getPolicy();

console.log("Allowed Recipients:", policy.allowed_recipients);
console.log("Soft Limit (yoctoNEAR):", policy.soft_limit_yocto);
console.log("Hard Limit (yoctoNEAR):", policy.hard_limit_yocto);
console.log("Daily Limit (yoctoNEAR):", policy.daily_limit_yocto);
```

---

## 3. Submitting Payments and Idempotency

### Idempotency Keys

Every payment request requires an `idempotency-key` (16 to 128 URL-safe characters). If an agent does not supply one, the SDK automatically generates a cryptographically random key using `generateIdempotencyKey()`.

> **Important**: In the event of network disruption or uncertain state, **retain the original idempotency key**. Never generate a new key on retries, as this could lead to duplicate spending requests.

```javascript
import { generateIdempotencyKey } from "tapproved/sdk";

const idempotencyKey = generateIdempotencyKey("invoice-1042");

const result = await client.requestPayment({
  recipientId: "merchant.testnet",
  amountYocto: "5000000000000000000000", // 0.005 NEAR
  idempotencyKey
});

console.log("Payment ID:", result.payment?.id);
console.log("Initial Status:", result.payment?.status);
```

---

## 4. Polling and Pending Approval Notifications

For payments requiring physical hardware confirmation, the SDK provides `waitForPaymentResolution` with a notification callback:

```javascript
const payment = await client.waitForPaymentResolution(result.payment.id, {
  pollIntervalMs: 2000,
  timeoutMs: 120000,
  onPendingApproval: (pendingPayment) => {
    console.log(`[ALERT] Payment ${pendingPayment.id} is awaiting physical approval on the ESP32.`);
    console.log("Please press the button on GPIO25 to authorize.");
  }
});

console.log(`Payment settled successfully! Status: ${payment.status}`);
```

---

## 5. Error Handling and Typed Hierarchy

All SDK errors inherit from `TapprovedError`:

| Error Class | HTTP Status | Code | Description |
|---|---|---|---|
| `AuthenticationError` | 401 | `authentication_failed` | Missing, malformed, or invalid `AGENT_API_TOKEN`. |
| `PolicyViolationError` | 400 | `recipient_not_allowlisted`, `amount_out_of_bounds`, etc. | Request violates contract spending policy. |
| `IdempotencyConflictError` | 409 | `idempotency_conflict` | Idempotency key previously used with different recipient or amount. |
| `PaymentTerminalError` | 200 | `payment_failed`, `payment_expired`, `payment_cancelled` | Payment reached a non-successful terminal state. |
| `TimeoutError` | N/A | `timeout` | Polling timed out before reaching a terminal status. |
| `RelayConnectionError` | N/A | `relay_connection_error` | Relay unreachable or network failure. |

Example error handling:

```javascript
try {
  await client.requestPayment({
    recipientId: "unauthorized.testnet",
    amountYocto: "1000000000000000000000"
  });
} catch (err) {
  if (err instanceof PolicyViolationError) {
    console.error("Policy rejected:", err.message, err.code);
  } else if (err instanceof AuthenticationError) {
    console.error("Authentication rejected:", err.message);
  } else {
    console.error("Unexpected error:", err);
  }
}
```

---

## 6. Runnable Examples

- `examples/agent-request.js`: Minimal CLI request script.
- `examples/autonomous-agent.js`: Comprehensive autonomous lifecycle demo (policy check, routine payment, elevated payment, and error recovery).
