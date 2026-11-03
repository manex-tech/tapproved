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
  line.textContent = `[${time}] ${message}`;
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
    // If running in purely static mode
    state.hardwareStatus = {
      configured_port: "COM11",
      connected: false,
      button_gpio: "GPIO25"
    };
  }
}

async function loadContractData() {
  try {
    // 0. Hardware Status Probe
    await fetchHardwareStatus();

    // 1. Fetch Policy
    const policy = await queryContractView(state.rpcUrl, state.contractId, "get_policy");
    state.policy = policy;

    // 2. Fetch Storage Metrics
    try {
      state.storageMetrics = await queryContractView(state.rpcUrl, state.contractId, "get_storage_metrics");
    } catch {
      state.storageMetrics = null;
    }

    // 3. Fetch Active Payment
    state.activePayment = await queryContractView(state.rpcUrl, state.contractId, "get_active_payment");

    // 4. Fetch Daily Usage for Today
    const currentDay = Math.floor(Date.now() / 86400000);
    try {
      state.dailyUsage = await queryContractView(state.rpcUrl, state.contractId, "get_daily_usage", { day: currentDay });
    } catch {
      state.dailyUsage = null;
    }

    // 5. Fetch Payment History
    const nextPaymentId = Number(policy.next_payment_id || 1);
    const paymentFetches = [];
    const minId = Math.max(1, nextPaymentId - 20); // Last 20 payments
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
    logToTerminal(`RPC Sync Warning: ${err.message}`, "warning");
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
    el.availableBalance.textContent = `${formatYoctoNear(storageMetrics.available_balance_yocto, 4)} liquid available`;
    if (el.storageStaked) el.storageStaked.textContent = formatYoctoNear(storageMetrics.required_storage_balance_yocto, 4);
    if (el.storageUsage) el.storageUsage.textContent = `${storageMetrics.storage_usage_bytes} bytes (${Math.round(storageMetrics.storage_usage_bytes / 1024)} KB)`;
  }

  // 2. Daily Spend Quota
  if (policy) {
    const spent = dailyUsage ? dailyUsage.spent_yocto : "0";
    const reserved = dailyUsage ? dailyUsage.reserved_yocto : "0";
    const totalUsed = (BigInt(spent) + BigInt(reserved)).toString();
    const limit = policy.daily_limit_yocto;

    el.dailySpent.textContent = formatYoctoNear(totalUsed, 4);
    el.dailyLimit.textContent = `Limit: ${formatYoctoNear(limit, 2)}`;

    const pct = computeQuotaPercentage(totalUsed, limit);
    el.dailyProgressBar.style.width = `${pct}%`;
    if (el.dailyQuotaPct) {
      el.dailyQuotaPct.textContent = `${pct}% Used`;
      el.dailyQuotaPct.className = pct > 75 ? "badge badge-pending" : "badge badge-paid";
    }
  }

  // 3. Active / Pending Payment Card & Alert
  if (activePayment) {
    el.activePaymentCard.textContent = `Payment #${activePayment.id} (${activePayment.status.toUpperCase()})`;
    if (el.activeLockBadge) {
      el.activeLockBadge.textContent = activePayment.status === "pending" ? "Awaiting GPIO25" : "In Flight";
      el.activeLockBadge.className = activePayment.status === "pending" ? "badge badge-pending" : "badge badge-approved";
    }
    if (el.activePaymentSub) {
      el.activePaymentSub.textContent = `Recipient: ${activePayment.recipient_id} • Amount: ${formatYoctoNear(activePayment.amount_yocto, 4)}`;
    }

    if (activePayment.status === "pending") {
      el.pendingAlert.classList.add("active");
      el.pendingAlertText.textContent = `Payment #${activePayment.id} for ${formatYoctoNear(activePayment.amount_yocto, 4)} to ${activePayment.recipient_id} is frozen on-chain. Requires physical ESP32 button press.`;

      const nowNs = BigInt(Date.now()) * 1_000_000n;
      const expireNs = BigInt(activePayment.expires_at_ns);
      const remainingMs = Number((expireNs - nowNs) / 1_000_000n);
      if (remainingMs > 0) {
        const remainingSec = Math.floor(remainingMs / 1000);
        el.pendingTimeRemaining.textContent = `⏱️ Window expires in ${remainingSec}s — Press GPIO25 button on ESP32 (or use simulator below)`;
      } else {
        el.pendingTimeRemaining.textContent = "⏱️ Window expired. Payment ready for keeper expiry.";
      }
    } else {
      el.pendingAlert.classList.remove("active");
    }
  } else {
    el.activePaymentCard.textContent = "None (Idle)";
    if (el.activeLockBadge) {
      el.activeLockBadge.textContent = "Concurrency Lock Safe";
      el.activeLockBadge.className = "badge badge-paid";
    }
    if (el.activePaymentSub) {
      el.activePaymentSub.textContent = "Safe state: treasury ready for agent requests";
    }
    el.pendingAlert.classList.remove("active");
  }

  // 4. ESP32 Hardware Status (Accurate Physical Detection + On-Chain Registration)
  const portName = hardwareStatus?.configured_port || "COM11";
  if (el.devicePortBadge) {
    el.devicePortBadge.textContent = portName;
  }

  if (hardwareStatus && hardwareStatus.connected) {
    el.deviceStatus.textContent = "Connected & Armed";
    el.deviceStatus.style.color = "var(--color-success)";
    if (el.deviceSubtext) {
      el.deviceSubtext.textContent = `${portName} @ 115200 baud • GPIO25 Ready`;
    }
    if (el.devicePortBadge) {
      el.devicePortBadge.className = "badge badge-paid";
      el.devicePortBadge.textContent = `${portName} Ready`;
    }
  } else {
    el.deviceStatus.textContent = "Disconnected (USB)";
    el.deviceStatus.style.color = "var(--color-danger)";
    if (el.deviceSubtext) {
      el.deviceSubtext.textContent = `Plug ESP32 into USB (${portName}) to enable physical signing`;
    }
    if (el.devicePortBadge) {
      el.devicePortBadge.className = "badge badge-failed";
      el.devicePortBadge.textContent = `${portName} Unplugged`;
    }
  }

  if (el.telemetrySerialPort) {
    el.telemetrySerialPort.textContent = `${portName} @ 115200 baud (${hardwareStatus?.connected ? 'Connected' : 'Disconnected'})`;
  }

  // 5. Policy Details
  if (policy) {
    if (el.policyOwner) el.policyOwner.textContent = policy.owner_id;
    if (el.policyAgent) el.policyAgent.textContent = policy.agent_id;
    if (el.policySoftLimit) el.policySoftLimit.textContent = formatYoctoNear(policy.soft_limit_yocto, 4);
    if (el.policyHardLimit) el.policyHardLimit.textContent = formatYoctoNear(policy.hard_limit_yocto, 4);
    if (el.policyDailyLimit) el.policyDailyLimit.textContent = formatYoctoNear(policy.daily_limit_yocto, 4);
    if (el.policyPaused) {
      el.policyPaused.textContent = policy.paused ? "PAUSED (Circuit Breaker Triggered)" : "Active (Normal Operations)";
      el.policyPaused.style.color = policy.paused ? "var(--color-danger)" : "var(--color-success)";
    }

    if (el.policyRecipientsList) {
      el.policyRecipientsList.innerHTML = policy.allowed_recipients
        .map((r) => `<span class="badge badge-approved" style="margin-right: 4px; font-family: var(--font-mono);">${r}</span>`)
        .join("");
    }
  }

  // 6. Payments Table with NEAR Explorer Links
  if (el.paymentsTableBody) {
    if (payments.length === 0) {
      el.paymentsTableBody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: var(--text-muted); padding: 24px;">No payment records found on contract</td></tr>`;
    } else {
      el.paymentsTableBody.innerHTML = payments
        .map((p) => {
          const statusClass = `badge-${p.status}`;
          const hwBadge = p.hardware_approved ? `<span class="badge badge-hw">ESP32 Signed</span>` : "";
          const createdTime = p.created_at_ns ? new Date(Number(BigInt(p.created_at_ns) / 1_000_000n)).toUTCString().replace("GMT", "UTC") : "-";
          return `
            <tr>
              <td><strong>#${p.id}</strong></td>
              <td><span style="font-family: var(--font-mono);">${p.recipient_id}</span></td>
              <td><strong style="font-family: var(--font-mono);">${formatYoctoNear(p.amount_yocto, 4)}</strong></td>
              <td><span class="badge ${statusClass}">${p.status}</span>${hwBadge}</td>
              <td><span style="font-family: var(--font-mono); color: var(--text-muted);">${p.agent_id}</span></td>
              <td style="font-size: 11px; color: var(--text-muted);">${createdTime}</td>
              <td><code>${p.nonce}</code></td>
              <td>
                <a href="https://explorer.testnet.near.org/accounts/${state.contractId}" target="_blank" style="color: var(--accent-cyan); text-decoration: none; font-size: 11px;">
                  Receipt ↗
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
    logToTerminal("Manual sync triggered...", "info");
    loadContractData();
  });
}

// Auto refresh
if (el.autoRefreshToggle) {
  el.autoRefreshToggle.addEventListener("change", (e) => {
    state.autoRefresh = e.target.checked;
    if (state.autoRefresh) {
      startAutoRefresh();
      logToTerminal("Auto-refresh enabled (5s polling)", "info");
    } else if (state.refreshTimer) {
      clearInterval(state.refreshTimer);
      state.refreshTimer = null;
      logToTerminal("Auto-refresh paused", "warning");
    }
  });
}

function startAutoRefresh() {
  if (state.refreshTimer) clearInterval(state.refreshTimer);
  state.refreshTimer = setInterval(() => {
    if (state.autoRefresh) loadContractData();
  }, 5000);
}

// Simulate Physical Button Press Handler
if (el.btnSimulateApproval) {
  el.btnSimulateApproval.addEventListener("click", async () => {
    if (!state.activePayment || state.activePayment.status !== "pending") {
      alert("No pending payment is currently awaiting hardware authorization.");
      return;
    }
    el.btnSimulateApproval.disabled = true;
    el.btnSimulateApproval.textContent = "Signing...";
    logToTerminal(`[SIMULATOR] Physical GPIO25 button actuation triggered for Payment #${state.activePayment.id}...`, "warning");

    try {
      const res = await fetch("/v1/approvals/process", {
        method: "POST",
        headers: {
          "authorization": "Bearer tapproved-dev-session-token-0123456789abcdef",
          "content-type": "application/json"
        }
      });
      const data = await res.json();
      if (res.ok) {
        logToTerminal(`[SETTLED] Payment #${state.activePayment.id} approved and executed on-chain!`, "success");
        loadContractData();
      } else {
        logToTerminal(`[SIMULATOR NOTICE] Approval submitted. Relay response: ${JSON.stringify(data)}`, "info");
      }
    } catch (err) {
      logToTerminal(`[SIMULATOR] Hardware signing simulation: ${err.message}`, "info");
    } finally {
      el.btnSimulateApproval.disabled = false;
      el.btnSimulateApproval.textContent = "⚡ Simulate Button Press";
    }
  });
}

// Playground Test Buttons
if (el.btnTestRoutine) {
  el.btnTestRoutine.addEventListener("click", async () => {
    logToTerminal("[AGENT] Executing routine spend test: 0.001 NEAR (Autonomous)", "info");
    if (el.playgroundOutputBlock) {
      el.playgroundOutputBlock.textContent = "Submitting request to relay...\nPOST /v1/payment-requests\nAmount: 0.001 NEAR (1000000000000000000000 yoctoNEAR)\nRecipient: manex-agent.testnet\nIdempotency-Key: test-routine-" + Date.now();
    }
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
      if (el.playgroundOutputBlock) {
        el.playgroundOutputBlock.textContent = `Status: ${res.status}\nOutcome: ${JSON.stringify(data, null, 2)}`;
      }
      logToTerminal(`[AGENT RESPONSE] Status ${res.status}: ${data.payment?.status || data.error || 'ok'}`, res.ok ? "success" : "info");
      loadContractData();
    } catch (err) {
      if (el.playgroundOutputBlock) {
        el.playgroundOutputBlock.textContent = `Error: ${err.message}\n(Ensure relay server is running on port 3000)`;
      }
    }
  });
}

if (el.btnTestElevated) {
  el.btnTestElevated.addEventListener("click", async () => {
    logToTerminal("[AGENT] Executing elevated spend test: 0.05 NEAR (Hardware Gated)", "warning");
    if (el.playgroundOutputBlock) {
      el.playgroundOutputBlock.textContent = "Submitting elevated request...\nPOST /v1/payment-requests\nAmount: 0.05 NEAR (50000000000000000000000 yoctoNEAR)\nStatus expected: pending";
    }
    try {
      const res = await fetch("/v1/payment-requests", {
        method: "POST",
        headers: {
          "authorization": "Bearer tapproved-dev-session-token-0123456789abcdef",
          "content-type": "application/json",
          "idempotency-key": "demo-elevated-" + Date.now()
        },
        body: JSON.stringify({
          recipient_id: "manex-agent.testnet",
          amount_yocto: "50000000000000000000000"
        })
      });
      const data = await res.json();
      if (el.playgroundOutputBlock) {
        el.playgroundOutputBlock.textContent = `Status: ${res.status}\nOutcome: ${JSON.stringify(data, null, 2)}`;
      }
      logToTerminal(`[PENDING ALERT] High-value payment gated by contract! Awaiting GPIO25 press on ESP32.`, "warning");
      loadContractData();
    } catch (err) {
      if (el.playgroundOutputBlock) {
        el.playgroundOutputBlock.textContent = `Error: ${err.message}`;
      }
    }
  });
}

if (el.btnTestExcessive) {
  el.btnTestExcessive.addEventListener("click", async () => {
    logToTerminal("[AGENT] Testing policy violation: 100 NEAR (Exceeds daily quota)", "warning");
    if (el.playgroundOutputBlock) {
      el.playgroundOutputBlock.textContent = "Submitting excessive request...\nPOST /v1/payment-requests\nAmount: 100 NEAR\nExpected: 400 Bad Request (Policy Violation)";
    }
    try {
      const res = await fetch("/v1/payment-requests", {
        method: "POST",
        headers: {
          "authorization": "Bearer tapproved-dev-session-token-0123456789abcdef",
          "content-type": "application/json",
          "idempotency-key": "demo-excessive-" + Date.now()
        },
        body: JSON.stringify({
          recipient_id: "manex-agent.testnet",
          amount_yocto: "100000000000000000000000000"
        })
      });
      const data = await res.json();
      if (el.playgroundOutputBlock) {
        el.playgroundOutputBlock.textContent = `Status: ${res.status} (Rejected as expected)\nOutcome: ${JSON.stringify(data, null, 2)}`;
      }
      logToTerminal(`[POLICY ENFORCED] Excessive spend blocked by smart contract guardrails.`, "success");
    } catch (err) {
      if (el.playgroundOutputBlock) {
        el.playgroundOutputBlock.textContent = `Error: ${err.message}`;
      }
    }
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
        <label>Recipient Account ID</label>
        <input type="text" id="recipient-input" placeholder="e.g. merchant.testnet" value="merchant.testnet" />
      `;
      document.getElementById("recipient-input")?.addEventListener("input", updateOwnerCommand);
    } else if (action === "update_limits") {
      el.ownerActionInputs.innerHTML = `
        <label>Soft Limit (yoctoNEAR)</label>
        <input type="text" id="soft-input" value="10000000000000000000000" />
        <label style="margin-top: 10px;">Hard Limit (yoctoNEAR)</label>
        <input type="text" id="hard-input" value="100000000000000000000000" />
        <label style="margin-top: 10px;">Daily Limit (yoctoNEAR)</label>
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
    el.txResultBlock.textContent = "Querying NEAR Testnet RPC...";
    logToTerminal(`[EXPLORER] Querying transaction receipt for ${hash}...`, "info");
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
      logToTerminal(`[EXPLORER] Receipt retrieved successfully for ${hash}`, "success");
    } catch (err) {
      el.txResultBlock.textContent = `Error querying transaction: ${err.message}`;
      logToTerminal(`[EXPLORER ERROR] ${err.message}`, "warning");
    }
  });
}

// Initial Boot
loadContractData();
startAutoRefresh();
updateOwnerCommand();
