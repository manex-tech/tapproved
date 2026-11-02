import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentAuthenticator } from "./auth.js";
import { createApprovalProcessor } from "./approval-service.js";
import { JsonIdempotencyStore } from "./payment-requests.js";
import { createRecoveryService } from "./recovery-service.js";
import { createRelayServer } from "./server.js";

const token = "relay-integration-test-token-0123456789";
const idempotencyKey = "integration-payment-request-0001";
const requestBody = {
  recipient_id: "merchant.testnet",
  amount_yocto: "1000000000000000000000"
};
const pendingPayment = {
  id: "901",
  agent_id: "manex-agent.testnet",
  recipient_id: requestBody.recipient_id,
  amount_yocto: requestBody.amount_yocto,
  nonce: "901",
  created_at_ns: "1793519412345678901",
  expires_at_ns: "1793519712345678901",
  status: "pending",
  hardware_approved: false
};

async function withJournal(run) {
  const directory = await mkdtemp(join(tmpdir(), "tapproved-integration-"));
  try {
    await run(join(directory, "journal.json"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function withServer(options, run) {
  const server = createRelayServer(options);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

function quietLogger() {
  return {
    info() {},
    warn() {},
    error() {}
  };
}

function authHeaders(extra = {}) {
  return { authorization: `Bearer ${token}`, ...extra };
}

test("integrates authenticated payment creation, hardware approval, lifecycle reads and durable replay", async () => {
  await withJournal(async (journalPath) => {
    const store = new JsonIdempotencyStore(journalPath);
    let contractPayment = null;
    let paymentSubmissions = 0;
    let serialRequests = 0;
    let approvalSubmissions = 0;

    const processApproval = createApprovalProcessor({
      operationStore: store,
      getActivePayment: async () => contractPayment,
      serialBridge: {
        async connect() {},
        async requestApproval(payment) {
          serialRequests += 1;
          assert.equal(payment.id, pendingPayment.id);
          return { public_key: "device-public-key", signature: "device-signature" };
        }
      },
      approvalSigner: {
        async approveSpend(payment, signedResponse) {
          approvalSubmissions += 1;
          assert.equal(payment.id, pendingPayment.id);
          assert.equal(signedResponse.signature, "device-signature");
          contractPayment = { ...payment, status: "processing", hardware_approved: true };
          return {
            transaction_hash: "approval-transaction-hash",
            payment: contractPayment
          };
        }
      }
    });

    const recovery = createRecoveryService({
      store,
      getActivePayment: async () => contractPayment,
      getPayment: async (paymentId) => contractPayment?.id === paymentId ? contractPayment : null
    });

    await withServer({
      authenticate: createAgentAuthenticator({ token }),
      idempotencyStore: store,
      submitPayment: async (payment) => {
        paymentSubmissions += 1;
        assert.deepEqual(payment, requestBody);
        contractPayment = { ...pendingPayment };
        return {
          transaction_hash: "request-transaction-hash",
          payment: contractPayment
        };
      },
      getActivePayment: async () => contractPayment,
      getPayment: async (paymentId) => contractPayment?.id === paymentId ? contractPayment : null,
      processHardwareApproval: processApproval,
      reconcileRecovery: recovery.reconcileOnce,
      logger: quietLogger()
    }, async (base) => {
      const createRequest = () => fetch(`${base}/v1/payment-requests`, {
        method: "POST",
        headers: authHeaders({
          "content-type": "application/json",
          "idempotency-key": idempotencyKey
        }),
        body: JSON.stringify(requestBody)
      });

      const created = await createRequest();
      assert.equal(created.status, 202);
      const createdBody = await created.json();
      assert.equal(createdBody.state, "submitted");
      assert.equal(createdBody.replayed, false);
      assert.equal(createdBody.payment.id, pendingPayment.id);

      const pending = await fetch(`${base}/v1/pending-approvals`, {
        headers: authHeaders()
      });
      assert.equal(pending.status, 200);
      const pendingBody = await pending.json();
      assert.equal(pendingBody.approval_required, true);
      assert.equal(pendingBody.approval_request.payment_id, pendingPayment.id);
      assert.equal(pendingBody.approval_request.amount_yocto, requestBody.amount_yocto);

      const approved = await fetch(`${base}/v1/approvals/process`, {
        method: "POST",
        headers: authHeaders()
      });
      assert.equal(approved.status, 200);
      const approvedBody = await approved.json();
      assert.equal(approvedBody.state, "submitted");
      assert.equal(approvedBody.payment_id, pendingPayment.id);
      assert.equal(approvedBody.payment.status, "processing");

      const status = await fetch(`${base}/v1/payments/${pendingPayment.id}`, {
        headers: authHeaders()
      });
      assert.equal(status.status, 200);
      const statusBody = await status.json();
      assert.equal(statusBody.approval_required, false);
      assert.equal(statusBody.terminal, false);
      assert.equal(statusBody.payment.status, "processing");

      const replay = await createRequest();
      assert.equal(replay.status, 200);
      const replayBody = await replay.json();
      assert.equal(replayBody.replayed, true);
      assert.equal(replayBody.payment.id, pendingPayment.id);

      const reconciliation = await fetch(`${base}/v1/recovery/reconcile`, {
        method: "POST",
        headers: authHeaders()
      });
      assert.equal(reconciliation.status, 200);
      const recoveryBody = await reconciliation.json();
      assert.equal(recoveryBody.unresolved_operations, 0);
      assert.equal(recoveryBody.state, "reconciled");
    });

    assert.equal(paymentSubmissions, 1);
    assert.equal(serialRequests, 1);
    assert.equal(approvalSubmissions, 1);
  });
});

test("integrates ambiguous approval failure with durable retry suppression and manual recovery", async () => {
  await withJournal(async (journalPath) => {
    const store = new JsonIdempotencyStore(journalPath);
    let serialRequests = 0;
    let approvalSubmissions = 0;
    const processApproval = createApprovalProcessor({
      operationStore: store,
      getActivePayment: async () => pendingPayment,
      serialBridge: {
        async connect() {},
        async requestApproval() {
          serialRequests += 1;
          return { public_key: "device-public-key", signature: "device-signature" };
        }
      },
      approvalSigner: {
        async approveSpend() {
          approvalSubmissions += 1;
          throw new Error("connection lost after transaction broadcast");
        }
      }
    });
    const recovery = createRecoveryService({
      store,
      getActivePayment: async () => pendingPayment,
      getPayment: async () => pendingPayment
    });

    await withServer({
      authenticate: createAgentAuthenticator({ token }),
      processHardwareApproval: processApproval,
      reconcileRecovery: recovery.reconcileOnce,
      logger: quietLogger()
    }, async (base) => {
      const process = () => fetch(`${base}/v1/approvals/process`, {
        method: "POST",
        headers: authHeaders()
      });

      const first = await process();
      assert.equal(first.status, 502);
      assert.deepEqual(await first.json(), { error: "approval_submission_outcome_unknown" });

      const retry = await process();
      assert.equal(retry.status, 502);
      assert.deepEqual(await retry.json(), { error: "approval_recovery_required" });

      const reconciliation = await fetch(`${base}/v1/recovery/reconcile`, {
        method: "POST",
        headers: authHeaders()
      });
      assert.equal(reconciliation.status, 200);
      const body = await reconciliation.json();
      assert.equal(body.state, "manual_review_required");
      assert.equal(body.unresolved_operations, 1);
    });

    assert.equal(serialRequests, 1);
    assert.equal(approvalSubmissions, 1);
    const operation = await store.getOperation("manex-agent.testnet", pendingPayment.id, "approval");
    assert.equal(operation.state, "uncertain");
  });
});
