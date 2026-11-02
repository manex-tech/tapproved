const SAFE_FIELDS = new Set([
  "request_id", "method", "route", "status", "duration_ms",
  "error_code", "error_name", "operation", "payment_id", "transaction_hash",
  "state", "component"
]);

function safeValue(value) {
  if (typeof value === "string") return value.slice(0, 128);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean" || value === null) return value;
  return undefined;
}

export function sanitizeLogFields(fields = {}) {
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) return {};
  const safe = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!SAFE_FIELDS.has(key)) continue;
    const normalized = safeValue(value);
    if (normalized !== undefined) safe[key] = normalized;
  }
  return safe;
}

export function sanitizeError(error, fallbackCode = "internal_error") {
  const code = typeof error?.code === "string" && /^[a-z0-9_]{1,64}$/.test(error.code)
    ? error.code
    : fallbackCode;
  const name = typeof error?.name === "string" && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(error.name)
    ? error.name
    : "Error";
  return { error_code: code, error_name: name };
}

export function createStructuredLogger(options = {}) {
  const write = options.write ?? ((line) => {
    const output = options.output ?? process.stdout;
    output.write(line + "\n");
  });
  if (typeof write !== "function") throw new TypeError("logger write must be a function");

  function log(level, event, fields = {}) {
    if (!["debug", "info", "warn", "error"].includes(level)) {
      throw new TypeError("invalid log level");
    }
    if (typeof event !== "string" || !/^[a-z][a-z0-9_.-]{0,63}$/.test(event)) {
      throw new TypeError("invalid log event");
    }
    const record = {
      timestamp: new Date().toISOString(),
      level,
      event,
      ...sanitizeLogFields(fields)
    };
    try {
      write(JSON.stringify(record));
    } catch {
      // Logging must never interrupt payment or recovery control flow.
    }
  }

  return Object.freeze({
    log,
    debug: (event, fields) => log("debug", event, fields),
    info: (event, fields) => log("info", event, fields),
    warn: (event, fields) => log("warn", event, fields),
    error: (event, fields) => log("error", event, fields)
  });
}
