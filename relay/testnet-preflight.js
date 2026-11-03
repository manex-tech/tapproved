import {
  DEFAULT_CONTRACT_ID,
  getAccountView,
  getActivePayment,
  getDailyUsage,
  getFinalizedBlock,
  getPayment,
  getPolicy
} from "./near-rpc.js";

const NANOS_PER_DAY = 86_400_000_000_000n;
const RETAINED_DAYS = 90;
const MAX_ENUMERATED_PAYMENT_HISTORY = 20n;
const ZERO_CODE_HASH = "11111111111111111111111111111111";
const CANONICAL_AGENT_ID = "manex-agent.testnet";

function decimal(value, label) {
  const normalized = typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? String(value)
    : value;
  if (typeof normalized !== "string" || !/^(0|[1-9][0-9]*)$/.test(normalized)) {
    throw new Error(`${label} must be a canonical non-negative decimal string`);
  }
  return BigInt(normalized);
}

function addBlocker(blockers, code, detail) {
  blockers.push({ code, detail });
}

async function inBatches(values, batchSize, run, delayMs = 750) {
  const results = [];
  for (let offset = 0; offset < values.length; offset += batchSize) {
    if (offset > 0 && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    const batch = values.slice(offset, offset + batchSize);
    results.push(...await Promise.all(batch.map(run)));
  }
  return results;
}

/**
 * Read-only, block-pinned snapshot for the one-time Vec-to-LookupMap migration.
 * The legacy contract never pruned its daily Vec. For a small payment history,
 * use the retained payment records to discover every non-empty daily bucket
 * with a small number of RPC calls. For longer histories, inspect the complete
 * rolling 90-day window. On the legacy ABI, reserved_yocto is the complete
 * committed-plus-active daily total.
 */
export async function collectTestnetPreflight(options = {}) {
  const rpc = options.rpc ?? {
    getFinalizedBlock,
    getAccountView,
    getPolicy,
    getActivePayment,
    getPayment,
    getDailyUsage
  };
  const concurrency = options.concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) {
    throw new RangeError("concurrency must be an integer between 1 and 16");
  }

  const block = await rpc.getFinalizedBlock();
  const currentDayBig = decimal(block.timestamp_nanosec, "finalized block timestamp") / NANOS_PER_DAY;
  if (currentDayBig > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("finalized UTC day exceeds the safe JSON integer range");
  }
  const currentDay = Number(currentDayBig);
  const firstDay = Math.max(0, currentDay - (RETAINED_DAYS - 1));
  const blockOptions = { blockId: block.hash };

  const [account, policy, activePayment] = await Promise.all([
    rpc.getAccountView(blockOptions),
    rpc.getPolicy(blockOptions),
    rpc.getActivePayment(blockOptions)
  ]);

  const blockers = [];
  const warnings = [];

  if (account.code_hash === ZERO_CODE_HASH) {
    addBlocker(blockers, "contract-code-missing", "manextech.testnet has no deployed Wasm code at the snapshot block");
  }
  if (policy.network_id !== "testnet") {
    addBlocker(blockers, "wrong-network", "The deployed policy does not identify NEAR testnet");
  }
  if (policy.agent_id !== CANONICAL_AGENT_ID) {
    addBlocker(blockers, "wrong-agent", `Expected ${CANONICAL_AGENT_ID}, found ${String(policy.agent_id)}`);
  }
  if (!Array.isArray(policy.device_public_key) || policy.device_public_key.length !== 32 ||
      policy.device_public_key.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    addBlocker(blockers, "invalid-device-key", "The deployed policy does not contain exactly 32 public-key bytes");
  }
  if (!Array.isArray(policy.allowed_recipients) || policy.allowed_recipients.length === 0) {
    addBlocker(blockers, "empty-recipient-allowlist", "The deployed policy has no allowed recipients");
  }

  let softLimit;
  let hardLimit;
  let dailyLimit;
  let nextPaymentId = 1n;
  try {
    softLimit = decimal(policy.soft_limit_yocto, "soft limit");
    hardLimit = decimal(policy.hard_limit_yocto, "hard limit");
    dailyLimit = decimal(policy.daily_limit_yocto, "daily limit");
    nextPaymentId = decimal(policy.next_payment_id, "next payment ID");
    if (softLimit === 0n || hardLimit === 0n || softLimit > hardLimit || dailyLimit < hardLimit) {
      addBlocker(blockers, "invalid-spending-limits", "The deployed soft, hard and daily limits are inconsistent");
    }
    if (nextPaymentId < 1n) {
      addBlocker(blockers, "invalid-next-payment-id", "The deployed next_payment_id must be at least 1");
    }
  } catch (error) {
    addBlocker(blockers, "invalid-policy-numeric-field", error.message);
  }

  let activePaymentRecord = null;
  let activePaymentId = null;
  let activePaymentDay = null;
  let activeAmount = 0n;
  if (activePayment !== null && activePayment !== undefined) {
    try {
      activePaymentId = decimal(activePayment.id, "active payment ID");
      const createdAt = decimal(activePayment.created_at_ns, "active payment creation timestamp");
      activePaymentDay = Number(createdAt / NANOS_PER_DAY);
      activeAmount = decimal(activePayment.amount_yocto, "active payment amount");
      if (activeAmount === 0n) {
        addBlocker(blockers, "invalid-active-payment", "The active payment amount is zero");
      }
      if (activePaymentDay > currentDay) {
        addBlocker(blockers, "active-payment-future-date", "The active payment timestamp is later than the finalized block");
      }
      if (!["pending", "approved", "processing"].includes(activePayment.status)) {
        addBlocker(blockers, "invalid-active-payment-status", `Active payment has unexpected status ${String(activePayment.status)}`);
      }
      if (activePayment.status === "processing") {
        addBlocker(blockers, "processing-payment-unresolved", "An active transfer is processing; inspect its final transfer and callback receipts before upgrading");
      }
      activePaymentRecord = await rpc.getPayment(activePaymentId.toString(), blockOptions);
      if (!activePaymentRecord ||
          String(activePaymentRecord.id) !== activePaymentId.toString() ||
          String(activePaymentRecord.amount_yocto) !== activeAmount.toString() ||
          activePaymentRecord.status !== activePayment.status ||
          activePaymentRecord.recipient_id !== activePayment.recipient_id) {
        addBlocker(blockers, "active-payment-record-mismatch", "get_active_payment and get_payment do not return the same retained payment");
      }
    } catch (error) {
      addBlocker(blockers, "invalid-active-payment", error.message);
    }
  }

  const enumerateAllPayments = nextPaymentId >= 1n &&
    nextPaymentId <= MAX_ENUMERATED_PAYMENT_HISTORY + 1n;
  const paymentHistoryRecords = [];
  const daysToQuery = new Set([currentDay]);

  if (enumerateAllPayments) {
    const paymentIds = Array.from({ length: Number(nextPaymentId - 1n) }, (_, index) => String(index + 1));
    try {
      const records = await inBatches(paymentIds, Math.min(concurrency, 4), async (paymentId) => {
        if (activePaymentId !== null && paymentId === activePaymentId.toString()) {
          return activePaymentRecord;
        }
        return rpc.getPayment(paymentId, blockOptions);
      });
      for (let index = 0; index < records.length; index += 1) {
        const expectedId = paymentIds[index];
        const record = records[index];
        if (!record || String(record.id) !== expectedId) {
          addBlocker(blockers, "payment-history-gap", `Expected retained payment ${expectedId}, but get_payment returned no matching record`);
          continue;
        }
        const createdAt = decimal(record.created_at_ns, `payment ${expectedId} creation timestamp`);
        const day = Number(createdAt / NANOS_PER_DAY);
        if (day > currentDay) {
          addBlocker(blockers, "payment-history-future-date", `Payment ${expectedId} has a timestamp later than the finalized block`);
        }
        if (["pending", "approved", "processing"].includes(record.status) &&
            (activePaymentId === null || BigInt(expectedId) !== activePaymentId)) {
          addBlocker(blockers, "orphaned-nonterminal-payment", `Payment ${expectedId} is ${record.status} but is not the active payment`);
        }
        if (day >= firstDay && day <= currentDay) daysToQuery.add(day);
        paymentHistoryRecords.push({
          id: expectedId,
          utc_day: day,
          status: record.status,
          recipient_id: record.recipient_id,
          amount_yocto: String(record.amount_yocto)
        });
      }
    } catch (error) {
      addBlocker(blockers, "payment-history-read-failed", error.message);
    }
  } else {
    for (let day = firstDay; day <= currentDay; day += 1) daysToQuery.add(day);
  }

  if (activePaymentDay !== null) daysToQuery.add(activePaymentDay);
  const days = [...daysToQuery].sort((a, b) => a - b);
  let legacyDailyUsage = [];
  try {
    legacyDailyUsage = await inBatches(days, concurrency, async (utcDay) => {
      const usage = await rpc.getDailyUsage(utcDay, blockOptions);
      if (!usage || usage.spent_yocto !== undefined || usage.used_yocto !== undefined ||
          usage.reserved_yocto === undefined) {
        throw new Error("deployed get_daily_usage is not the expected pre-migration Vec-based ABI");
      }
      const total = decimal(usage.reserved_yocto, `legacy daily total for UTC day ${utcDay}`);
      const limit = decimal(usage.daily_limit_yocto, `daily limit for UTC day ${utcDay}`);
      if (dailyLimit !== undefined && limit !== dailyLimit) {
        addBlocker(blockers, "daily-limit-view-mismatch", `UTC day ${utcDay} reports a different daily limit than get_policy`);
      }
      if (dailyLimit !== undefined && total > dailyLimit) {
        addBlocker(blockers, "legacy-daily-total-exceeds-limit", `UTC day ${utcDay} exceeds the configured daily limit`);
      }
      return { utc_day: utcDay, legacy_daily_total_yocto: total.toString() };
    });
  } catch (error) {
    addBlocker(blockers, "legacy-daily-usage-read-failed", error.message);
  }

  if (activePayment && activePaymentDay !== null) {
    const activeDayEntry = legacyDailyUsage.find((entry) => entry.utc_day === activePaymentDay);
    const activeDayTotal = activeDayEntry ? BigInt(activeDayEntry.legacy_daily_total_yocto) : 0n;
    if (!activeDayEntry || activeDayTotal < activeAmount) {
      addBlocker(blockers, "active-reservation-missing", "The active payment's original UTC-day bucket is missing or smaller than the active payment amount");
    }
  }

  if (policy.paused) {
    warnings.push({
      code: "spending-paused",
      detail: "The contract is paused; the owner must unpause it before the automatic-payment demonstration."
    });
  }
  if (activePayment && ["pending", "approved"].includes(activePayment.status)) {
    warnings.push({
      code: "active-payment-present",
      detail: "The migration can preserve this active payment, but resolve or expire it before creating the E2 demonstration request."
    });
  }

  const migratedAccountingExpectation = legacyDailyUsage.map((entry) => {
    const total = BigInt(entry.legacy_daily_total_yocto);
    const reservation = activePaymentDay === entry.utc_day ? activeAmount : 0n;
    return {
      utc_day: entry.utc_day,
      expected_spent_yocto: (total >= reservation ? total - reservation : 0n).toString(),
      expected_reserved_yocto: reservation.toString(),
      expected_used_yocto: total.toString()
    };
  });

  return {
    schema_version: 1,
    purpose: "read-only pre-upgrade snapshot for the Tapproved Vec-to-LookupMap migration",
    read_only: true,
    ready_for_upgrade: blockers.length === 0,
    blockers,
    warnings,
    network: "testnet",
    contract_id: DEFAULT_CONTRACT_ID,
    snapshot_block: {
      height: block.height,
      hash: block.hash,
      timestamp_nanosec: block.timestamp_nanosec,
      utc_day: currentDay
    },
    account: {
      amount_yocto: account.amount,
      locked_yocto: account.locked,
      code_hash: account.code_hash,
      storage_usage_bytes: account.storage_usage
    },
    policy: {
      owner_id: policy.owner_id,
      agent_id: policy.agent_id,
      device_public_key_hex: Array.isArray(policy.device_public_key)
        ? Buffer.from(policy.device_public_key).toString("hex")
        : null,
      network_id: policy.network_id,
      soft_limit_yocto: String(policy.soft_limit_yocto),
      hard_limit_yocto: String(policy.hard_limit_yocto),
      daily_limit_yocto: String(policy.daily_limit_yocto),
      allowed_recipients: policy.allowed_recipients,
      paused: policy.paused,
      next_payment_id: String(policy.next_payment_id)
    },
    active_payment: activePayment ?? null,
    active_payment_record: activePaymentRecord,
    payment_history_strategy: enumerateAllPayments ? "enumerate_all_retained_payment_ids" : "read_90_day_rolling_window",
    payment_history_records: enumerateAllPayments ? paymentHistoryRecords : null,
    legacy_daily_usage: legacyDailyUsage,
    expected_migrated_daily_usage: migratedAccountingExpectation,
    storage_funding_review_required: true
  };
}
