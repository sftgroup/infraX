// MODULE 1: Non-Custodial Wallet — Dashboard Panel
// NC is a thin dashboard: connect wallet → sign → show balance + module gateways

async function ncDash() {
  var grid = document.getElementById("nc-kpi"); if (!grid) return;
  var assetBody = document.getElementById("nc-assets-body");
  grid.innerHTML = "<div class=\"kpi\"><div class=\"kpi-label\">Total Balance</div><div class=\"kpi-val gold\"><span id=\"nc-total-native\">—</span> ETH</div></div>";

  var walletAddr = user().walletAddress;
  var chains = ["sepolia","eth","bsc","base"];
  var labels = {sepolia:"Sepolia",eth:"Ethereum",bsc:"BSC",base:"Base"};
  var rows = {};
  var total = 0;
  var loaded = 0;
  
  // Render placeholder rows immediately
  var html = "";
  chains.forEach(function(c){ 
    html += "<tr id=\"nc-row-" + c + "\"><td><span style=\"color:var(--gold-light);font-weight:600\">" + (labels[c]||c) + "</span></td>" +
      "<td class=\"mono\"><div class=\"spin\"></div></td><td class=\"num\">" + (labels[c]||c) + "</td>" +
      "<td><span class=\"status\">loading</span></td></tr>";
  });
  assetBody.innerHTML = html;
  document.getElementById("nc-stat-chains").innerHTML = "<b>" + chains.length + "</b> chains";
  document.getElementById("nc-stat-tokens").innerHTML = "<b>4</b> chains queried";
  
  // Update topbar
  var addrEl = document.getElementById("topbar-wallet-addr");
  if (addrEl) addrEl.textContent = fmtAddrLong(walletAddr);

  // Fetch each chain balance individually — render as they arrive
  chains.forEach(function(c){
    afetch("/api/v2/data/balance?address=" + encodeURIComponent(walletAddr) + "&chain=" + c)
      .then(function(d){
        var bal = (d.chainBalances && d.chainBalances[0]) ? parseFloat(d.chainBalances[0].balance||0) : 0;
        var err = (d.chainBalances && d.chainBalances[0]) ? d.chainBalances[0].error : null;
        rows[c] = bal;
        total += bal;
        loaded++;
        
        // Update row
        var row = document.getElementById("nc-row-" + c);
        if (row) {
          row.innerHTML = "<td><span style=\"color:var(--gold-light);font-weight:600\">" + (labels[c]||c) + "</span></td>" +
            "<td class=\"mono\">" + bal.toFixed(6) + "</td>" +
            "<td class=\"num\">" + (labels[c]||c) + "</td>" +
            "<td><span class=\"status success\">" + (err ? "error" : "live") + "</span></td>";
        }
        document.getElementById("nc-total-native").textContent = total.toFixed(6);
        if (loaded === chains.length) {
          document.getElementById("nc-big-balance").textContent = total.toFixed(6) + " ETH";
          document.getElementById("nc-big-sub").innerHTML = "<span class=\"pos\">All chains</span> · via InfraX DC";
        }
      })
      .catch(function(e){
        loaded++;
        console.warn("NC balance fetch failed for", c, e.message);
      });
  });
}






function ncReceiveLoad() {
  var addrVal = getOrCreateAddr();
  document.getElementById('nc-recv-full').textContent = addrVal;
  var qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=' + encodeURIComponent('ethereum:' + addrVal);
  ncLoadQRToCanvas(qrUrl, 'nc-recv-qr');
}

function ncLoadQRToCanvas(url, canvasId) {
  var canvas = document.getElementById(canvasId);
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  var img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = function() {
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    canvas.style.display = 'block';
    var fb = document.getElementById('nc-recv-qr-fallback');
    if (fb) fb.style.display = 'none';
  };
  img.onerror = function() {
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#000'; ctx.font = 'bold 18px monospace';
    ctx.fillText('Scan to Pay', 20, 60);
    ctx.font = '11px monospace';
    var addr = getOrCreateAddr();
    var lines = [addr.slice(0,20), addr.slice(20,40), addr.slice(40,42)];
    lines.forEach(function(l, i) { ctx.fillText(l, 15, 90 + i * 16); });
    canvas.style.display = 'block';
    var fb = document.getElementById('nc-recv-qr-fallback');
    if (fb) fb.style.display = 'none';
  };
  img.src = url;
}

function ncCopyAddr() { copyText(getOrCreateAddr()); }

async function ncSettings() {
  var addr = (user().walletAddress || '');
  var m = await getMe() || {};
  var mpcAddr = (m.mpc && m.mpc.walletAddress) ? m.mpc.walletAddress : '';
  var mpcStatus = mpcAddr ? '🟢 Activated — ' + fmtAddrLong(mpcAddr) : '⚪ Not activated';
  var mpcStyle = mpcAddr ? 'color:var(--success)' : 'color:var(--text-tertiary)';

  var safeOn = (m.safe && m.safe.enabled);
  var safeStatus = safeOn ? '🟢 Enabled — see Safe Vault page for details' : '⚪ Not enabled';
  var safeStyle = safeOn ? 'color:var(--success)' : 'color:var(--text-tertiary)';

  var planNames = { free: 'Free Trial', pro: 'Pro', enterprise: 'Enterprise' };
  var waasOn = (m.waas && m.waas.activated);
  var waasPlan = waasOn ? (m.waas.plan || 'free') : '';
  var waasStatus = waasOn ? '🟢 Activated — ' + (planNames[waasPlan] || waasPlan || 'Free Trial') : '⚪ Not activated';
  var waasStyle = waasOn ? 'color:var(--success)' : 'color:var(--text-tertiary)';

  var dcOn = false, dcPlanName = '', dcApiKey = '', dcPlanId = '', dcQuota = 0, dcUsage = 0;
  try {
    var dcResp = await afetch('/api/v2/data/usage', { auth: 'none' });
    if (dcResp && dcResp.dcApiKey) {
      dcOn = true;
      dcPlanName = dcResp.planName || dcResp.planId;
      dcPlanId = dcResp.planId || '';
      dcApiKey = dcResp.dcApiKey;
      dcQuota = dcResp.monthlyQuota || 0;
      dcUsage = dcResp.currentUsage || 0;
    }
  } catch (e) {}
  var dcStatus = dcOn ? '🟢 Activated — ' + dcPlanName : '⚪ Not activated';
  var dcStyle = dcOn ? 'color:var(--success)' : 'color:var(--text-tertiary)';
  var dcDetail = dcOn
    ? '<div style="margin-top:8px;font-size:12px;line-height:1.8;">' +
      '<div style="color:var(--text-secondary);">📋 API Key</div>' +
      '<div class="mono" style="background:var(--bg);padding:6px 10px;border-radius:6px;margin:4px 0;font-size:11px;word-break:break-all;">' + dcApiKey + '</div>' +
      '<div style="display:flex;gap:16px;margin-top:6px;">' +
      '<div><span style="color:var(--text-tertiary);">Plan</span> ' + (dcPlanName || dcPlanId) + '</div>' +
      '<div><span style="color:var(--text-tertiary);">Usage</span> ' + dcUsage.toLocaleString() + ' / ' + (dcQuota ? dcQuota.toLocaleString() : '∞') + '</div>' +
      '</div></div>'
    : '';

  document.getElementById('nc-settings-body').innerHTML =
    '<div class="setting-row"><div><div class="setting-label">Connected Wallet</div><div class="setting-desc mono" style="word-break:break-all">' + (addr ? '<span class="addr-pill" style="color:var(--brand)">' + addr + '</span>' : 'Not connected') + '</div></div></div>' +
    '<div class="setting-row"><div><div class="setting-label">MPC Wallet</div><div class="setting-desc"><span style="' + mpcStyle + '">' + mpcStatus + '</span> — Free tier (3 wallets)</div></div></div>' +
    '<div class="setting-row"><div><div class="setting-label">Safe Vault</div><div class="setting-desc"><span style="' + safeStyle + '">' + safeStatus + '</span> — First 3 vaults free</div></div></div>' +
    '<div class="setting-row"><div><div class="setting-label">WaaS B2B</div><div class="setting-desc"><span style="' + waasStyle + '">' + waasStatus + '</span> — Tenant ID: ' + (typeof waasTenantId !== 'undefined' && waasTenantId ? waasTenantId.slice(0,8) + '…' : '—') + '</div></div></div>' +
    '<div class="setting-row"><div><div class="setting-label">Data Center</div><div class="setting-desc"><span style="' + dcStyle + '">' + dcStatus + '</span> — B2B on-chain data API</div></div>' + dcDetail + '</div>' +
    '<div class="setting-row"><div><div class="setting-label">Network</div><div class="setting-desc">Currently on Sepolia Testnet</div></div><span class="addr-pill" style="color:var(--success)">🟢 Sepolia</span></div>';
}
