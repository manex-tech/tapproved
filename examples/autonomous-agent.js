import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRelayServer } from "../relay/server.js";
import { JsonIdempotencyStore } from "../relay/payment-requests.js";
import {
  TapprovedClient,
  PolicyViolationError,
  generateIdempotencyKey
} from "../sdk/index.js";

/**
 * Autonomous AI Agent that plans and executes payments subject to hardware-backed policy controls.
 */
export class AutonomousAgent {
  #client;
  #logger;

  constructor(options = {}) {
    const relayUrl = options.relayUrl ?? process.env.TAPPROVED_RELAY_URL ?? "http://127.0.0.1:3000";
    const token = options.token ?? process.env.AGENT_API_TOKEN ?? "a".repeat(32);
    this.#logger = options.logger ?? console;
    this.#client = new TapprovedClient({
      relayUrl,
      token,
      fetchImpl: options.fetchImpl
    });
  }

  get client() {
    return this.#client;
  }

  /**
   * Run the autonomous payment workflow:
   * 1. Inspect on-chain policy and limits.
   * 2. Execute routine automatic spending (<= soft limit).
   * 3. Handle high-value spending (> soft limit) with hardware notification.
   * 4. Handle policy rejection for unauthorized recipients.
   */
  async runLifecycleDemo({ routineRecipient, highValueRecipient, restrictedRecipient } = {}) {
    this.#logger.log("[Agent] Connecting to Tapproved relay and fetching policy...");
    const rawPolicy = await this.#client.getPolicy();
    const policy = rawPolicy?.policy ?? rawPolicy;
    this.#logger.log(`[Agent] Policy loaded: Soft Limit = ${policy?.soft_limit_yocto} yoctoNEAR, Hard Limit = ${policy?.hard_limit_yocto} yoctoNEAR`);
    this.#logger.log(`[Agent] Allowlisted recipients: ${JSON.stringify(policy?.allowed_recipients)}`);

    const allowedRecipients = Array.isArray(policy?.allowed_recipients) && policy.allowed_recipients.length > 0
      ? policy.allowed_recipients
      : ["manex-agent.testnet"];
    const defaultRecipient = allowedRecipients[0] || "manex-agent.testnet";
    const routineTarget = routineRecipient || defaultRecipient;
    const highValueTarget = highValueRecipient || defaultRecipient;
    const invalidTarget = restrictedRecipient || "unauthorized-merchant.testnet";

    const results = {
      routine: null,
      highValue: null,
      restricted: null
    };

    // Scenario 1: Routine Payment (within soft limit)
    this.#logger.log("\n--- Scenario 1: Autonomous Routine Spending (Within Soft Limit) ---");
    const routineAmount = BigInt(policy.soft_limit_yocto) / 2n;
    this.#logger.log(`[Agent] Requesting ${routineAmount} yoctoNEAR to ${routineTarget}`);
    const routineReq = await this.#client.requestPayment({
      recipientId: routineTarget,
      amountYocto: routineAmount.toString(),
      idempotencyKey: generateIdempotencyKey("routine")
    });

    this.#logger.log(`[Agent] Request status: ${routineReq.payment?.status ?? routineReq.state} (replayed=${routineReq.replayed})`);
    results.routine = routineReq;

    // Scenario 2: High-Value Payment (exceeds soft limit, within hard limit)
    this.#logger.log("\n--- Scenario 2: Elevated Spending Requiring Hardware Approval ---");
    const elevatedAmount = (BigInt(policy.soft_limit_yocto) + BigInt(policy.hard_limit_yocto)) / 2n;
    this.#logger.log(`[Agent] Requesting ${elevatedAmount} yoctoNEAR to ${highValueTarget}`);
    const elevatedReq = await this.#client.requestPayment({
      recipientId: highValueTarget,
      amountYocto: elevatedAmount.toString(),
      idempotencyKey: generateIdempotencyKey("highval")
    });

    if (elevatedReq.payment?.status === "pending" || elevatedReq.state === "processing") {
      this.#logger.log(`[Agent] Payment ${elevatedReq.payment?.id ?? "request"} is PENDING! Physical button confirmation required on ESP32.`);
    }
    results.highValue = elevatedReq;

    // Scenario 3: Restricted Spending (Disallowed recipient)
    this.#logger.log("\n--- Scenario 3: Restricted Spending Rejection ---");
    this.#logger.log(`[Agent] Attempting spend to unauthorized recipient: ${invalidTarget}`);
    try {
      if (Array.isArray(policy?.allowed_recipients) && !policy.allowed_recipients.includes(invalidTarget)) {
        throw new PolicyViolationError(`recipient ${invalidTarget} is not allowlisted`, "recipient_not_allowlisted");
      }
      await this.#client.requestPayment({
        recipientId: invalidTarget,
        amountYocto: routineAmount.toString(),
        idempotencyKey: generateIdempotencyKey("restricted")
      });
      throw new Error("Expected policy violation did not occur!");
    } catch (err) {
      if (err instanceof PolicyViolationError || err.status === 400) {
        this.#logger.log(`[Agent] Successfully blocked by policy enforcement: ${err.message}`);
        results.restricted = { blocked: true, code: err.code, message: err.message };
      } else {
        throw err;
      }
    }

    this.#logger.log("\n[Agent] Lifecycle demo completed successfully.");
    return results;
  }
}

async function runLocalSimulation() {
  const token = randomBytes(32).toString("base64url");
  const directory = await mkdtemp(join(tmpdir(), "tapproved-agent-simulation-"));
  const store = new JsonIdempotencyStore(join(directory, "idempotency.json"));
  const policy = {
    soft_limit_yocto: "10000000000000000000000",
    hard_limit_yocto: "100000000000000000000000",
    daily_limit_yocto: "500000000000000000000000",
    allowed_recipients: ["manex-agent.testnet"]
  };
  let nextPaymentId = 0;
  const server = createRelayServer({
    agentApiToken: token,
    idempotencyStore: store,
    getPolicy: async () => policy,
    submitPayment: async (request) => {
      const id = String(++nextPaymentId);
      const status = BigInt(request.amount_yocto) <= BigInt(policy.soft_limit_yocto)
        ? "approved"
        : "pending";
      return {
        transaction_hash: `simulation-tx-${id}`,
        payment: {
          id,
          agent_id: "manex-agent.testnet",
          recipient_id: request.recipient_id,
          amount_yocto: request.amount_yocto,
          status,
          hardware_approved: false
        }
      };
    }
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    console.log("[Agent] Running in-process simulation; no NEAR transactions are sent.");
    const agent = new AutonomousAgent({
      relayUrl: `http://127.0.0.1:${address.port}`,
      token
    });
    await agent.runLifecycleDemo();
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}

async function main() {
  if (process.env.TAPPROVED_RELAY_URL) {
    if (!process.env.AGENT_API_TOKEN) {
      throw new Error("AGENT_API_TOKEN is required when TAPPROVED_RELAY_URL points to an external relay");
    }
    const agent = new AutonomousAgent({
      relayUrl: process.env.TAPPROVED_RELAY_URL,
      token: process.env.AGENT_API_TOKEN
    });
    await agent.runLifecycleDemo();
    return;
  }
  await runLocalSimulation();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("Autonomous agent failed:", err);
    process.exitCode = 1;
  });
}
