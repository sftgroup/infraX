// Dashboard — Service Status Overview
async function ncDash() {
  var walletAddr = user().walletAddress;
  var addrEl = document.getElementById("dash-wallet");
  if (addrEl) addrEl.textContent = walletAddr ? fmtAddrLong(walletAddr) : "—";

  if (!walletAddr) {
    document.getElementById("dash-active-count").textContent = "0/4";
    document.getElementById("dash-dc-plan").textContent = "—";
    document.getElementById("dash-waas-plan").textContent = "—";
    document.getElementById("dash-services-body").innerHTML =
      '<tr><td colspan="4" style="text-align:center;padding:40px">' +
      '<div style="font-size:48px;margin-bottom:12px">🔌</div>' +
      '<div style="font-size:16px;color:var(--gold-light);margin-bottom:8px">Connect wallet to view services</div>' +
      '<a href="/connect.html" style="color:var(--gold);font-size:14px">→ Go to Connect</a>' +
      '</td></tr>';
    return;
  }

  try {
    // afetch() already unwraps .data → fields are direct on response
    var me = await getMe();
    var activeCount = 0;
    var waasPlan = "—";
    var dcPlanName = "—";

    // MPC — {registered, walletAddress, email, ...}
    if (me.mpc && me.mpc.registered) {
      activeCount++;
      setDashRow("mpc", "active", "Free", "Wallet: " + fmtAddr(me.mpc.walletAddress));
    } else {
      setDashRow("mpc", "inactive", "—", "Activate in MPC tab");
    }

    // WaaS — {status, planName, apiKey, ...}
    if (me.waas && me.waas.status === "active") {
      activeCount++;
      waasPlan = me.waas.planName || "Starter";
      var keySnippet = me.waas.apiKey ? me.waas.apiKey.slice(0, 14) + "…" : "—";
      setDashRow("waas", "active", waasPlan, "API Key: " + keySnippet);
    } else {
      setDashRow("waas", "inactive", "—", "Activate in WaaS tab");
    }

    // Vault — {enabled, count}
    if (me.safe && me.safe.count > 0) {
      activeCount++;
      setDashRow("safe", "active", "Free", me.safe.count + " safe(s)");
    } else {
      setDashRow("safe", "inactive", "—", "Create in Vault tab");
    }

    // DC — {planId, planName, currentUsage, monthlyQuota, ...}
    // auth: 'none' because afetch always sends x-wallet-address header
    try {
      var dcResp = await afetch("/api/v2/data/usage", { auth: "none" });
      if (dcResp && dcResp.planId) {
        activeCount++;
        dcPlanName = dcResp.planName || "Data Free";
        setDashRow("dc", "active", dcPlanName,
          (dcResp.currentUsage || 0) + "/" + (dcResp.monthlyQuota || 0) + " calls");

        document.getElementById("dash-usage").innerHTML =
          '<table class="data-table"><thead><tr><th>Service</th><th>Plan</th><th>Used</th><th>Quota</th></tr></thead><tbody>' +
          '<tr><td>📡 Data Center</td><td>' + dcPlanName + '</td><td>' + (dcResp.currentUsage || 0) + '</td><td>' + (dcResp.monthlyQuota || 0) + '</td></tr>' +
          '<tr><td>🔑 MPC</td><td>Free</td><td>1 wallet</td><td>5 wallets</td></tr>' +
          '<tr><td>🏦 WaaS</td><td>' + waasPlan + '</td><td>1 tenant</td><td>—</td></tr>' +
          '</tbody></table>';
      } else {
        setDashRow("dc", "inactive", "—", "Subscribe in DC tab");
      }
    } catch (e) {
      setDashRow("dc", "inactive", "—", "Subscribe in DC tab");
    }

    // KPI cards
    document.getElementById("dash-active-count").textContent = activeCount + "/4";
    document.getElementById("dash-dc-plan").textContent = dcPlanName;
    document.getElementById("dash-waas-plan").textContent = waasPlan;

    var dotEl = document.getElementById("topbar-wallet-dot");
    if (dotEl) dotEl.className = "topbar-wallet-dot connected";

  } catch (e) {
    console.error("Dashboard init failed:", e);
  }
}

function setDashRow(svc, status, plan, detail) {
  var row = document.getElementById("dash-row-" + svc);
  if (!row) return;
  var label = row.children[0] ? row.children[0].textContent : svc;
  row.innerHTML = "<td>" + label + "</td>" +
    "<td><span class=\"status " + status + "\">" + (status === "active" ? "🟢 Active" : "○ Inactive") + "</span></td>" +
    "<td>" + plan + "</td>" +
    "<td class=\"mono\" style=\"font-size:12px\">" + detail + "</td>";
}

function ncSendLoad(){}
function ncReceiveLoad(){}
function ncHistory(){}
function ncCopyAddr(){}
