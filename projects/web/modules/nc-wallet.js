// Dashboard — Service Status Overview
async function ncDash() {
  var walletAddr = user().walletAddress;
  var addrEl = document.getElementById("dash-wallet");
  if (addrEl) addrEl.textContent = walletAddr ? fmtAddrLong(walletAddr) : "—";

  if (!walletAddr) {
    document.getElementById("dash-active-count").textContent = "0/6";
    document.getElementById("dash-dc-plan").textContent = "—";
    document.getElementById("dash-waas-plan").textContent = "—";
    document.getElementById("dash-services-body").innerHTML =
      '<tr><td colspan="4" style="text-align:center;padding:40px">' +
      '<div style="font-size:48px;margin-bottom:12px">🔌</div>' +
      '<div style="font-size:16px;color:var(--gold-light);margin-bottom:8px">Connect wallet to view services</div>' +
      '<a href="/connect.html" style="color:var(--gold);font-size:14px">→ Go to Connect</a>' +
      '</td></tr>';
    var uEl = document.getElementById("dash-usage");
    if (uEl) uEl.innerHTML = '<div style="text-align:center;padding:16px;color:var(--text-muted);font-size:13px">🔌 Connect wallet to view usage</div>';
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
        setDashRow("dc", "active", dcPlanName, "Insights · On-Chain · Market Data");
      } else {
        setDashRow("dc", "inactive", "—", "Subscribe in DC tab");
      }
    } catch (e) {
      setDashRow("dc", "inactive", "—", "Subscribe in DC tab");
    }

    // B2B API Services — 独立服务健康状态（非订阅型，无需激活）；健康即计入 Active Services
    var healthActive = 0;
    (async function () {
      // Chain RPC :9130（/api/v2/rpc → chain-rpc 反代）
      try {
        var rpcResp = await fetch("/api/v2/rpc/health");
        setDashHealthRow("rpc", rpcResp.ok, "rx_ key", "rpc-gw.0xainet.top · JSON-RPC");
        if (rpcResp.ok) healthActive++;
      } catch (e) { setDashHealthRow("rpc", false, "—", "Unreachable"); }
      // LightRAG :9721（/api/rag → ragservicer）
      try {
        var ragResp = await fetch("/api/rag/api/v1/health");
        setDashHealthRow("lightrag", ragResp.ok, "lr_ key", "/api/rag · 知识图谱 RAG");
        if (ragResp.ok) healthActive++;
      } catch (e) { setDashHealthRow("lightrag", false, "—", "Unreachable"); }
      var kpiEl = document.getElementById("dash-active-count");
      if (kpiEl) kpiEl.textContent = (activeCount + healthActive) + "/6";
    })();

    // A-9: 统一租户用量视图——聚合各产品线真实配额/余额（计费仍 per-product 分离，仅展示聚合）
    var usageRows = [];

    // 1) Data Center — 订阅用量（plan/quota/used）
    try {
      var dcU = await afetch("/api/v2/data/usage", { auth: "none" });
      usageRows.push(dcU && dcU.planId
        ? ['📡 Data Center', dcU.planName || 'Data Free', (dcU.currentUsage || 0) + '', (dcU.monthlyQuota || 0) + ' calls']
        : ['📡 Data Center', '—', '—', '未订阅']);
    } catch (e) { usageRows.push(['📡 Data Center', '—', '—', '不可用']); }

    // 2) MPC — 价目公开（ledger 余额需会话 token，面板不持 token 故只展示模式）
    try {
      var mpcP = await afetch("/api/v2/mpc/plans", { auth: "none" });
      usageRows.push(['🔐 MPC Wallet', mpcP && mpcP.mode === 'metered' ? '按量计费' : 'Free',
        '—', (mpcP && mpcP.configured) ? 'ledger 按量' : '免费']);
    } catch (e) { usageRows.push(['🔐 MPC Wallet', 'Free', '—', '—']); }

    // 3) WaaS — 订阅套餐
    var waasPlanName = (me.waas && me.waas.status === "active") ? (me.waas.planName || "Starter") : "—";
    usageRows.push(['🏦 WaaS', waasPlanName, '—', (me.waas && me.waas.status === "active") ? 'API Key 计费' : '未激活']);

    // 4) Safe Vault — gas 自付 ledger 余额（subscriber = 钱包地址）
    try {
      var vPlans = await afetch("/api/vault/plans", { auth: "none" });
      var vBal = null;
      try { vBal = await afetch("/api/vault/ledger-balance", { method: "POST", auth: "none", body: { userId: walletAddr } }); } catch (e) {}
      usageRows.push(['🛡️ Safe Vault', 'gas 自付',
        vBal && vBal.balance ? vBal.balance + ' ETH' : '—',
        (vPlans && vPlans.configured) ? '实际 gas 结算' : '免费']);
    } catch (e) { usageRows.push(['🛡️ Safe Vault', '—', '—', '不可用']); }

    // 5) AA/Session — UserOp 次数费 + paymaster gas 代付（ledger 余额 = 智能账户）
    try {
      var aaP = await afetch("/v1/plans", { auth: "none" });
      var aaBal = null;
      try { aaBal = await afetch("/v1/ledger-balance", { method: "POST", auth: "none", body: { account: walletAddr } }); } catch (e) {}
      usageRows.push(['⚡ Smart Account', (aaP && aaP.mode) || '—',
        aaBal && aaBal.balance ? aaBal.balance + ' ETH' : '—',
        (aaP && aaP.configured) ? '次数 + gas 代付' : '免费']);
    } catch (e) { usageRows.push(['⚡ Smart Account', '—', '—', '不可用']); }

    var rowsHtml = usageRows.map(function (r) {
      return '<tr><td>' + r[0] + '</td><td>' + r[1] + '</td><td>' + r[2] + '</td><td>' + r[3] + '</td></tr>';
    }).join('');
    document.getElementById("dash-usage").innerHTML =
      '<table class="data-table"><thead><tr><th>Service</th><th>Plan</th><th>Used / Balance</th><th>Quota / Billing</th></tr></thead><tbody>' +
      rowsHtml + '</tbody></table>';

    // KPI cards（Active Services 最终计数由上面的健康检查异步块刷新到 /6）
    document.getElementById("dash-active-count").textContent = activeCount + "/6";
    document.getElementById("dash-dc-plan").textContent = dcPlanName;
    document.getElementById("dash-waas-plan").textContent = waasPlan;

    var dotEl = document.getElementById("topbar-wallet-dot");
    if (dotEl) dotEl.className = "topbar-wallet-dot connected";

  } catch (e) {
    var uEl = document.getElementById("dash-usage");
    if (uEl) uEl.innerHTML = '<div style="text-align:center;padding:16px;color:var(--text-muted);font-size:13px">🔌 Connect wallet to view usage</div>';
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

// B2B 独立服务（RPC / LightRAG）：以健康状态呈现，非订阅型
function setDashHealthRow(svc, ok, plan, detail) {
  var row = document.getElementById("dash-row-" + svc);
  if (!row) return;
  var label = row.children[0] ? row.children[0].textContent : svc;
  row.innerHTML = "<td>" + label + "</td>" +
    "<td><span class=\"status " + (ok ? "success" : "failed") + "\">" + (ok ? "🟢 Up" : "🔴 Down") + "</span></td>" +
    "<td>" + plan + "</td>" +
    "<td class=\"mono\" style=\"font-size:12px\">" + detail + "</td>";
}

function ncSendLoad(){}
function ncReceiveLoad(){}
function ncHistory(){}
function ncCopyAddr(){}
