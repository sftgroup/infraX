// Dashboard — Service Status Overview (replaces NC Wallet)
async function ncDash() {
  // Top bar
  var walletAddr = user().walletAddress;
  var addrEl = document.getElementById("dash-wallet");
  if (addrEl) addrEl.textContent = walletAddr ? fmtAddrLong(walletAddr) : "—";

  // Load all service statuses in parallel
  try {
    var me = await getMe();
    var activeCount = 0;

    // MPC
    if (me.mpc && me.mpc.walletAddress) {
      activeCount++;
      setDashRow("mpc", "active", "Free", me.mpc.walletAddress);
    } else {
      setDashRow("mpc", "inactive", "—", "Activate in MPC tab");
    }

    // WaaS
    var waasPlan = "—";
    if (me.waas && me.waas.planId) {
      activeCount++;
      waasPlan = me.waas.planId === "pro" ? "Pro" : me.waas.planId === "enterprise" ? "Enterprise" : "Starter";
      setDashRow("waas", "active", waasPlan, "API Key: " + (me.waas.apiKey ? me.waas.apiKey.slice(0,14) + "…" : "—"));
    } else {
      setDashRow("waas", "inactive", "—", "Activate in WaaS tab");
    }

    // Vault / Safe
    if (me.safe && me.safe.wallets > 0) {
      activeCount++;
      setDashRow("safe", "active", "Free", me.safe.wallets + " wallets, " + (me.safe.transactions || 0) + " txns");
    } else {
      setDashRow("safe", "inactive", "—", "Create in Vault tab");
    }

    // DC
    try {
      var dcUsage = await afetch("/api/v2/data/usage", { auth: "none" });
      if (dcUsage && dcUsage.planId) {
        activeCount++;
        var dcPlanName = dcUsage.planId === "data_pro" ? "Data Pro" : dcUsage.planId === "data_enterprise" ? "Data Enterprise" : "Data Free";
        setDashRow("dc", "active", dcPlanName, (dcUsage.currentUsage || 0) + "/" + (dcUsage.monthlyQuota || 0) + " calls");
        // Usage detail
        var usageEl = document.getElementById("dash-usage");
        if (usageEl) {
          usageEl.innerHTML = "<table class=\"data-table\"><thead><tr><th>Service</th><th>Plan</th><th>Used</th><th>Quota</th></tr></thead><tbody>" +
            "<tr><td>📡 Data Center</td><td>" + dcPlanName + "</td><td>" + (dcUsage.currentUsage || 0) + "</td><td>" + (dcUsage.monthlyQuota || 0) + "</td></tr>" +
            "<tr><td>🔑 MPC</td><td>Free</td><td>1 wallet</td><td>5 wallets</td></tr>" +
            "<tr><td>🏦 WaaS</td><td>" + waasPlan + "</td><td>1 tenant</td><td>—</td></tr>" +
            "</tbody></table>";
        }
      } else {
        setDashRow("dc", "inactive", "—", "Subscribe in DC tab");
      }
    } catch(e) {
      setDashRow("dc", "inactive", "—", "Subscribe in DC tab");
    }

    // Payment
    setDashRow("payment", "inactive", "—", "Coming soon");

    // Update KPIs
    var countEl = document.getElementById("dash-active-count");
    if (countEl) countEl.textContent = activeCount + "/5";
    var dcPlanEl = document.getElementById("dash-dc-plan");
    if (dcPlanEl) {
      try { var du = await afetch("/api/v2/data/usage", { auth: "none" }); dcPlanEl.textContent = du && du.planId ? (du.planId==="data_pro"?"Data Pro":du.planId==="data_enterprise"?"Data Enterprise":"Data Free") : "—"; } catch(e) { dcPlanEl.textContent = "—"; }
    }
    var waasPlanEl = document.getElementById("dash-waas-plan");
    if (waasPlanEl) waasPlanEl.textContent = waasPlan;

    // Topbar
    var dotEl = document.getElementById("topbar-wallet-dot");
    if (dotEl) dotEl.className = "topbar-wallet-dot connected";

  } catch(e) {
    console.error("Dashboard init failed:", e);
  }
}

function setDashRow(svc, status, plan, detail) {
  var row = document.getElementById("dash-row-" + svc);
  if (!row) return;
  row.innerHTML = "<td>" + row.children[0].textContent + "</td>" +
    "<td><span class=\"status " + status + "\">" + (status === "active" ? "🟢 Active" : "○ Inactive") + "</span></td>" +
    "<td>" + plan + "</td>" +
    "<td class=\"mono\" style=\"font-size:12px\">" + detail + "</td>";
}

function setHtml(id, html) {
  var el = document.getElementById(id);
  if (el) el.innerHTML = html;
}

// Stubs — Dashboard replaced NC wallet, these no-ops prevent undefined errors
function ncSendLoad(){}
function ncReceiveLoad(){}
function ncHistory(){}
function ncCopyAddr(){}
