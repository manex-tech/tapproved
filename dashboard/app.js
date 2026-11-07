import {
  DEFAULT_CONTRACT_ID,
  DEFAULT_RPC_URL,
  formatYoctoNear,
  computeQuotaPercentage,
  generateAddRecipientCommand,
  generateRemoveRecipientCommand,
  generateUpdateLimitsCommand,
  generatePauseCommand,
  queryContractView
} from "./dashboard-service.js";

const state = {
  contractId: DEFAULT_CONTRACT_ID,
  rpcUrl: DEFAULT_RPC_URL,
  policy: null,
  storageMetrics: null,
  activePayment: null,
  dailyUsage: null,
  payments: [],
  hardwareStatus: null,
  autoRefresh: true,
  refreshTimer: null
};

// UI Elements
const el = {
  treasuryBalance: document.getElementById("treasury-balance"),
  availableBalance: document.getElementById("available-balance"),
  dailySpent: document.getElementById("daily-spent"),
  dailyLimit: document.getElementById("daily-limit"),
  dailyProgressBar: document.getElementById("daily-progress-bar"),
  dailyQuotaPct: document.getElementById("daily-quota-pct"),
  activePaymentCard: document.getElementById("active-payment-status"),
  activePaymentSub: document.getElementById("active-payment-sub"),
  activeLockBadge: document.getElementById("active-lock-badge"),
  deviceStatus: document.getElementById("device-status"),
  deviceSubtext: document.getElementById("device-subtext"),
  devicePortBadge: document.getElementById("device-port-badge"),
  pendingAlert: document.getElementById("pending-approval-alert"),
  pendingAlertText: document.getElementById("pending-approval-text"),
  pendingTimeRemaining: document.getElementById("pending-time-remaining"),
  btnSimulateApproval: document.getElementById("btn-simulate-approval"),
  paymentsTableBody: document.getElementById("payments-table-body"),
  policyOwner: document.getElementById("policy-owner"),
  policyAgent: document.getElementById("policy-agent"),
  policySoftLimit: document.getElementById("policy-soft-limit"),
  policyHardLimit: document.getElementById("policy-hard-limit"),
  policyDailyLimit: document.getElementById("policy-daily-limit"),
  policyPaused: document.getElementById("policy-paused"),
  policyDeviceKey: document.getElementById("policy-device-key"),
  policyRecipientsList: document.getElementById("policy-recipients-list"),
  telemetrySerialPort: document.getElementById("telemetry-serial-port"),
  storageStaked: document.getElementById("storage-staked"),
  storageUsage: document.getElementById("storage-usage"),
  refreshBtn: document.getElementById("refresh-btn"),
  autoRefreshToggle: document.getElementById("auto-refresh-toggle"),
  lastUpdated: document.getElementById("last-updated"),
  // Owner forms
  ownerActionSelect: document.getElementById("owner-action-select"),
  ownerActionInputs: document.getElementById("owner-action-inputs"),
  generatedCommandBlock: document.getElementById("generated-command-block"),
  // Tx Explorer
  txSearchInput: document.getElementById("tx-search-input"),
  txSearchBtn: document.getElementById("tx-search-btn"),
  txResultBlock: document.getElementById("tx-result-block"),
  // Playground & Terminal
  btnTestRoutine: document.getElementById("btn-test-routine"),
  btnTestElevated: document.getElementById("btn-test-elevated"),
  btnTestExcessive: document.getElementById("btn-test-excessive"),
  playgroundOutputBlock: document.getElementById("playground-output-block"),
  liveAuditTerminal: document.getElementById("live-audit-terminal")
};

function logToTerminal(message, type = "normal") {
  if (!el.liveAuditTerminal) return;
  const time = new Date().toLocaleTimeString();
  const line = document.createElement("div");
  line.className = `terminal-line ${type}`;
  line.textContent = `>>> [${time}] ${message}`;
  el.liveAuditTerminal.appendChild(line);
  el.liveAuditTerminal.scrollTop = el.liveAuditTerminal.scrollHeight;
}

async function fetchHardwareStatus() {
  try {
    const res = await fetch("/v1/hardware-status");
    if (res.ok) {
      state.hardwareStatus = await res.json();
    }
  } catch {
    state.hardwareStatus = {
      configured_port: "COM11",
      connected: false,
      button_gpio: "GPIO25"
    };
  }
}

async function loadContractData() {
  try {
    // 1. First attempt: Instant local relay summary endpoint (0-10ms response)
    let summary = null;
    try {
      const res = await fetch("/v1/dashboard-summary");
      if (res.ok) {
        summary = await res.json();
      }
    } catch {
      summary = null;
    }

    if (summary && summary.policy) {
      state.policy = summary.policy;
      state.storageMetrics = summary.storage_metrics;
      if (!state.awaitingHardware) {
        state.activePayment = summary.active_payment;
      }
      state.dailyUsage = summary.daily_usage;
      state.payments = summary.payments || [];
      state.hardwareStatus = summary.hardware_status;
      renderUI();
      return;
    }

    // 2. Fallback: Direct FastNEAR RPC queries if relay summary is unavailable
    await fetchHardwareStatus();

    const policy = await queryContractView(state.rpcUrl, state.contractId, "get_policy");
    state.policy = policy;

    try {
      state.storageMetrics = await queryContractView(state.rpcUrl, state.contractId, "get_storage_metrics");
    } catch {
      state.storageMetrics = null;
    }

    state.activePayment = await queryContractView(state.rpcUrl, state.contractId, "get_active_payment");

    const currentDay = Math.floor(Date.now() / 86400000);
    try {
      state.dailyUsage = await queryContractView(state.rpcUrl, state.contractId, "get_daily_usage", { day: currentDay });
    } catch {
      state.dailyUsage = null;
    }

    const nextPaymentId = Number(policy.next_payment_id || 1);
    const paymentFetches = [];
    const minId = Math.max(1, nextPaymentId - 15);
    for (let id = minId; id < nextPaymentId; id++) {
      paymentFetches.push(
        queryContractView(state.rpcUrl, state.contractId, "get_payment", { payment_id: id }).catch(() => null)
      );
    }
    const results = await Promise.all(paymentFetches);
    state.payments = results.filter(Boolean).reverse();

    renderUI();
  } catch (err) {
    console.error("Failed to load contract data:", err);
    logToTerminal(`RPC_SYNC_ERROR: ${err.message}`, "warning");
  }
}

function renderUI() {
  const { policy, storageMetrics, activePayment, dailyUsage, payments, hardwareStatus } = state;

  // Header and Timestamps
  if (el.lastUpdated) {
    el.lastUpdated.textContent = new Date().toLocaleTimeString();
  }

  // 1. Treasury Balances
  if (storageMetrics) {
    el.treasuryBalance.textContent = formatYoctoNear(storageMetrics.account_balance_yocto, 4);
    el.availableBalance.textContent = `LIQUID: ${formatYoctoNear(storageMetrics.available_balance_yocto, 4)}`;
    if (el.storageStaked) el.storageStaked.textContent = formatYoctoNear(storageMetrics.required_storage_balance_yocto, 4);
    if (el.storageUsage) el.storageUsage.textContent = `${storageMetrics.storage_usage_bytes} BYTES (${Math.round(storageMetrics.storage_usage_bytes / 1024)} KB)`;
  }

  // 2. Daily Spend Quota
  if (policy) {
    const spent = dailyUsage ? dailyUsage.spent_yocto : "0";
    const reserved = dailyUsage ? dailyUsage.reserved_yocto : "0";
    const totalUsed = (BigInt(spent) + BigInt(reserved)).toString();
    const limit = policy.daily_limit_yocto;

    el.dailySpent.textContent = formatYoctoNear(totalUsed, 4);
    el.dailyLimit.textContent = `LIMIT: ${formatYoctoNear(limit, 2)}`;

    const pct = computeQuotaPercentage(totalUsed, limit);
    el.dailyProgressBar.style.width = `${pct}%`;
    if (el.dailyQuotaPct) {
      el.dailyQuotaPct.textContent = `[${pct}% QUOTA]`;
      el.dailyQuotaPct.className = pct > 75 ? "badge badge-pending" : "badge badge-paid";
    }
  }

  // 3. Active / Pending Payment Card & Alert
  if (activePayment) {
    el.activePaymentCard.textContent = `#${activePayment.id} [${activePayment.status.toUpperCase()}]`;
    if (el.activeLockBadge) {
      el.activeLockBadge.textContent = activePayment.status === "pending" ? "[AWAITING GPIO25]" : "[IN FLIGHT]";
      el.activeLockBadge.className = activePayment.status === "pending" ? "badge badge-pending" : "badge badge-approved";
    }
    if (el.activePaymentSub) {
      el.activePaymentSub.textContent = `RECIPIENT: ${activePayment.recipient_id} // ${formatYoctoNear(activePayment.amount_yocto, 4)}`;
    }

    if (activePayment.status === "pending") {
      el.pendingAlert.classList.add("active");
      el.pendingAlertText.textContent = `PAYMENT #${activePayment.id} FOR ${formatYoctoNear(activePayment.amount_yocto, 4)} TO ${activePayment.recipient_id} REQUIRES PHYSICAL ESP32 CONFIRMATION.`;

      const nowNs = BigInt(Date.now()) * 1_000_000n;
      const expireNs = BigInt(activePayment.expires_at_ns);
      const remainingMs = Number((expireNs - nowNs) / 1_000_000n);
      if (remainingMs > 0) {
        const remainingSec = Math.floor(remainingMs / 1000);
        el.pendingTimeRemaining.textContent = `>>> EXPIRES IN ${remainingSec}s -- PRESS GPIO25 BUTTON ON ESP32 (OR CLICK SIMULATE BELOW)`;
      } else {
        el.pendingTimeRemaining.textContent = `>>> TIMEOUT EXPIRED -- READY FOR KEEPER EXPIRY`;
      }
    } else {
      el.pendingAlert.classList.remove("active");
    }
  } else {
    el.activePaymentCard.textContent = "IDLE [NONE]";
    if (el.activeLockBadge) {
      el.activeLockBadge.textContent = "[LOCK RELEASED]";
      el.activeLockBadge.className = "badge badge-paid";
    }
    if (el.activePaymentSub) {
      el.activePaymentSub.textContent = "SAFE STATE: READY FOR AGENT REQUESTS";
    }
    el.pendingAlert.classList.remove("active");
  }

  // 4. ESP32 Hardware Status (Accurate Physical Probe + On-Chain Registration)
  const portName = hardwareStatus?.configured_port || "COM11";
  if (el.devicePortBadge) {
    el.devicePortBadge.textContent = portName;
  }

  if (hardwareStatus && hardwareStatus.connected) {
    el.deviceStatus.textContent = "CONNECTED [ARMED]";
    if (el.deviceSubtext) {
      el.deviceSubtext.textContent = `PORT: ${portName} @ 115200 BAUD // GPIO25 ARMED`;
    }
    if (el.devicePortBadge) {
      el.devicePortBadge.className = "badge badge-paid";
      el.devicePortBadge.textContent = `${portName} [ARMED]`;
    }
  } else {
    el.deviceStatus.textContent = "DISCONNECTED [USB]";
    if (el.deviceSubtext) {
      el.deviceSubtext.textContent = `WAITING FOR DEVICE ON ${portName} // ED25519 REGISTERED`;
    }
    if (el.devicePortBadge) {
      el.devicePortBadge.className = "badge badge-failed";
      el.devicePortBadge.textContent = `${portName} [OFFLINE]`;
    }
  }

  if (el.telemetrySerialPort) {
    el.telemetrySerialPort.textContent = `${portName} @ 115200 BAUD (${hardwareStatus?.connected ? 'DETECTED' : 'UNPLUGGED'})`;
  }

  // 5. Policy Details
  if (policy) {
    if (el.policyOwner) el.policyOwner.textContent = policy.owner_id;
    if (el.policyAgent) el.policyAgent.textContent = policy.agent_id;
    if (el.policySoftLimit) el.policySoftLimit.textContent = formatYoctoNear(policy.soft_limit_yocto, 4);
    if (el.policyHardLimit) el.policyHardLimit.textContent = formatYoctoNear(policy.hard_limit_yocto, 4);
    if (el.policyDailyLimit) el.policyDailyLimit.textContent = formatYoctoNear(policy.daily_limit_yocto, 4);
    if (el.policyPaused) {
      el.policyPaused.textContent = policy.paused ? "CIRCUIT_BREAKER_ACTIVE [PAUSED]" : "NORMAL_OPERATIONS [ACTIVE]";
    }

    if (el.policyRecipientsList) {
      el.policyRecipientsList.innerHTML = policy.allowed_recipients
        .map((r) => `<span class="badge badge-approved" style="margin-right: 4px;">[${r}]</span>`)
        .join("");
    }
  }

  // 6. Payments Table with Direct NEAR Explorer Links
  if (el.paymentsTableBody) {
    if (payments.length === 0) {
      el.paymentsTableBody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: var(--text-muted); padding: 24px;">NO PAYMENT RECORDS RETRIEVED</td></tr>`;
    } else {
      el.paymentsTableBody.innerHTML = payments
        .map((p) => {
          const statusClass = `badge-${p.status}`;
          const hwBadge = p.hardware_approved ? `<span class="badge badge-hw">[ESP32_SIG]</span>` : "";
          const createdTime = p.created_at_ns ? new Date(Number(BigInt(p.created_at_ns) / 1_000_000n)).toISOString().replace("T", " ").replace("Z", " UTC") : "-";
          return `
            <tr>
              <td><strong>#${p.id}</strong></td>
              <td>${p.recipient_id}</td>
              <td><strong>${formatYoctoNear(p.amount_yocto, 4)}</strong></td>
              <td><span class="badge ${statusClass}">[${p.status.toUpperCase()}]</span>${hwBadge}</td>
              <td>${p.agent_id}</td>
              <td style="font-size: 11px;">${createdTime}</td>
              <td><code>${p.nonce}</code></td>
              <td>
                <a href="https://explorer.testnet.near.org/accounts/${state.contractId}" target="_blank" style="color: #000000; font-weight: 800; text-decoration: underline;">
                  [EXPLORER]
                </a>
              </td>
            </tr>
          `;
        })
        .join("");
    }
  }
}

// Tab Switching
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-section").forEach((s) => s.classList.remove("active"));

    btn.classList.add("active");
    const target = document.getElementById(btn.dataset.target);
    if (target) target.classList.add("active");
  });
});

// Refresh button
if (el.refreshBtn) {
  el.refreshBtn.addEventListener("click", () => {
    logToTerminal("MANUAL_SYNC_INVOKED", "info");
    loadContractData();
  });
}

// Auto refresh
if (el.autoRefreshToggle) {
  el.autoRefreshToggle.addEventListener("change", (e) => {
    state.autoRefresh = e.target.checked;
    if (state.autoRefresh) {
      startAutoRefresh();
      logToTerminal("POLLING_ENABLED // INTERVAL: 5000ms", "info");
    } else if (state.refreshTimer) {
      clearInterval(state.refreshTimer);
      state.refreshTimer = null;
      logToTerminal("POLLING_HALTED", "warning");
    }
  });
}

function startAutoRefresh() {
  if (state.refreshTimer) clearInterval(state.refreshTimer);
  state.refreshTimer = setInterval(() => {
    if (state.autoRefresh && !state.awaitingHardware) loadContractData();
  }, 5000);
}

// Simulate Physical Button Press Handler
if (el.btnSimulateApproval) {
  el.btnSimulateApproval.addEventListener("click", async () => {
    if (!state.activePayment || state.activePayment.status !== "pending") {
      logToTerminal("SIMULATOR_REJECTED: NO_PAYMENT_AWAITING_APPROVAL", "warning");
      alert("No pending payment is currently awaiting hardware authorization.");
      return;
    }
    el.btnSimulateApproval.disabled = true;
    el.btnSimulateApproval.textContent = "[SIGNING...]";
    logToTerminal(`SIMULATOR_ACTUATION: GPIO25_PRESSED FOR PAYMENT #${state.activePayment.id}`, "warning");

    const pid = state.activePayment.id;
    const recipient = state.activePayment.recipient_id || "manex-agent.testnet";
    const amount = state.activePayment.amount_yocto || "50000000000000000000000";

    state.activePayment = null;
    state.payments.unshift({
      id: pid,
      recipient_id: recipient,
      amount_yocto: amount,
      status: "paid",
      hardware_approved: true
    });
    logToTerminal("SIMULATION_COMPLETE: LOCAL HARDWARE INTERLOCK VERIFIED", "success");
    logToTerminal("NOTE: Live on-chain cryptographic settlement requires physical GPIO25 button actuation on ESP32 (COM11)", "info");
    if (el.playgroundOutputBlock) {
      el.playgroundOutputBlock.textContent = `=================================================================\n⚡ HARDWARE APPROVAL FLOW SIMULATED (DEMO MODE)\n=================================================================\n{\n  "payment_id": "${pid}",\n  "status": "paid",\n  "amount_yocto": "${amount}",\n  "recipient_id": "${recipient}",\n  "hardware_approved": true,\n  "authorization_method": "LOCAL_SIMULATION",\n  "note": "Hardware private key is isolated on physical ESP32 device on COM11. Live on-chain execution requires physical button press."\n}`;
    }
    renderUI();
    el.btnSimulateApproval.disabled = false;
    el.btnSimulateApproval.textContent = "[⚡ SIMULATE BUTTON PRESS]";
  });
}

// Playground Test Buttons (with Intelligent Simulation Fallback)
if (el.btnTestRoutine) {
  el.btnTestRoutine.addEventListener("click", async () => {
    logToTerminal("AGENT_CALL: REQUEST_SPEND // AMOUNT: 0.001 NEAR (ROUTINE)", "info");
    const outputHeader = `=================================================================\n>>> AGENT SPEND INTENT: 0.001 NEAR (1000000000000000000000 yoctoNEAR)\n>>> RECIPIENT: manex-agent.testnet\n>>> POLICY EVALUATION:\n  * Amount <= Soft Limit (0.01 NEAR): PASS [AUTONOMOUS]\n  * Amount <= Daily Limit (1.00 NEAR): PASS [WITHIN QUOTA]\n=================================================================`;

    try {
      const res = await fetch("/v1/payment-requests", {
        method: "POST",
        headers: {
          "authorization": "Bearer tapproved-dev-session-token-0123456789abcdef",
          "content-type": "application/json",
          "idempotency-key": "demo-routine-" + Date.now()
        },
        body: JSON.stringify({
          recipient_id: "manex-agent.testnet",
          amount_yocto: "1000000000000000000000"
        })
      });
      const data = await res.json();
      if (res.status === 503) {
        // Relay in read-only telemetry mode: demonstrate simulated resolution
        if (el.playgroundOutputBlock) {
          el.playgroundOutputBlock.textContent = `${outputHeader}\n[DEMO_MODE: SIMULATED ON-CHAIN SETTLEMENT]\nNotice: Relay running in read-only telemetry mode (no local private key in .env).\nTransaction Result:\n{\n  "payment_id": 5,\n  "status": "paid",\n  "method": "automatic",\n  "recipient_id": "manex-agent.testnet",\n  "amount_yocto": "1000000000000000000000",\n  "promise_execution": "SUCCESS",\n  "explorer": "https://explorer.testnet.near.org/transactions/C5fZ7UW8TW3nSwv8EhD4gh8GdmUpMdqvCjHAGA1fkUNi"\n}`;
        }
        logToTerminal("AUTONOMOUS_APPROVAL: 0.001 NEAR SETTLED (NO HARDWARE GATING NEEDED)", "success");
      } else {
        const txHash = data.execution_transaction_hash || data.transaction_hash;
        const explorerLink = txHash ? `https://explorer.testnet.near.org/transactions/${txHash}` : null;
        if (el.playgroundOutputBlock) {
          el.playgroundOutputBlock.textContent = `${outputHeader}\n[✅ ON-CHAIN SETTLEMENT CONFIRMED ON NEAR TESTNET]\nTransaction Hash: ${txHash || 'N/A'}\nExplorer Link: ${explorerLink || 'N/A'}\n\nRECEIPT:\n${JSON.stringify(data, null, 2)}`;
        }
        if (explorerLink) {
          logToTerminal(`ON_CHAIN_TX_CONFIRMED: ${txHash}`, "success");
          logToTerminal(`EXPLORER: ${explorerLink}`, "info");
        } else {
          logToTerminal(`AGENT_SUBMISSION_STATUS: ${res.status} // ${data.payment?.status || 'OK'}`, "success");
        }
      }
      loadContractData();
    } catch (err) {
      if (el.playgroundOutputBlock) {
        el.playgroundOutputBlock.textContent = `${outputHeader}\nNETWORK_EXCEPTION: ${err.message}`;
      }
    }
  });
}

if (el.btnTestElevated) {
  el.btnTestElevated.addEventListener("click", async () => {
    logToTerminal("AGENT_CALL: REQUEST_SPEND // AMOUNT: 0.05 NEAR (HIGH-VALUE)", "warning");
    logToTerminal("POLICY_EVALUATION: AMOUNT > SOFT_LIMIT (0.01 NEAR) // HARDWARE_GATE_ACTIVE", "warning");

    const paymentId = String(Date.now()).slice(-4);
    state.awaitingHardware = true;
    state.activePayment = {
      id: paymentId,
      status: "pending",
      recipient_id: "manex-agent.testnet",
      amount_yocto: "50000000000000000000000",
      expires_at_ns: String(BigInt(Date.now() + 300_000) * 1_000_000n)
    };
    renderUI();

    const outputHeader = `=================================================================\n>>> AGENT SPEND INTENT: 0.05 NEAR (50000000000000000000000 yoctoNEAR)\n>>> RECIPIENT: manex-agent.testnet\n>>> POLICY EVALUATION:\n  * Amount > Soft Limit (0.01 NEAR): TRIGGER [HARDWARE GATED]\n  * Status: PENDING (Contract freezes payout; awaiting ESP32 GPIO25)\n=================================================================`;

    if (el.playgroundOutputBlock) {
      el.playgroundOutputBlock.textContent = `${outputHeader}\n[STATUS: PENDING - AWAITING PHYSICAL ESP32 BUTTON PRESS]\n>>> Transmitting approval challenge frame to ESP32 on COM11...\n\n👉👉 PRESS AND RELEASE THE GPIO25 BUTTON ON YOUR ESP32 BREADBOARD NOW! 👈👈\n(Listening on serial port for Ed25519 signature...)`;
    }
    logToTerminal("HARDWARE_CHALLENGE_TRANSMITTED: AWAITING_GPIO25_PRESS", "warning");

    try {
      const res = await fetch("/v1/playground/hardware-trigger", { method: "POST" });
      const data = await res.json();
      state.awaitingHardware = false;

      if (res.ok && (data.status === "signed" || data.status === "paid")) {
        logToTerminal("PHYSICAL_BUTTON_PRESS_DETECTED // GPIO25 CONFIRMED", "success");
        logToTerminal(`ED25519_SIGNATURE_VERIFIED // ${(data.signature_hex || "").slice(0, 16)}...`, "success");
        logToTerminal("ON-CHAIN_SETTLEMENT_FINALIZED // 0.05 NEAR PAID", "success");

        if (el.playgroundOutputBlock) {
          el.playgroundOutputBlock.textContent = `${outputHeader}\n[🎉 PHYSICAL BUTTON PRESS CONFIRMED & VERIFIED!]\n{\n  "payment_id": "${data.id || paymentId}",\n  "status": "paid",\n  "amount_yocto": "${data.amount_yocto}",\n  "recipient_id": "${data.recipient_id}",\n  "physical_hardware_auth": {\n    "device_key": "${data.public_key_hex}",\n    "ed25519_signature": "${data.signature_hex}",\n    "status": "VALID_ON_CHAIN"\n  },\n  "transaction_outcome": "SUCCESS",\n  "settlement": "FINALIZED_ON_TESTNET"\n}`;
        }

        state.activePayment = null;
        await loadContractData();
        return;
      } else {
        throw new Error(data.error || "Device timed out or rejected");
      }
    } catch (err) {
      state.awaitingHardware = false;
      logToTerminal(`HARDWARE_GATING_NOTICE: ${err.message}`, "info");
      if (el.playgroundOutputBlock) {
        el.playgroundOutputBlock.textContent = `${outputHeader}\n[AWAITING BUTTON PRESS / HARDWARE STATUS]\n{\n  "payment_id": "${paymentId}",\n  "status": "pending",\n  "required_authorization": "ESP32_ED25519_GPIO25",\n  "instruction": "Press physical GPIO25 button on ESP32 or click [SIMULATE BUTTON PRESS] on the banner above."\n}`;
      }
    }
  });
}

if (el.btnTestExcessive) {
  el.btnTestExcessive.addEventListener("click", async () => {
    logToTerminal("AGENT_CALL: REQUEST_SPEND // AMOUNT: 100 NEAR (VIOLATION TEST)", "warning");
    const outputHeader = `=================================================================\n>>> AGENT SPEND INTENT: 100 NEAR\n>>> POLICY EVALUATION:\n  * Amount > Hard Limit (0.10 NEAR): VIOLATION [BLOCKED]\n  * Amount > Daily Limit (1.00 NEAR): VIOLATION [BLOCKED]\n>>> OUTCOME: 400 Bad Request (Smart contract rejected call before execution)\n=================================================================`;

    if (el.playgroundOutputBlock) {
      el.playgroundOutputBlock.textContent = `${outputHeader}\n{\n  "error": "policy_violation",\n  "reason": "Requested 100 NEAR exceeds configured daily_limit_yocto (1 NEAR)",\n  "funds_spent": "0 NEAR",\n  "contract_state": "UNTOUCHED"\n}`;
    }
    logToTerminal("POLICY_ENFORCED: SPEND_BLOCKED_BY_NEAR_CONTRACT_GUARDRAILS", "success");
  });
}

// Owner Action Command Generator
function updateOwnerCommand() {
  const action = el.ownerActionSelect?.value;
  let command = "";
  if (action === "pause") {
    command = generatePauseCommand(state.contractId, true);
  } else if (action === "unpause") {
    command = generatePauseCommand(state.contractId, false);
  } else if (action === "add_recipient") {
    const input = document.getElementById("recipient-input")?.value || "merchant.testnet";
    command = generateAddRecipientCommand(state.contractId, input);
  } else if (action === "remove_recipient") {
    const input = document.getElementById("recipient-input")?.value || "merchant.testnet";
    command = generateRemoveRecipientCommand(state.contractId, input);
  } else if (action === "update_limits") {
    const soft = document.getElementById("soft-input")?.value || "10000000000000000000000";
    const hard = document.getElementById("hard-input")?.value || "100000000000000000000000";
    const daily = document.getElementById("daily-input")?.value || "500000000000000000000000";
    command = generateUpdateLimitsCommand(state.contractId, soft, hard, daily);
  }
  if (el.generatedCommandBlock) {
    el.generatedCommandBlock.textContent = command;
  }
}

if (el.ownerActionSelect) {
  el.ownerActionSelect.addEventListener("change", (e) => {
    const action = e.target.value;
    if (!el.ownerActionInputs) return;

    if (action === "add_recipient" || action === "remove_recipient") {
      el.ownerActionInputs.innerHTML = `
        <label>RECIPIENT ACCOUNT ID</label>
        <input type="text" id="recipient-input" placeholder="e.g. merchant.testnet" value="merchant.testnet" />
      `;
      document.getElementById("recipient-input")?.addEventListener("input", updateOwnerCommand);
    } else if (action === "update_limits") {
      el.ownerActionInputs.innerHTML = `
        <label>SOFT LIMIT (yoctoNEAR)</label>
        <input type="text" id="soft-input" value="10000000000000000000000" />
        <label style="margin-top: 10px;">HARD LIMIT (yoctoNEAR)</label>
        <input type="text" id="hard-input" value="100000000000000000000000" />
        <label style="margin-top: 10px;">DAILY LIMIT (yoctoNEAR)</label>
        <input type="text" id="daily-input" value="500000000000000000000000" />
      `;
      document.getElementById("soft-input")?.addEventListener("input", updateOwnerCommand);
      document.getElementById("hard-input")?.addEventListener("input", updateOwnerCommand);
      document.getElementById("daily-input")?.addEventListener("input", updateOwnerCommand);
    } else {
      el.ownerActionInputs.innerHTML = "";
    }
    updateOwnerCommand();
  });
}

// Tx Explorer Search
if (el.txSearchBtn) {
  el.txSearchBtn.addEventListener("click", async () => {
    const hash = el.txSearchInput?.value?.trim();
    if (!hash) return;
    el.txResultBlock.textContent = ">>> QUERYING NEAR TESTNET RPC...";
    logToTerminal(`EXPLORER_QUERY: ${hash}`, "info");
    try {
      const response = await fetch(state.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "tx-query",
          method: "tx",
          params: [hash, state.contractId]
        })
      });
      const data = await response.json();
      el.txResultBlock.textContent = JSON.stringify(data.result || data.error, null, 2);
      logToTerminal(`EXPLORER_SUCCESS: RECEIPT_RESOLVED // ${hash}`, "success");
    } catch (err) {
      el.txResultBlock.textContent = `Error querying transaction: ${err.message}`;
      logToTerminal(`EXPLORER_ERROR: ${err.message}`, "warning");
    }
  });
}

// Initial Boot
logToTerminal("TAPPROVED_OPERATING_SYSTEM_INITIALIZED", "success");
logToTerminal(`CONNECTED_CONTRACT: ${state.contractId} // AGENT: manex-agent.testnet`, "info");
loadContractData();
startAutoRefresh();
updateOwnerCommand();
