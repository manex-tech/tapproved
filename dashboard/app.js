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
  activePaymentCard: document.getElementById("active-payment-status"),
  deviceStatus: document.getElementById("device-status"),
  pendingAlert: document.getElementById("pending-approval-alert"),
  pendingAlertText: document.getElementById("pending-approval-text"),
  pendingTimeRemaining: document.getElementById("pending-time-remaining"),
  paymentsTableBody: document.getElementById("payments-table-body"),
  policyOwner: document.getElementById("policy-owner"),
  policyAgent: document.getElementById("policy-agent"),
  policySoftLimit: document.getElementById("policy-soft-limit"),
  policyHardLimit: document.getElementById("policy-hard-limit"),
  policyDailyLimit: document.getElementById("policy-daily-limit"),
  policyPaused: document.getElementById("policy-paused"),
  policyRecipientsList: document.getElementById("policy-recipients-list"),
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
  txResultBlock: document.getElementById("tx-result-block")
};

async function loadContractData() {
  try {
    // 1. Fetch Policy
    const policy = await queryContractView(state.rpcUrl, state.contractId, "get_policy");
    state.policy = policy;

    // 2. Fetch Storage Metrics
    try {
      state.storageMetrics = await queryContractView(state.rpcUrl, state.contractId, "get_storage_metrics");
    } catch (err) {
      // Fallback if not available
      state.storageMetrics = null;
    }

    // 3. Fetch Active Payment
    state.activePayment = await queryContractView(state.rpcUrl, state.contractId, "get_active_payment");

    // 4. Fetch Daily Usage for Today
    const currentDay = Math.floor(Date.now() / 86400000);
    try {
      state.dailyUsage = await queryContractView(state.rpcUrl, state.contractId, "get_daily_usage", { utc_day: currentDay });
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
  }
}

function renderUI() {
  const { policy, storageMetrics, activePayment, dailyUsage, payments } = state;

  // Header and Timestamps
  if (el.lastUpdated) {
    el.lastUpdated.textContent = new Date().toLocaleTimeString();
  }

  // 1. Treasury Balances
  if (storageMetrics) {
    el.treasuryBalance.textContent = formatYoctoNear(storageMetrics.account_balance_yocto, 4);
    el.availableBalance.textContent = `${formatYoctoNear(storageMetrics.available_balance_yocto, 4)} available`;
    if (el.storageStaked) el.storageStaked.textContent = formatYoctoNear(storageMetrics.required_storage_balance_yocto, 4);
    if (el.storageUsage) el.storageUsage.textContent = `${storageMetrics.storage_usage_bytes} bytes`;
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
  }

  // 3. Active / Pending Payment Card & Alert
  if (activePayment) {
    el.activePaymentCard.textContent = `Payment #${activePayment.id} (${activePayment.status})`;

    if (activePayment.status === "pending") {
      el.pendingAlert.classList.add("active");
      el.pendingAlertText.textContent = `Payment #${activePayment.id} for ${formatYoctoNear(activePayment.amount_yocto, 4)} to ${activePayment.recipient_id} requires human approval.`;

      const nowNs = BigInt(Date.now()) * 1_000_000n;
      const expireNs = BigInt(activePayment.expires_at_ns);
      const remainingMs = Number((expireNs - nowNs) / 1_000_000n);
      if (remainingMs > 0) {
        const remainingSec = Math.floor(remainingMs / 1000);
        el.pendingTimeRemaining.textContent = `Expires in ${remainingSec}s — Press GPIO25 button on ESP32 to authorize.`;
      } else {
        el.pendingTimeRemaining.textContent = "Window expired. Ready for keeper expiry.";
      }
    } else {
      el.pendingAlert.classList.remove("active");
    }
  } else {
    el.activePaymentCard.textContent = "None (Idle)";
    el.pendingAlert.classList.remove("active");
  }

  // 4. Device Status
  if (policy) {
    el.deviceStatus.textContent = "Online / Registered";
  }

  // 5. Policy Details
  if (policy) {
    if (el.policyOwner) el.policyOwner.textContent = policy.owner_id;
    if (el.policyAgent) el.policyAgent.textContent = policy.agent_id;
    if (el.policySoftLimit) el.policySoftLimit.textContent = formatYoctoNear(policy.soft_limit_yocto, 4);
    if (el.policyHardLimit) el.policyHardLimit.textContent = formatYoctoNear(policy.hard_limit_yocto, 4);
    if (el.policyDailyLimit) el.policyDailyLimit.textContent = formatYoctoNear(policy.daily_limit_yocto, 4);
    if (el.policyPaused) el.policyPaused.textContent = policy.paused ? "PAUSED (Alert)" : "Active (Normal)";

    if (el.policyRecipientsList) {
      el.policyRecipientsList.innerHTML = policy.allowed_recipients
        .map((r) => `<span class="badge badge-approved" style="margin-right: 6px; margin-bottom: 6px;">${r}</span>`)
        .join("");
    }
  }

  // 6. Payments Table
  if (el.paymentsTableBody) {
    if (payments.length === 0) {
      el.paymentsTableBody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: var(--text-muted);">No payment records found</td></tr>`;
    } else {
      el.paymentsTableBody.innerHTML = payments
        .map((p) => {
          const statusClass = `badge-${p.status}`;
          const hwBadge = p.hardware_approved ? `<span class="badge badge-hw">ESP32 Signed</span>` : "";
          const createdTime = p.created_at_ns ? new Date(Number(BigInt(p.created_at_ns) / 1_000_000n)).toLocaleString() : "-";
          return `
            <tr>
              <td><strong>#${p.id}</strong></td>
              <td>${p.recipient_id}</td>
              <td><strong>${formatYoctoNear(p.amount_yocto, 4)}</strong></td>
              <td><span class="badge ${statusClass}">${p.status}</span>${hwBadge}</td>
              <td>${p.agent_id}</td>
              <td>${createdTime}</td>
              <td><code>${p.nonce}</code></td>
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
    loadContractData();
  });
}

// Auto refresh
if (el.autoRefreshToggle) {
  el.autoRefreshToggle.addEventListener("change", (e) => {
    state.autoRefresh = e.target.checked;
    if (state.autoRefresh) {
      startAutoRefresh();
    } else if (state.refreshTimer) {
      clearInterval(state.refreshTimer);
      state.refreshTimer = null;
    }
  });
}

function startAutoRefresh() {
  if (state.refreshTimer) clearInterval(state.refreshTimer);
  state.refreshTimer = setInterval(() => {
    if (state.autoRefresh) loadContractData();
  }, 5000);
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
    } catch (err) {
      el.txResultBlock.textContent = `Error querying transaction: ${err.message}`;
    }
  });
}

// Initial Boot
loadContractData();
startAutoRefresh();
updateOwnerCommand();
