// INFRAX CORE //
var API = "";


  // ── Shared module state (was global vars) ──
  var _sig = '', _ts = '', _addr = '';
  var _me = null;
  var activeChain = 'sepolia';
  var CHAIN_NAMES = { sepolia:'Sepolia', ethereum:'Ethereum', bsc:'BSC', base:'Base', oxa:'OxaChain', polygon:'Polygon', arbitrum:'Arbitrum', optimism:'Optimism', xlayer:'XLayer', solana:'Solana' };
  var CHAIN_COLORS = { sepolia:'#6366f1', ethereum:'#627eea', bsc:'#f0b90b', base:'#0052ff', oxa:'#8b5cf6', polygon:'#8247e5', arbitrum:'#28a0f0', optimism:'#ff0420', xlayer:'#0f0f0f', solana:'#9945ff' };
  var CHAIN_IDS = { sepolia:11155111, ethereum:1, bsc:56, base:8453, oxa:19505, polygon:137, arbitrum:42161, optimism:10, xlayer:196, solana:101 };
  // 持久化恢复 activeChain（localStorage）
  try { var _savedChain = localStorage.getItem('px_chain'); if (_savedChain && CHAIN_NAMES[_savedChain]) activeChain = _savedChain; } catch (_) {}
  var histPage = 1, histFilter = 'all';
  var waasActiveTenantId = '';
  var ncCustomTokens = [];
  var mpcCurrentEmail = '', mpcCurrentAddr = '', mpcActivated = false;
  var mpcEmail = '';
  var waasTenantData = null;
  var waasSelectedPlan = 'free';
  var safeEnabled = false;

  var PAGE_TITLES = { noncustodial:'dash_title', mpc:'nav_mpc', waas:'nav_waas', datacenter:'nav_datacenter', safe:'nav_safe', aa:'nav_aa', payments:'nav_payments', rpc:'nav_chain_rpc', lightrag:'nav_lightrag', status:'nav_status' };

  // ── Re-declare all functions below (code preserved from original, wrapped) ──
// ═══════════════════════════════════════════════════════
// InfraX v4.0 — Core Logic
// ═══════════════════════════════════════════════════════

// ── Auth — standard Web3 wallet signature ──
// API = '' (IIFE scoped)
function user() { try { return JSON.parse(localStorage.getItem('px_user') || '{}'); } catch (e) { return {}; } }
function logout() { localStorage.clear(); window.location.href = '/connect.html'; }

// One signature per session (memory), one prompt per wallet per 24h
// _sig/_ts/_addr (IIFE scoped)
async function signOnce() {
  var a = user().walletAddress;
  if (!a) throw new Error(I18N.t("not_connected"));
  // Reuse cached signature (memory or localStorage, 24h TTL)
  if (_sig && _addr === a && Date.now() - parseInt(_ts) < 86400000) return;
  // Read from localStorage (saved at connect time)
  var savedSig = localStorage.getItem('px_sig');
  var savedTs = localStorage.getItem('px_ts');
  if (savedSig && savedTs && Date.now() - parseInt(savedTs) < 86400000) {
    _sig = savedSig;
    _ts = savedTs;
    _addr = a;
    return;
  }
  // Fallback: prompt MetaMask (first connect or expired session)
  var w = window.ethereum;
  if (!w) throw new Error(I18N.t("no_wallet_detected"));
  _ts = Date.now().toString();
  _addr = a;
  _sig = await Promise.race([w.request({ method: "personal_sign", params: ["InfraX auth: " + _ts, a] }), new Promise(function(_, r){ setTimeout(function(){ r(new Error(I18N.t("meta_mask_timeout"))); }, 10000); })]);
  localStorage.setItem('px_sig', _sig);
  localStorage.setItem('px_ts', _ts);
}

// ── API ──
// opts.auth: 'wallet' = require signature, 'none' = address only, default 'wallet'
async function afetch(url, opts) {
  if (!opts) opts = {};
  if (!opts.headers) opts.headers = {};
  var a = user().walletAddress;
  if (a && a !== 'undefined' && /^0x[a-fA-F0-9]+$/i.test(a)) {
    opts.headers['x-wallet-address'] = a;
    if (opts.auth !== 'none') {
      try {
        await signOnce();
        if (_sig) {
          opts.headers['x-wallet-signature'] = _sig;
          opts.headers['x-wallet-timestamp'] = _ts;
        }
      } catch (e) {
        if (opts.auth === 'wallet') throw e; // hard fail only if signature explicitly required
      }
    }
  }
  if (opts.body && typeof opts.body === 'object') {
    opts.body = JSON.stringify(opts.body);
    if (!opts.headers['Content-Type']) opts.headers['Content-Type'] = 'application/json';
  }
  try {
    var r = await fetch(API + url, opts);
    if (r.status === 401) { throw new Error(I18N.t("auth_required")); }
    var j; try { j = await r.json(); } catch(e) { throw new Error(I18N.t("invalid_response")); }
    if (j.code && j.code !== 0) throw new Error(j.message || I18N.t("api_error"));
    return j.data !== undefined ? j.data : j;
  } catch(e) {
    if (opts.method && opts.method !== 'GET') throw e;
    console.error('afetch error for ' + url + ':', e.message);
    return afetchMock(url);
  }
}

// ── Global state cache (each module owns its status endpoint) ──
// _me (IIFE scoped)
async function getMe() {
  if (_me) return _me;
  var mpc = null, safe = null, waas = null, tokens = [];
  // Each module provides its own lightweight status check — no aggregation coupling
  try {
    var results = await Promise.allSettled([
      afetch('/api/v2/mpc/status?walletAddress=' + encodeURIComponent(user().walletAddress), { auth: 'none' }),
      afetch('/api/vault/safe/status', { auth: 'wallet' }),
      afetch('/api/v2/saas/tenants/my', { auth: 'none' }),
      afetch('/api/v2/wallet/custom-tokens', { auth: 'wallet' })
    ]);
    if (results[0].status === 'fulfilled' && results[0].value) mpc = results[0].value;
    if (results[1].status === 'fulfilled' && results[1].value) safe = results[1].value;
    if (results[2].status === 'fulfilled' && results[2].value) waas = results[2].value;
    if (results[3].status === 'fulfilled' && results[3].value) tokens = results[3].value;
  } catch(e) {}
  // Only cache if we got at least some real data; otherwise allow retry
  if (mpc !== null || safe !== null || waas !== null || tokens.length > 0) {
    _me = { mpc: mpc, safe: safe, waas: waas, customTokens: tokens || [] };
  } else {
    _me = null; // don't cache empty results — allow retry on next call
  }
  return _me || { mpc: null, safe: null, waas: null, customTokens: [] };
}
function clearMe() { _me = null; }

// Mock fallback data so pages don't go black when backend is unavailable
function afetchMock(url) {
  var mocks = {
    '/api/v2/saas/tenants/my': null,
    '/api/v2/wallet/balance': { balance: '0.00', tokens: [] },
    '/api/v2/tx/history': { items: [] },
    '/api/vault/safe/owned': { items: [] },
    '/api/vault/safe/participating': { items: [] },
    '/api/v2/mpc/status': { registered: false },
    '/api/v2/subscription/plans': [
      { id: 'free', name: 'Free Trial', price: 0, interval: 'month', features: ['3-day trial', '10 addresses', '1 API Key'] },
      { id: 'pro', name: 'Pro', price: 49, interval: 'month', features: ['Unlimited addresses', '5 API Keys', 'Email support'] },
      { id: 'enterprise', name: 'Enterprise', price: 199, interval: 'month', features: ['Everything in Pro', 'White label', 'Dedicated Slack'] }
    ],
    '/api/v2/subscription/me': null,
  };
  if (mocks[url]) return mocks[url];
  // Try matching prefix
  for (var key in mocks) { if (url.startsWith(key)) return mocks[key]; }
  return null;
}

// ── Toast ──
function showToast(msg, cls) {
  var c = document.getElementById('toast-container');
  var el = document.createElement('div');
  var icons = { success: '✅', error: '❌', warning: '⚠️' };
  el.className = 'toast ' + (cls || '');
  el.innerHTML = '<span>' + (icons[cls] || '') + '</span><span>' + msg + '</span><span class="toast-dismiss" onclick="this.parentElement.remove()">\u00d7</span>';
  c.appendChild(el);
  setTimeout(function () { if (el.parentElement) el.remove(); }, 4000);
}

// ── Formatters ──
function fmtAddr(a) { return a ? a.slice(0, 6) + '...' + a.slice(-4) : '—'; }
function fmtAddrLong(a) { return a ? a.slice(0, 12) + '...' + a.slice(-6) : '—'; }
function fmtTime(ts) {
  if (!ts) return '—';
  var d = new Date(ts);
  return d.toLocaleDateString('en', { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' });
}
function fmtUSD(n) { return n ? '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '$0.00'; }

// ── Copy ──
function copyText(txt) {
  navigator.clipboard.writeText(txt).then(function () { showToast(I18N.t("copied"), 'success'); }).catch(function () { showToast(I18N.t("copy_failed"), 'error'); });
}

// ── Modal ──
function openModal(id) { document.getElementById(id).classList.add('show'); }
function closeModal(id) { document.getElementById(id).classList.remove('show'); }

// ── Pub / chain state ──
// activeChain (IIFE scoped)
// histPage/histFilter (IIFE scoped)
// waasActiveTenantId (IIFE scoped)

// ── Chain switcher ──
function chainDisplayName(c) { return CHAIN_NAMES[c] || c; }

function updateTopbarChain() {
  var el = document.getElementById('topbar-chain-label');
  if (el) el.textContent = chainDisplayName(activeChain);
}

function setActiveChain(c) {
  if (!CHAIN_NAMES[c]) return showToast(I18N.t("unsupported_chain") + c, 'error');
  activeChain = c;
  try { localStorage.setItem('px_chain', c); } catch (_) {}
  updateTopbarChain();
  closeChainPicker();
  syncChainSelectors();
  // 当前页面有链依赖的 loader 时，重新加载以反映新链（如非托管余额）
  if (typeof ncDash === 'function' && document.getElementById('page-noncustodial') && document.getElementById('page-noncustodial').classList.contains('active')) {
    try { ncDash(); } catch (e) { console.error(e); }
  }
  showToast(I18N.t("active_chain") + chainDisplayName(c), 'success');
}

// 将 activeChain 同步到各页面链下拉（waas-token-chain 用 chainId 值，其余用链名值）
function syncChainSelectors() {
  var chainId = CHAIN_IDS[activeChain];
  var byName = ['waas-addr-chain', 'waas-sweep-chain', 'waas-wd-chain', 'safe-chain'];
  byName.forEach(function (id) {
    var sel = document.getElementById(id);
    if (!sel) return;
    if (sel.querySelector('option[value="' + activeChain + '"]')) sel.value = activeChain;
  });
  var tok = document.getElementById('waas-token-chain');
  if (tok && chainId && tok.querySelector('option[value="' + chainId + '"]')) tok.value = String(chainId);
}

function toggleChainPicker() {
  var picker = document.getElementById('chain-picker');
  if (!picker) return;
  if (picker.classList.contains('open')) { closeChainPicker(); return; }
  var order = Object.keys(CHAIN_NAMES);
  picker.innerHTML = order.map(function (c) {
    return '<div class="chain-picker-item' + (c === activeChain ? ' active' : '') + '" onclick="event.stopPropagation();setActiveChain(\'' + c + '\')">' +
      '<span class="chain-picker-dot" style="background:' + (CHAIN_COLORS[c] || '#888') + '"></span>' +
      chainDisplayName(c) +
      (c === activeChain ? '<span class="chain-picker-check">✓</span>' : '') +
    '</div>';
  }).join('');
  picker.classList.add('open');
  var chainEl = document.getElementById('topbar-chain');
  if (chainEl) chainEl.classList.add('open');
}

function closeChainPicker() {
  var picker = document.getElementById('chain-picker');
  if (picker) picker.classList.remove('open');
  var chainEl = document.getElementById('topbar-chain');
  if (chainEl) chainEl.classList.remove('open');
}

// 点击其他区域关闭链选择器
document.addEventListener('click', function (e) {
  var picker = document.getElementById('chain-picker');
  if (!picker) return;
  var chainEl = document.getElementById('topbar-chain');
  if (picker.classList.contains('open') && (!chainEl || !chainEl.contains(e.target))) closeChainPicker();
});
// ── Navigation ──
// PAGE_TITLES (IIFE scoped)

function setupNav() {
  document.querySelectorAll('.nav-item[data-page]').forEach(function (el) {
    el.addEventListener('click', function () {
      var p = el.dataset.page;
      document.querySelectorAll('.nav-item').forEach(function (x) { x.classList.remove('active'); });
      el.classList.add('active');
      document.querySelectorAll('.page').forEach(function (x) { x.classList.remove('active'); });
      var target = document.getElementById('page-' + p);
      if (!target) return;
      target.classList.add('active');
      document.getElementById('page-title').textContent = I18N.t(PAGE_TITLES[p] || p);
      var loaders = { noncustodial: ncDash, mpc: mpcInit, waas: waasInit, datacenter: dcInit, safe: safeInit, aa: aaInit, payments: paymentsInit, rpc: rpcInit, lightrag: lightragInit, status: statusInit };
      try { if (loaders[p]) loaders[p](); } catch(e) { console.error('Page loader failed:', p, e); }
    });
  });
}

function initActivePage() {
  var loaders = { noncustodial: ncDash, mpc: mpcInit, waas: waasInit, datacenter: dcInit, safe: safeInit, aa: aaInit, payments: paymentsInit, rpc: rpcInit, lightrag: lightragInit, status: statusInit };
  var activePage = document.querySelector('.page.active');
  if (!activePage) return;
  var pageId = activePage.id.replace('page-', '');
  if (loaders[pageId]) { try { loaders[pageId](); } catch(e) { console.error('Init loader failed:', pageId, e); } }
}

// 语言切换后重载当前页 loader，让动态渲染内容（innerHTML）立即跟随语言
document.addEventListener('i18n:changed', function () {
  var loaders = { noncustodial: ncDash, mpc: mpcInit, waas: waasInit, datacenter: dcInit, safe: safeInit, aa: aaInit, payments: paymentsInit, rpc: rpcInit, lightrag: lightragInit, status: statusInit };
  // 带 dataset.loaded 防重复初始化的 loader，重载前先解除 guard 才会重新渲染
  var guardedRoots = { rpc: 'rpc-root', lightrag: 'lightrag-root' };
  var activePage = document.querySelector('.page.active');
  if (!activePage) return;
  var pageId = activePage.id.replace('page-', '');
  if (guardedRoots[pageId]) {
    var g = document.getElementById(guardedRoots[pageId]);
    if (g) delete g.dataset.loaded;
  }
  if (loaders[pageId]) { try { loaders[pageId](); } catch(e) { console.error('i18n reload failed:', pageId, e); } }
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function() { setupNav(); initActivePage(); updateTopbarChain(); syncChainSelectors(); setTimeout(function(){ if (typeof updateTopbar === 'function') updateTopbar(); }, 100); });
} else {
  setupNav();
  setTimeout(initActivePage, 50);
  updateTopbarChain();
  syncChainSelectors();
  setTimeout(function(){ if (typeof updateTopbar === 'function') updateTopbar(); }, 150);
}

// Tab clicks
document.addEventListener('click', function (e) {
  var btn = e.target.closest('.tab-btn');
  if (!btn) return;
  var s = btn.dataset.sub;
  // 无 data-sub 的 tab 按钮（如 Insights 子 tab Graph/Factors/RAG/ML，由模块自身切换）
  // 不进入 sub-panel 切换逻辑，否则会把所在 .sub-panel 隐藏且无法恢复 → 黑屏
  if (!s) return;
  var page = btn.closest('.page');
  if (!page) return;
  page.querySelectorAll('.tab-btn').forEach(function (x) { x.classList.remove('active'); });
  btn.classList.add('active');
  page.querySelectorAll('.sub-panel').forEach(function (x) { x.classList.remove('active'); });
  var subEl = document.getElementById('sub-' + s);
  if (subEl) subEl.classList.add('active');
  var subLoaders = {
    'nc-dash': ncDash, 'nc-send': ncSendLoad, 'nc-receive': ncReceiveLoad, 'nc-history': function () { histPage = 1; ncHistory(); },
    'nc-nft': function() {}, 'nc-settings': function() {},
    'mpc-reg': mpcReg, 'mpc-rec': mpcRec, 'mpc-dash': mpcDash, 'mpc-send': mpcSendLoad, 'mpc-recv': mpcReceiveLoad,
    'waas-dash-overview': waasLoadOverviewWithState, 'waas-dash-tokens': waasTokens, 'waas-dash-addresses': waasAddresses,
    'waas-dash-sweep': waasSweep, 'waas-dash-withdrawals': waasWithdrawals, 'waas-dash-api': waasApiTab,
    'dc-sub': dcLoadMySub, 'dc-overview': dcSwitchTab.bind(null, 'dc-overview'), 'dc-apikey': dcSwitchTab.bind(null, 'dc-apikey'), 'dc-docs': dcSwitchTab.bind(null, 'dc-docs'), 'safe-owned': safeLoadOwned, 'safe-participating': safeLoadParticipating, 'safe-create-fm': function () {}, 'safe-propose-fm': function () {},
    'safe-pending': function () {}, 'safe-owners': function () {}
  };
  if (subLoaders[s]) subLoaders[s]();
});

function switchModuleTab(pageId, subName) {
  document.querySelector('#page-' + pageId + ' .tab-btn[data-sub="' + subName + '"]').click();
}

// Quick Start 卡跳转（WaaS Overview）——别名到 switchModuleTab
function switchWaaSTab(subName) {
  switchModuleTab('waas', subName);
}

function getOrCreateAddr() {
  return (mpcCurrentAddr || user().walletAddress || '');
}

// ═══════════════════════════════════════════════

// ============================================================