/**
 * InfraX Data Center — B2B On-chain Data API Module
 * Dependencies: core.js, infrax.css
 */

function obscureKey(key) { return key && key.length > 16 ? key.slice(0,14) + '…' + key.slice(-8) : key; }

// ─── State ───────────────────────────────────────────────────────────
let dcPlan = null;
let dcUsage = null;

// WSG-1: DC 套餐目录（与 intro 订阅卡一致，用于"我的订阅"升级卡）
var DC_DEFAULT_PLANS = [
  { id: 'data_free', name: 'Free', price: 0, badge: 'Free', emoji: '🆓', features: ['Sepolia only', '10,000 calls/mo', '24h retention'] },
  { id: 'data_pro', name: 'Pro', price: 29, badge: 'Popular', emoji: '📡', features: ['All 7 chains', '100,000 calls/mo', '72h retention'] },
  { id: 'data_enterprise', name: 'Enterprise', price: 99, badge: 'Enterprise', emoji: '🏭', features: ['All chains + custom', '1,000,000 calls/mo', 'Unlimited retention'] }
];

// 支付状态可写入多个目标（intro dc-sub-status + dash dc-upgrade-status）
function dcSetSubStatus(html, ok) {
  var els = [];
  var a = document.getElementById('dc-sub-status'); if (a) els.push(a);
  var b = document.getElementById('dc-upgrade-status'); if (b) els.push(b);
  els.forEach(function (el) {
    el.innerHTML = '<span style="color:' + (ok ? 'var(--success)' : 'var(--error)') + '">' + html + '</span>';
  });
}

function dcShowIntro() {
  var ie = document.getElementById('dc-intro');
  var de = document.getElementById('dc-dash');
  if (ie) ie.style.display = 'block';
  if (de) de.style.display = 'none';
}

// ─── Init ────────────────────────────────────────────────────────────
async function dcInit() {
  var addr = '';
  try { addr = user().walletAddress || ''; } catch(e) {}

  if (!addr) {
    var intro = document.getElementById('dc-intro');
    if (intro) {
      intro.innerHTML = '<div style="text-align:center;padding:60px">' +
        '<div style="font-size:48px;margin-bottom:12px">🔌</div>' +
        '<div style="font-size:16px;color:var(--gold-light);margin-bottom:8px">' + I18N.t('dc_connect_wallet') + '</div>' +
        '<a href="/connect.html" style="color:var(--gold);font-size:14px">' + I18N.t('dc_go_connect') + '</a>' +
        '<div style="margin-top:20px"><button class="btn btn-secondary" onclick="dcSkipToInsights()">' + I18N.t('dc_skip_insights') + '</button></div></div>';
    }
    return;
  }

  try {
    const ok = await dcRefreshUsage();
    if (ok) {
      // MQ-16 T-1: 付费订阅待支付 → 停留在 intro 并提示等待支付确认
      if (dcUsage.dcSubStatus === 'pending') {
        var sEl = document.getElementById('dc-sub-status');
        if (sEl) sEl.innerHTML = '<span style="color:var(--warning)">' + I18N.t('sub_pending') + '</span> <button class="btn btn-sm btn-primary" onclick="dcRecheckPayment()" style="margin-left:8px">' + I18N.t('sub_refresh') + '</button>';
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
  function setStatus(html, ok) { dcSetSubStatus(html, ok); }
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
      setStatus(I18N.t('sub_chain_wait') + pay.chainId + I18N.t('sub_chain_close') +
        'SubscriptionManager: <code>' + pay.subscriptionManager + '</code><br>' +
        I18N.t('sub_amount') + ': <b>' + amount + '</b> / ' + (pay.period || 'month') + '<br>' +
        '<small>' + I18N.t('sub_self_subscriber') + '</small>', true);
      showToast(I18N.t('sub_chain_confirming'), 'info');
      dcPollSubscription();
    } else if (pay.rail === 'fiat') {
      setStatus(I18N.t('sub_redirecting'), true);
      window.location.href = pay.sessionUrl;
    } else if (pay.rail === 'x402') {
      var amountEth = pay.priceWei ? (Number(pay.priceWei) / 1e18).toFixed(4) : '';
      setStatus(I18N.t('sub_transfer_to') + '<code>' + pay.payTo + '</code>' + I18N.t('sub_transfer_suffix') + amountEth + I18N.t('sub_eth_net_open') + pay.network + I18N.t('sub_net_close') +
        '<small>' + I18N.t('sub_transfer_hint') + '</small>', true);
      showToast(I18N.t('sub_submit_txhash'), 'info');
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
        dcSetSubStatus(I18N.t('sub_activated'), true);
        await dcLoadDashboard();
      }
    } catch (_) {}
    if (Date.now() - started > (timeoutMs || 5 * 60 * 1000)) {
      clearInterval(dcPollTimer); dcPollTimer = null;
      dcSetSubStatus(I18N.t('sub_timeout'), false);
    }
  }, 4000);
}

// MQ-16 T-1: x402 rail — 提示用户输入链上转账 txHash 并调 /verify 激活订阅
async function dcSubmitX402(network) {
  var txHash = window.prompt(I18N.t('sub_prompt_txhash') + (network || I18N.t('sub_prompt_chain')) + I18N.t('sub_prompt_suffix'));
  if (!txHash) return;
  try {
    var d = await afetch('/api/v2/data/verify', { method: 'POST', auth: 'none', body: { txHash: txHash } });
    if (d.verified && d.activated) {
      showToast(I18N.t('sub_activated_toast'), 'success');
      await dcRefreshUsage();
      dcSetSubStatus(I18N.t('sub_activated'), true);
      await dcLoadDashboard();
    } else if (d.verified) {
      showToast(I18N.t('sub_verified_no_sub'), 'error');
    } else {
      showToast(I18N.t('sub_not_confirmed'), 'error');
    }
  } catch (e) { showToast(e.message, 'error'); }
}

// MQ-16 T-1: 手动刷新支付状态（pending 态 intro 按钮）
async function dcRecheckPayment() {
  try {
    var d = await afetch('/api/v2/data/payment-check', { method: 'POST', auth: 'none' });
    if (d.status === 'active') {
      await dcRefreshUsage();
      showToast(I18N.t('sub_activated_toast'), 'success');
      await dcLoadDashboard();
    } else {
      showToast(I18N.t('sub_still_confirming'), 'warning');
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

    var apiKey = dcUsage?.dcApiKey || '—';
    var ki = document.getElementById('dc-api-key');
    if (ki) ki.value = apiKey;

    dcLoadMySub(); // WSG-1: 默认 tab 为"我的订阅"
  } else {
    if (ie) ie.style.display = 'block';
    if (de) de.style.display = 'none';
  }
}

// WSG-1: dc-dash "我的订阅"——刷新真实用量后渲染（当前套餐 + 当月用量进度条 + 升级卡片）
function dcLoadMySub() {
  var el = document.getElementById('dc-my-sub');
  if (!el) return;
  var wallet = '';
  try { wallet = user().walletAddress || ''; } catch (e) {}
  if (!wallet) { dcRenderMySub(el, 'nowallet'); return; }
  dcRefreshUsage()
    .then(function (ok) { dcRenderMySub(el, ok ? null : 'nosub'); })
    .catch(function () { dcRenderMySub(el, 'failed'); });
}

function dcRenderMySub(el, mode) {
  if (!el) return;
  if (mode === 'nowallet') {
    el.innerHTML = '<div style="text-align:center;padding:22px;background:var(--surface);border:1px solid var(--border);border-radius:var(--r-md)">' +
      '<div style="font-size:30px;margin-bottom:10px">🔌</div>' +
      '<div style="font-size:14px;color:var(--gold-light);margin-bottom:10px">' + I18N.t("dc_connect_sub") + '</div>' +
      '<a href="/connect.html" style="color:var(--gold);font-size:14px">' + I18N.t("dash_go_connect") + '</a></div>';
    return;
  }
  if (mode === 'failed') {
    el.innerHTML = '<div style="text-align:center;padding:16px;color:var(--error);font-size:13px">' + I18N.t("dc_load_failed") + ' <button class="btn btn-sm btn-secondary" onclick="dcLoadMySub()">🔄 ' + I18N.t("st_refresh") + '</button></div>';
    return;
  }
  if (mode === 'nosub' || !dcUsage || !dcPlan) {
    el.innerHTML = '<div style="text-align:center;padding:22px;background:var(--surface);border:1px solid var(--border);border-radius:var(--r-md)">' +
      '<div style="font-size:30px;margin-bottom:10px">📡</div>' +
      '<div style="font-size:14px;color:var(--gold-light);margin-bottom:10px">' + I18N.t("dc_no_sub") + '</div>' +
      '<button class="btn btn-primary" onclick="dcShowIntro()">' + I18N.t("dc_activate_now") + '</button></div>';
    return;
  }
  var quota = dcUsage.monthlyQuota || 0;
  var used = dcUsage.currentUsage || 0;
  var pct = quota ? Math.min(100, Math.round((used / quota) * 100)) : 0;
  var st = dcUsage.dcSubStatus === 'active'
    ? '<span class="status success">● active</span>'
    : '<span style="color:var(--warning)">● ' + (dcUsage.dcSubStatus || 'pending') + '</span>';
  el.innerHTML = '<div style="background:var(--surface-card);border:1px solid var(--border);border-radius:var(--r-md);padding:16px 20px;text-align:left">' +
    '<div style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.6px;color:var(--text-tertiary);margin-bottom:12px">' + I18N.t("dc_my_sub") + '</div>' +
    '<div style="display:flex;gap:28px;flex-wrap:wrap;align-items:center">' +
      '<div><div style="font-size:20px;font-weight:700;color:var(--gold-light)">📡 ' + dcPlan.name + '</div>' + st + '</div>' +
      '<div><div style="font-size:12px;color:var(--text-tertiary)">' + I18N.t("dc_usage_title") + '</div>' +
        '<div style="display:flex;gap:8px;align-items:center">' +
          '<span style="font-size:16px;font-weight:600">' + formatNumber(used) + ' / ' + formatNumber(quota) + '</span>' +
          '<div style="width:120px;height:8px;background:var(--surface);border-radius:4px;overflow:hidden">' +
            '<div style="width:' + pct + '%;height:100%;background:linear-gradient(90deg,var(--gold,#F0B90B),#d98e04)"></div></div>' +
        '</div></div>' +
      '<div><div style="font-size:12px;color:var(--text-tertiary)">dx_ key</div><code style="font-size:13px;color:var(--gold-light)">' + (dcUsage.dcApiKey ? obscureKey(dcUsage.dcApiKey) : '—') + '</code></div>' +
    '</div>' +
    dcUpgradeHtml(dcPlan.name) +
    '<div style="font-size:11.5px;color:var(--text-tertiary);margin-top:10px">' + I18N.t("dc_my_sub_note") + '</div>' +
  '</div>';
}

// WSG-1: dc 套餐升级卡片 —— 基于 DC_DEFAULT_PLANS 价格基线，过滤高于当前套餐的候选
function dcUpgradeHtml(planName) {
  var cur = 0;
  for (var i = 0; i < DC_DEFAULT_PLANS.length; i++) {
    if (planName && planName.toLowerCase().indexOf(DC_DEFAULT_PLANS[i].name.toLowerCase()) !== -1) {
      cur = DC_DEFAULT_PLANS[i].price;
      break;
    }
  }
  var up = DC_DEFAULT_PLANS.filter(function (p) { return p.price > cur; });
  if (!up.length) {
    return '<div style="text-align:center;padding:14px;color:var(--gold-light);font-size:13px;border:1px dashed var(--border);border-radius:var(--r-md);margin-top:16px">' + I18N.t("dc_upgrade_max") + '</div>';
  }
  return '<div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--border)">' +
    '<div style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.6px;color:var(--text-tertiary);margin-bottom:10px">' + I18N.t("dc_upgrade_title") +
    ' <span style="color:var(--text-muted);font-weight:400;text-transform:none;letter-spacing:0">' + I18N.t("dc_upgrade_note") + '</span></div>' +
    '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px">' +
      up.map(function (p) {
        return '<div class="waas-plan" style="cursor:pointer" data-plan="' + p.id + '" onclick="dcSubscribe(\'' + p.id + '\')">' +
          '<div class="waas-plan-badge">' + p.badge + '</div>' +
          '<div class="waas-plan-name">' + p.emoji + ' ' + p.name + '</div>' +
          '<div class="waas-plan-price">$' + p.price + '</div><div class="waas-plan-period">/mo</div>' +
          '<div class="waas-plan-features">' + p.features.join('<br>') + '</div>' +
          '<button class="btn btn-primary" style="margin-top:12px;width:100%">' + I18N.t("dc_upgrade_to") + '</button>' +
        '</div>';
      }).join('') +
    '</div></div>';
}

// ─── Copy Key ────────────────────────────────────────────────────────
function dcCopyKey() {
  const input = document.getElementById('dc-api-key');
  if (!input || !input.value || input.value === '—') return;
  navigator.clipboard.writeText(input.value).then(function() { showToast('API Key copied', 'success'); });
}

// ─── Tab Switch ──────────────────────────────────────────────────────
function dcSkipToInsights() {
  var ie = document.getElementById('dc-intro');
  var de = document.getElementById('dc-dash');
  if (ie) ie.style.display = 'none';
  if (de) de.style.display = 'block';
  dcSwitchTab('dc-insights');
}

function dcSwitchTab(sub) {
  document.querySelectorAll('#dc-dash .tab-btn').forEach(function(b) { b.classList.remove('active'); });
  document.querySelectorAll('#dc-dash .sub-panel').forEach(function(p) { p.classList.remove('active'); });
  const btn = document.querySelector('#dc-dash [data-sub="' + sub + '"]');
  const panel = document.getElementById('sub-' + sub);
  if (btn) btn.classList.add('active');
  if (panel) panel.classList.add('active');
  if (sub === 'dc-apikey') myKeysLoad(); // B-11-3：进入 API Key 页加载用户级 keys
  if (sub === 'dc-insights' && !window._insInitDone) { // dx_ key 数据能力合并：首次进入渲染 Insights
    window._insInitDone = true;
    if (typeof insightsInit === 'function') insightsInit();
  }
  if (sub === 'dc-market' && !window._dcMarketInitDone) { // 金融行情（/ticker /bars）：首次进入渲染
    window._dcMarketInitDone = true;
    dcRenderMarket();
  }
}

// ─── Market Data（分类：CEX / DEX / 新闻 / 财经日历 / 宏观经济，WEB-10）──
var DC_MTABS = ['cex', 'dex', 'news', 'cal', 'macro'];
var DC_MTAB_KEYS = { cex: 'dc_mkt_tab_cex', dex: 'dc_mkt_tab_dex', news: 'dc_mkt_tab_news', cal: 'dc_mkt_tab_cal', macro: 'dc_mkt_tab_macro' };
function dcRenderMarket() {
  var root = document.getElementById('dc-market-root');
  if (!root) return;
  root.innerHTML =
    '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">' +
      DC_MTABS.map(function(t) {
        return '<button class="tab-btn" id="dc-mtab-' + t + '" onclick="dcMTab(\'' + t + '\')" style="padding:7px 14px;font-size:12px;border:1px solid var(--border);border-radius:8px;background:var(--bg-sub,#242a36);color:var(--text-muted);cursor:pointer">' + I18N.t(DC_MTAB_KEYS[t]) + '</button>';
      }).join('') +
    '</div>' +
    '<div id="dc-m-pane"><div style="text-align:center;padding:24px;color:var(--text-muted)">' + I18N.t('dc_mkt_loading') + '</div></div>';
  dcMTab('cex');
}
function dcMTab(t) {
  if (DC_MTABS.indexOf(t) < 0) t = 'cex';
  DC_MTABS.forEach(function(x) {
    var b = document.getElementById('dc-mtab-' + x);
    if (!b) return;
    var on = x === t;
    b.style.borderColor = on ? 'var(--brand,#F0B90B)' : 'var(--border)';
    b.style.color = on ? 'var(--text)' : 'var(--text-muted)';
    b.style.background = on ? 'rgba(240,185,11,0.08)' : 'var(--bg-sub,#242a36)';
  });
  var pane = document.getElementById('dc-m-pane');
  if (!pane) return;
  if (t === 'cex') dcMCex();
  else if (t === 'dex') dcMDex();
  else if (t === 'news') dcMNews();
  else if (t === 'cal') dcMCal();
  else dcMMacro();
}
// 字段取值 helper：依次尝试候选键，null/undefined 才回退（0 不被丢弃）
function dcPk(o, keys) {
  if (!o) return null;
  for (var i = 0; i < keys.length; i++) { if (o[keys[i]] != null) return o[keys[i]]; }
  return null;
}
// 大数紧凑格式：≥1e6 显示 M / ≥1e3 显示 K，保留 2 位
function dcCompact(n) {
  if (n == null) return '—';
  var v = Number(n);
  if (!isFinite(v)) return '—';
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(2) + 'K';
  return formatNumber(v);
}
var DC_DEX_CHAINS = ['ETH', 'BSC', 'SOL', 'BASE', 'ARB', 'OP', 'POLYGON', 'AVAX', 'TRON', 'SUI'];

// ── CEX：中心化交易所行情（/ticker + /bars，data :9112）──
function dcMCex() {
  var pane = document.getElementById('dc-m-pane');
  if (!pane) return;
  var inputStyle = 'width:170px;font-size:12px;padding:7px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-card,#1b1f27);color:var(--text,#e8eaed)';
  var selStyle = 'font-size:12px;padding:7px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-card,#1b1f27);color:var(--text,#e8eaed)';
  pane.innerHTML =
    '<div class="panel" style="margin-bottom:14px"><div class="panel-body" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">' +
      '<input id="dc-m-symbol" placeholder="' + I18N.t('dc_symbol_placeholder') + '" value="BTC/USDT" style="' + inputStyle + '">' +
      '<select id="dc-m-market" style="' + selStyle + 'width:120px">' +
        '<option value="crypto" selected>crypto</option><option value="usstock">usstock</option><option value="forex">forex</option><option value="futures">futures</option><option value="cnstock">cnstock</option><option value="hkstock">hkstock</option>' +
      '</select>' +
      '<select id="dc-m-type" style="' + selStyle + 'width:96px">' +
        '<option value="">auto</option><option value="spot">spot</option><option value="swap">swap</option>' +
      '</select>' +
      '<select id="dc-m-tf" style="' + selStyle + 'width:84px">' +
        '<option value="1h">1h</option><option value="4h">4h</option><option value="1d" selected>1d</option>' +
      '</select>' +
      '<button class="btn btn-sm btn-primary" onclick="dcLoadMarket()">🔄 ' + I18N.t('dc_query') + '</button>' +
      '<span style="font-size:11px;color:var(--text-muted)">' + I18N.t('dc_market_hint') + '</span>' +
    '</div></div>' +
    '<div id="dc-market-result"></div>';
  dcLoadMarket();
}

async function dcLoadMarket() {
  var box = document.getElementById('dc-market-result');
  if (!box) return;
  box.innerHTML = '<div style="padding:14px 4px"><div class="skeleton-text" style="width:92%"></div><div class="skeleton-text" style="width:66%"></div><div class="skeleton-text short"></div></div>';
  var symbol = (document.getElementById('dc-m-symbol').value || 'BTC/USDT').trim();
  var market = document.getElementById('dc-m-market').value;
  var mtype = document.getElementById('dc-m-type').value;
  var tf = document.getElementById('dc-m-tf').value;
  var mtypeQ = mtype ? '&market_type=' + encodeURIComponent(mtype) : '';
  try {
    var tResp = await afetch('/ticker?symbol=' + encodeURIComponent(symbol) + '&market=' + encodeURIComponent(market) + mtypeQ, { auth: 'none' });
    var bResp = await afetch('/bars?symbol=' + encodeURIComponent(symbol) + '&timeframe=' + encodeURIComponent(tf) + mtypeQ + '&limit=15', { auth: 'none' });
    var t = tResp && typeof tResp.price === 'number' ? tResp : null;
    var bars = (bResp && Array.isArray(bResp.bars)) ? bResp.bars : [];
    var html = '';
    if (t) {
      var up = (t.changePercent || 0) >= 0;
      var color = up ? '#0ecb81' : '#F6465D';
      var arrow = up ? '▲' : '▼';
      html += '<div class="panel" style="margin-bottom:14px"><div class="panel-header">💹 ' + esc(symbol) + ' ' + I18N.t('dc_ticker_title') +
        '<span style="margin-left:auto;font-weight:700;color:' + color + '">' + arrow + ' ' + formatNumber(t.changePercent) + '%</span></div>' +
        '<div class="panel-body"><div class="kpi-grid" style="display:grid;grid-template-columns:repeat(5,1fr);gap:12px">' +
        '<div class="kpi"><div class="kpi-label">Price</div><div class="kpi-val" style="color:' + color + '">' + formatNumber(t.price) + '</div></div>' +
        '<div class="kpi"><div class="kpi-label">Change</div><div class="kpi-val">' + formatNumber(t.change) + '</div></div>' +
        '<div class="kpi"><div class="kpi-label">High</div><div class="kpi-val">' + formatNumber(t.high) + '</div></div>' +
        '<div class="kpi"><div class="kpi-label">Low</div><div class="kpi-val">' + formatNumber(t.low) + '</div></div>' +
        '<div class="kpi"><div class="kpi-label">Open</div><div class="kpi-val">' + formatNumber(t.open) + '</div></div>' +
        '</div></div></div>';
    } else {
      html += '<div class="panel" style="margin-bottom:14px"><div class="panel-body" style="color:var(--text-muted);font-size:13px">' + esc(symbol) + ' (' + esc(market) + ') ' + I18N.t('dc_no_ticker') + '</div></div>';
    }
    if (bars.length) {
      html += '<div class="panel"><div class="panel-header">📊 ' + esc(symbol) + ' · ' + esc(tf) + ' ' + I18N.t('dc_bars_title') + bars.length + I18N.t('dc_bars_suffix') + '</div>' +
        '<div class="panel-body" style="padding:0;overflow:auto"><table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr style="text-align:left;color:var(--text-muted)"><th style="padding:8px 10px;border-bottom:1px solid var(--border)">' + I18N.t('dc_th_time') + '</th><th style="padding:8px 10px;border-bottom:1px solid var(--border)">' + I18N.t('dc_th_open') + '</th><th style="padding:8px 10px;border-bottom:1px solid var(--border)">' + I18N.t('dc_th_high') + '</th><th style="padding:8px 10px;border-bottom:1px solid var(--border)">' + I18N.t('dc_th_low') + '</th><th style="padding:8px 10px;border-bottom:1px solid var(--border)">' + I18N.t('dc_th_close') + '</th><th style="padding:8px 10px;border-bottom:1px solid var(--border)">' + I18N.t('dc_th_volume') + '</th></tr></thead><tbody>' +
        bars.map(function(b) {
          var ts = b.ts || b.timestamp || 0;
          var time = ts ? new Date(ts).toLocaleString(I18N.getLang() === 'en' ? 'en-US' : 'zh-CN', { hour12: false }) : '—';
          return '<tr style="border-bottom:1px solid var(--border)"><td class="dc-mono">' + time + '</td><td style="padding:6px 10px">' + formatNumber(b.open) + '</td><td style="padding:6px 10px">' + formatNumber(b.high) + '</td><td style="padding:6px 10px">' + formatNumber(b.low) + '</td><td style="padding:6px 10px">' + formatNumber(b.close) + '</td><td style="padding:6px 10px">' + formatNumber(b.volume) + '</td></tr>';
        }).join('') + '</tbody></table></div></div>';
    } else {
      html += '<div class="panel"><div class="panel-body" style="color:var(--text-muted);font-size:13px">' + esc(symbol) + ' · ' + esc(tf) + ' ' + I18N.t('dc_no_bars') + '</div></div>';
    }
    box.innerHTML = html;
  } catch (e) {
    box.innerHTML = '<div class="panel"><div class="panel-body" style="color:var(--binance-red,#F6465D)">' + I18N.t('dc_load_failed') + esc(e && e.message ? e.message : String(e)) + '</div></div>';
  }
}

// ── DEX：去中心化交易所数据（collector /api/dex/*，R1 hot-tokens）──
function dcMDex() {
  var pane = document.getElementById('dc-m-pane');
  if (!pane) return;
  var selStyle = 'font-size:12px;padding:7px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-card,#1b1f27);color:var(--text,#e8eaed)';
  var chainOpts = '<option value="">all</option>' + DC_DEX_CHAINS.map(function(c) { return '<option value="' + c + '">' + c + '</option>'; }).join('');
  pane.innerHTML =
    '<div class="panel" style="margin-bottom:14px"><div class="panel-body" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">' +
      '<span style="font-size:11px;color:var(--text-muted)">' + I18N.t('dc_mkt_chain') + '</span>' +
      '<select id="dc-d-chain" style="' + selStyle + 'width:96px">' + chainOpts + '</select>' +
      '<span style="font-size:11px;color:var(--text-muted)">' + I18N.t('dc_mkt_ranking') + '</span>' +
      '<select id="dc-d-rank" style="' + selStyle + 'width:116px">' +
        '<option value="trending">' + I18N.t('dc_mkt_rank_trending') + '</option>' +
        '<option value="x_mentions">' + I18N.t('dc_mkt_rank_mentions') + '</option>' +
      '</select>' +
      '<button class="btn btn-sm btn-primary" onclick="dcLoadDex()">🔄 ' + I18N.t('dc_query') + '</button>' +
    '</div></div>' +
    '<div id="dc-dex-result"><div style="padding:14px 4px"><div class="skeleton-text" style="width:92%"></div><div class="skeleton-text" style="width:66%"></div></div></div>';
  dcLoadDex();
}
async function dcLoadDex() {
  var box = document.getElementById('dc-dex-result');
  if (!box) return;
  box.innerHTML = '<div style="padding:14px 4px"><div class="skeleton-text" style="width:92%"></div><div class="skeleton-text" style="width:66%"></div></div>';
  var chain = document.getElementById('dc-d-chain').value;
  var rank = document.getElementById('dc-d-rank').value;
  var q = '/api/dex/hot-tokens?limit=20&ranking=' + encodeURIComponent(rank) + (chain ? '&chain=' + encodeURIComponent(chain) : '');
  try {
    var d = await afetch(q, { auth: 'none' }) || {};
    var okx = d.okx || [];
    var ds = d.dexscreener || [];
    var mkTable = function(list, title) {
      return '<div class="panel" style="margin-bottom:14px"><div class="panel-header">' + title + ' · ' + list.length + '</div>' +
        '<div class="panel-body" style="padding:0;overflow:auto"><table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr style="text-align:left;color:var(--text-muted)"><th style="padding:8px 10px;border-bottom:1px solid var(--border)">Symbol</th><th style="padding:8px 10px;border-bottom:1px solid var(--border)">Chain</th><th style="padding:8px 10px;border-bottom:1px solid var(--border)">' + I18N.t('dc_mkt_price') + '</th><th style="padding:8px 10px;border-bottom:1px solid var(--border)">' + I18N.t('dc_mkt_change24h') + '</th><th style="padding:8px 10px;border-bottom:1px solid var(--border)">' + I18N.t('dc_mkt_volume24h') + '</th><th style="padding:8px 10px;border-bottom:1px solid var(--border)">' + I18N.t('dc_mkt_liquidity') + '</th></tr></thead><tbody>' +
        list.map(function(tk) {
          var price = dcPk(tk, ['price', 'priceUsd']);
          var chg = dcPk(tk, ['change24h', 'change_percent', 'priceChange24h']);
          var chgTxt = (chg == null) ? '—' : '<span style="color:' + (Number(chg) >= 0 ? 'var(--success)' : 'var(--error)') + '">' + (Number(chg) >= 0 ? '+' : '') + Number(chg).toFixed(2) + '%</span>';
          return '<tr style="border-bottom:1px solid var(--border)"><td style="padding:6px 10px;font-weight:600">' + esc(tk.symbol || '?') + '</td><td style="padding:6px 10px">' + esc(tk.chain || '') + '</td><td style="padding:6px 10px" class="dc-mono">' + formatNumber(price) + '</td><td style="padding:6px 10px">' + chgTxt + '</td><td style="padding:6px 10px" class="dc-mono">' + dcCompact(dcPk(tk, ['volume24h', 'volume_24h', 'volume'])) + '</td><td style="padding:6px 10px" class="dc-mono">' + dcCompact(dcPk(tk, ['liquidity', 'liquidityUsd'])) + '</td></tr>';
        }).join('') + '</tbody></table></div></div>';
    };
    if (!okx.length && !ds.length) {
      box.innerHTML = '<div class="panel"><div class="panel-body" style="color:var(--text-muted);font-size:13px">' + I18N.t('dc_mkt_no_dex') + '</div></div>';
    } else {
      var html = '';
      if (okx.length) html += mkTable(okx, 'OKX ' + I18N.t('dc_mkt_hot_tokens'));
      if (ds.length) html += mkTable(ds, 'DexScreener ' + I18N.t('dc_mkt_hot_tokens'));
      box.innerHTML = html;
    }
  } catch (e) {
    box.innerHTML = '<div class="panel"><div class="panel-body" style="color:var(--binance-red,#F6465D)">' + I18N.t('dc_load_failed') + esc(e && e.message ? e.message : String(e)) + '</div></div>';
  }
}

// ── News：金融/加密新闻（data :9112 /snapshots?type=news，R-I2 语言过滤）──
function dcMNews() {
  var pane = document.getElementById('dc-m-pane');
  if (!pane) return;
  var selStyle = 'font-size:12px;padding:7px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-card,#1b1f27);color:var(--text,#e8eaed)';
  pane.innerHTML =
    '<div class="panel" style="margin-bottom:14px"><div class="panel-body" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">' +
      '<span style="font-size:11px;color:var(--text-muted)">' + I18N.t('dc_mkt_lang') + '</span>' +
      '<select id="dc-n-lang" style="' + selStyle + 'width:84px">' +
        '<option value="zh">zh</option><option value="en" selected>en</option><option value="all">' + I18N.t('dc_mkt_all_lang') + '</option>' +
      '</select>' +
      '<button class="btn btn-sm btn-primary" onclick="dcLoadNews()">🔄 ' + I18N.t('dc_query') + '</button>' +
    '</div></div>' +
    '<div id="dc-news-result"><div style="padding:14px 4px"><div class="skeleton-text" style="width:92%"></div><div class="skeleton-text" style="width:66%"></div></div></div>';
  dcLoadNews();
}
async function dcLoadNews() {
  var box = document.getElementById('dc-news-result');
  if (!box) return;
  box.innerHTML = '<div style="padding:14px 4px"><div class="skeleton-text" style="width:92%"></div><div class="skeleton-text" style="width:66%"></div></div>';
  var lang = document.getElementById('dc-n-lang').value;
  try {
    var d = await afetch('/snapshots?type=news' + (lang && lang !== 'all' ? '&lang=' + encodeURIComponent(lang) : ''), { auth: 'none' }) || {};
    // data-service 返回 {ts, snapshots:{news:{items}}}（无信封），兼容直接 {news}
    var news = d.news || (d.snapshots && d.snapshots.news);
    var items = Array.isArray(news) ? news : (news && news.items ? news.items : []);
    if (!items.length) {
      box.innerHTML = '<div class="panel"><div class="panel-body" style="color:var(--text-muted);font-size:13px">' + I18N.t('dc_mkt_no_news') + '</div></div>';
      return;
    }
    box.innerHTML = items.slice(0, 30).map(function(n) {
      var href = n.link || n.url || '#';
      return '<div class="panel" style="margin-bottom:10px"><div class="panel-body" style="font-size:13px">' +
        '<a href="' + esc(href) + '" target="_blank" rel="noopener" style="color:var(--text);text-decoration:none;font-weight:600">' + esc(n.title || n.link || '—') + '</a>' +
        '<div style="font-size:11px;color:var(--text-muted);margin-top:4px">' + esc(n.source || '') + (n.published ? ' · ' + esc(n.published) : '') + '</div>' +
        (n.snippet ? '<div style="font-size:12px;color:var(--text-secondary);margin-top:4px">' + esc(n.snippet) + '</div>' : '') +
      '</div></div>';
    }).join('');
  } catch (e) {
    box.innerHTML = '<div class="panel"><div class="panel-body" style="color:var(--binance-red,#F6465D)">' + I18N.t('dc_load_failed') + esc(e && e.message ? e.message : String(e)) + '</div></div>';
  }
}

// ── Economic Calendar：财经日历（data :9112 /snapshots?type=calendar）──
function dcMCal() {
  var pane = document.getElementById('dc-m-pane');
  if (!pane) return;
  pane.innerHTML = '<div id="dc-cal-result"><div style="padding:14px 4px"><div class="skeleton-text" style="width:92%"></div><div class="skeleton-text" style="width:66%"></div></div></div>';
  dcLoadCal();
}
async function dcLoadCal() {
  var box = document.getElementById('dc-cal-result');
  if (!box) return;
  box.innerHTML = '<div style="padding:14px 4px"><div class="skeleton-text" style="width:92%"></div><div class="skeleton-text" style="width:66%"></div></div>';
  try {
    var d = await afetch('/snapshots?type=calendar', { auth: 'none' }) || {};
    // data-service 返回 {ts, snapshots:{calendar:[...]}}（无信封），兼容直接 {calendar}
    var cal = d.calendar || (d.snapshots && d.snapshots.calendar);
    var items = Array.isArray(cal) ? cal : (cal && cal.items ? cal.items : []);
    if (!items.length) {
      box.innerHTML = '<div class="panel"><div class="panel-body" style="color:var(--text-muted);font-size:13px">' + I18N.t('dc_mkt_no_cal') + '</div></div>';
      return;
    }
    box.innerHTML = '<div class="panel"><div class="panel-header">📅 ' + I18N.t('dc_mkt_tab_cal') + ' · ' + items.length + '</div>' +
      '<div class="panel-body" style="padding:0;overflow:auto"><table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr style="text-align:left;color:var(--text-muted)"><th style="padding:8px 10px;border-bottom:1px solid var(--border)">Date</th><th style="padding:8px 10px;border-bottom:1px solid var(--border)">Country</th><th style="padding:8px 10px;border-bottom:1px solid var(--border)">Event</th><th style="padding:8px 10px;border-bottom:1px solid var(--border)">' + I18N.t('dc_mkt_impact') + '</th><th style="padding:8px 10px;border-bottom:1px solid var(--border)">' + I18N.t('dc_mkt_forecast') + '</th><th style="padding:8px 10px;border-bottom:1px solid var(--border)">' + I18N.t('dc_mkt_previous') + '</th></tr></thead><tbody>' +
      items.slice(0, 60).map(function(ev) {
        var dstr = ev.timestamp ? new Date(ev.timestamp * 1000 || ev.timestamp).toLocaleString() : (ev.date || '—');
        var imp = String(ev.impact || '').toLowerCase();
        var impColor = imp === 'high' ? 'var(--binance-red,#F6465D)' : imp === 'medium' ? 'var(--warning)' : 'var(--text-muted)';
        return '<tr style="border-bottom:1px solid var(--border)"><td style="padding:6px 10px">' + esc(dstr) + '</td><td style="padding:6px 10px">' + esc(ev.country || '') + '</td><td style="padding:6px 10px;font-weight:600">' + esc(ev.name || ev.event || '—') + '</td><td style="padding:6px 10px"><span style="color:' + impColor + '">' + esc(ev.impact || '—') + '</span></td><td style="padding:6px 10px">' + esc(ev.forecast || '—') + '</td><td style="padding:6px 10px">' + esc(ev.previous || '—') + '</td></tr>';
      }).join('') + '</tbody></table></div></div>';
  } catch (e) {
    box.innerHTML = '<div class="panel"><div class="panel-body" style="color:var(--binance-red,#F6465D)">' + I18N.t('dc_load_failed') + esc(e && e.message ? e.message : String(e)) + '</div></div>';
  }
}

// ── Macro：宏观经济数据（data :9112 /macro/history，FRED 序列）──
function dcMMacro() {
  var pane = document.getElementById('dc-m-pane');
  if (!pane) return;
  pane.innerHTML = '<div id="dc-macro-result"><div style="padding:14px 4px"><div class="skeleton-text" style="width:92%"></div><div class="skeleton-text" style="width:66%"></div></div></div>';
  dcLoadMacro();
}
async function dcLoadMacro() {
  var box = document.getElementById('dc-macro-result');
  if (!box) return;
  box.innerHTML = '<div style="padding:14px 4px"><div class="skeleton-text" style="width:92%"></div><div class="skeleton-text" style="width:66%"></div></div>';
  try {
    var d = await afetch('/macro/history?limit=2000', { auth: 'none' }) || {};
    var series = d.series || {};
    var names = Object.keys(series);
    if (!names.length) {
      box.innerHTML = '<div class="panel"><div class="panel-body" style="color:var(--text-muted);font-size:13px">' + I18N.t('dc_mkt_no_macro') + '</div></div>';
      return;
    }
    box.innerHTML = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px">' +
      names.map(function(nm) {
        var pts = series[nm] || [];
        var last = pts[pts.length - 1] || {};
        var prev = pts[pts.length - 2] || {};
        var v = last.value;
        var p = prev.value;
        var chg = (typeof v === 'number' && typeof p === 'number' && p !== 0) ? (v - p) / Math.abs(p) * 100 : null;
        var vTxt = (v == null) ? '—' : (typeof v === 'number' ? formatNumber(v) : esc(String(v)));
        return '<div class="panel"><div class="panel-header" style="font-size:12px">' + esc(nm) + '<span style="margin-left:auto;font-size:10px;color:var(--text-muted)">' + esc(last.date || '') + '</span></div>' +
          '<div class="panel-body"><div class="kpi-val mono" style="font-size:18px;font-weight:700">' + vTxt +
          (chg != null ? '<span style="font-size:12px;color:' + (chg >= 0 ? 'var(--success)' : 'var(--error)') + ';margin-left:8px">' + (chg >= 0 ? '▲' : '▼') + chg.toFixed(2) + '%</span>' : '') +
          '</div><div style="font-size:10px;color:var(--text-muted);margin-top:4px">' + pts.length + ' obs · ' + esc((pts[0] && pts[0].date) || '—') + ' → ' + esc(last.date || '—') + '</div></div></div>';
      }).join('') + '</div>';
  } catch (e) {
    box.innerHTML = '<div class="panel"><div class="panel-body" style="color:var(--binance-red,#F6465D)">' + I18N.t('dc_load_failed') + esc(e && e.message ? e.message : String(e)) + '</div></div>';
  }
}

// ─── My Keys（B-11-3 用户级 key 自助管理，钱包签名鉴权）───────────────
var myKeysNewKey = null;
function myKeysMsg(text, ok) {
  const el = document.getElementById('mykeys-msg');
  if (!el) return;
  if (myKeysNewKey) {
    el.innerHTML = '<div style="padding:10px;border:1px solid var(--border);border-radius:8px;background:rgba(14,203,129,0.06)">' +
      '<div style="font-weight:700;margin-bottom:4px">' + I18N.t('mykeys_new_once') + '</div>' +
      '<div class="mono" style="word-break:break-all;margin-bottom:6px">' + esc(myKeysNewKey) + '</div>' +
      '<button class="btn btn-xs" onclick="myKeysCopyNew()">📋 ' + I18N.t('copy') + '</button></div>';
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
  if (hint) hint.textContent = user().walletAddress ? ('owner: ' + user().walletAddress.slice(0, 6) + '…' + user().walletAddress.slice(-4)) : I18N.t('mykeys_no_wallet');
  const keys = (resp && resp.keys) || [];
  if (!keys.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:20px;color:var(--text-muted)">' + I18N.t('mykeys_empty') + '</td></tr>';
    return;
  }
  tbody.innerHTML = keys.map(function(k) {
    var scopeBadge = k.scope === 'mcp' ? 'mx_' : k.scope === 'payment' ? 'px_' : k.scope === 'vault' ? 'vx_' : k.scope === 'mpc' ? 'mp_' : k.scope === 'chain-rpc' ? 'cr_' : k.scope === 'waas' ? 'wa_' : 'dx_';
    return '<tr>' +
      '<td style="font-weight:600">' + esc(k.label) + '</td>' +
      '<td><span class="dc-chain-badge">' + esc(k.scope || 'data') + '（' + scopeBadge + '）</span></td>' +
      '<td class="mono">' + esc(k.key_masked) + '</td>' +
      '<td>' + (k.enabled ? '<span style="color:var(--green,#0ecb81)">' + I18N.t('mykeys_enabled') + '</span>' : '<span style="color:var(--binance-red,#F6465D)">' + I18N.t('mykeys_disabled') + '</span>') + '</td>' +
      '<td class="mono">' + k.rate_limit + '/min</td>' +
      '<td class="mono">' + (k.request_count || 0) + '</td>' +
      '<td class="mono">' + fmtTime(k.last_used_at) + '</td>' +
      '<td><span style="display:inline-flex;gap:6px">' +
        '<button class="btn btn-xs" title="' + I18N.t('mykeys_rotate_title') + '" onclick="myKeysRotate(' + k.id + ')">🔄</button>' +
        '<button class="btn btn-xs" title="' + I18N.t('mykeys_revoke_title') + '" onclick="myKeysDelete(' + k.id + ')">🗑️</button>' +
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
    myKeysMsg(I18N.t('mykeys_load_failed') + e.message, false);
  }
}
async function myKeysCreate() {
  if (!user().walletAddress) { myKeysMsg(I18N.t('mykeys_connect_wallet'), false); return; }
  const labelEl = document.getElementById('mykeys-label');
  const label = (labelEl && labelEl.value || '').trim();
  if (!label) { myKeysMsg(I18N.t('mykeys_need_label'), false); return; }
  myKeysNewKey = null;
  try {
    const resp = await afetch('/api/v2/data/my-keys', { method: 'POST', auth: 'wallet', body: { label: label, scope: 'data' } });
    if (resp && resp.api_key) {
      myKeysNewKey = resp.api_key;
      myKeysMsg(I18N.t('mykeys_issued'), true);
      if (labelEl) labelEl.value = '';
      myKeysLoad();
      showToast('New key issued — copy below', 'success');
    } else {
      myKeysMsg(I18N.t('mykeys_issue_failed'), false);
    }
  } catch (e) {
    myKeysMsg(I18N.t('mykeys_issue_error') + e.message, false);
  }
}
async function myKeysRotate(id) {
  try {
    const resp = await afetch('/api/v2/data/my-keys/' + id + '/rotate', { method: 'POST', auth: 'wallet' });
    if (resp && resp.api_key) { myKeysNewKey = resp.api_key; myKeysMsg(I18N.t('mykeys_rotated'), true); }
    myKeysLoad();
  } catch (e) { myKeysMsg(I18N.t('mykeys_rotate_error') + e.message, false); }
}
async function myKeysDelete(id) {
  if (!confirm(I18N.t('mykeys_confirm_revoke'))) return;
  try {
    await afetch('/api/v2/data/my-keys/' + id, { method: 'DELETE', auth: 'wallet' });
    myKeysMsg(I18N.t('mykeys_revoked'), true);
    myKeysLoad();
  } catch (e) { myKeysMsg(I18N.t('mykeys_revoke_error') + e.message, false); }
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
