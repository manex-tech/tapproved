# Tapproved relay and backend architecture

**Status:** Phase C1 design baseline  
**Network:** NEAR Testnet  
**Canonical contract:** `manextech.testnet`  
**Canonical agent:** `manex-agent.testnet`  
**Approval protocol:** v1, defined in [APPROVAL-PROTOCOL.md](APPROVAL-PROTOCOL.md)

## 1. Responsibilities and trust boundaries

The relay is an orchestration and transport service, not a policy authority.

- **Agent client:** authenticates to the relay and submits an idempotent payment intent. It cannot choose whether a payment is automatically approved or hardware-gated.
- **Relay API:** authenticates callers, validates request shape, applies rate and size limits, assigns an idempotency key, submits only contract-supported calls, and tracks lifecycle state.
- **NEAR contract:** remains authoritative for agent identity, recipient allowlisting, pause state, soft/hard/daily limits, active-payment exclusion, expiry, device signature verification and treasury settlement.
- **NEAR transaction signers:** three separate Ed25519 FunctionCall keys on `manex-agent.testnet` are used for request/execution (`request_spend`, `execute_approved_spend`), hardware approval (`approve_spend`) and expiry (`expire_payment`). Each is scoped to `manextech.testnet` and its exact method allowlist, with finite allowance. None is a FullAccess key or the ESP32 device key. The expiry method is permissionless at the contract level; its relay key only pays gas and cannot move treasury funds.
- **ESP32:** holds the device Ed25519 seed, validates the complete signed payment context against its compiled/configured contract and network, displays the request over the current serial console, and signs only after an intentional GPIO25 press. The relay never receives the private seed.
- **Serial bridge:** transports bounded, framed JSON messages between relay and device. Transport delivery is not approval; only the contract-verified signature authorizes a pending payment.

A compromised relay may delay, replay or misroute messages, but it must not be able to forge a device approval or bypass on-chain contract policy. Contract-side signature verification and payment state transitions remain mandatory.

## 2. Canonical request and payment flow

1. An authenticated agent sends a payment intent with recipient, integer yoctoNEAR amount and an idempotency key.
2. The relay validates syntax and bounds, resolves the key to a single logical request, and calls `request_spend` as the configured registered agent.
3. The contract validates policy and creates the payment. The relay reads the resulting payment record from the contract; it does not invent nonce, payment ID or expiry.
4. If the contract returns an automatically approved payment, the relay submits `execute_approved_spend` through the backend signer and reads the contract payment record again. Pending payments are never auto-executed.
5. If the payment is pending, the relay reads the contract-derived approval context through the authenticated pending-approval API and sends one bounded newline-delimited JSON frame to the configured ESP32 USB serial port.
6. The ESP32 validates contract ID, network ID and numeric encodings, presents recipient and amount over its current serial console, and waits for a physical GPIO25 press. It returns the v1 Ed25519 signature and public key only after approval. Serial output is not a trusted display.
7. The relay checks the returned public key against `get_policy.device_public_key`, reconstructs the exact v1 message from the contract-derived payment fields, verifies the Ed25519 signature locally, and submits `approve_spend` with the payment ID and 64 signature bytes using a separate FunctionCall key restricted to `approve_spend`. The contract independently verifies the signature against its registered key and its own stored payment fields.
8. The contract transfer promise and callback determine terminal settlement. The relay observes contract state and transaction receipts; it never marks a payment Paid based only on an RPC submission acknowledgement.
9. The C10 expiry keeper polls the active payment and compares `expires_at_ns` with the timestamp from the latest finalized NEAR block. If a `pending` or `approved` payment has expired, it calls permissionless `expire_payment` through the expire-only key. The contract rechecks chain time and status, releases the reservation from its original UTC-day bucket and clears the active payment. The relay then reads `get_payment` and reports expiry only when the contract status is `expired`.
10. On ambiguous transfer/callback outcomes, the relay leaves the payment Processing, inspects final receipts and alerts the operator. It must not blindly retry a transfer or call owner reconciliation without verified transfer evidence.

## 3. Proposed service boundaries

Keep the implementation modular and testable:

- `relay/config.js`: validated environment configuration, canonical Testnet defaults, signer and serial settings.
- `relay/auth.js`: agent API authentication, constant-time credential comparison, credential rotation support and authorization middleware.
- `relay/payment-requests.js`: strict recipient/amount validation, request fingerprinting and a durable JSON idempotency journal. The journal uses atomic replacement and a single-process lock; run one relay writer per journal. It deliberately never automatically resubmits an entry left reserved, submitting or uncertain after a crash. A multi-instance deployment will require a transactional shared database or equivalent distributed lock.
- `relay/near-rpc.js`: read-only JSON-RPC views and canonical agent transaction/receipt status queries with request timeouts, finality selection and strict signer/contract validation.
- `relay/near-signer.js`: isolated request/execution, hardware-approval and expiry signers, each restricted to an exact FunctionCall method set. No secret key is accepted from HTTP request data.
- `relay/expiry-service.js`: finalized-chain-time expiry monitor with overlap suppression, one attempt per payment per process and post-transaction contract-state confirmation.
- `relay/approval-service.js`: one-cycle pending-payment-to-device-to-contract orchestration. It does not retry ambiguous approval submissions.
- `relay/contract.js`: typed contract method wrappers, exact decimal-string handling for u64/u128 values, and transaction outcome parsing.
- `relay/serial.js`: serial port lifecycle, bounded newline-delimited JSON frames (2,048-byte maximum), one outstanding approval at a time, signature-frame shape validation, explicit disconnect/error handling and a bounded approval timeout. Reconnection is explicit; the bridge never retries a physical approval automatically.
- `relay/orchestrator.js`: payment lifecycle state machine driven by contract observations and serial events.
- `relay/server.js`: HTTP routes, authentication, input limits, structured error mapping and graceful shutdown.

The first implementation may use Node.js built-ins and small explicit interfaces. Do not add a database, cloud service or framework without a concrete requirement. The current local JSON journal persists across process restarts and fails closed on corruption, but it is not a distributed database and does not claim multi-instance production reliability.

## 4. HTTP API contract

Initial authenticated routes:

- `POST /v1/payment-requests`: create or retrieve an idempotent payment request.
- `POST /v1/approvals/process`: start one explicit hardware-approval cycle from the active contract-pending payment. The route accepts no caller-supplied payment context, never retries a physical approval, verifies the returned device key/signature locally, then submits `approve_spend`.
- `GET /v1/pending-approvals`: implemented authenticated, contract-backed poll for the single active payment when its status is exactly `pending`; returns `payment` plus a device-ready `approval_request` containing canonical contract/network, payment ID, recipient, exact amount, nonce and expiry. Returns null approval fields for absent, approved or processing payments.
- `GET /v1/payments/:paymentId`: implemented authenticated contract-backed lookup for one payment. Returns the lifecycle status, an `approval_required` flag for `pending`, and a `terminal` flag for `paid`, `failed`, `expired` or `cancelled`. Foreign-agent and missing records return 404; invalid numeric IDs return 400.
- `GET /v1/transactions/:hash`: implemented authenticated NEAR `tx` query for the canonical agent signer and contract. Supports NEAR `wait_until` milestones (default `NONE` for immediate polling); returns transaction execution state, receipt statuses, gas burnt, tokens burnt and logs, but never returns raw transaction arguments or signatures. Returns 202 until all receipts reach `FINAL` or the RPC wait times out.
- C10 background expiry monitor: polls the contract active-payment view, uses the latest finalized block timestamp rather than host time, and submits `expire_payment` only for expired `pending` or `approved` payments. It does not accept an expiry timestamp from an API caller.
- `GET /v1/payments/:paymentId/events`: expose bounded lifecycle events or polling cursor.
- `GET /health`: process health only; must not expose credentials or private operational details.
- `GET /ready`: dependency readiness, including configured contract/network and optional serial connection state, without leaking secrets.

All amounts and potentially 64-bit values are decimal strings. Reject JSON numbers for u64/u128 fields to avoid JavaScript precision loss. Enforce a small request-body limit, strict content type, authentication before mutation, rate limits, and safe error responses. Never accept contract ID, network ID, agent account, signer key, device public key, nonce, payment ID or expiry as authoritative caller-controlled values.

## 5. Configuration and secrets

Canonical defaults are NEAR Testnet, `https://rpc.testnet.near.org`, and `manextech.testnet`. Production-like configuration must fail closed if the network or contract differs from the explicitly allowed deployment.

- `AGENT_API_TOKEN`: high-entropy relay credential; store only a verifier/hash where feasible and compare safely.
- `NEAR_SIGNER_ACCOUNT_ID` is fixed to `manex-agent.testnet`. `NEAR_SIGNER_PRIVATE_KEY` must be a dedicated Ed25519 FunctionCall access key on that account, scoped to receiver `manextech.testnet`, method list exactly `request_spend` and `execute_approved_spend`, and a finite allowance no greater than 5 NEAR. `NEAR_APPROVAL_SIGNER_PRIVATE_KEY` is a separate Ed25519 FunctionCall key scoped to the same receiver, method list exactly `approve_spend`, and a finite allowance no greater than 5 NEAR. `NEAR_EXPIRY_SIGNER_PRIVATE_KEY` is a third key scoped to that receiver and method list exactly `expire_payment`, with a finite allowance no greater than 5 NEAR. `EXPIRY_MONITOR_INTERVAL_MS` defaults to 15000 and is bounded from 1000 to 3600000. The relay validates all three keys separately and never uses a FullAccess key. The relay verifies this permission against the live access-key list at startup and refuses FullAccess or broader keys. Prefer an OS secret store or managed signer; never commit credentials. The key must be provisioned separately by the account owner; the relay never creates or broadens keys.
- `SERIAL_PORT`, baud rate and frame limits: explicit device transport configuration.
- Wi-Fi SSID/password belong on the ESP32 through a local provisioning path or ignored local secrets file, never in Git or firmware constants.
- Keep `.env.example` placeholder-only. Do not log authorization headers, private keys, full signatures or Wi-Fi credentials.

## 6. Reliability and safety invariants

- The contract is the sole authority for policy and settlement. The backend agent signer is restricted to the `request_spend` and `execute_approved_spend` methods on the canonical contract and cannot transfer NEAR from the agent account.
- A request retry with the same idempotency key must not create a second logical payment.
- A serial retry must not cause a second signature or a second contract approval.
- A device signature is bound to contract, network, payment ID, recipient, amount, nonce and expiry by protocol v1.
- Only one contract payment is active at a time; the orchestrator must respect this contract invariant.
- Never treat transaction submission as final success. Confirm final transfer and callback receipts and contract state.
- Never release a Processing reservation on timeout alone. Do not blindly retry an ambiguous transfer.
- Serial disconnection, relay restart, RPC outage or ESP32 reset must preserve an honest unknown/pending state and permit safe re-observation.
- Structured logs use correlation IDs and redact credentials and signing material.

## 7. Delivery order

Implement and verify one task at a time:

1. C1 architecture and trust-boundary baseline (this document).
2. C2 agent authentication and request validation.
3. C3 contract-backed payment request submission and idempotency.
4. C4 isolated signer integration and transaction submission.
5. C5 automatic approval execution.
6. C6 pending approval tracking.
7. C7 serial transport and ESP32 framing.
8. C8 signature verification and contract submission.
9. C9 status and receipt tracking.
10. C10 expiry monitoring.
11. C11 interruption and recovery.
12. C12 structured logs and safe errors.
13. C13 integration and failure-injection tests.

Hardware Wi-Fi provisioning and reconnect logic are implemented in Phase D against this serial/network boundary. End-to-end execution is Phase E. No deployment, initialization or payment is performed as part of this design task.
