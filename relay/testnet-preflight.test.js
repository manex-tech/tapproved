import test from "node:test";
import assert from "node:assert/strict";
import { collectTestnetPreflight } from "./testnet-preflight.js";

const NANOS_PER_DAY = 86_400_000_000_000n;
const TIMESTAMP = "1793606400000000000";
const CURRENT_DAY = Number(BigInt(TIMESTAMP) / NANOS_PER_DAY);
const BLOCK = { height: 123456, hash: "finalized-block-hash-12345678901234567890", timestamp_nanosec: TIMESTAMP };

function makeRpc(overrides = {}) {
  const captures = { blockOptions: [], usageDays: [] };
  const policy = {
    owner_id: "owner.testnet",
    agent_id: "manex-agent.testnet",
    device_public_key: Array(32).fill(7),
    network_id: "testnet",
    soft_limit_yocto: "100",
    hard_limit_yocto: "1000",
    daily_limit_yocto: "5000",
    allowed_recipients: ["merchant.testnet"],
    paused: false,
    next_payment_id: "22"
  };
  const account = {
    amount: "1000000000000000000000000",
    locked: "0",
    code_hash: "5Z8aA2ExampleContractCodeHashNotZero",
    storage_usage: 2048
  };
  const rpc = {
    captures,
    async getFinalizedBlock() { return BLOCK; },
    async getAccountView(options) { captures.blockOptions.push(options.blockId); return account; },
    async getPolicy(options) { captures.blockOptions.push(options.blockId); return policy; },
    async getActivePayment(options) { captures.blockOptions.push(options.blockId); return null; },
    async getPayment() { return null; },
    async getDailyUsage(day, options) {
      captures.usageDays.push(day);
      captures.blockOptions.push(options.blockId);
      return { utc_day: String(day), reserved_yocto: "0", daily_limit_yocto: "5000" };
    },
    ...overrides
  };
  return rpc;
}

test("collects a block-pinned read-only snapshot of the legacy deployment", async () => {
  const rpc = makeRpc();
  const snapshot = await collectTestnetPreflight({ rpc, concurrency: 8, batchDelayMs: 0 });

  assert.equal(snapshot.read_only, true);
  assert.equal(snapshot.ready_for_upgrade, true);
  assert.deepEqual(snapshot.blockers, []);
  assert.equal(snapshot.contract_id, "manextech.testnet");
  assert.equal(snapshot.snapshot_block.hash, BLOCK.hash);
  assert.equal(snapshot.account.storage_usage_bytes, 2048);
  assert.equal(snapshot.policy.agent_id, "manex-agent.testnet");
  assert.equal(snapshot.policy.device_public_key_hex, "07".repeat(32));
  assert.equal(snapshot.legacy_daily_usage.length, 90);
  assert.deepEqual(rpc.captures.blockOptions, Array(93).fill(BLOCK.hash));
  assert.equal(rpc.captures.usageDays.length, 90);
});

test("discovers legacy daily buckets from every retained payment when payment history is short", async () => {
  const queriedPaymentIds = [];
  const queriedDays = [];
  const records = {
    "1": {
      id: "1",
      created_at_ns: (BigInt(CURRENT_DAY - 1) * NANOS_PER_DAY + 10n).toString(),
      amount_yocto: "20",
      status: "paid",
      recipient_id: "merchant.testnet"
    },
    "2": {
      id: "2",
      created_at_ns: (BigInt(CURRENT_DAY - 1) * NANOS_PER_DAY + 20n).toString(),
      amount_yocto: "30",
      status: "failed",
      recipient_id: "merchant.testnet"
    },
    "3": {
      id: "3",
      created_at_ns: TIMESTAMP,
      amount_yocto: "50",
      status: "paid",
      recipient_id: "merchant.testnet"
    }
  };
  const rpc = makeRpc({
    async getPolicy(options) {
      this.captures.blockOptions.push(options.blockId);
      return {
        owner_id: "owner.testnet",
        agent_id: "manex-agent.testnet",
        device_public_key: Array(32).fill(7),
        network_id: "testnet",
        soft_limit_yocto: "100",
        hard_limit_yocto: "1000",
        daily_limit_yocto: "5000",
        allowed_recipients: ["merchant.testnet"],
        paused: false,
        next_payment_id: "4"
      };
    },
    async getPayment(id, options) {
      queriedPaymentIds.push(id);
      this.captures.blockOptions.push(options.blockId);
      return records[id] ?? null;
    },
    async getDailyUsage(day, options) {
      queriedDays.push(day);
      this.captures.blockOptions.push(options.blockId);
      return {
        utc_day: String(day),
        reserved_yocto: day === CURRENT_DAY ? "50" : "50",
        daily_limit_yocto: "5000"
      };
    }
  });
  const snapshot = await collectTestnetPreflight({ rpc, batchDelayMs: 0 });

  assert.equal(snapshot.ready_for_upgrade, true);
  assert.equal(snapshot.payment_history_strategy, "enumerate_all_retained_payment_ids");
  assert.deepEqual(queriedPaymentIds, ["1", "2", "3"]);
  assert.deepEqual(queriedDays, [CURRENT_DAY - 1, CURRENT_DAY]);
  assert.equal(snapshot.payment_history_records.length, 3);
  assert.equal(snapshot.legacy_daily_usage.length, 2);
  assert.ok(snapshot.expected_migrated_daily_usage.every((entry) =>
    entry.expected_spent_yocto === "50" &&
    entry.expected_reserved_yocto === "0" &&
    entry.expected_used_yocto === "50"
  ));
  assert.ok(rpc.captures.blockOptions.every((hash) => hash === BLOCK.hash));
});

test("blocks missing retained payment IDs during short-history enumeration", async () => {
  const rpc = makeRpc({
    async getPolicy(options) {
      this.captures.blockOptions.push(options.blockId);
      return {
        owner_id: "owner.testnet",
        agent_id: "manex-agent.testnet",
        device_public_key: Array(32).fill(7),
        network_id: "testnet",
        soft_limit_yocto: "100",
        hard_limit_yocto: "1000",
        daily_limit_yocto: "5000",
        allowed_recipients: ["merchant.testnet"],
        paused: false,
        next_payment_id: "4"
      };
    },
    async getPayment(id, options) {
      this.captures.blockOptions.push(options.blockId);
      if (id === "2") return null;
      return {
        id,
        created_at_ns: TIMESTAMP,
        amount_yocto: "20",
        status: "paid",
        recipient_id: "merchant.testnet"
      };
    }
  });
  const snapshot = await collectTestnetPreflight({ rpc, batchDelayMs: 0 });
  assert.equal(snapshot.ready_for_upgrade, false);
  assert.ok(snapshot.blockers.some((item) => item.code === "payment-history-gap"));
});

test("calculates the expected committed spend and active reservation without changing the legacy total", async () => {
  const active = {
    id: "11",
    agent_id: "manex-agent.testnet",
    recipient_id: "merchant.testnet",
    amount_yocto: "50",
    nonce: "11",
    created_at_ns: TIMESTAMP,
    expires_at_ns: (BigInt(TIMESTAMP) + 300_000_000_000n).toString(),
    status: "pending",
    hardware_approved: false
  };
  const rpc = makeRpc({
    async getActivePayment() { return active; },
    async getPayment(id) { return id === "11" ? active : null; },
    async getDailyUsage(day) {
      return {
        utc_day: String(day),
        reserved_yocto: day === CURRENT_DAY ? "75" : "0",
        daily_limit_yocto: "5000"
      };
    }
  });
  const snapshot = await collectTestnetPreflight({ rpc, batchDelayMs: 0 });
  const migratedDay = snapshot.expected_migrated_daily_usage.find((entry) => entry.utc_day === CURRENT_DAY);

  assert.equal(snapshot.ready_for_upgrade, true);
  assert.equal(snapshot.active_payment.id, "11");
  assert.equal(migratedDay.expected_spent_yocto, "25");
  assert.equal(migratedDay.expected_reserved_yocto, "50");
  assert.equal(migratedDay.expected_used_yocto, "75");
  assert.equal(snapshot.legacy_daily_usage.find((entry) => entry.utc_day === CURRENT_DAY).legacy_daily_total_yocto, "75");
});

test("blocks when the active payment exceeds its original-day legacy total", async () => {
  const active = {
    id: "11",
    created_at_ns: TIMESTAMP,
    amount_yocto: "50",
    status: "pending",
    recipient_id: "merchant.testnet"
  };
  const rpc = makeRpc({
    async getActivePayment() { return active; },
    async getPayment() { return active; },
    async getDailyUsage(day) {
      return { utc_day: String(day), reserved_yocto: "20", daily_limit_yocto: "5000" };
    }
  });
  const snapshot = await collectTestnetPreflight({ rpc, batchDelayMs: 0 });
  assert.equal(snapshot.ready_for_upgrade, false);
  assert.ok(snapshot.blockers.some((item) => item.code === "active-reservation-missing"));
});

test("blocks an unresolved processing payment", async () => {
  const active = {
    id: "11",
    created_at_ns: TIMESTAMP,
    amount_yocto: "50",
    status: "processing",
    recipient_id: "merchant.testnet"
  };
  const rpc = makeRpc({
    async getActivePayment() { return active; },
    async getPayment() { return active; },
    async getDailyUsage(day) {
      return { utc_day: String(day), reserved_yocto: day === CURRENT_DAY ? "50" : "0", daily_limit_yocto: "5000" };
    }
  });
  const snapshot = await collectTestnetPreflight({ rpc, batchDelayMs: 0 });
  assert.equal(snapshot.ready_for_upgrade, false);
  assert.ok(snapshot.blockers.some((item) => item.code === "processing-payment-unresolved"));
});

test("blocks the wrong contract code and a non-legacy daily-usage ABI", async () => {
  const wrongCode = makeRpc({
    async getAccountView() {
      return { amount: "100", locked: "0", code_hash: "11111111111111111111111111111111", storage_usage: 0 };
    }
  });
  const noCode = await collectTestnetPreflight({ rpc: wrongCode });
  assert.ok(noCode.blockers.some((item) => item.code === "contract-code-missing"));

  const newAbi = makeRpc({
    async getDailyUsage(day) {
      return { utc_day: String(day), spent_yocto: "0", reserved_yocto: "0", used_yocto: "0", daily_limit_yocto: "5000" };
    }
  });
  const notLegacy = await collectTestnetPreflight({ rpc: newAbi });
  assert.ok(notLegacy.blockers.some((item) => item.code === "legacy-daily-usage-read-failed"));
});
