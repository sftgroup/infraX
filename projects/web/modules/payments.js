// ============================================================================
// InfraX Payments · 通用支付网关面板（invites / transfers / a2a）
// 后端: infrax-payments (:9132) 经 web server.js /payments 反代
//   GET  /payments/capabilities  rails 能力发现（未启用 rail 返回 503）
//   POST /payments/invites      创建账单邀请 {payer, payee, valueWei, memo}
//   GET  /payments/invites?address=&role=payer|payee
//   POST /payments/invites/:id/pay         payer 用 ledger 余额支付
//   POST /payments/invites/:id/settle      payee 链上支付验证结算 {txHash}
//   POST /payments/invites/:id/cancel      撤销未结邀请
//   POST /payments/transfers              创建 ledger 内部转账 {from,to,valueWei}
//   GET  /payments/transfers?address=&role=from|to
//   POST /payments/transfers/:id/confirm   确认并原子执行（debit+credit）
//   POST /payments/a2a                     创建 a2a 意图 {subscriber,valueWei,payee}
//   POST /payments/a2a/settle              {paymentId, mode:'balance', subscriber, amountWei}
// 全部 fail-silent：后端不可达/未启用 → 空态 + 提示。
// ============================================================================

var PM_STATE = { tab: 'overview', caps: null };

function pmEsc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function pmShort(s, n) { s = s || ''; n = n || 10; return s.length > n + 6 ? s.slice(0, n) + '…' + s.slice(-4) : s; }
function pmWei(wei) { if (wei == null) return '—'; var n = Number(wei) / 1e18; return n >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : n.toFixed(6); }
function pmEthToWei(v) {
  var x = String(v == null ? '' : v).trim();
  if (!x) return '';
  try { return BigInt(Math.round(parseFloat(x) * 1e18)).toString(); }
  catch (e) { return ''; }
}
function pmEmpty(msg) { return '<div style="padding:36px;text-align:center;color:var(--text-muted);font-size:12px">' + pmEsc(msg || 'no data') + '</div>'; }
function pmTime(ts) { if (!ts) return '—'; var d = new Date(ts); return isNaN(d) ? '—' : d.toLocaleDateString('en', { month: 'short', day: 'numeric' }); }

// 统一请求：后端错误为 {error, status}，非 2xx 抛错
async function pmFetch(url, opts) {
  if (!opts) opts = {};
  if (opts.body && typeof opts.body === 'object') {
    opts.body = JSON.stringify(opts.body);
    if (!opts.headers) opts.headers = {};
    if (!opts.headers['Content-Type']) opts.headers['Content-Type'] = 'application/json';
  }
  var r = await fetch(url, opts);
  var j; try { j = await r.json(); } catch (e) { throw new Error('Invalid response (' + r.status + ')'); }
  if (!r.ok) {
    var e = new Error((j && j.error) || ('HTTP ' + r.status));
    e.status = r.status;
    throw e;
  }
  return j;
}

// ── 入口 ──
async function paymentsInit() {
  var root = document.getElementById('payments-root');
  if (!root) return;
  pmRenderShell();
  pmLoadTab(PM_STATE.tab);
}

function pmRenderShell() {
  var root = document.getElementById('payments-root');
  if (!root) return;
  root.innerHTML =
    '<div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap">' +
      '<div style="font-size:15px;font-weight:700">💳 Payments Gateway</div>' +
      '<span style="font-size:11px;padding:2px 10px;border-radius:999px;background:rgba(252,213,53,.12);color:#fcd535">infrax-payments</span>' +
    '</div>' +
    '<div class="tab-row">' +
      '<button class="tab-btn active" data-pm-tab="overview">📊 Overview</button>' +
      '<button class="tab-btn" data-pm-tab="invites">🧾 Invites</button>' +
      '<button class="tab-btn" data-pm-tab="transfers">🔁 Transfers</button>' +
      '<button class="tab-btn" data-pm-tab="a2a">⚡ A2A</button>' +
    '</div>' +
    '<div class="pm-pane active" id="pm-pane-overview"><div style="padding:6px"><div class="skeleton" style="height:26px;width:45%;margin:18px auto 10px;border-radius:8px"></div><div class="skeleton-card" style="height:120px;max-width:680px;margin:0 auto 12px"></div><div class="skeleton-text" style="width:70%;margin:0 auto"></div><div class="skeleton-text short" style="margin:0 auto"></div></div></div>' +
    '<div class="pm-pane" id="pm-pane-invites"></div>' +
    '<div class="pm-pane" id="pm-pane-transfers"></div>' +
    '<div class="pm-pane" id="pm-pane-a2a"></div>';

  root.querySelectorAll('.tab-btn[data-pm-tab]').forEach(function(b) {
    b.onclick = function() {
      root.querySelectorAll('.tab-btn[data-pm-tab]').forEach(function(x) { x.classList.remove('active'); });
      root.querySelectorAll('.pm-pane').forEach(function(x) { x.classList.remove('active'); });
      b.classList.add('active');
      var t = b.getAttribute('data-pm-tab');
      PM_STATE.tab = t;
      var pane = document.getElementById('pm-pane-' + t);
      if (pane) pane.classList.add('active');
      pmLoadTab(t);
    };
  });
}

function pmLoadTab(t) {
  if (t === 'overview') pmLoadOverview();
  else if (t === 'invites') pmLoadInvites();
  else if (t === 'transfers') pmLoadTransfers();
  else if (t === 'a2a') pmLoadA2a();
}

// ── Overview：capabilities + info ──
async function pmLoadOverview() {
  var pane = document.getElementById('pm-pane-overview');
  if (!pane) return;
  pane.innerHTML = '<div style="padding:6px"><div class="skeleton" style="height:26px;width:45%;margin:18px auto 10px;border-radius:8px"></div><div class="skeleton-card" style="height:120px;max-width:680px;margin:0 auto 12px"></div><div class="skeleton-text" style="width:70%;margin:0 auto"></div><div class="skeleton-text short" style="margin:0 auto"></div></div>';
  var results = await Promise.allSettled([
    pmFetch('/payments/capabilities'),
    pmFetch('/payments/info'),
  ]);
  var caps = results[0].status === 'fulfilled' ? (results[0].value.capabilities || results[0].value) : null;
  PM_STATE.caps = caps;

  var infoHtml = '';
  if (results[1].status === 'fulfilled' && results[1].value) {
    var i = results[1].value;
    infoHtml = '<div class="kpi-grid" style="grid-template-columns:repeat(auto-fill,minmax(200px,1fr))">' +
      '<div class="kpi"><div class="kpi-label">x402</div><div class="kpi-val mono" style="font-size:16px">' + (i.enabled ? '✅ enabled' : '⛔ off') + '</div></div>' +
      '<div class="kpi"><div class="kpi-label">Price</div><div class="kpi-val mono" style="font-size:14px">' + (i.priceWei != null ? pmWei(i.priceWei) : '—') + ' wei</div></div>' +
      '<div class="kpi"><div class="kpi-label">Pay To</div><div class="kpi-val mono" style="font-size:12px">' + pmEsc(pmShort(i.payTo, 16)) + '</div></div>' +
      '<div class="kpi"><div class="kpi-label">Chain</div><div class="kpi-val mono" style="font-size:14px">' + pmEsc(i.chain || '—') + '</div></div>' +
    '</div>';
  } else {
    infoHtml = '<div style="padding:16px;color:var(--warning);font-size:12px">⚠️ /payments/info 不可用：' + pmEsc(results[1].status === 'rejected' ? results[1].reason.message : '') + '</div>';
  }

  var railOrder = ['chain', 'fiat', 'x402', 'mpp', 'a2a', 'period', 'batch', 'invite', 'transfer'];
  var railLabels = { chain: '链上定价', fiat: 'Stripe 法币', x402: 'x402 链上支付', mpp: 'MPP 支付通道', a2a: 'A2A 两阶段', period: '周期订阅', batch: '批量收款', invite: '账单邀请', transfer: 'Ledger 转账' };
  var railHtml = '';
  if (caps) {
    railHtml = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px">' + railOrder.map(function(k) {
      var c = caps[k];
      if (!c) return '';
      var on = !!c.enabled;
      return '<div style="background:var(--surface-input);border-radius:8px;padding:12px 14px;border:1px solid ' + (on ? 'rgba(14,203,129,.35)' : 'var(--border)') + '">' +
        '<div style="display:flex;align-items:center;gap:8px;font-size:12px;font-weight:600">' +
          '<span style="width:7px;height:7px;border-radius:50%;background:' + (on ? 'var(--success)' : 'var(--error)') + '"></span>' +
          pmEsc(railLabels[k] || k) +
        '</div>' +
        '<div style="font-size:10px;color:var(--text-muted);margin-top:6px;line-height:1.6">' + pmEsc((c.endpoints || []).join(' · ') || c.description || '') + '</div>' +
      '</div>';
    }).join('') + '</div>';
  } else {
    railHtml = '<div style="padding:16px;color:var(--warning);font-size:12px">⚠️ capabilities 不可用：' + pmEsc(results[0].status === 'rejected' ? results[0].reason.message : '') + '</div>';
  }

  pane.innerHTML =
    infoHtml +
    '<div class="panel" style="margin-top:16px"><div class="panel-header">🧩 Rails 能力</div><div class="panel-body">' + railHtml + '</div></div>' +
    '<div class="panel" style="margin-top:14px"><div class="panel-header">💡 使用指引</div><div class="panel-body" style="font-size:12px;color:var(--text-secondary);line-height:1.9">' +
      '<b>🧾 Invites</b> — 向 payee 发起账单，payee 链上支付（settle）或 payer 用 ledger 余额支付（pay）。<br>' +
      '<b>🔁 Transfers</b> — ledger 内部转账（debit+credit 原子执行），创建后需 confirm。<br>' +
      '<b>⚡ A2A</b> — 两阶段意图：先建 intent，再以链上 tx 或 ledger 余额结算。<br>' +
      '<span style="color:var(--text-muted)">钱包地址（payer/subscriber）默认取当前连接钱包；所有金额单位 wei。</span>' +
    '</div></div>';
}

// ── Invites ──
function pmLoadInvites() {
  var pane = document.getElementById('pm-pane-invites');
  if (!pane) return;
  var addr = user().walletAddress || '';
  pane.innerHTML =
    '<div class="panel" style="margin-bottom:14px"><div class="panel-header">🧾 创建账单邀请</div><div class="panel-body">' +
      '<div class="form-row" style="grid-template-columns:1.6fr 1fr 1fr 1fr auto">' +
        '<div><label style="font-size:12px;font-weight:600;color:var(--text-dim)">Payee（收款地址）</label><input class="input mono" id="pm-inv-payee" placeholder="0x…" style="font-size:12px"></div>' +
        '<div><label style="font-size:12px;font-weight:600;color:var(--text-dim)">金额 (ETH)</label><input class="input mono" id="pm-inv-amt" placeholder="0.01" style="font-size:12px"></div>' +
        '<div><label style="font-size:12px;font-weight:600;color:var(--text-dim)">截止 (days)</label><input class="input" id="pm-inv-days" value="7" type="number" min="1" style="font-size:12px"></div>' +
        '<div><label style="font-size:12px;font-weight:600;color:var(--text-dim)">Memo</label><input class="input" id="pm-inv-memo" placeholder="invoice #1" style="font-size:12px"></div>' +
        '<button class="btn btn-primary" style="align-self:end" onclick="pmCreateInvite()">＋ 创建</button>' +
      '</div>' +
      '<div style="font-size:11px;color:var(--text-muted);margin-top:8px">Payer = 当前连接钱包 <code class="mono">' + pmEsc(addr) + '</code></div>' +
      '<div class="result-box" id="pm-inv-result" style="margin-top:12px"></div>' +
    '</div></div>' +
    '<div class="panel"><div class="panel-header">📋 邀请列表 <span style="font-size:11px;font-weight:400;color:var(--text-muted);margin-left:auto">payer / payee</span></div>' +
    '<div class="panel-body" style="padding:0" id="pm-inv-list"><div style="text-align:center;padding:28px;color:var(--text-muted)"><span class="spin"></span></div></div></div>';
  pmListInvites();
}

async function pmCreateInvite() {
  var payer = user().walletAddress;
  var payee = document.getElementById('pm-inv-payee').value.trim();
  var amt = pmEthToWei(document.getElementById('pm-inv-amt').value);
  var memo = document.getElementById('pm-inv-memo').value.trim();
  var days = parseInt(document.getElementById('pm-inv-days').value) || 7;
  if (!payer) return showToast('Connect wallet first', 'error');
  if (!payee || !amt) return showToast('Payee 和金额必填', 'warning');
  var box = document.getElementById('pm-inv-result');
  box.innerHTML = '<div style="padding:10px;color:var(--text-muted)">⏳ 创建中…</div>';
  try {
    var d = await pmFetch('/payments/invites', { method: 'POST', body: { payer: payer, payee: payee, valueWei: amt, memo: memo, dueAt: days > 0 ? Date.now() + days * 86400000 : undefined } });
    box.innerHTML = '<div style="padding:12px;border-radius:8px;background:rgba(14,203,129,.08);border:1px solid rgba(14,203,129,.3);font-size:13px">' +
      '✅ 邀请已创建 <code class="mono">' + pmEsc(d.inviteId) + '</code> · ' + pmWei(d.amountWei) + ' ETH → ' + pmEsc(pmShort(d.payee, 14)) + '</div>';
    document.getElementById('pm-inv-payee').value = '';
    document.getElementById('pm-inv-amt').value = '';
    pmListInvites();
  } catch (e) {
    box.innerHTML = '<div style="padding:12px;border-radius:8px;background:rgba(246,70,93,.08);border:1px solid rgba(246,70,93,.3);font-size:12px;color:var(--error)">❌ ' + pmEsc(e.message) + '</div>';
  }
}

async function pmListInvites() {
  var el = document.getElementById('pm-inv-list');
  if (!el) return;
  var addr = user().walletAddress;
  if (!addr) { el.innerHTML = pmEmpty('Connect wallet first'); return; }
  var results = await Promise.allSettled([
    pmFetch('/payments/invites?address=' + encodeURIComponent(addr) + '&role=payer'),
    pmFetch('/payments/invites?address=' + encodeURIComponent(addr) + '&role=payee'),
  ]);
  var payerList = results[0].status === 'fulfilled' ? (results[0].value.invites || []) : [];
  var payeeList = results[1].status === 'fulfilled' ? (results[1].value.invites || []) : [];
  if (results[0].status === 'rejected' && results[1].status === 'rejected') {
    el.innerHTML = pmEmpty('invites 不可用：' + pmEsc(results[0].reason.message) + '（rail 未启用则返回 503）');
    return;
  }
  if (!payerList.length && !payeeList.length) {
    el.innerHTML = pmEmpty('暂无邀请');
    return;
  }
  function row(inv, role) {
    var act = '';
    if (role === 'payee' && inv.status === 'open') {
      act = '<input class="input mono" placeholder="txHash" id="pm-settle-' + inv.inviteId + '" style="width:150px;font-size:11px"> ' +
        '<button class="btn btn-sm" style="font-size:11px;padding:4px 8px" onclick="pmSettleInvite(\'' + inv.inviteId + '\')">🔗 结算</button>';
    } else if (role === 'payer' && inv.status === 'open') {
      act = '<button class="btn btn-sm btn-primary" style="font-size:11px;padding:4px 8px" onclick="pmPayInvite(\'' + inv.inviteId + '\')">💳 Ledger 支付</button> ' +
        '<button class="btn btn-sm" style="font-size:11px;padding:4px 8px" onclick="pmCancelInvite(\'' + inv.inviteId + '\')">✕</button>';
    } else if (inv.status !== 'open') {
      act = '<span class="mono" style="font-size:10px;color:var(--text-muted)">' + (inv.settledMethod || inv.status) + '</span>';
    }
    return '<tr>' +
      '<td class="mono" style="font-size:10px">' + pmShort(inv.inviteId, 14) + '</td>' +
      '<td class="mono" style="font-size:11px">' + pmEsc(pmShort(inv[role === 'payer' ? 'payee' : 'payer'], 12)) + '</td>' +
      '<td class="mono" style="font-size:11px">' + pmWei(inv.amountWei) + '</td>' +
      '<td style="font-size:11px">' + pmTime(inv.dueAt) + '</td>' +
      '<td><span style="font-size:11px;color:' + (inv.status === 'open' ? 'var(--warning)' : 'var(--success)') + '">' + pmEsc(inv.status) + '</span></td>' +
      '<td style="white-space:nowrap">' + act + '</td>' +
    '</tr>';
  }
  el.innerHTML =
    '<div style="padding:8px 14px;font-size:10px;color:var(--text-muted);border-bottom:1px solid var(--border)">payer（我发起）: ' + payerList.length + ' · payee（我待收）: ' + payeeList.length + '</div>' +
    '<table class="data-table" style="width:100%"><thead><tr><th>Invite ID</th><th>对方</th><th>金额</th><th>截止</th><th>状态</th><th>操作</th></tr></thead><tbody>' +
    payerList.map(function(i) { return row(i, 'payer'); }).join('') +
    payeeList.map(function(i) { return row(i, 'payee'); }).join('') +
    '</tbody></table>';
}

async function pmPayInvite(inviteId) {
  if (!confirm('用我的 ledger 余额支付邀请 ' + pmShort(inviteId, 12) + '？')) return;
  try {
    var d = await pmFetch('/payments/invites/' + encodeURIComponent(inviteId) + '/pay', { method: 'POST' });
    showToast('✅ 已支付 (transfer ' + pmShort(d.transferId, 10) + ')', 'success');
    pmListInvites();
  } catch (e) { showToast('支付失败：' + e.message, 'error'); }
}

async function pmSettleInvite(inviteId) {
  var tx = document.getElementById('pm-settle-' + inviteId);
  var txHash = tx ? tx.value.trim() : '';
  if (!txHash) return showToast('请输入 txHash', 'warning');
  try {
    var d = await pmFetch('/payments/invites/' + encodeURIComponent(inviteId) + '/settle', { method: 'POST', body: { txHash: txHash } });
    showToast('✅ 结算成功 reference=' + pmShort(d.reference, 12), 'success');
    pmListInvites();
  } catch (e) { showToast('结算失败：' + e.message, 'error'); }
}

async function pmCancelInvite(inviteId) {
  if (!confirm('取消邀请 ' + pmShort(inviteId, 12) + '？')) return;
  try {
    await pmFetch('/payments/invites/' + encodeURIComponent(inviteId) + '/cancel', { method: 'POST' });
    showToast('✅ 已取消', 'success');
    pmListInvites();
  } catch (e) { showToast('取消失败：' + e.message, 'error'); }
}

// ── Transfers ──
function pmLoadTransfers() {
  var pane = document.getElementById('pm-pane-transfers');
  if (!pane) return;
  var addr = user().walletAddress || '';
  pane.innerHTML =
    '<div class="panel" style="margin-bottom:14px"><div class="panel-header">🔁 创建 Ledger 转账</div><div class="panel-body">' +
      '<div class="form-row" style="grid-template-columns:1.6fr 1fr 1.2fr auto">' +
        '<div><label style="font-size:12px;font-weight:600;color:var(--text-dim)">To（收款地址）</label><input class="input mono" id="pm-tf-to" placeholder="0x…" style="font-size:12px"></div>' +
        '<div><label style="font-size:12px;font-weight:600;color:var(--text-dim)">金额 (ETH)</label><input class="input mono" id="pm-tf-amt" placeholder="0.01" style="font-size:12px"></div>' +
        '<div><label style="font-size:12px;font-weight:600;color:var(--text-dim)">Reference</label><input class="input" id="pm-tf-ref" placeholder="optional" style="font-size:12px"></div>' +
        '<button class="btn btn-primary" style="align-self:end" onclick="pmCreateTransfer()">＋ 创建</button>' +
      '</div>' +
      '<div style="font-size:11px;color:var(--text-muted);margin-top:8px">From = 当前连接钱包 <code class="mono">' + pmEsc(addr) + '</code> · 创建后需 <b>Confirm</b> 原子执行（debit+credit）。</div>' +
      '<div class="result-box" id="pm-tf-result" style="margin-top:12px"></div>' +
    '</div></div>' +
    '<div class="panel"><div class="panel-header">📋 转账列表</div><div class="panel-body" style="padding:0" id="pm-tf-list"><div style="text-align:center;padding:28px;color:var(--text-muted)"><span class="spin"></span></div></div></div>';
  pmListTransfers();
}

async function pmCreateTransfer() {
  var from = user().walletAddress;
  var to = document.getElementById('pm-tf-to').value.trim();
  var amt = pmEthToWei(document.getElementById('pm-tf-amt').value);
  var ref = document.getElementById('pm-tf-ref').value.trim();
  if (!from) return showToast('Connect wallet first', 'error');
  if (!to || !amt) return showToast('To 和金额必填', 'warning');
  var box = document.getElementById('pm-tf-result');
  box.innerHTML = '<div style="padding:10px;color:var(--text-muted)">⏳ 创建中…</div>';
  try {
    var d = await pmFetch('/payments/transfers', { method: 'POST', body: { from: from, to: to, valueWei: amt, reference: ref } });
    box.innerHTML = '<div style="padding:12px;border-radius:8px;background:rgba(14,203,129,.08);border:1px solid rgba(14,203,129,.3);font-size:13px">✅ 转账已创建 <code class="mono">' + pmEsc(d.transferId) + '</code> · status=' + pmEsc(d.status) + '</div>';
    document.getElementById('pm-tf-to').value = '';
    document.getElementById('pm-tf-amt').value = '';
    pmListTransfers();
  } catch (e) {
    box.innerHTML = '<div style="padding:12px;border-radius:8px;background:rgba(246,70,93,.08);border:1px solid rgba(246,70,93,.3);font-size:12px;color:var(--error)">❌ ' + pmEsc(e.message) + '</div>';
  }
}

async function pmListTransfers() {
  var el = document.getElementById('pm-tf-list');
  if (!el) return;
  var addr = user().walletAddress;
  if (!addr) { el.innerHTML = pmEmpty('Connect wallet first'); return; }
  var results = await Promise.allSettled([
    pmFetch('/payments/transfers?address=' + encodeURIComponent(addr) + '&role=from'),
    pmFetch('/payments/transfers?address=' + encodeURIComponent(addr) + '&role=to'),
  ]);
  var fromList = results[0].status === 'fulfilled' ? (results[0].value.transfers || []) : [];
  var toList = results[1].status === 'fulfilled' ? (results[1].value.transfers || []) : [];
  if (results[0].status === 'rejected' && results[1].status === 'rejected') {
    el.innerHTML = pmEmpty('transfers 不可用：' + pmEsc(results[0].reason.message));
    return;
  }
  if (!fromList.length && !toList.length) {
    el.innerHTML = pmEmpty('暂无转账');
    return;
  }
  function row(t, role) {
    var act = (role === 'from' && t.status === 'open')
      ? '<button class="btn btn-sm btn-primary" style="font-size:11px;padding:4px 8px" onclick="pmConfirmTransfer(\'' + t.transferId + '\')">✅ Confirm</button>'
      : '<span class="mono" style="font-size:10px;color:var(--text-muted)">' + pmEsc(t.status) + '</span>';
    return '<tr>' +
      '<td class="mono" style="font-size:10px">' + pmShort(t.transferId, 14) + '</td>' +
      '<td class="mono" style="font-size:11px">' + pmEsc(pmShort(t[role === 'from' ? 'toAddr' : 'fromAddr'], 12)) + '</td>' +
      '<td class="mono" style="font-size:11px">' + pmWei(t.amountWei) + '</td>' +
      '<td style="font-size:11px">' + pmEsc(t.reference || '—') + '</td>' +
      '<td style="white-space:nowrap">' + act + '</td>' +
    '</tr>';
  }
  el.innerHTML =
    '<div style="padding:8px 14px;font-size:10px;color:var(--text-muted);border-bottom:1px solid var(--border)">我发起: ' + fromList.length + ' · 我收款: ' + toList.length + '</div>' +
    '<table class="data-table" style="width:100%"><thead><tr><th>Transfer ID</th><th>对方</th><th>金额</th><th>Reference</th><th>操作</th></tr></thead><tbody>' +
    fromList.map(function(t) { return row(t, 'from'); }).join('') +
    toList.map(function(t) { return row(t, 'to'); }).join('') +
    '</tbody></table>';
}

async function pmConfirmTransfer(transferId) {
  if (!confirm('确认执行转账 ' + pmShort(transferId, 12) + '？（原子 debit+credit）')) return;
  try {
    await pmFetch('/payments/transfers/' + encodeURIComponent(transferId) + '/confirm', { method: 'POST' });
    showToast('✅ 转账已执行', 'success');
    pmListTransfers();
  } catch (e) { showToast('执行失败：' + e.message, 'error'); }
}

// ── A2A ──
function pmLoadA2a() {
  var pane = document.getElementById('pm-pane-a2a');
  if (!pane) return;
  var addr = user().walletAddress || '';
  pane.innerHTML =
    '<div class="panel" style="margin-bottom:14px"><div class="panel-header">⚡ A2A 两阶段支付</div><div class="panel-body">' +
      '<div class="form-row" style="grid-template-columns:1.6fr 1fr auto">' +
        '<div><label style="font-size:12px;font-weight:600;color:var(--text-dim)">Payee（收款地址）</label><input class="input mono" id="pm-a2a-payee" placeholder="0x…" style="font-size:12px"></div>' +
        '<div><label style="font-size:12px;font-weight:600;color:var(--text-dim)">金额 (ETH)</label><input class="input mono" id="pm-a2a-amt" placeholder="0.01" style="font-size:12px"></div>' +
        '<button class="btn btn-primary" style="align-self:end" onclick="pmCreateA2a()">① 建意图</button>' +
      '</div>' +
      '<div style="font-size:11px;color:var(--text-muted);margin-top:8px">Subscriber = 当前连接钱包 <code class="mono">' + pmEsc(addr) + '</code>。创建后可用 ledger 余额结算（无需链上交易）。</div>' +
      '<div class="result-box" id="pm-a2a-result" style="margin-top:12px"></div>' +
    '</div></div>' +
    '<div class="panel"><div class="panel-header">② 结算（ledger 余额模式）</div><div class="panel-body">' +
      '<div class="form-row" style="grid-template-columns:1.6fr 1fr auto">' +
        '<div><label style="font-size:12px;font-weight:600;color:var(--text-dim)">paymentId</label><input class="input mono" id="pm-a2a-pid" placeholder="a2a_…" style="font-size:12px"></div>' +
        '<div><label style="font-size:12px;font-weight:600;color:var(--text-dim)">金额 (ETH)</label><input class="input mono" id="pm-a2a-settle-amt" placeholder="与意图一致" style="font-size:12px"></div>' +
        '<button class="btn btn-primary" style="align-self:end" onclick="pmSettleA2a()">② 结算</button>' +
      '</div>' +
      '<div class="result-box" id="pm-a2a-settle-result" style="margin-top:12px"></div>' +
    '</div></div>';
}

async function pmCreateA2a() {
  var subscriber = user().walletAddress;
  var payee = document.getElementById('pm-a2a-payee').value.trim();
  var amt = pmEthToWei(document.getElementById('pm-a2a-amt').value);
  if (!subscriber) return showToast('Connect wallet first', 'error');
  if (!payee || !amt) return showToast('Payee 和金额必填', 'warning');
  var box = document.getElementById('pm-a2a-result');
  box.innerHTML = '<div style="padding:10px;color:var(--text-muted)">⏳ 创建意图…</div>';
  try {
    var d = await pmFetch('/payments/a2a', { method: 'POST', body: { subscriber: subscriber, valueWei: amt, payee: payee } });
    box.innerHTML = '<div style="padding:12px;border-radius:8px;background:rgba(14,203,129,.08);border:1px solid rgba(14,203,129,.3);font-size:13px">' +
      '✅ 意图已创建 <code class="mono">' + pmEsc(d.paymentId) + '</code> · ' + pmWei(d.amountWei) + ' ETH<br>' +
      '<button class="btn btn-sm" style="margin-top:8px" onclick="document.getElementById(\'pm-a2a-pid\').value=\'' + pmEsc(d.paymentId) + '\';document.getElementById(\'pm-a2a-settle-amt\').value=document.getElementById(\'pm-a2a-amt\').value;showToast(\'已填入结算表单\',\'info\')">↳ 填入结算</button></div>';
  } catch (e) {
    box.innerHTML = '<div style="padding:12px;border-radius:8px;background:rgba(246,70,93,.08);border:1px solid rgba(246,70,93,.3);font-size:12px;color:var(--error)">❌ ' + pmEsc(e.message) + '</div>';
  }
}

async function pmSettleA2a() {
  var subscriber = user().walletAddress;
  var paymentId = document.getElementById('pm-a2a-pid').value.trim();
  var amt = pmEthToWei(document.getElementById('pm-a2a-settle-amt').value);
  if (!paymentId || !amt) return showToast('paymentId 和金额必填', 'warning');
  var box = document.getElementById('pm-a2a-settle-result');
  box.innerHTML = '<div style="padding:10px;color:var(--text-muted)">⏳ 结算中…</div>';
  try {
    var d = await pmFetch('/payments/a2a/settle', { method: 'POST', body: { paymentId: paymentId, mode: 'balance', subscriber: subscriber, amountWei: amt } });
    box.innerHTML = '<div style="padding:12px;border-radius:8px;background:rgba(14,203,129,.08);border:1px solid rgba(14,203,129,.3);font-size:13px">✅ 结算成功 · credited ' + pmWei(d.creditedWei) + ' ' + pmEsc(d.asset || '') + '</div>';
  } catch (e) {
    box.innerHTML = '<div style="padding:12px;border-radius:8px;background:rgba(246,70,93,.08);border:1px solid rgba(246,70,93,.3);font-size:12px;color:var(--error)">❌ ' + pmEsc(e.message) + '</div>';
  }
}
