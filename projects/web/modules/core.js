// INFRAX CORE //
var API = "";


  // ── Shared module state (was global vars) ──
  var _sig = '', _ts = '', _addr = '';
  var _me = null;
  var activeChain = 'sepolia';
  var histPage = 1, histFilter = 'all';
  var waasActiveTenantId = '';
  var paymentEnabled = false;
  var ncCustomTokens = [];
  var mpcCurrentEmail = '', mpcCurrentAddr = '', mpcActivated = false;
  var mpcEmail = '';
  var waasTenantData = null;
  var waasSelectedPlan = 'free';
  var safeEnabled = false;

  var PAGE_TITLES = { noncustodial:'Non-Custodial Wallet', mpc:'MPC Wallet', waas:'WaaS · B2B Wallet Service', datacenter:'Data Center · On-Chain API', safe:'Multi-Sig Vault', payment:'Payment' };

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
  if (!a) throw new Error('Not connected');
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
  if (!w) throw new Error('No wallet detected');
  _ts = Date.now().toString();
  _addr = a;
  _sig = await Promise.race([w.request({ method: "personal_sign", params: ["InfraX auth: " + _ts, a] }), new Promise(function(_, r){ setTimeout(function(){ r(new Error("MetaMask timeout")); }, 10000); })]);
  localStorage.setItem('px_sig', _sig);
  localStorage.setItem('px_ts', _ts);
}

// ── API ──
// opts.auth: 'wallet' = require signature, 'none' = address only, default 'wallet'
async function afetch(url, opts) {
  if (!opts) opts = {};
  if (!opts.headers) opts.headers = {};
  var a = user().walletAddress;
  if (a) {
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
    if (r.status === 401) { throw new Error('Wallet auth required — please reconnect'); }
    var j; try { j = await r.json(); } catch(e) { throw new Error('Invalid response'); }
    if (j.code && j.code !== 0) throw new Error(j.message || 'API error');
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
    '/api/v2/payment/methods': { methods: [
      { id: 'stripe', icon: '💳', name: 'Credit Card', description: 'Visa/MC/UnionPay', minAmount: 1, maxAmount: 99999, currency: 'USD' },
      { id: 'wallet', icon: '🔐', name: 'Wallet Transfer', description: 'Connected wallet', minAmount: 0.001, maxAmount: 100, currency: 'ETH', chains: ['sepolia'] },
      { id: 'qr', icon: '📱', name: 'QR Scan', description: 'External wallet', minAmount: 0.001, maxAmount: 100, currency: 'ETH', chains: ['sepolia'] },
      { id: 'x402', icon: '⚡', name: 'x402 Protocol', description: 'HTTP 402 Agent Pay', minAmount: 0.001, maxAmount: 100, currency: 'ETH', chains: ['sepolia'] }
    ], defaultMethod: 'stripe' },
    '/api/v2/payment/orders': { orders: [] }
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
  navigator.clipboard.writeText(txt).then(function () { showToast('Copied!', 'success'); }).catch(function () { showToast('Copy failed', 'error'); });
}

// ── Modal ──
function openModal(id) { document.getElementById(id).classList.add('show'); }
function closeModal(id) { document.getElementById(id).classList.remove('show'); }

// ── Pub / chain state ──
// activeChain (IIFE scoped)
// histPage/histFilter (IIFE scoped)
// waasActiveTenantId (IIFE scoped)
// ── Navigation ──
// PAGE_TITLES (IIFE scoped)

function setupNav() {
  document.querySelectorAll('.nav-item[data-page]').forEach(function (el) {
    el.addEventListener('click', function () {
      document.querySelectorAll('.nav-item').forEach(function (x) { x.classList.remove('active'); });
      el.classList.add('active');
      var p = el.dataset.page;
      document.querySelectorAll('.page').forEach(function (x) { x.classList.remove('active'); });
      var target = document.getElementById('page-' + p);
      if (!target) return;
      target.classList.add('active');
      document.getElementById('page-title').textContent = PAGE_TITLES[p] || p;
      var loaders = { noncustodial: ncDash, mpc: mpcInit, waas: waasInit, datacenter: dcInit, safe: safeInit, payment: paymentInit };
      try { if (loaders[p]) loaders[p](); } catch(e) { console.error('Page loader failed:', p, e); }
    });
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setupNav);
} else {
  setupNav();
}

// Tab clicks
document.addEventListener('click', function (e) {
  var btn = e.target.closest('.tab-btn');
  if (!btn) return;
  var page = btn.closest('.page');
  if (!page) return;
  page.querySelectorAll('.tab-btn').forEach(function (x) { x.classList.remove('active'); });
  btn.classList.add('active');
  var s = btn.dataset.sub;
  page.querySelectorAll('.sub-panel').forEach(function (x) { x.classList.remove('active'); });
  var subEl = document.getElementById('sub-' + s);
  if (subEl) subEl.classList.add('active');
  var subLoaders = {
    'nc-dash': ncDash, 'nc-send': ncSendLoad, 'nc-receive': ncReceiveLoad, 'nc-history': function () { histPage = 1; ncHistory(); },
    'nc-nft': ncNFT, 'nc-settings': ncSettings,
    'mpc-reg': mpcReg, 'mpc-rec': mpcRec, 'mpc-dash': mpcDash, 'mpc-send': mpcSendLoad, 'mpc-recv': mpcReceiveLoad,
    'waas-dash-overview': waasLoadOverviewWithState, 'waas-dash-tokens': waasTokens, 'waas-dash-addresses': waasAddresses,
    'waas-dash-sweep': waasSweep, 'waas-dash-withdrawals': waasWithdrawals, 'waas-dash-api': waasApiTab,
    'dc-overview': dcSwitchTab.bind(null, 'dc-overview'), 'dc-apikey': dcSwitchTab.bind(null, 'dc-apikey'), 'dc-docs': dcSwitchTab.bind(null, 'dc-docs'), 'dc-explorer': dcSwitchTab.bind(null, 'dc-explorer'), 'safe-owned': safeLoadOwned, 'safe-participating': safeLoadParticipating, 'safe-create-fm': function () {}, 'safe-propose-fm': function () {}, 'pay-create': function() {}, 'pay-history': paymentLoadHistory, 'pay-methods': paymentLoadMethods,
    'safe-pending': function () {}, 'safe-owners': function () {}
  };
  if (subLoaders[s]) subLoaders[s]();
});

function switchModuleTab(pageId, subName) {
  document.querySelector('#page-' + pageId + ' .tab-btn[data-sub="' + subName + '"]').click();
}

function getOrCreateAddr() {
  return (mpcCurrentAddr || user().walletAddress || '');
}

// ═══════════════════════════════════════════════

// ============================================================