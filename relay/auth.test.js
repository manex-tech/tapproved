import test from "node:test";
import assert from "node:assert/strict";
import { createAgentAuthenticator, DEV_AGENT_API_TOKEN, resolveAgentApiToken } from "./auth.js";

const token = "test-agent-token-0123456789abcdef";

test("accepts the configured bearer token", () => {
  const authenticate = createAgentAuthenticator({ token });
  assert.equal(authenticate({ headers: { authorization: `Bearer ${token}` } }), true);
});

test("rejects missing, malformed and incorrect authorization headers", () => {
  const authenticate = createAgentAuthenticator({ token });
  for (const request of [
    { headers: {} },
    { headers: { authorization: "" } },
    { headers: { authorization: token } },
    { headers: { authorization: `Basic ${token}` } },
    { headers: { authorization: "Bearer wrong-token-0123456789abcdef" } },
    { headers: { authorization: `Bearer ${token} trailing` } }
  ]) {
    assert.equal(authenticate(request), false);
  }
});

test("fails closed when server token is missing, short or malformed", () => {
  for (const invalid of [undefined, "", "short", "contains spaces and is long enough"]) {
    assert.throws(() => createAgentAuthenticator({ token: invalid }), /AGENT_API_TOKEN/);
  }
  assert.deepEqual(resolveAgentApiToken({}), { token: DEV_AGENT_API_TOKEN, development: true });
  for (const signerName of [
    "NEAR_SIGNER_PRIVATE_KEY",
    "NEAR_APPROVAL_SIGNER_PRIVATE_KEY",
    "NEAR_EXPIRY_SIGNER_PRIVATE_KEY"
  ]) {
    const liveSignerEnv = { [signerName]: "ed25519:live-key" };
    assert.throws(() => resolveAgentApiToken(liveSignerEnv), /non-development secret/);
    assert.throws(() => resolveAgentApiToken({
      ...liveSignerEnv, AGENT_API_TOKEN: DEV_AGENT_API_TOKEN
    }), /non-development secret/);
    assert.deepEqual(resolveAgentApiToken({
      ...liveSignerEnv, AGENT_API_TOKEN: "a-real-agent-api-token-with-sufficient-entropy"
    }), {
      token: "a-real-agent-api-token-with-sufficient-entropy", development: false
    });
  }
});

test("does not throw for absent or malformed request objects", () => {
  const authenticate = createAgentAuthenticator({ token });
  assert.equal(authenticate(undefined), false);
  assert.equal(authenticate({ headers: { authorization: ["Bearer", token] } }), false);
});
