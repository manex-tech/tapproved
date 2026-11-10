import { createHash, timingSafeEqual } from "node:crypto";

const MIN_TOKEN_LENGTH = 32;
export const DEV_AGENT_API_TOKEN = "tapproved-dev-session-token-0123456789abcdef";

export function resolveAgentApiToken(env = process.env) {
  const signerVariables = [
    "NEAR_SIGNER_PRIVATE_KEY",
    "NEAR_APPROVAL_SIGNER_PRIVATE_KEY",
    "NEAR_EXPIRY_SIGNER_PRIVATE_KEY"
  ];
  const hasRealSigner = signerVariables.some((name) =>
    typeof env[name] === "string" && env[name].length > 0
  );
  const configuredToken = env.AGENT_API_TOKEN;
  if (hasRealSigner && (!configuredToken || configuredToken === DEV_AGENT_API_TOKEN)) {
    throw new Error("AGENT_API_TOKEN must be explicitly set to a non-development secret whenever a NEAR signer key is configured");
  }
  return { token: configuredToken || DEV_AGENT_API_TOKEN, development: !configuredToken };
}

const BEARER_PATTERN = /^Bearer ([A-Za-z0-9._~-]+)$/;

function digest(value) {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Build a fail-closed bearer-token authenticator for trusted agent callers.
 * Tokens must be high entropy (at least 32 URL-safe characters) and are
 * supplied only through server-side configuration, never request parameters.
 */
export function createAgentAuthenticator(options = {}) {
  const token = options.token;
  if (typeof token !== "string" || token.length < MIN_TOKEN_LENGTH ||
      !/^[A-Za-z0-9._~-]+$/.test(token)) {
    throw new Error("AGENT_API_TOKEN must contain at least 32 URL-safe characters");
  }

  const expected = digest(token);

  return function authenticateAgent(request) {
    const header = request?.headers?.authorization;
    if (typeof header !== "string") return false;
    const match = BEARER_PATTERN.exec(header);
    if (!match) return false;

    // Hashing produces fixed-length buffers, allowing timing-safe comparison
    // regardless of the supplied token length.
    const supplied = digest(match[1]);
    return timingSafeEqual(expected, supplied);
  };
}

export { MIN_TOKEN_LENGTH };
