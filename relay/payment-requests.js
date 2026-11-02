import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const U128_MAX = (1n << 128n) - 1n;
const ACCOUNT_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._~-]{16,128}$/;

export class IdempotencyConflictError extends Error {
  constructor() {
    super("idempotency key was already used with a different payment request");
    this.name = "IdempotencyConflictError";
    this.code = "idempotency_conflict";
  }
}

export class IdempotencyStoreError extends Error {
  constructor(message) {
    super(message);
    this.name = "IdempotencyStoreError";
    this.code = "idempotency_store_error";
  }
}

export function validatePaymentRequest(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("request body must be a JSON object");
  }
  const { recipient_id: recipientId, amount_yocto: amountYocto } = input;
  if (typeof recipientId !== "string" || recipientId.length < 2 ||
      recipientId.length > 64 || !ACCOUNT_ID.test(recipientId)) {
    throw new TypeError("recipient_id must be a valid NEAR account ID");
  }
  if (typeof amountYocto !== "string" || !/^[0-9]+$/.test(amountYocto)) {
    throw new TypeError("amount_yocto must be a decimal string");
  }
  const amount = BigInt(amountYocto);
  if (amount <= 0n || amount > U128_MAX) {
    throw new RangeError("amount_yocto must be greater than zero and fit u128");
  }
  return { recipient_id: recipientId, amount_yocto: amount.toString() };
}

export function validateIdempotencyKey(value) {
  if (typeof value !== "string" || !IDEMPOTENCY_KEY.test(value)) {
    throw new TypeError("Idempotency-Key must contain 16 to 128 URL-safe characters");
  }
  return value;
}

function fingerprint(agentId, payment) {
  return createHash("sha256")
    .update(JSON.stringify([agentId, payment.recipient_id, payment.amount_yocto]))
    .digest("hex");
}

function recordId(agentId, key) {
  return `${agentId}:${key}`;
}

/**
 * Durable single-process idempotency journal.
 *
 * Atomic file replacement protects against torn writes. The journal is not a
 * distributed lock: run exactly one relay writer against a given file path.
 * A reserved/submitting/uncertain entry is never automatically resubmitted,
 * because the process may have stopped after broadcasting a transaction.
 */
export class JsonIdempotencyStore {
  #filePath;
  #records = new Map();
  #loaded = false;
  #tail = Promise.resolve();

  constructor(filePath) {
    if (typeof filePath !== "string" || filePath.length === 0) {
      throw new TypeError("idempotency store path is required");
    }
    this.#filePath = resolve(filePath);
  }

  async #exclusive(operation) {
    const previous = this.#tail;
    let release;
    this.#tail = new Promise((resolveLock) => { release = resolveLock; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async #load() {
    if (this.#loaded) return;
    let raw;
    try {
      raw = await readFile(this.#filePath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {
        this.#loaded = true;
        return;
      }
      throw new IdempotencyStoreError("could not read idempotency journal");
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.records)) {
        throw new Error("invalid journal schema");
      }
      for (const record of parsed.records) {
        if (!record || typeof record.id !== "string" ||
            typeof record.agent_id !== "string" ||
            typeof record.idempotency_key !== "string" ||
            typeof record.fingerprint !== "string" ||
            !["reserved", "submitting", "submitted", "uncertain"].includes(record.state)) {
          throw new Error("invalid journal record");
        }
        this.#records.set(record.id, record);
      }
    } catch {
      throw new IdempotencyStoreError("idempotency journal is corrupt; refusing payment submissions");
    }
    this.#loaded = true;
  }

  async #persist() {
    const directory = dirname(this.#filePath);
    await mkdir(directory, { recursive: true });
    const temporary = `${this.#filePath}.${process.pid}.${Date.now()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify({
        version: 1,
        records: [...this.#records.values()]
      }) + "\n", "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, this.#filePath);
    } catch (error) {
      await rm(temporary, { force: true });
      throw new IdempotencyStoreError("could not commit idempotency journal");
    }
  }

  async reserve({ agentId, idempotencyKey, payment }) {
    return this.#exclusive(async () => {
      await this.#load();
      const id = recordId(agentId, idempotencyKey);
      const digest = fingerprint(agentId, payment);
      const existing = this.#records.get(id);
      if (existing) {
        if (existing.fingerprint !== digest) throw new IdempotencyConflictError();
        return { created: false, record: structuredClone(existing) };
      }
      const now = new Date().toISOString();
      const record = {
        id,
        agent_id: agentId,
        idempotency_key: idempotencyKey,
        fingerprint: digest,
        payment,
        state: "reserved",
        created_at: now,
        updated_at: now,
        result: null
      };
      this.#records.set(id, record);
      await this.#persist();
      return { created: true, record: structuredClone(record) };
    });
  }

  async transition(agentId, idempotencyKey, state, result = null) {
    if (!["submitting", "submitted", "uncertain"].includes(state)) {
      throw new TypeError("invalid idempotency state transition");
    }
    return this.#exclusive(async () => {
      await this.#load();
      const id = recordId(agentId, idempotencyKey);
      const record = this.#records.get(id);
      if (!record) throw new IdempotencyStoreError("idempotency reservation does not exist");
      if (record.state === "submitted" || record.state === "uncertain") {
        return structuredClone(record);
      }
      if (state === "submitted" && record.state !== "submitting") {
        throw new IdempotencyStoreError("cannot mark an unsubmitted request as submitted");
      }
      record.state = state;
      record.updated_at = new Date().toISOString();
      record.result = result;
      await this.#persist();
      return structuredClone(record);
    });
  }

  async get(agentId, idempotencyKey) {
    return this.#exclusive(async () => {
      await this.#load();
      const record = this.#records.get(recordId(agentId, idempotencyKey));
      return record ? structuredClone(record) : null;
    });
  }
}

export async function submitIdempotentPaymentRequest({
  store, agentId, idempotencyKey, payment, submit
}) {
  if (!store || typeof store.reserve !== "function" ||
      typeof store.transition !== "function" || typeof submit !== "function") {
    throw new TypeError("store and submit adapter are required");
  }
  const reservation = await store.reserve({ agentId, idempotencyKey, payment });
  if (!reservation.created) {
    return { replayed: true, record: reservation.record };
  }

  await store.transition(agentId, idempotencyKey, "submitting");
  try {
    const result = await submit(payment);
    const safeResult = {
      transaction_hash: typeof result?.transaction_hash === "string" ? result.transaction_hash : null,
      payment: result?.payment && typeof result.payment === "object" ? result.payment : null
    };
    const record = await store.transition(agentId, idempotencyKey, "submitted", safeResult);
    return { replayed: false, record };
  } catch (error) {
    await store.transition(agentId, idempotencyKey, "uncertain", {
      error_code: "submission_outcome_unknown"
    });
    throw error;
  }
}

export { U128_MAX };
