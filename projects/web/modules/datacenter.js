/**
 * InfraX Data Center — B2B On-chain Data API Module
 * Dependencies: core.js, infrax.css
 */

function obscureKey(key) { return key && key.length > 16 ? key.slice(0,14) + '…' + key.slice(-8) : key; }

// ─── State ───────────────────────────────────────────────────────────
let dcPlan = null;
let dcUsage = null;
let dcEventsPageToken = null;

const DC_CHAINS = [
  { name: 'Sepolia', img: '/img/chain-sepolia.svg', color: '#6366f1' },
  { name: 'Ethereum', img: '/img/chain-ethereum.svg', color: '#627eea' },
  { name: 'BSC', img: '/img/chain-bsc.svg', color: '#f0b90b' },
  { name: 'Base', img: '/img/chain-base.svg', color: '#0052ff' },
  { name: 'OxaChain', img: '/img/chain-oxa.svg', color: '#ff6b35' },
];

// ─── Init ────────────────────────────────────────────────────────────
async function dcInit() {
  const sel = document.getElementById('dc-filter-chain');
  if (sel) {
    sel.innerHTML = '<option value="">All Chains</option>' + 
      DC_CHAINS.map(c => '<option value="' + c.name.toLowerCase() + '">' + c.name + '</option>').join('');
  }

  var addr = '';
  try { addr = user().walletAddress || ''; } catch(e) {}

  if (!addr) {
    var intro = document.getElementById('dc-intro');
    if (intro) {
      intro.innerHTML = '<div style="text-align:center;padding:60px">' +
        '<div style="font-size:48px;margin-bottom:12px">🔌</div>' +
        '<div style="font-size:16px;color:var(--gold-light);margin-bottom:8px">Connect wallet to view Data Center</div>' +
        '<a href="/connect.html" style="color:var(--gold);font-size:14px">→ Go to Connect</a></div>';
    }
    return;
  }

  try {
    const ok = await dcRefreshUsage();
    if (ok) {
      // MQ-16 T-1: 付费订阅待支付 → 停留在 intro 并提示等待支付确认
      if (dcUsage.dcSubStatus === 'pending') {
        var sEl = document.getElementById('dc-sub-status');
        if (sEl) sEl.innerHTML = '<span style="color:var(--warning)">⏳ 订阅待支付确认</span> <button class="btn btn-sm btn-primary" onclick="dcRecheckPayment()" style="margin-left:8px">刷新支付状态</button>';
        var ie = document.getElementById('dc-intro');
        var de = document.getElementById('dc-dash');
        if (ie) ie.style.display = 'block';
        if (de) de.style.display = 'none';
      } else {
        await dcLoadDashboard();
      }
      return;
    }
  } catch (e) {
    console.log('dcInit error:', e.message);
  }
  var ie = document.getElementById('dc-intro');
  var de = document.getElementById('dc-dash');
  if (ie) ie.style.display = 'block';
  if (de) de.style.display = 'none';
}

// MQ-16 T-1: 拉取真实用量（plan/quota/usage/订阅状态）并刷新本地状态
async function dcRefreshUsage() {
  var addr = '';
  try { addr = user().walletAddress || ''; } catch(e) {}
  if (!addr) return false;
  const usage = await afetch('/api/v2/data/usage?walletAddress=' + encodeURIComponent(addr), { auth: 'none' });
  if (usage && usage.planId) {
    dcPlan = { id: usage.planId, name: usage.planName };
    dcUsage = usage;
    return true;
  }
  return false;
}

// ─── Subscribe ───────────────────────────────────────────────────────
async function dcSubscribe(planId) {
  const wallet = (typeof user !== 'undefined' && user()?.walletAddress) || '';
  if (!wallet) { showToast('Connect wallet first', 'error'); return; }
  var statusEl = document.getElementById('dc-sub-status');
  function setStatus(html, ok) {
    if (statusEl) statusEl.innerHTML = '<span style="color:' + (ok ? 'var(--success)' : 'var(--error)') + '">' + html + '</span>';
  }
  try {
    const resp = await afetch('/api/v2/data/subscribe', {
      method: 'POST', auth: 'none',
      headers: { 'Content-Type': 'application/json', 'x-wallet-address': wallet },
      body: JSON.stringify({ planId }),
    });
    // MQ-16 T-1: free 套餐直通 active（返回 dcApiKey）；付费套餐走引擎支付流程（pending）
    if (resp.dcSubStatus === 'active' && resp.dcApiKey) {
      setStatus('✅ ' + ((resp.plan && resp.plan.name) || planId) + ' plan activated', true);
      showToast('Data plan activated!', 'success');
      await dcRefreshUsage();
      await dcLoadDashboard();
      return;
    }
    var pay = resp.payment;
    if (!pay) { setStatus('❌ Subscribe failed — please try again', false); showToast('Subscribe failed — please try again', 'error'); return; }
    if (pay.rail === 'chain') {
      var isNative = !pay.payToken || pay.payToken === '0x0000000000000000000000000000000000000000';
      var amount = pay.price !== undefined ? (Number(pay.price) / 1e18).toFixed(4) + ' ' + (isNative ? 'ETH' : pay.payToken) : '';
      setStatus('⏳ 请在钱包中完成链上订阅（chainId ' + pay.chainId + '）<br>' +
        'SubscriptionManager: <code>' + pay.subscriptionManager + '</code><br>' +
        '金额: <b>' + amount + '</b> / ' + (pay.period || 'month') + '<br>' +
        '<small>当前钱包即 subscriber，支付确认后自动生效</small>', true);
      showToast('等待链上支付确认…', 'info');
      dcPollSubscription();
    } else if (pay.rail === 'fiat') {
      setStatus('⏳ 跳转支付页…', true);
      window.location.href = pay.sessionUrl;
    } else if (pay.rail === 'x402') {
      var amountEth = pay.priceWei ? (Number(pay.priceWei) / 1e18).toFixed(4) : '';
      setStatus('⏳ 请向 <code>' + pay.payTo + '</code> 转账 ' + amountEth + ' ETH（' + pay.network + '）<br>' +
        '<small>转账完成后请输入交易哈希（txHash）确认</small>', true);
      showToast('完成转账后提交 txHash', 'info');
      dcSubmitX402(pay.network);
    }
  } catch (e) {
    setStatus('❌ ' + (e.message || 'Network error'), false);
    showToast(e.message || 'Network error', 'error');
  }
}

// MQ-16 T-1: chain rail — 轮询支付状态（payment-check），确认后刷新 dashboard
var dcPollTimer = null;
function dcPollSubscription(timeoutMs) {
  var started = Date.now();
  if (dcPollTimer) { clearInterval(dcPollTimer); dcPollTimer = null; }
  dcPollTimer = setInterval(async function () {
    try {
      var d = await afetch('/api/v2/data/payment-check', { method: 'POST', auth: 'none' });
      if (d.status === 'active') {
        clearInterval(dcPollTimer); dcPollTimer = null;
        await dcRefreshUsage();
        showToast('Data plan activated!', 'success');
        var statusEl = document.getElementById('dc-sub-status');
        if (statusEl) statusEl.innerHTML = '<span style="color:var(--success)">✅ 支付确认，套餐已激活</span>';
        await dcLoadDashboard();
      }
    } catch (_) {}
    if (Date.now() - started > (timeoutMs || 5 * 60 * 1000)) {
      clearInterval(dcPollTimer); dcPollTimer = null;
      var statusEl = document.getElementById('dc-sub-status');
      if (statusEl) statusEl.innerHTML = '<span style="color:var(--error)">⏰ 等待支付超时，请确认已支付后重试</span>';
    }
  }, 4000);
}

// MQ-16 T-1: x402 rail — 提示用户输入链上转账 txHash 并调 /verify 激活订阅
async function dcSubmitX402(network) {
  var txHash = window.prompt('请输入 ' + (network || '链上') + ' 转账的交易哈希（txHash）:');
  if (!txHash) return;
  try {
    var d = await afetch('/api/v2/data/verify', { method: 'POST', auth: 'none', body: { txHash: txHash } });
    if (d.verified && d.activated) {
      showToast('支付已确认，套餐已激活!', 'success');
      await dcRefreshUsage();
      var statusEl = document.getElementById('dc-sub-status');
      if (statusEl) statusEl.innerHTML = '<span style="color:var(--success)">✅ 支付确认，套餐已激活</span>';
      await dcLoadDashboard();
    } else if (d.verified) {
      showToast('支付已确认，但未找到待处理订阅', 'error');
    } else {
      showToast('支付未确认', 'error');
    }
  } catch (e) { showToast(e.message, 'error'); }
}

// MQ-16 T-1: 手动刷新支付状态（pending 态 intro 按钮）
async function dcRecheckPayment() {
  try {
    var d = await afetch('/api/v2/data/payment-check', { method: 'POST', auth: 'none' });
    if (d.status === 'active') {
      await dcRefreshUsage();
      showToast('支付已确认，套餐已激活!', 'success');
      await dcLoadDashboard();
    } else {
      showToast('支付仍在确认中…', 'warning');
    }
  } catch (e) { showToast(e.message, 'error'); }
}

// ─── Load Dashboard ──────────────────────────────────────────────────
async function dcLoadDashboard() {
  var ie = document.getElementById('dc-intro');
  var de = document.getElementById('dc-dash');

  if (dcUsage && dcPlan) {
    if (ie) ie.style.display = 'none';
    if (de) de.style.display = 'block';

    setHtml('dc-plan-name', dcPlan.name + (dcUsage.dcSubStatus && dcUsage.dcSubStatus !== 'active' ? '<br><span style="font-size:11px;color:var(--warning)">' + dcUsage.dcSubStatus + '</span>' : ''));
    setHtml('dc-usage-count', formatNumber(dcUsage.currentUsage || 0));
    setHtml('dc-quota', formatNumber(dcUsage.monthlyQuota || 0));
    var planChains = { data_free: ['Sepolia'], data_pro: ['All 6 chains'], data_enterprise: ['All 6 chains + custom'] };
    setHtml('dc-chains', (planChains[dcPlan.id] || ['—']).join(', '));

    // Chain scan status — card UI
    setHtml('dc-chain-count', DC_CHAINS.length + ' chains');
    setHtml('dc-chain-stats',
      '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px">' +
      DC_CHAINS.map(function(c) {
        return '<div class="chain-card">' +
          '<div class="chain-card-icon"><img src="' + c.img + '" width="36" height="36" alt="' + c.name + '"></div>' +
          '<div class="chain-card-name">' + c.name + '</div>' +
          '<div class="chain-card-status">' +
            '<span class="chain-dot" style="background:#0ecb81"></span> scanning' +
          '</div>' +
          '<div class="chain-card-stats">' +
            '<span class="chain-stat">⛽ 12 Gwei</span>' +
            '<span class="chain-stat">📦 #19.8M</span>' +
          '</div>' +
        '</div>';
      }).join('') +
      '</div>'
    );

    var apiKey = dcUsage?.dcApiKey || '—';
    var ki = document.getElementById('dc-api-key');
    if (ki) ki.value = apiKey;
  } else {
    if (ie) ie.style.display = 'block';
    if (de) de.style.display = 'none';
  }
}

// ─── Explorer ────────────────────────────────────────────────────────
async function dcQueryEvents(pageToken) {
  const chain = document.getElementById('dc-filter-chain')?.value || '';
  const address = document.getElementById('dc-filter-addr')?.value || '';
  const eventType = document.getElementById('dc-filter-type')?.value || '';
  const params = new URLSearchParams();
  if (chain) params.set('chain', chain);
  if (address) params.set('address', address);
  if (eventType) params.set('event_type', eventType);
  params.set('page_size', '20');
  if (pageToken) params.set('page_token', pageToken);
  const tbody = document.getElementById('dc-events-tbody');
  if (tbody) tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:24px">Loading...</td></tr>';
  try {
    const headers = {};
    if (dcUsage && dcUsage.dcApiKey) headers['x-dc-api-key'] = dcUsage.dcApiKey;
    const resp = await afetch('/api/v2/data/events?' + params.toString(), { auth: 'none', headers: headers });
    if (!resp || !resp.data) {
      if (tbody) tbody.innerHTML = '<tr><td colspan="7" style="color:var(--text-muted);text-align:center;padding:24px">No results</td></tr>';
      return;
    }
    const { data, next_page_token } = resp;
    dcEventsPageToken = next_page_token;
    if (!data || data.length === 0) {
      if (tbody) tbody.innerHTML = '<tr><td colspan="7" style="color:var(--text-muted);text-align:center;padding:24px">No events found</td></tr>';
      return;
    }
    if (tbody) {
      tbody.innerHTML = data.map(function(e) {
        var sf = (e.from_address || '').slice(0, 10) + '...';
        var st = (e.to_address || '').slice(0, 10) + '...';
        var sx = (e.tx_hash || '').slice(0, 8) + '...';
        return '<tr><td><span class="dc-chain-badge dc-chain-' + e.chain + '">' + e.chain + '</span></td><td>' + formatNumber(e.block_number) + '</td><td>' + e.event_type + '</td><td><span class="dc-mono">' + sf + '</span></td><td><span class="dc-mono">' + st + '</span></td><td>' + (e.amount || '—') + ' ' + (e.token_symbol || '') + '</td><td><span class="dc-mono">' + sx + '</span></td></tr>';
      }).join('');
    }
    const pager = document.getElementById('dc-explorer-pager');
    if (pager) {
      pager.innerHTML = next_page_token ? '<button class="btn btn-sm" onclick="dcQueryEvents(\'' + next_page_token + '\')">Next Page →</button>' : '<span style="color:var(--text-muted);font-size:12px">End of results</span>';
    }
  } catch (e) {
    if (tbody) tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--binance-red,#F6465D)">Query failed</td></tr>';
  }
}

// ─── Copy Key ────────────────────────────────────────────────────────
function dcCopyKey() {
  const input = document.getElementById('dc-api-key');
  if (!input || !input.value || input.value === '—') return;
  navigator.clipboard.writeText(input.value).then(function() { showToast('API Key copied', 'success'); });
}

// ─── Tab Switch ──────────────────────────────────────────────────────
function dcSwitchTab(sub) {
  document.querySelectorAll('#dc-dash .tab-btn').forEach(function(b) { b.classList.remove('active'); });
  document.querySelectorAll('#dc-dash .sub-panel').forEach(function(p) { p.classList.remove('active'); });
  const btn = document.querySelector('#dc-dash [data-sub="' + sub + '"]');
  const panel = document.getElementById('sub-' + sub);
  if (btn) btn.classList.add('active');
  if (panel) panel.classList.add('active');
  if (sub === 'dc-apikey') myKeysLoad(); // B-11-3：进入 API Key 页加载用户级 keys
}

// ─── My Keys（B-11-3 用户级 key 自助管理，钱包签名鉴权）───────────────
var myKeysNewKey = null;
function myKeysMsg(text, ok) {
  const el = document.getElementById('mykeys-msg');
  if (!el) return;
  if (myKeysNewKey) {
    el.innerHTML = '<div style="padding:10px;border:1px solid var(--border);border-radius:8px;background:rgba(14,203,129,0.06)">' +
      '<div style="font-weight:700;margin-bottom:4px">新 key —— 仅此一次显示，请立即复制保存</div>' +
      '<div class="mono" style="word-break:break-all;margin-bottom:6px">' + esc(myKeysNewKey) + '</div>' +
      '<button class="btn btn-xs" onclick="myKeysCopyNew()">📋 复制</button></div>';
    myKeysNewKey = null;
    return;
  }
  el.textContent = text || '';
  el.style.color = ok ? 'var(--green,#0ecb81)' : 'var(--binance-red,#F6465D)';
}
function myKeysCopyNew() {
  const el = document.querySelector('#mykeys-msg .mono');
  if (el) navigator.clipboard.writeText(el.textContent).then(function() { showToast('Copied', 'success'); });
}
function myKeysRender(resp) {
  const tbody = document.getElementById('mykeys-tbody');
  const hint = document.getElementById('mykeys-hint');
  if (!tbody) return;
  if (hint) hint.textContent = user().walletAddress ? ('owner: ' + user().walletAddress.slice(0, 6) + '…' + user().walletAddress.slice(-4)) : '未连接钱包';
  const keys = (resp && resp.keys) || [];
  if (!keys.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:20px;color:var(--text-muted)">暂无 key，在上方签发第一个</td></tr>';
    return;
  }
  tbody.innerHTML = keys.map(function(k) {
    var scopeBadge = k.scope === 'mcp' ? 'mx_' : k.scope === 'payment' ? 'px_' : k.scope === 'vault' ? 'vx_' : k.scope === 'mpc' ? 'mp_' : k.scope === 'chain-rpc' ? 'cr_' : k.scope === 'waas' ? 'wa_' : 'dx_';
    return '<tr>' +
      '<td style="font-weight:600">' + esc(k.label) + '</td>' +
      '<td><span class="dc-chain-badge">' + esc(k.scope || 'data') + '（' + scopeBadge + '）</span></td>' +
      '<td class="mono">' + esc(k.key_masked) + '</td>' +
      '<td>' + (k.enabled ? '<span style="color:var(--green,#0ecb81)">启用</span>' : '<span style="color:var(--binance-red,#F6465D)">禁用</span>') + '</td>' +
      '<td class="mono">' + k.rate_limit + '/min</td>' +
      '<td class="mono">' + (k.request_count || 0) + '</td>' +
      '<td class="mono">' + fmtTime(k.last_used_at) + '</td>' +
      '<td><span style="display:inline-flex;gap:6px">' +
        '<button class="btn btn-xs" title="轮换" onclick="myKeysRotate(' + k.id + ')">🔄</button>' +
        '<button class="btn btn-xs" title="吊销" onclick="myKeysDelete(' + k.id + ')">🗑️</button>' +
      '</span></td>' +
    '</tr>';
  }).join('');
}
async function myKeysLoad() {
  var wa = user().walletAddress;
  if (!wa || wa === 'undefined' || !/^0x[a-fA-F0-9]+$/i.test(wa)) return;
  try {
    const resp = await afetch('/api/v2/data/my-keys', { auth: 'wallet' });
    myKeysRender(resp || { keys: [] });
    myKeysMsg('');
  } catch (e) {
    myKeysMsg('加载失败：' + e.message, false);
  }
}
async function myKeysCreate() {
  if (!user().walletAddress) { myKeysMsg('请先连接钱包', false); return; }
  const labelEl = document.getElementById('mykeys-label');
  const label = (labelEl && labelEl.value || '').trim();
  if (!label) { myKeysMsg('请填写 label', false); return; }
  myKeysNewKey = null;
  try {
    const resp = await afetch('/api/v2/data/my-keys', { method: 'POST', auth: 'wallet', body: { label: label, scope: 'data' } });
    if (resp && resp.api_key) {
      myKeysNewKey = resp.api_key;
      myKeysMsg('签发成功（新 key 仅显示一次）', true);
      if (labelEl) labelEl.value = '';
      myKeysLoad();
      showToast('New key issued — copy below', 'success');
    } else {
      myKeysMsg('签发失败：服务端未返回 key', false);
    }
  } catch (e) {
    myKeysMsg('签发失败：' + e.message, false);
  }
}
async function myKeysRotate(id) {
  try {
    const resp = await afetch('/api/v2/data/my-keys/' + id + '/rotate', { method: 'POST', auth: 'wallet' });
    if (resp && resp.api_key) { myKeysNewKey = resp.api_key; myKeysMsg('已轮换（新 key 仅显示一次）', true); }
    myKeysLoad();
  } catch (e) { myKeysMsg('轮换失败：' + e.message, false); }
}
async function myKeysDelete(id) {
  if (!confirm('确认吊销该 key？吊销后立即失效')) return;
  try {
    await afetch('/api/v2/data/my-keys/' + id, { method: 'DELETE', auth: 'wallet' });
    myKeysMsg('已吊销', true);
    myKeysLoad();
  } catch (e) { myKeysMsg('吊销失败：' + e.message, false); }
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }


// ─── Helpers ─────────────────────────────────────────────────────────
function formatNumber(n) { return n == null ? '—' : Number(n).toLocaleString(); }
function setHtml(id, html) { const el = document.getElementById(id); if (el) el.innerHTML = html; }

// ─── Register ────────────────────────────────────────────────────────
(function() {
  document.addEventListener('click', function(e) {
    const btn = e.target.closest('#dc-dash .tab-btn');
    if (btn) { var s = btn.getAttribute('data-sub'); if (s) dcSwitchTab(s); }
  });
})();
