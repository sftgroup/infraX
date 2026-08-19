async function safeInit() {
  var intro = document.getElementById("safe-intro");
  var dash = document.getElementById("safe-dashboard-area");
  if (!intro || !dash) return;
  // Restore from localStorage first
  if (localStorage.getItem("px_safe_enabled")) safeEnabled = true;
  // Also load from API
  var me = await getMe();
  if (me.safe && me.safe.enabled) safeEnabled = true;
  if (safeEnabled) {
    intro.style.display = "none";
    dash.style.display = "block";
    safeLoadOwned();
  } else {
    intro.style.display = "block";
    dash.style.display = "none";
  }
}

function safeActivateIntro() {
  safeEnabled = true;
  // Persist to localStorage — survives page refresh, reconnect
  localStorage.setItem("px_safe_enabled", "1");
  clearMe();
  safeInit();
  showToast("Safe Vault enabled!", "success");
}

async function safeLoadOwned() {
  var list = document.getElementById('safe-owned-list');
  if (!list) return;
  try {
    var d = await afetch('/api/vault/safe/owned');
    var safes = d.items || [];
    if (!safes.length) {
      list.innerHTML = `<div class="empty" style="padding:40px"><div class="empty-icon" style="font-size:48px">🔐</div><div class="empty-text" style="font-size:16px;margin:12px 0">No Safe wallets yet</div><div class="empty-sub" style="margin-bottom:20px">Create a multi-sig vault to start managing shared assets</div><button class="btn btn-primary" onclick="document.querySelector('[data-sub=safe-create-fm]').click()" style="padding:10px 24px">🛡️ Create Vault</button></div>`;
      return;
    }
    list.innerHTML = safes.map(function(s) {
      var addr = (s.address || '').slice(0, 10) + '...' + (s.address || '').slice(-6);
      var si = s.status === 'deployed' ? '🟢' : '🟡';
      var name = s.name || addr;
      return '<div class="card" style="padding:14px 16px;margin-bottom:10px">' +
        '<div style="display:flex;justify-content:space-between;align-items:center">' +
        '<div><div style="font-size:14px;font-weight:600">' + si + ' ' + name + '</div>' +
        '<div style="font-size:11px;color:var(--text-muted);margin-top:4px">Owners: ' + ((s.owners && s.owners.length) || '—') + ' | Threshold: ' + (s.threshold || '—') + '</div>' +
        '<div style="font-size:11px;color:var(--text-muted);word-break:break-all">' + (s.address || '') + '</div></div>' +
        '<div style="text-align:right">' +
        '<div style="font-size:12px;color:var(--warning)">' + (s.pending_tx_count > 0 ? s.pending_tx_count + ' pending' : '') + '</div>' +
        "<button class='btn btn-primary btn-sm' onclick='safeShowPropose(\"" + s.address + "\")' style='margin-top:4px'>Propose</button></div>" +
        '</div></div>';
    }).join('');
  } catch (e) { list.innerHTML = '<div class="empty"><div class="empty-text" style="color:var(--error)">Failed to load</div></div>'; }
}

async function safeLoadParticipating() {
  var list = document.getElementById('safe-participating-list');
  if (!list) return;
  try {
    var d = await afetch('/api/vault/safe/participating');
    var safes = d.items || [];
    if (!safes.length) {
      list.innerHTML = '<div class="empty"><div class="empty-icon">🤝</div><div class="empty-text">Not participating in any Safe wallets</div><div class="empty-sub">Ask a team member to add you as an owner</div></div>';
      return;
    }
    list.innerHTML = safes.map(function(s) {
      var addr = (s.address || '').slice(0, 10) + '...' + (s.address || '').slice(-6);
      var name = s.name || addr;
      return '<div class="card" style="padding:14px 16px;margin-bottom:10px">' +
        '<div style="display:flex;justify-content:space-between;align-items:center">' +
        '<div><div style="font-size:14px;font-weight:600">🤝 ' + name + '</div>' +
        '<div style="font-size:11px;color:var(--text-muted);margin-top:4px">Threshold: ' + (s.threshold || '—') + '</div>' +
        '<div style="font-size:11px;color:var(--text-muted);word-break:break-all">' + (s.address || '') + '</div></div>' +
        '<div style="text-align:right">' +
        '<div style="font-size:13px;font-weight:600;color:var(--warning)">' + (s.pending_tx_count > 0 ? s.pending_tx_count + ' to sign' : '') + '</div></div>' +
        '</div></div>';
    }).join('');
  } catch (e) { list.innerHTML = '<div class="empty"><div class="empty-text" style="color:var(--error)">Failed to load</div></div>'; }
}

function safeCreate() {
  var name = document.getElementById('safe-name').value.trim() || 'My Safe';
  var ownersStr = document.getElementById('safe-owners').value.trim();
  if (!ownersStr) return showToast('Enter at least one owner address', 'error');
  var owners = ownersStr.split(',').map(function(s) { return s.trim(); }).filter(Boolean);
  var threshold = parseInt(document.getElementById('safe-threshold').value) || 2;
  if (threshold > owners.length) return showToast('Threshold must be <= owner count', 'error');
  var btn = document.getElementById('safe-create-btn');
  btn.classList.add('btn-loading');
  afetch('/api/vault/safe/create', { method: 'POST', body: { chainId: 11155111, owners: owners, threshold: threshold, name: name } })
    .then(function(d) { showToast('Safe deployed: ' + (d.address || '').slice(0, 12) + '...', 'success'); safeLoadOwned(); })
    .catch(function(e) { showToast(e.message, 'error'); })
    .finally(function() { btn.classList.remove('btn-loading'); });
}

function safePropose() {
  var addr = document.getElementById('safe-propose-addr').value.trim();
  var to = document.getElementById('safe-propose-to').value.trim();
  var amt = document.getElementById('safe-propose-amt').value.trim() || '0';
  if (!addr || !to) return showToast('Safe address and recipient required', 'error');
  var btn = document.getElementById('safe-propose-btn');
  btn.classList.add('btn-loading');
  afetch('/api/vault/safe/propose', { method: 'POST', body: { safeAddress: addr, to: to, value: amt } })
    .then(function(d) {
      showToast('Proposal #' + (d.nonce || '?') + ' created', 'success');
      if (document.getElementById('sub-safe-owned').classList.contains('active')) safeLoadOwned();
      if (document.getElementById('sub-safe-participating').classList.contains('active')) safeLoadParticipating();
    })
    .catch(function(e) { showToast(e.message, 'error'); })
    .finally(function() { btn.classList.remove('btn-loading'); });
}

function safeShowPropose(addr) {
  document.getElementById('safe-propose-addr').value = addr;
  var tab = document.querySelector('[data-sub="safe-propose-fm"]');
  if (tab) tab.click();
}

function safeList() { safeLoadOwned(); }

/* ── Topbar wallet state ── */
function updateTopbar() {
  try {
    var u = user();
    var addrText = u.walletAddress || '';
    var addrEl = document.getElementById('topbar-wallet-addr');
    var dotEl = document.getElementById('topbar-wallet-dot');
    if (addrEl) {
      if (addrText) {
        addrEl.textContent = fmtAddrLong(addrText);
        addrEl.style.color = '';
      } else {
        addrEl.textContent = 'Not connected';
        addrEl.style.color = 'var(--text-muted)';
      }
    }
    if (dotEl) {
      dotEl.className = addrText ? 'topbar-wallet-dot connected' : 'topbar-wallet-dot';
    }
  } catch(e) {}
}