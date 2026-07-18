// MODULE 3: WaaS - Self-Service B2B Wallet-as-a-Service
// ============================================================

// waasTenantData (IIFE scoped)
// waasSelectedPlan (IIFE scoped)

async function waasInit() {
  var me = await getMe();
  if (me.waas && me.waas.tenantId) {
    waasActiveTenantId = me.waas.tenantId;
    waasTenantData = me.waas;
    waasActiveApiKey = me.waas.apiKey || me.waas.api_key || '';
    document.getElementById('waas-intro').style.display = 'none';
    document.getElementById('waas-dashboard').style.display = 'block';
    waasLoadOverview(waasTenantData);
  } else {
    document.getElementById('waas-intro').style.display = 'block';
    document.getElementById('waas-dashboard').style.display = 'none';
  }
}

// Overview tab loader — only called when dashboard is already visible

// WaaS API fetch — uses tenant x-api-key auth
async function waasFetch(url, opts) {
  if (!opts) opts = {};
  if (!opts.headers) opts.headers = {};
  if (waasActiveApiKey) opts.headers['x-api-key'] = waasActiveApiKey;
  if (opts.body && typeof opts.body === 'object') {
    opts.body = JSON.stringify(opts.body);
    if (!opts.headers['Content-Type']) opts.headers['Content-Type'] = 'application/json';
  }
  var r = await fetch(API + url, opts);
  var j; try { j = await r.json(); } catch(e) { throw new Error('Invalid response'); }
  if (j.code && j.code !== 0) throw new Error(j.message || 'API error');
  return j.data !== undefined ? j.data : j;
}

function waasLoadOverviewWithState() {
  if (!waasTenantData && waasActiveTenantId) {
    // Re-fetch in case we lost state
    waasInit();
    return;
  }
  var d = waasTenantData;
  if (!d) { showToast('WaaS not activated', 'warning'); return; }
  document.getElementById('waas-intro').style.display = 'none';
  document.getElementById('waas-dashboard').style.display = 'block';
  waasLoadOverview(d);
}

function waasSelectPlan(planId) {
  waasSelectedPlan = planId;
  var names = { free: 'Free Trial', pro: 'Pro', enterprise: 'Enterprise' };
  var el = document.getElementById('waas-selected-plan');
  if (el) el.textContent = names[planId] || planId;
  // Highlight selected plan card
  document.querySelectorAll('.plan-card').forEach(function(c) { c.style.borderColor = 'transparent'; });
  var card = document.getElementById('plan-' + planId);
  if (card) card.style.borderColor = 'var(--success)';
  showToast('Plan selected: ' + (names[planId] || planId), 'success');
}

async function waasActivate() {
  try {
    var d = await afetch('/api/v2/saas/tenants/activate', { auth: 'none', method: 'POST', body: { planId: waasSelectedPlan } });
    showToast('WaaS activated!', 'success');
    waasTenantData = d;
    waasActiveTenantId = d.tenantId;
    waasActiveApiKey = d.apiKey || d.api_key || '';
    clearMe();
    document.getElementById('waas-intro').style.display = 'none';
    document.getElementById('waas-dashboard').style.display = 'block';
    var keyEl = document.getElementById('waas-api-key-display');
    if (keyEl) keyEl.textContent = d.apiKey || '—';
    waasLoadOverview(d);
  } catch (e) { showToast(e.message, 'error'); }
}

async function waasUpgradePlan(planId) {
  try {
    var d = await afetch('/api/v2/subscription/subscribe', { method: 'POST', body: { planId: planId } });
    var names = { free: 'Free', pro: 'Pro', enterprise: 'Enterprise' };
    showToast('Upgraded to ' + (names[planId] || planId) + ' plan!', 'success');
    document.getElementById('waas-ov-sub-status').textContent = '🟢 ' + (names[planId] || planId) + ' (Active)';
    document.getElementById('waas-ov-plan').textContent = names[planId] || planId;
    document.getElementById('waas-upgrade-status').innerHTML = '<span style="color:var(--success)">✅ Switched to ' + (names[planId] || planId) + ' plan</span>';
  } catch (e) { showToast(e.message, 'error'); document.getElementById('waas-upgrade-status').innerHTML = '<span style="color:var(--error)">❌ ' + e.message + '</span>'; }
}


function waasSweep() {
  // Load and render saved sweep targets
  var targets = [];
  try { targets = JSON.parse(waasTenantData.sweepTargets || '[]'); } catch(_) {}
  if (!targets.length && waasTenantData.sweepAddress) {
    // migrate legacy single target
    targets = [{ address: waasTenantData.sweepAddress, chain: 'sepolia' }];
  }
  waasRenderSweepTargets(targets);
  // Load schedule
  if (waasTenantData) {
    if (waasTenantData.sweepFrequency) { var ef = document.getElementById('waas-sweep-freq'); if (ef) ef.value = waasTenantData.sweepFrequency; }
    if (waasTenantData.sweepMinBalance) { var emb = document.getElementById('waas-sweep-min'); if (emb) emb.value = waasTenantData.sweepMinBalance; }
    if (waasTenantData.sweepToken) { var et = document.getElementById('waas-sweep-token'); if (et) et.value = waasTenantData.sweepToken; }
  }
  waasSweepLog();
}

async function waasSweepLog() {
  var el = document.getElementById('waas-sweep-log');
  if (!el) return;
  try {
    var d = await waasFetch('/api/v2/saas/tenants/' + waasActiveTenantId + '/sweeps');
    var items = d.items || d.data || d || [];
    if (!items.length) { el.innerHTML = '<div style="text-align:center;padding:30px;font-size:13px;color:var(--text-tertiary)">📋 No sweep records yet</div>'; return; }
    el.innerHTML = items.map(function(s) {
      return '<div style="display:flex;align-items:center;gap:12px;padding:10px 14px;border-bottom:1px solid var(--border);font-size:12px">' +
        '<span style="color:var(--text-tertiary);min-width:140px">' + (s.created_at || s.createdAt || '') + '</span>' +
        '<span style="font-family:monospace;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + (s.tx_hash || s.txHash || '') + '</span>' +
        '<span style="min-width:80px">' + (s.amount || '0') + ' ' + (s.token_symbol || s.tokenSymbol || '') + '</span>' +
        '<span style="color:' + (s.status === 'confirmed' ? 'var(--success)' : 'var(--text-tertiary)') + ';min-width:80px;text-align:right">' + (s.status || '') + '</span>' +
        '</div>';
    }).join('');
  } catch(e) {
    el.innerHTML = '<div style="text-align:center;padding:30px;font-size:13px;color:var(--text-tertiary)">📋 No sweep records yet</div>';
  }
}

// Render sweep targets list
function waasRenderSweepTargets(targets) {
  var el = document.getElementById('waas-sweep-targets');
  if (!el) return;
  if (!targets || !targets.length) {
    el.innerHTML = '<div style="text-align:center;padding:20px;font-size:12px;color:var(--text-muted)">No targets configured. Add one below.</div>';
    return;
  }
  var html = '';
  for (var i = 0; i < targets.length; i++) {
    var t = targets[i];
    html += '<div style="display:flex;align-items:center;gap:12px;padding:10px 14px;background:var(--bg-card);border:1px solid var(--border);border-radius:8px">' +
      '<div style="flex:1;min-width:0"><div style="font-family:SF Mono,Fira Code,monospace;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + (t.address || '') + '</div></div>' +
      '<div style="min-width:80px;text-align:center"><span style="font-size:11px;font-weight:600;text-transform:uppercase;padding:2px 8px;border-radius:4px;background:var(--surface);color:var(--text-brand)">' + (t.chain || 'sepolia') + '</span></div>' +
      '<button class="btn btn-outline" style="font-size:11px;padding:4px 10px;color:var(--danger);border-color:var(--danger)" onclick="waasRemoveSweepTarget(' + i + ')">✕ Remove</button>' +
      '</div>';
  }
  el.innerHTML = html;
}

// Add a new sweep target
async function waasAddSweepTarget() {
  var addr = document.getElementById('waas-sweep-addr').value.trim();
  var chain = document.getElementById('waas-sweep-chain').value;
  if (!addr || addr.length < 10) return showToast('Enter a valid destination address', 'error');
  if (!waasActiveTenantId) return showToast('Activate WaaS first', 'error');

  var targets = [];
  try { targets = JSON.parse(waasTenantData.sweepTargets || '[]'); } catch(_) {}
  if (!targets.length && waasTenantData.sweepAddress) {
    targets = [{ address: waasTenantData.sweepAddress, chain: 'sepolia' }];
  }

  // Check for duplicate chain
  for (var i = 0; i < targets.length; i++) {
    if (targets[i].chain === chain) return showToast('Target for ' + chain.toUpperCase() + ' already exists. Remove it first.', 'error');
  }

  targets.push({ address: addr, chain: chain });
  try {
    await afetch('/api/v2/saas/tenants/' + waasActiveTenantId + '/config', {
      method: 'PATCH',
      body: { sweepTargets: JSON.stringify(targets), sweepAddress: addr }
    });
    waasTenantData.sweepTargets = JSON.stringify(targets);
    waasTenantData.sweepAddress = addr;
    document.getElementById('waas-sweep-addr').value = '';
    waasRenderSweepTargets(targets);
    showToast('Sweep target added for ' + chain.toUpperCase(), 'success');
  } catch (e) { showToast(e.message, 'error'); }
}

// Remove a sweep target
async function waasRemoveSweepTarget(index) {
  if (!waasActiveTenantId) return showToast('Activate WaaS first', 'error');
  var targets = [];
  try { targets = JSON.parse(waasTenantData.sweepTargets || '[]'); } catch(_) {}
  if (index < 0 || index >= targets.length) return;
  var removed = targets[index].chain;
  targets.splice(index, 1);
  try {
    await afetch('/api/v2/saas/tenants/' + waasActiveTenantId + '/config', {
      method: 'PATCH',
      body: { sweepTargets: JSON.stringify(targets) }
    });
    waasTenantData.sweepTargets = JSON.stringify(targets);
    waasRenderSweepTargets(targets);
    showToast('Target for ' + removed.toUpperCase() + ' removed', 'success');
  } catch (e) { showToast(e.message, 'error'); }
}

// Save current sweep target without adding to list (for first save)
async function waasSaveSweepSingle() {
  var addr = document.getElementById('waas-sweep-addr').value.trim();
  var chain = document.getElementById('waas-sweep-chain').value;
  if (!addr || addr.length < 10) return showToast('Enter a valid destination address', 'error');
  if (!waasActiveTenantId) return showToast('Activate WaaS first', 'error');
  try {
    await afetch('/api/v2/saas/tenants/' + waasActiveTenantId + '/config', {
      method: 'PATCH',
      body: { sweepAddress: addr, sweepChain: chain }
    });
    waasTenantData.sweepAddress = addr;
    waasTenantData.sweepChain = chain;
    showToast('Sweep target saved for ' + chain.toUpperCase(), 'success');
  } catch (e) { showToast(e.message, 'error'); }
}

// Legacy single-target save (kept for backward compat)
async function waasSaveSweepAddr() {
  var target = document.getElementById('waas-sweep-addr').value.trim();
  if (!target || target.length < 10) return showToast('Enter valid destination address', 'error');
  if (!waasActiveTenantId) return showToast('Activate WaaS first', 'error');
  try {
    await afetch('/api/v2/saas/tenants/' + waasActiveTenantId + '/config', {
      method: 'PATCH',
      body: { sweepAddress: target }
    });
    if (waasTenantData) waasTenantData.sweepAddress = target;
    showToast('Sweep destination saved', 'success');
  } catch (e) { showToast(e.message, 'error'); }
}

async function waasSaveSweepSchedule() {
  if (!waasActiveTenantId) return showToast('Activate WaaS first', 'error');
  var freq = document.getElementById('waas-sweep-freq').value;
  var min = document.getElementById('waas-sweep-min').value;
  var token = document.getElementById('waas-sweep-token').value;
  try {
    await afetch('/api/v2/saas/tenants/' + waasActiveTenantId + '/config', {
      method: 'PATCH',
      body: { sweepFrequency: freq, sweepMinBalance: Number(min), sweepToken: token }
    });
    if (waasTenantData) { waasTenantData.sweepFrequency = freq; waasTenantData.sweepMinBalance = min; waasTenantData.sweepToken = token; }
    showToast('Sweep schedule saved', 'success');
  } catch (e) { showToast(e.message, 'error'); }
}

async function waasTriggerSweep() {
  if (!waasActiveTenantId) return showToast('Activate WaaS first', 'error');
  var targets = [];
  try { targets = JSON.parse(waasTenantData.sweepTargets || '[]'); } catch(_) {}
  if (!targets.length) return showToast('Add at least one sweep target first', 'error');
  var token = document.getElementById('waas-sweep-token').value;
  try {
    var d = await afetch('/api/v2/saas/sweep', {
      method: 'POST',
      body: { token: token }
    });
    showToast('Sweep triggered! ' + (d.message || d.txHash || ''), 'success');
  } catch (e) { showToast(e.message, 'error'); }
}

async function waasGenerateApiKey() {
  if (!waasActiveTenantId) return showToast('Activate WaaS first', 'error');
  try {
    var d = await waasFetch('/api/v2/saas/tenants/' + waasActiveTenantId + '/apikey', { method: 'POST' });
    if (d.apiKey) {
      document.getElementById('waas-api-key-display').textContent = d.apiKey;
      showToast('API Key generated', 'success');
    }
  } catch (e) { showToast(e.message, 'error'); }
}

async function waasRotateApiKey() {
  if (!waasActiveTenantId) return showToast('Activate WaaS first', 'error');
  try {
    var d = await waasFetch('/api/v2/saas/tenants/' + waasActiveTenantId + '/apikey/rotate', { method: 'POST' });
    if (d.apiKey) {
      document.getElementById('waas-api-key-display').textContent = d.apiKey;
      showToast('API Key rotated', 'success');
    }
  } catch (e) { showToast(e.message, 'error'); }
}

async function waasDeleteApiKey() {
  if (!confirm('Delete API key? Existing integrations will stop working.')) return;
  if (!waasActiveTenantId) return showToast('Activate WaaS first', 'error');
  try {
    await waasFetch('/api/v2/saas/tenants/' + waasActiveTenantId + '/apikey', { method: 'DELETE' });
    document.getElementById('waas-api-key-display').textContent = '—';
    showToast('API Key deleted', 'success');
  } catch (e) { showToast(e.message, 'error'); }
}
// API & SDK tab loader
function waasApiTab() {
  var keyEl = document.getElementById('waas-api-key-display');
  if (!keyEl) return;
  var apiKey = waasTenantData && (waasTenantData.apiKey || waasTenantData.api_key) || '';
  if (apiKey) {
    keyEl.textContent = apiKey;
  } else {
    keyEl.textContent = '—';
  }
  // Also show tenant ID
  var tidEl = document.getElementById('waas-api-tid');
  if (tidEl && waasActiveTenantId) {
    tidEl.textContent = waasActiveTenantId;
  }
}

// async (removed)
function waasLoadOverview(t) {
  if (!t) return;
  var tid = waasActiveTenantId || t.tenantId || '';
  var plan = t.plan || 'Free';
  var isActive = t.status === 'active';
  var el;
  el = document.getElementById('waas-ov-status'); if (el) { el.textContent = isActive ? '● Active' : 'Inactive'; el.style.color = isActive ? 'var(--success,#4caf50)' : 'var(--warning,#ff9800)'; }
  el = document.getElementById('waas-ov-plan'); if (el) el.textContent = 'Plan: ' + plan;
  el = document.getElementById('waas-ov-tid'); if (el) el.textContent = tid;
  el = document.getElementById('waas-ov-addr'); if (el) el.textContent = t.addressCount || '0';
  el = document.getElementById('waas-ov-wd'); if (el) el.textContent = t.withdrawalCount || '0';
  el = document.getElementById('waas-ov-sub-status'); if (el) el.textContent = '🟢 ' + plan + ' (Active)';
  waasTokens();
}

async function waasTokens() {
  var listEl = document.getElementById('waas-tokens-list');
  if (!listEl) return;
  if (!waasActiveTenantId) { 
    listEl.innerHTML = '<div class="empty">Activate WaaS first</div>'; 
    return; 
  }
  try {
    var d = await waasFetch('/api/v2/saas/tenants/' + waasActiveTenantId + '/tokens');
    var tokens = d.items || d.data || d || [];
    if (!tokens.length) { listEl.innerHTML = '<div class="empty" style="padding:32px 24px;text-align:center"><div style="font-size:40px;margin-bottom:14px;opacity:0.8">&#x1fa99;</div><div class="empty-text">No Tokens Configured</div><div class="empty-sub" style="font-size:12px;color:var(--text-dim);line-height:1.6;max-width:420px;margin:6px auto 0">Use the form above to add ERC-20 tokens. Deposits for unlisted tokens are ignored during sweep.</div></div>'; return; }
    listEl.innerHTML = tokens.map(function(t) {
      var sym = t.token_symbol || t.symbol || '—';
      var addr = (t.contract_address || '').slice(0, 8) + '...' + (t.contract_address || '').slice(-6);
      return '<div class="card" style="display:flex;justify-content:space-between;align-items:center;padding:14px 16px;margin-bottom:8px">' +
        '<div><div style="font-weight:600">' + sym + ' <span style="font-size:10px;color:var(--warning)">' + (
          t.chain_id === 1 ? 'ETH' : t.chain_id === 56 ? 'BSC' : t.chain_id === 8453 ? 'BASE' : 'SEPOLIA'
        ) + '</span></div>' +
        '<div style="font-size:11px;color:var(--text-muted);font-family:monospace">' + (t.contract_address || '') + '</div></div>' +
        '<div style="text-align:right"><div style="font-size:11px;color:var(--text-muted)">Min Sweep</div><div style="font-size:13px;font-weight:600;color:var(--gold-light)">' + (t.min_sweep_amount || '0') + ' ' + sym + '</div></div></div>';
    }).join('');
  } catch (e) { console.error('waasTokens:', e); }
}

async function waasAddToken() {
  if (!waasActiveTenantId) return showToast('Activate WaaS first', 'error');
  var contract = document.getElementById('waas-token-contract').value.trim();
  var symbol = document.getElementById('waas-token-symbol').value.trim();
  var decimals = parseInt(document.getElementById('waas-token-decimals').value) || 18;
  if (!contract || !symbol) return showToast('Contract + symbol required', 'error');
  try {
    await waasFetch('/api/v2/saas/tenants/' + waasActiveTenantId + '/tokens', {
      method: 'POST', body: { chainId: parseInt(document.getElementById('waas-token-chain').value) || 11155111, tokenSymbol: symbol, contractAddress: contract, decimals: decimals, minSweepAmount: 0 }
    });
    showToast('Token added', 'success');
    waasTokens();
    document.getElementById('waas-token-contract').value = '';
    document.getElementById('waas-token-symbol').value = '';
  } catch (e) { showToast(e.message, 'error'); }
}

function waasAddresses() {
  if (!waasActiveTenantId) {
    document.getElementById('waas-addr-list').innerHTML = '<div class="empty">Activate WaaS first</div>';
    return;
  }
  waasAddressLoad();
}

function waasAddressLoad() {
  waasFetch('/api/v2/saas/addresses').then(function(d) {
    var items = d.items || d.data || d || [];
    var el = document.getElementById('waas-addr-list');
    if (!items.length) { el.innerHTML = '<div class="empty" style="padding:32px 24px;text-align:center"><div style="font-size:40px;margin-bottom:14px;opacity:0.8">&#x1f4cd;</div><div class="empty-text">No Deposit Addresses</div><div class="empty-sub" style="font-size:12px;color:var(--text-dim);line-height:1.6;max-width:420px;margin:6px auto 0">Create one above or use <code style="background:var(--dark-600);padding:1px 5px;border-radius:3px;font-size:11px">POST /api/v2/saas/address</code></div></div>'; return; }
    el.innerHTML = items.map(function(a) {
      var addr = a.address || '';
      return '<div class="card" style="display:flex;justify-content:space-between;align-items:center;padding:14px 16px;margin-bottom:8px">' +
        '<div style="flex:1;min-width:0"><div style="font-size:13px;font-family:monospace;word-break:break-all;margin-bottom:4px;color:var(--text-brand,#6c8cff)">' + addr + '</div>' +
        '<div style="font-size:11px;color:var(--text-muted)">User ID: ' + (a.external_user_id || '—') + ' | Chain: ' + (a.chain || 'sepolia') + '</div></div>' +
        '<div style="text-align:right;margin-left:12px;white-space:nowrap"><div style="font-size:15px;font-weight:600;color:var(--gold-light)">' + (a.balance || '0') + '</div><div style="font-size:11px;color:var(--text-muted)">' + (a.token_symbol || a.token || 'ETH') + '</div></div>' +
        '</div>';
    }).join('');
  }).catch(function(e) { document.getElementById('waas-addr-list').innerHTML = '<div class="empty"><div class="empty-text" style="color:var(--error)">Failed to load</div></div>'; });
}

async function waasAddressCreate() {
  if (!waasActiveTenantId) return showToast('Activate WaaS first', 'error');
  var uid = document.getElementById('waas-addr-uid').value.trim();
  var chain = document.getElementById('waas-addr-chain').value;
  if (!uid) return showToast('Enter external user ID', 'error');
  try {
    var d = await waasFetch('/api/v2/saas/address', {
      method: 'POST',
      body: { externalUserId: uid, chain: chain }
    });
    showToast('Address created: ' + (d.address || '').slice(0, 12) + '...', 'success');
    waasAddressLoad();
  } catch (e) { showToast(e.message, 'error'); }
}
window.generateHotWallet = async function() {
  if (!waasActiveTenantId) { showToast('Activate WaaS first', 'error'); return; }
  try {
    showToast('Generating Hot Wallet...', 'info');
    var d = await waasFetch('/api/v2/saas/tenants/' + waasActiveTenantId + '/hot-wallet', { method: 'POST', body: { chainId: 11155111 } });
    if (d && d.address) waasTenantData.hotWalletAddress = d.address;
    showToast('Hot Wallet created: ' + d.address.slice(0,10) + '...', 'success');
    // Refresh withdrawals panel to show new hot wallet
    if (typeof waasWithdrawals === 'function') waasWithdrawals();
  } catch(e) { showToast(e.message, 'error'); }
};

// === Withdrawals Tab ===
function waasWithdrawals() {
  waasHotWalletLoad();
  waasWithdrawRulesLoad();
}

async function waasHotWalletLoad() {
  var el = document.getElementById('waas-hotwallets');
  if (!el) { console.log('HWL: el not found'); return; }
  if (!waasActiveTenantId) { console.log('HWL: no tid'); return; }
  console.log('HWL: tid=' + waasActiveTenantId + ' tenData=' + JSON.stringify(waasTenantData));
  var hwAddr = waasTenantData && waasTenantData.hotWalletAddress || '';
  if (hwAddr) {
    var ETH_SVG = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="12" fill="#627EEA"/><path d="M12 3v6.75l5.25 2.36L12 3zM12 3L6.75 12.11 12 9.75V3zM12 16.5v4.5l5.25-7.29L12 16.5zM12 21v-4.5l-5.25-2.79L12 21z" fill="#fff" fill-opacity=".6"/><path d="M12 15.75l5.25-3.64L12 9.75v6zM6.75 12.11L12 15.75v-6L6.75 12.11z" fill="#fff"/></svg>';
    var ARB_SVG = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="12" fill="#28A0F0"/><path d="M14.2 15.1l-1.1-2.4 2.1-3.3c.1-.2 0-.3-.2-.1l-5 3.2c-.1.1-.1.2 0 .3l1.8 1.2-2.4 3.7c-.1.2-.2.2-.3 0L7 14.3c-.1-.1-.1-.2 0-.3l7.2-4.6c.1-.1.3 0 .2.1l-2.3 3.6 1.2.8 2.3-3.6c.1-.1.3 0 .2.1l-2.1 3.3 1.1 2.4c.3.6.5.8-.4.8h-2.2c-.6 0-.8-.3-1-.8z" fill="#fff"/></svg>';
    var BASE_SVG = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="12" fill="#0052FF"/><path d="M12 21c5 0 9-4 9-9s-4-9-9-9-9 4-9 9 4 9 9 9z" fill="#0052FF"/><path d="M12 4.5c-1.7 0-3.3.6-4.5 1.6l11.4 11.4c1-1.2 1.6-2.8 1.6-4.5 0-3.9-3.1-7-8.5-7z" fill="#fff" fill-opacity=".4"/><path d="M16.5 7.5c-1.2-1-2.8-1.6-4.5-1.6C8.1 6 5 9.1 5 13c0 1.7.6 3.3 1.6 4.5L16.5 7.5z" fill="#fff"/></svg>';
    var BSC_SVG = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="12" fill="#F3BA2F"/><path d="M7.5 12l1.65-1.65L12 13.2l2.83-2.85L16.5 12 12 16.5 7.5 12zM12 7.5l2.85 2.85L16.5 8.7 12 4.2 7.5 8.7l1.65 1.65L12 7.5z" fill="#fff"/></svg>';
    var OP_SVG = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="12" fill="#FF0420"/><path d="M9.5 7c-1.2 0-2.2.9-2.5 2-.1.3-.1.7 0 1 .2.7.7 1.2 1.3 1.5.2.1.5.2.7.2.6 0 1.1-.3 1.4-.8l.3-.5c.2-.4.7-.5 1.1-.3l.3.3c.4.4 1 .6 1.6.5.7-.1 1.3-.5 1.7-1.1.2-.3.3-.7.3-1 0-1.1-.9-2-2-2-.4 0-.8.1-1.1.4l-.3.3c-.3.3-.8.3-1.1 0l-.3-.3c-.3-.3-.7-.5-1.1-.4-.2-.2-.6-.3-.8-.3zm5 3.5c-.4 0-.8.1-1.1.4l-.3.3c-.3.3-.8.3-1.1 0l-.3-.3c-.3-.3-.7-.4-1.1-.4-.3 0-.6.1-.9.3.5 1.1 1.6 1.9 2.9 1.9 1.3 0 2.4-.8 2.9-1.9-.3-.2-.6-.3-1-.3z" fill="#fff"/></svg>';
    var POL_SVG = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="12" fill="#8247E5"/><path d="M17 8.5c-.3-.3-.7-.4-1.1-.3l-4.5 1c-.3.1-.5.3-.6.6l-1 4.5c-.1.4.1.8.4 1 .3.3.7.4 1.1.3l4.5-1c.3-.1.5-.3.6-.6l1-4.5c.1-.4-.1-.7-.4-1z" fill="#fff"/></svg>';
    var chains = [
      { id:'ethereum', name:'Ethereum', symbol:'ETH', svg:ETH_SVG, explorer:'https://etherscan.io/address/' },
      { id:'arbitrum', name:'Arbitrum', symbol:'ETH', svg:ARB_SVG, explorer:'https://arbiscan.io/address/' },
      { id:'base', name:'Base', symbol:'ETH', svg:BASE_SVG, explorer:'https://basescan.org/address/' },
      { id:'bsc', name:'BSC', symbol:'BNB', svg:BSC_SVG, explorer:'https://bscscan.com/address/' },
      { id:'optimism', name:'Optimism', symbol:'ETH', svg:OP_SVG, explorer:'https://optimistic.etherscan.io/address/' },
      { id:'polygon', name:'Polygon', symbol:'POL', svg:POL_SVG, explorer:'https://polygonscan.com/address/' },
      { id:'sepolia', name:'Sepolia', symbol:'sETH', svg:ETH_SVG, explorer:'https://sepolia.etherscan.io/address/' }
    ];
    var wAddr = hwAddr;
    var selectedPlan = (waasTenantData && waasTenantData.planName) || 'Free Trial';
    var tidShort = waasActiveTenantId ? waasActiveTenantId.slice(0, 8) : '';
    var rows = '';
    for (var i = 0; i < chains.length; i++) {
      var c = chains[i];
      rows += '<div class="waas-hw-card">' +
        '<span class="waas-hw-chain-icon">' + c.svg + '</span>' +
        '<span class="waas-hw-chain-name">' + c.name + '</span>' +
        '<code class="waas-hw-card-addr">' + wAddr.slice(0, 10) + '…' + wAddr.slice(-8) + '</code>' +
        '<span class="waas-hw-balance-value">0.00<span class="waas-hw-balance-sym"> ' + c.symbol + '</span></span>' +
        '<div class="waas-hw-card-actions">' +
          '<button class="waas-hw-btn waas-hw-btn-copy" onclick="waasCopyAddrEl(' + JSON.stringify(wAddr) + ')">📋</button>' +
          '<a class="waas-hw-btn waas-hw-btn-explorer" href="' + c.explorer + wAddr + '" target="_blank" rel="noopener">↗</a>' +
        '</div>' +
      '</div>';
    }
    el.innerHTML = '<div class="waas-hw-summary">' +
      '<div class="waas-hw-summary-item"><span class="waas-hw-summary-label">Hot Wallet</span><code class="waas-hw-summary-addr">' + wAddr.slice(0, 10) + '…' + wAddr.slice(-8) + '</code><button class="waas-hw-summary-copy" onclick="waasCopyAddrEl(' + JSON.stringify(wAddr) + ')">📋</button></div>' +
      '<div class="waas-hw-summary-item"><span class="waas-hw-summary-label">Plan</span><span class="waas-hw-summary-val">' + selectedPlan + '</span></div>' +
      '<div class="waas-hw-summary-item"><span class="waas-hw-summary-label">Tenant ID</span><span class="waas-hw-summary-val">' + tidShort + '</span></div>' +
      '</div>' +
      '<div class="waas-hw-cards">' + rows + '</div>' +
      '<button class="btn btn-sm waas-hw-regen" onclick="window.generateHotWallet()">🪙 Regenerate</button>';
  } else {
    el.innerHTML = '<button class="btn btn-sm" style="background:var(--success);color:#fff" onclick="window.generateHotWallet()">🪙 Create Hot Wallet</button><span class="waas-hotwallet-hint">Sepolia Testnet</span>';
  }
}

async function waasWithdrawRulesLoad() {
  var el = document.getElementById('waas-wd-queue');
  if (!el || !waasActiveTenantId) return;
  try {
    var d = await waasFetch('/api/v2/saas/withdrawals');
    var items = d.items || d.data || d || [];
    if (!items.length) { el.innerHTML = '<div style="text-align:center;padding:30px;font-size:13px;color:var(--text-tertiary)">No withdrawal requests</div>'; return; }
    el.innerHTML = items.map(function(w) {
      return '<div style="display:flex;align-items:center;gap:12px;padding:10px 14px;border-bottom:1px solid var(--border);font-size:12px">' +
        '<span style="color:var(--text-tertiary);min-width:140px">' + (w.created_at || w.createdAt || '') + '</span>' +
        '<span style="font-family:monospace;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + (w.to_address || w.toAddress || '') + '</span>' +
        '<span style="min-width:80px">' + (w.amount || '0') + ' ' + (w.token_symbol || w.tokenSymbol || '') + '</span>' +
        '<span style="min-width:80px;text-align:right;color:' + (w.status === 'confirmed' ? 'var(--success)' : w.status === 'approved' ? 'var(--brand)' : 'var(--text-tertiary)') + '">' + (w.status || '') + '</span>' +
        '</div>';
    }).join('');
  } catch(e) {
    el.innerHTML = '<div style="text-align:center;padding:30px;font-size:13px;color:var(--text-tertiary)">No withdrawal requests</div>';
  }
}

// Retry withdrawal — called from waas-extras.js button handlers
async function waasRetryWithdrawal(wid) {
  if (!confirm('Retry this withdrawal?')) return;
  try {
    var r = await waasFetch('/api/v2/saas/withdraw/' + wid + '/retry', { method: 'POST' });
    showToast('Retry queued', 'success');
    waasWithdrawRulesLoad();
  } catch (e) { showToast(e.message, 'error'); }
}