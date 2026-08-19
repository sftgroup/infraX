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

function safeEsc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) { return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]; }); }
function safeShort(s, n) { s = s || ''; n = n || 10; return s.length > n + 6 ? s.slice(0, n) + '…' + s.slice(-4) : s; }
function safeWei(wei) { if (wei == null) return '0'; var n = Number(wei) / 1e18; return n >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : n.toFixed(6); }
function safeTxStatus(s) {
  var map = { pending: '🟡 pending', ready: '🟢 ready', executed: '✅ executed', failed: '❌ failed', rejected: '⛔ rejected' };
  return map[s] || s;
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
        "<button class='btn btn-primary btn-sm' onclick='safeShowPropose(\"" + s.address + "\")' style='margin-top:4px'>Propose</button> " +
        "<button class='btn btn-outline btn-sm' onclick='safeShowDetail(\"" + s.address + "\")' style='margin-top:4px' title='交易明细 + 审批/执行'>📋 Txns</button></div>" +
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
        '<div style="font-size:13px;font-weight:600;color:var(--warning)">' + (s.pending_tx_count > 0 ? s.pending_tx_count + ' to sign' : '') + '</div>' +
        "<button class='btn btn-outline btn-sm' onclick='safeShowDetail(\"" + s.address + "\")' style='margin-top:4px' title='交易明细 + 审批/执行'>📋 Txns</button></div>" +
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

/* ── 审批闭环：交易明细弹窗 + confirm（personal_sign）/ execute ── */
async function safeShowDetail(address) {
  var overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.setAttribute('data-safe-addr', address);
  overlay.style.cssText = 'display:flex;align-items:center;justify-content:center;position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:300;padding:24px;overflow:auto';
  overlay.innerHTML =
    '<div style="background:var(--surface-card);border:1px solid var(--border);border-radius:12px;padding:24px;width:760px;max-width:94vw;max-height:88vh;overflow:auto">' +
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:14px">' +
        '<div style="font-size:16px;font-weight:700">🛡️ Safe 交易审批</div>' +
        '<code class="mono" style="font-size:11px;color:var(--text-muted)">' + safeEsc(safeShort(address, 18)) + '</code>' +
        '<button class="btn btn-outline btn-sm" style="margin-left:auto" onclick="this.closest(\'.modal-overlay\').remove()">✕ 关闭</button>' +
      '</div>' +
      '<div id="safe-detail-body" style="font-size:12px;color:var(--text-secondary)">' +
        '<div style="text-align:center;padding:32px;color:var(--text-muted)"><span class="spin"></span> Loading transactions…</div>' +
      '</div>' +
    '</div>';
  document.body.appendChild(overlay);
  safeLoadDetail(address, overlay);
}

async function safeLoadDetail(address, overlay) {
  var body = overlay ? overlay.querySelector('#safe-detail-body') : document.getElementById('safe-detail-body');
  if (!body) return;
  try {
    var d = await afetch('/api/vault/safe/' + encodeURIComponent(address));
    var safe = d.safe || {};
    var txs = d.transactions || [];

    var info = '<div style="display:flex;gap:10px;margin-bottom:14px;flex-wrap:wrap">' +
      '<div style="background:var(--surface-input);border-radius:8px;padding:8px 14px"><span style="font-size:10px;color:var(--text-muted)">THRESHOLD</span><div class="mono" style="font-size:15px;font-weight:700">' + (safe.threshold || '—') + '/' + ((safe.owners && safe.owners.length) || '—') + '</div></div>' +
      '<div style="background:var(--surface-input);border-radius:8px;padding:8px 14px"><span style="font-size:10px;color:var(--text-muted)">NONCE</span><div class="mono" style="font-size:15px;font-weight:700">' + (safe.nonce || 0) + '</div></div>' +
      '<div style="background:var(--surface-input);border-radius:8px;padding:8px 14px"><span style="font-size:10px;color:var(--text-muted)">OWNERS</span><div class="mono" style="font-size:11px;line-height:1.7">' + (safe.owners || []).map(function(o) { return safeShort(o, 10); }).join(' · ') + '</div></div>' +
    '</div>';

    if (!txs.length) {
      body.innerHTML = info + '<div style="padding:28px;text-align:center;color:var(--text-muted)">No transactions — 用 Propose 发起第一笔</div>';
      return;
    }
    var rows = txs.map(function(t) {
      var canConfirm = t.status === 'pending';
      var canExecute = t.status === 'ready';
      return '<tr>' +
        '<td class="mono" style="font-size:10px">' + safeShort(t.safe_tx_hash, 14) + '</td>' +
        '<td class="mono" style="font-size:11px">→ ' + safeShort(t.to_address, 12) + '</td>' +
        '<td class="mono" style="font-size:11px">' + safeWei(t.value) + ' ETH</td>' +
        '<td class="mono" style="font-size:11px">#' + (t.nonce != null ? t.nonce : '—') + '</td>' +
        '<td><span style="font-size:11px">' + safeTxStatus(t.status) + '</span>' +
          (t.sig_count != null ? ' <span class="mono" style="font-size:10px;color:var(--text-muted)">' + t.sig_count + '/' + (safe.threshold || '?') + '</span>' : '') + '</td>' +
        '<td style="white-space:nowrap">' +
          (canConfirm ? '<button class="btn btn-sm btn-primary" style="font-size:11px;padding:3px 8px" onclick="safeConfirmTx(\'' + address + '\',\'' + t.safe_tx_hash + '\')">✍️ 签名</button> ' : '') +
          (canExecute ? '<button class="btn btn-sm" style="font-size:11px;padding:3px 8px;background:var(--success);color:#fff;border:none" onclick="safeExecuteTx(\'' + t.safe_tx_hash + '\')">🚀 执行</button>' : '') +
          (t.tx_hash ? '<a class="mono" style="font-size:10px;color:var(--text-muted)" href="https://sepolia.etherscan.io/tx/' + t.tx_hash + '" target="_blank">' + safeShort(t.tx_hash, 10) + '</a>' : '') +
        '</td>' +
      '</tr>';
    }).join('');

    body.innerHTML = info +
      '<table class="data-table" style="width:100%"><thead><tr><th>Tx Hash</th><th>To</th><th>Value</th><th>Nonce</th><th>Status</th><th>操作</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '<div style="font-size:11px;color:var(--text-muted);margin-top:10px;line-height:1.7">💡 签名 = 对 safeTxHash 做 personal_sign（EIP-191）；达到 threshold 后端自动执行。若签名失败（MetaMask 拒绝），可复制 hash 用 ethers <code>signMessage</code> 手动签名后调用 API。</div>';
  } catch (e) {
    body.innerHTML = '<div style="padding:24px;text-align:center;color:var(--error)">加载失败：' + safeEsc(e.message) + '</div>';
  }
}

async function safeConfirmTx(address, safeTxHash) {
  if (!window.ethereum) return showToast('No wallet connected', 'error');
  var addr = user().walletAddress;
  if (!addr) return showToast('Connect wallet first', 'error');
  var btn = event && event.target;
  if (btn) { btn.classList.add('btn-loading'); btn.disabled = true; }
  try {
    var sig = await window.ethereum.request({ method: 'personal_sign', params: [safeTxHash, addr] });
    var r = await afetch('/api/vault/safe/confirm', { method: 'POST', body: { safeAddress: address, safeTxHash: safeTxHash, signature: sig } });
    showToast(r.sigCount >= r.threshold ? '✅ Threshold met — ready to execute' : '✅ 已签名 (' + r.sigCount + '/' + r.threshold + ')', 'success');
    var overlay = document.querySelector('.modal-overlay[data-safe-addr]');
    if (overlay) safeLoadDetail(address, overlay); else safeLoadOwned();
  } catch (e) {
    showToast(e.message || '签名失败', 'error');
  } finally {
    if (btn) { btn.classList.remove('btn-loading'); btn.disabled = false; }
  }
}

async function safeExecuteTx(safeTxHash) {
  if (!confirm('确认在链上执行该 Safe 交易（' + safeShort(safeTxHash, 14) + '）？')) return;
  try {
    var r = await afetch('/api/vault/safe/execute', { method: 'POST', body: { safeTxHash: safeTxHash } });
    showToast('🚀 已执行: ' + (r.txHash || safeShort(safeTxHash, 10)), 'success');
    var overlay = document.querySelector('.modal-overlay[data-safe-addr]');
    if (overlay) safeLoadDetail(overlay.getAttribute('data-safe-addr'), overlay);
  } catch (e) {
    showToast('执行失败：' + e.message, 'error');
  }
}

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