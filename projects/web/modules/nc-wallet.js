// Dashboard — Service Status Overview
async function ncDash() {
  var walletAddr = user().walletAddress;
  
  // No wallet connected — show connect prompt
  if (!walletAddr) {
    document.getElementById("dash-wallet").textContent = "—";
    document.getElementById("dash-active-count").textContent = "0/5";
    document.getElementById("dash-dc-plan").textContent = "—";
    document.getElementById("dash-waas-plan").textContent = "—";
    document.getElementById("dash-services-body").innerHTML = '<tr><td colspan="4" style="text-align:center;padding:40px">' +
      '<div style="font-size:48px;margin-bottom:12px">🔌</div>' +
      '<div style="font-size:16px;color:var(--gold-light);margin-bottom:8px">Connect your wallet to view services</div>' +
      '<a href="/connect.html" style="color:var(--gold);font-size:14px">→ Go to Connect</a>' +
      '</td></tr>';
    document.getElementById("dash-usage").innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted)">Connect wallet to view usage</div>';
    return;
  }

  var addrEl = document.getElementById("dash-wallet");
  if (addrEl) addrEl.textContent = fmtAddrLong(walletAddr);

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

    // Vault
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
        document.getElementById("dash-usage").innerHTML = "<table class=\"data-table\"><thead><tr><th>Service</th><th>Plan</th><th>Used</th><th>Quota</th></tr></thead><tbody>" +
          "<tr><td>📡 Data Center</td><td>" + dcPlanName + "</td><td>" + (dcUsage.currentUsage||0) + "</td><td>" + (dcUsage.monthlyQuota||0) + "</td></tr>" +
          "<tr><td>🔑 MPC</td><td>Free</td><td>1 wallet</td><td>5 wallets</td></tr>" +
          "<tr><td>🏦 WaaS</td><td>" + waasPlan + "</td><td>1 tenant</td><td>—</td></tr>" +
          "</tbody></table>";
      } else {
        setDashRow("dc", "inactive", "—", "Subscribe in DC tab");
      }
    } catch(e) {
      setDashRow("dc", "inactive", "—", "Subscribe in DC tab");
    }

    // Payment
    setDashRow("payment", "inactive", "—", "Coming soon");

    // KPIs
    document.getElementById("dash-active-count").textContent = activeCount + "/5";
    document.getElementById("dash-dc-plan").textContent = dcPlanName || "—";
    document.getElementById("dash-waas-plan").textContent = waasPlan;

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
  var label = row.children[0] ? row.children[0].textContent : svc;
  row.innerHTML = "<td>" + label + "</td>" +
    "<td><span class=\"status " + status + "\">" + (status==="active"?"🟢 Active":"○ Inactive") + "</span></td>" +
    "<td>" + plan + "</td>" +
    "<td class=\"mono\" style=\"font-size:12px\">" + detail + "</td>";
}

function ncSendLoad(){}
function ncReceiveLoad(){}
function ncHistory(){}
function ncCopyAddr(){}
