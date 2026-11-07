import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatYoctoNear,
  parseNearToYocto,
  computeQuotaPercentage,
  generateAddRecipientCommand,
  generateRemoveRecipientCommand,
  generateUpdateLimitsCommand,
  generatePauseCommand,
  queryContractView
} from "./dashboard-service.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

test("formatYoctoNear", () => {
  assert.equal(formatYoctoNear("0"), "0 NEAR");
  assert.equal(formatYoctoNear(null), "0 NEAR");
  assert.equal(formatYoctoNear("1000000000000000000000000"), "1 NEAR");
  assert.equal(formatYoctoNear("1500000000000000000000000"), "1.5 NEAR");
  assert.equal(formatYoctoNear("1000000000000000000000"), "0.001 NEAR");
  assert.equal(formatYoctoNear("10000000000000000000000"), "0.01 NEAR");
  assert.equal(formatYoctoNear("5982177255970149299999999", 4), "5.9821 NEAR");
});

test("parseNearToYocto", () => {
  assert.equal(parseNearToYocto("1"), "1000000000000000000000000");
  assert.equal(parseNearToYocto("0.5"), "500000000000000000000000");
  assert.equal(parseNearToYocto("0.001"), "1000000000000000000000");
  assert.throws(() => parseNearToYocto("invalid"), TypeError);
});

test("computeQuotaPercentage", () => {
  assert.equal(computeQuotaPercentage("0", "1000"), 0);
  assert.equal(computeQuotaPercentage("500", "1000"), 50);
  assert.equal(computeQuotaPercentage("1000", "1000"), 100);
  assert.equal(computeQuotaPercentage("1500", "1000"), 100);
});

test("Command generators match canonical NEAR CLI rs syntax", () => {
  const addCmd = generateAddRecipientCommand("manextech.testnet", "partner.testnet");
  assert.ok(addCmd.includes("add_allowed_recipient"));
  assert.ok(addCmd.includes("partner.testnet"));

  const remCmd = generateRemoveRecipientCommand("manextech.testnet", "partner.testnet");
  assert.ok(remCmd.includes("remove_allowed_recipient"));
  assert.ok(remCmd.includes("partner.testnet"));

  const limitCmd = generateUpdateLimitsCommand("manextech.testnet", "100", "500", "1000");
  assert.ok(limitCmd.includes("update_spending_limits"));
  assert.ok(limitCmd.includes('"soft_limit_yocto": "100"'));

  const pauseCmd = generatePauseCommand("manextech.testnet", true);
  assert.ok(pauseCmd.includes("pause"));
  const unpauseCmd = generatePauseCommand("manextech.testnet", false);
  assert.ok(unpauseCmd.includes("unpause"));
});

test("queryContractView parses valid JSON-RPC responses", async () => {
  const mockFetch = async (url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.method, "query");
    assert.equal(body.params.request_type, "call_function");
    assert.equal(body.params.method_name, "get_policy");

    const policyPayload = {
      owner_id: "manextech.testnet",
      agent_id: "manex-agent.testnet",
      soft_limit_yocto: "10000000000000000000000"
    };

    return new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: "tapproved-view",
      result: {
        result: Array.from(Buffer.from(JSON.stringify(policyPayload)))
      }
    }), { status: 200, headers: { "content-type": "application/json" } });
  };

  const policy = await queryContractView("https://test.rpc.fastnear.com", "manextech.testnet", "get_policy", {}, mockFetch);
  assert.equal(policy.owner_id, "manextech.testnet");
  assert.equal(policy.agent_id, "manex-agent.testnet");
});

test("dashboard index.html contains all essential dashboard elements", async () => {
  const htmlPath = resolve(__dirname, "index.html");
  const html = await readFile(htmlPath, "utf8");

  const requiredIds = [
    "treasury-balance",
    "available-balance",
    "daily-spent",
    "daily-limit",
    "daily-progress-bar",
    "active-payment-status",
    "device-status",
    "pending-approval-alert",
    "pending-approval-text",
    "pending-time-remaining",
    "payments-table-body",
    "policy-owner",
    "policy-agent",
    "policy-soft-limit",
    "policy-hard-limit",
    "policy-daily-limit",
    "policy-paused",
    "owner-action-select",
    "generated-command-block",
    "tx-search-input",
    "tx-search-btn",
    "tx-result-block"
  ];

  for (const id of requiredIds) {
    assert.ok(html.includes(`id="${id}"`), `Missing required element ID: ${id}`);
  }
});
