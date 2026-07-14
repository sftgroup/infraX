// Dashboard — Service Status Overview
async function ncDash() {
  var walletAddr = user().walletAddress;
  var addrEl = document.getElementById("dash-wallet");
  if (addrEl) addrEl.textContent = walletAddr ? fmtAddrLong(walletAddr) : "—";

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
    if (me.waas && me.waas.status === "active") {
      activeCount++;
      waasPlan = me.waas.planName || "Starter";
      setDashRow("waas", "active", waasPlan, "API Key: " + (me.waas.apiKey ? me.waas.apiKey.slice(0,14) + "…" : "—"));
    } else {
      setDashRow("waas", "inactive", "—", "Activate in WaaS tab");
    }

    // Vault / Safe
    if (me.safe && me.safe.count > 0) {
      activeCount++;
      setDashRow("safe", "active", "Free", me.safe.count + " safe(s)");
    } else {
      setDashRow("safe", "inactive", "—", "Create in Vault tab");
    }

    // DC
    try {
      var dcUsage = await afetch("/api/v2/data/usage", { auth: "wallet" });
      if (dcUsage && dcUsage.planId) {
        activeCount++;
        var dcPlanName = dcUsage.planName || "Data Free";
        setDashRow("dc", "active", dcPlanName, (dcUsage.currentUsage || 0) + "/" + (dcUsage.monthlyQuota || 0) + " calls");
        var usageEl = document.getElementById("dash-usage");
        if (usageEl) {
          usageEl.innerHTML = "<table class=\"data-table\"><thead><tr><th>Service</th><th>Plan</th><th>Used</th><th>Quota</th></tr></thead><tbody>" +
            "<tr><td>📡 Data Center</td><td>" + dcPlanName + "</td><td>" + (dcUsage.currentUsage||0) + "</td><td>" + (dcUsage.monthlyQuota||0) + "</td></tr>" +
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

    // KPI cards
    var countEl = document.getElementById("dash-active-count");
    if (countEl) countEl.textContent = activeCount + "/5";
    var dcPlanEl = document.getElementById("dash-dc-plan");
    if (dcPlanEl) {
      try { var du = await afetch("/api/v2/data/usage", { auth: "wallet" }); dcPlanEl.textContent = du && du.planName ? du.planName : "—"; } catch(e) { dcPlanEl.textContent = "—"; }
    }
    var waasPlanEl = document.getElementById("dash-waas-plan");
    if (waasPlanEl) waasPlanEl.textContent = waasPlan;

    // Topbar dot
    var dotEl = document.getElementById("topbar-wallet-dot");
    if (dotEl) dotEl.className = "topbar-wallet-dot connected";

  } catch(e) {
    console.error("Dashboard init failed:", e);
  }
}

function setDashRow(svc, status, plan, detail) {
  var row = document.getElementById("dash-row-" + svc);
  if (!row) return;
  var label = row.children[0] ? row.children[0].textContent : svc;
  row.innerHTML = "<td>" + label + "</td>" +
    "<td><span class=\"status " + status + "\">" + (status==="active"?"🟢 Active":"○ Inactive") + "</span></td>" +
    "<td>" + plan + "</td>" +
    "<td class=\"mono\" style=\"font-size:12px\">" + detail + "</td>";
}

// Stubs
function ncSendLoad(){}
function ncReceiveLoad(){}
function ncHistory(){}
function ncCopyAddr(){}
