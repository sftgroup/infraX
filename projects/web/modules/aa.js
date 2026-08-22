// ============================================================================
// InfraX AA · Session Manager（ERC-4337 Kernel v3 Session 管理面板）
// 后端: aa-relay (:9131) 经 web server.js /v1/* 反代
//   派生账户   POST /v1/account/derive  {chain, owner}
//   会话列表   GET  /v1/session?account=&chain=&product=
//   创建会话   POST /v1/session          {chain, product, owner, permissions, validUntil}
//   撤销阶段1  POST /v1/session/disable  {chain, account, sessionId} → draft{op, userOpHash}
//   撤销阶段2  POST /v1/session/revoke   {chain, account, owner, sessionId, userOpHash, signature, op}
//   轮换阶段1  POST /v1/session/replace  {chain, owner, oldSessionId, permissions, validUntil} → disableDraft
//   轮换阶段2  POST /v1/session/replace/submit {chain, account, owner, oldSessionId, userOpHash, signature, op}
//   账本/托管  POST /v1/ledger-balance   {account}
//   价目      GET  /v1/plans
// 签名: owner 对 userOpHash（raw 32B digest）的 ECDSA —— 链上 Kernel 与后端 recoverAddress({hash})
//       均只认原始摘要签名；浏览器优先 eth_sign，被拒时提供手动粘贴签名兜底。
// ============================================================================

var AA_CHAINS = [
  { id: 'base-sepolia', name: 'Base Sepolia', chainId: 84532 },
  { id: 'oxachain', name: 'OxaChain', chainId: 19505 },
];

var aaState = {
  chain: 'oxachain',
  account: '',
  sessions: [],
  plans: null,
  ledger: null,
  product: 'default',
  pendingRevoke: null,  // {sessionId, draft}
  pendingReplace: null, // {oldSessionId, sessionKey, ...result, disableDraft}
};

// ── 账户持久化（每链独立）──
function aaAccountKey() { return 'px_aa_account_' + aaState.chain; }
function aaLoadAccount() { return localStorage.getItem(aaAccountKey()) || ''; }
function aaSaveAccount(addr) {
  aaState.account = addr;
  if (addr) localStorage.setItem(aaAccountKey(), addr);
}

function aaEsc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function aaShort(s, n) { s = s || ''; n = n || 10; return s.length > n + 6 ? s.slice(0, n) + '…' + s.slice(-4) : s; }
function aaFmtWei(wei) {
  if (wei == null) return '—';
  var n = Number(wei) / 1e18;
  return n >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : n.toFixed(6);
}
function aaExpiry(ts) {
  if (!ts) return '—';
  var now = Math.floor(Date.now() / 1000);
  var left = Number(ts) - now;
  if (left <= 0) return '<span style="color:var(--error)">expired</span>';
  var d = Math.floor(left / 86400), h = Math.floor((left % 86400) / 3600);
  var when = new Date(Number(ts) * 1000).toLocaleDateString('en', { month: 'short', day: 'numeric' });
  return d > 0 ? d + 'd left · ' + when : h + 'h left · ' + when;
}
function aaPermSummary(perms) {
  if (!perms || !perms.length) return '<span class="text-dim">—</span>';
  return perms.map(function(p) {
    var sel = p.selectors && p.selectors.length ? p.selectors.length + ' fn' : 'all fn';
    return '<code class="mono" style="font-size:12px">' + aaShort(p.target, 8) + ' · ' + sel + ' · $' + aaFmtWei(p.valueLimit) + ' · x' + (p.countLimit || 0) + '</code>';
  }).join('<br>');
}

// ── 签名：eth_sign（raw digest）优先，失败转手动粘贴 ──
function aaSignDigest(digest, reason) {
  return new Promise(function(resolve, reject) {
    var addr = user().walletAddress;
    if (!window.ethereum || !addr) return reject(new Error('No wallet connected'));
    window.ethereum.request({ method: 'eth_sign', params: [addr, digest] }).then(function(sig) {
      resolve(sig);
    }).catch(function(err) {
      // MetaMask 默认禁用 eth_sign → 进入手动签名流程
      var userOpHash = digest;
      var manual = window.prompt(
        reason + '\n\n' + I18N.t('aa_manual_sign_hint') + '\n' + userOpHash + '\n\n' + I18N.t('aa_paste_sig') + '\n',
        ''
      );
      if (manual && manual.trim().length > 10) resolve(manual.trim());
      else reject(new Error(I18N.t('aa_sign_cancelled')));
    });
  });
}

// ── 通用请求（aa-relay 契约 {code, message, data}）──
async function aaFetch(url, opts) {
  if (!opts) opts = {};
  if (!opts.headers) opts.headers = {};
  if (opts.body && typeof opts.body === 'object') {
    opts.body = JSON.stringify(opts.body);
    if (!opts.headers['Content-Type']) opts.headers['Content-Type'] = 'application/json';
  }
  var r = await fetch(url, opts);
  var j; try { j = await r.json(); } catch (e) { throw new Error('Invalid response'); }
  if (j.code && j.code !== 0) {
    var e = new Error(j.message || 'AA relay error');
    e.data = j.data;
    e.httpStatus = r.status;
    throw e;
  }
  return j.data;
}

// ── 入口 ──
async function aaInit() {
  var root = document.getElementById('aa-root');
  if (!root) return;
  aaState.chain = AA_CHAINS.some(function (c) { return c.id === localStorage.getItem('px_aa_chain'); })
    ? localStorage.getItem('px_aa_chain')
    : 'oxachain';
  aaState.account = aaLoadAccount();
  aaRenderShell();
  await aaLoadAll();
}

function aaSwitchChain(chain) {
  aaState.chain = chain;
  aaState.account = aaLoadAccount();
  localStorage.setItem('px_aa_chain', chain);
  aaRenderShell();
  aaLoadAll();
}

// ── 渲染外壳 ──
function aaRenderShell() {
  var root = document.getElementById('aa-root');
  if (!root) return;
  var chainOpts = AA_CHAINS.map(function(c) {
    return '<option value="' + c.id + '"' + (c.id === aaState.chain ? ' selected' : '') + '>' + c.name + '</option>';
  }).join('');
  root.innerHTML =
    '<div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap">' +
      '<div style="font-size:15px;font-weight:700">' + robotIcon(16) + ' AA Session Manager</div>' +
      '<span style="font-size:11px;padding:2px 10px;border-radius:999px;background:rgba(124,58,237,.12);color:#a78bfa">ERC-4337</span>' +
      '<select class="input" style="width:200px;font-size:13px;margin-left:auto" onchange="aaSwitchChain(this.value)">' + chainOpts + '</select>' +
    '</div>' +
    '<div class="tab-row">' +
      '<button class="tab-btn active" data-aa-tab="overview">📊 Overview</button>' +
      '<button class="tab-btn" data-aa-tab="sessions">🔑 Sessions</button>' +
      '<button class="tab-btn" data-aa-tab="create">➕ Create Session</button>' +
    '</div>' +
    '<div class="aa-pane active" id="aa-pane-overview"></div>' +
    '<div class="aa-pane" id="aa-pane-sessions"></div>' +
    '<div class="aa-pane" id="aa-pane-create"></div>';

  root.querySelectorAll('.tab-btn[data-aa-tab]').forEach(function(b) {
    b.onclick = function() {
      root.querySelectorAll('.tab-btn[data-aa-tab]').forEach(function(x) { x.classList.remove('active'); });
      root.querySelectorAll('.aa-pane').forEach(function(x) { x.classList.remove('active'); });
      b.classList.add('active');
      var pane = document.getElementById('aa-pane-' + b.getAttribute('data-aa-tab'));
      if (pane) pane.classList.add('active');
    };
  });
}

// ── 数据加载 ──
async function aaLoadAll() {
  var owner = user().walletAddress;
  var pane = document.getElementById('aa-pane-overview');
  if (!owner) {
    if (pane) pane.innerHTML = '<div style="text-align:center;padding:60px"><div style="margin-bottom:12px">' + robotIcon(44) + '</div><div style="font-size:15px;color:var(--warning)">Connect wallet to manage Smart Account sessions</div><a href="/connect.html" style="color:var(--gold);font-size:13px">→ Go to Connect</a></div>';
    return;
  }

  // ① 派生智能账户（只读）
  if (!aaState.account) {
    try {
      var d = await aaFetch('/v1/account/derive', { method: 'POST', body: { chain: aaState.chain, owner: owner } });
      if (d && d.accountAddress) aaSaveAccount(d.accountAddress);
    } catch (e) {
      aaRenderOverviewError(I18N.t('aa_derive_failed') + (e.message || 'aa-relay unreachable') + I18N.t('aa_derive_failed_suffix'));
      return;
    }
  }

  // ② 并行拉取 plans / ledger / sessions
  var results = await Promise.allSettled([
    aaFetch('/v1/plans'),
    aaState.account ? aaFetch('/v1/ledger-balance', { method: 'POST', body: { account: aaState.account } }) : Promise.resolve(null),
    aaState.account ? aaFetch('/v1/session?account=' + encodeURIComponent(aaState.account) + '&chain=' + encodeURIComponent(aaState.chain) + '&product=' + encodeURIComponent(aaState.product)) : Promise.resolve([]),
  ]);
  aaState.plans = results[0].status === 'fulfilled' ? results[0].value : null;
  aaState.ledger = results[1].status === 'fulfilled' ? results[1].value : null;
  aaState.sessions = results[2].status === 'fulfilled' ? (results[2].value || []) : [];
  aaRenderOverview();
  aaRenderSessions();
}

function aaRenderOverviewError(msg) {
  var pane = document.getElementById('aa-pane-overview');
  if (pane) pane.innerHTML = '<div style="text-align:center;padding:48px;color:var(--error);font-size:13px">' + aaEsc(msg) + '</div>';
}

// ── Overview ──
function aaRenderOverview() {
  var pane = document.getElementById('aa-pane-overview');
  if (!pane) return;
  var p = aaState.plans || {};
  var l = aaState.ledger || {};
  var funds = l.funds || null;

  var modeHtml = p.mode === 'escrow-onchain'
    ? '<span style="color:var(--warning)">' + I18N.t('aa_mode_escrow') + '</span>'
    : '<span style="color:var(--text-brand)">session-subscription</span>';

  var feeHtml = (p.fees && p.fees.length)
    ? p.fees.map(function(f) {
        return '<tr><td>' + aaEsc(f.label) + '</td><td class="mono" style="text-align:right">' + aaFmtWei(f.feeWei) + ' ' + (f.operation === 'userop' ? 'OXA' : 'ETH') + '</td></tr>';
      }).join('')
    : '<tr><td colspan="2" style="text-align:center;color:var(--text-muted)">free (billing not configured)</td></tr>';

  var topupHtml = '';
  if (p.topup && p.topup.method && p.topup.method !== 'n/a') {
    topupHtml = '<div class="panel" style="margin-top:14px"><div class="panel-header">' + I18N.t('aa_topup_title') + aaEsc(p.topup.method) + '</div><div class="panel-body" style="font-size:13px;line-height:1.9">' +
      (p.topup.steps || []).map(function(s, i) { return '<div style="display:flex;gap:10px;margin-bottom:6px"><span class="mono" style="color:var(--brand);font-weight:700">' + (i + 1) + '</span><span>' + aaEsc(s) + '</span></div>'; }).join('') +
      '</div></div>';
  }

  var fundsHtml = '';
  if (p.mode === 'escrow-onchain' && funds) {
    var escrow = aaFmtWei(funds.escrowWei);
    var epDep = funds.epDepositWei != null ? aaFmtWei(funds.epDepositWei) : '—';
    var native = funds.nativeWei != null ? aaFmtWei(funds.nativeWei) : '—';
    var low = Number(funds.escrowWei || 0) === 0;
    fundsHtml = '<div class="panel" style="margin-top:14px"><div class="panel-header">' + I18N.t('aa_funds_escrow_title') + '</div><div class="panel-body">' +
      '<div class="kpi-grid" style="grid-template-columns:repeat(3,1fr)">' +
        '<div class="kpi"><div class="kpi-label">' + I18N.t('aa_kpi_escrow') + '</div><div class="kpi-val mono" style="font-size:20px;font-weight:700;color:' + (low ? 'var(--error)' : 'var(--success)') + '">' + escrow + ' OXA</div></div>' +
        '<div class="kpi"><div class="kpi-label">' + I18N.t('aa_kpi_epdep') + '</div><div class="kpi-val mono" style="font-size:20px;font-weight:700">' + epDep + ' ETH</div></div>' +
        '<div class="kpi"><div class="kpi-label">' + I18N.t('aa_kpi_native') + '</div><div class="kpi-val mono" style="font-size:20px;font-weight:700">' + native + ' ETH</div></div>' +
      '</div>' +
      (low ? '<div style="margin-top:10px;padding:10px 12px;border-radius:8px;background:rgba(246,70,93,.08);border:1px solid rgba(246,70,93,.3);font-size:12px;color:var(--error)">' + I18N.t('aa_escrow_zero') + '</div>' : '') +
      '</div></div>';
  } else if (l.balance) {
    fundsHtml = '<div class="panel" style="margin-top:14px"><div class="panel-header">' + I18N.t('aa_ledger_balance_title') + '</div><div class="panel-body"><div class="mono" style="font-size:22px;font-weight:700;color:var(--success)">' + aaFmtWei(l.balanceWei) + ' ETH</div></div></div>';
  }

  var accountHtml = aaState.account
    ? '<div class="addr-pill" style="font-size:13px;cursor:pointer" onclick="copyText(\'' + aaState.account + '\')" title="' + I18N.t('aa_copy_click') + '">' + robotIcon(13) + ' ' + aaState.account.slice(0, 12) + '…' + aaState.account.slice(-8) + '</div>'
    : '<span class="text-dim">—</span>';

  pane.innerHTML =
    '<div class="kpi-grid" style="grid-template-columns:repeat(4,1fr)">' +
      '<div class="kpi-card" style="border-top:3px solid var(--brand-purple)"><div class="kpi-label">Smart Account</div><div class="kpi-val" style="font-size:14px;font-weight:700;margin-top:6px">' + accountHtml + '</div><div class="kpi-sub" style="font-size:11px;color:var(--text-muted);margin-top:6px">' + I18N.t('aa_owner_hint') + aaShort(user().walletAddress, 6) + '</div></div>' +
      '<div class="kpi-card" style="border-top:3px solid var(--success)"><div class="kpi-label">Ledger Balance</div><div class="kpi-val mono" style="font-size:22px;font-weight:700;margin-top:4px">' + aaFmtWei(l.balanceWei) + ' <span style="font-size:12px;color:var(--text-muted)">ETH</span></div><div class="kpi-sub" style="font-size:11px;color:var(--text-muted);margin-top:4px">' + I18N.t('aa_paymaster_balance') + '</div></div>' +
      '<div class="kpi-card" style="border-top:3px solid var(--warning)"><div class="kpi-label">Billing Mode</div><div class="kpi-val" style="font-size:14px;font-weight:700;margin-top:8px">' + modeHtml + '</div><div class="kpi-sub" style="font-size:11px;color:var(--text-muted);margin-top:6px">' + (p.configured ? I18N.t('aa_billing_configured') : I18N.t('aa_billing_not_configured')) + '</div></div>' +
      '<div class="kpi-card" style="border-top:3px solid var(--brand)"><div class="kpi-label">Sessions</div><div class="kpi-val mono" style="font-size:22px;font-weight:700;margin-top:4px">' + (aaState.sessions.length || 0) + '</div><div class="kpi-sub" style="font-size:11px;color:var(--text-muted);margin-top:4px">' + I18N.t('aa_chain_bound') + (aaState.sessions.length ? (aaState.sessions[0].isBound ? '✅' : I18N.t('aa_not_deployed')) : '—') + '</div></div>' +
    '</div>' +
    '<div class="panel"><div class="panel-header">' + I18N.t('aa_fee_title_prefix') + aaEsc(p.mode || 'n/a') + I18N.t('aa_fee_title_suffix') + '</div><div class="panel-body" style="padding:0"><table class="data-table"><thead><tr><th>Operation</th><th>Fee</th></tr></thead><tbody>' + feeHtml + '</tbody></table></div></div>' +
    '<div class="panel" style="margin-top:14px"><div class="panel-header">' + robotIcon(14) + ' ' + I18N.t('aa_autorenew_title') + '</div><div class="panel-body" style="font-size:13px;color:var(--text-secondary);line-height:1.8">' +
      I18N.t('aa_autorenew_desc') +
      '<span style="color:var(--text-muted)">' + I18N.t('aa_autorenew_support') + '</span>' +
    '</div></div>' +
    fundsHtml +
    topupHtml;
}

// ── Sessions ──
function aaRenderSessions() {
  var pane = document.getElementById('aa-pane-sessions');
  if (!pane) return;
  if (!aaState.account) {
    pane.innerHTML = '<div class="empty">' + I18N.t('aa_no_account') + '</div>';
    return;
  }
  var list = aaState.sessions || [];
  if (!list.length) {
    pane.innerHTML = '<div class="empty" style="padding:48px"><div class="empty-icon" style="font-size:44px">🔑</div><div class="empty-text">No sessions</div><div class="empty-sub">Create your first session in the ➕ Create Session tab</div></div>';
    return;
  }
  pane.innerHTML =
    '<div class="panel"><div class="panel-header">' + I18N.t('aa_session_list_title') + '<span style="font-size:11px;font-weight:400;color:var(--text-muted);margin-left:auto">' + list.length + I18N.t('aa_session_count_suffix') + aaShort(aaState.account, 8) + '</span></div>' +
    '<div class="panel-body" style="padding:0"><table class="data-table">' +
    '<thead><tr><th>Session ID</th><th>Signer (key)</th><th>' + I18N.t('aa_th_valid') + '</th><th>' + I18N.t('aa_th_perms') + '</th><th>' + I18N.t('aa_th_created') + '</th><th>' + I18N.t('aa_th_actions') + '</th></tr></thead><tbody>' +
    list.map(function(s) {
      return '<tr>' +
        '<td class="mono" style="font-size:12px">' + aaShort(s.sessionId, 12) + '</td>' +
        '<td class="mono" style="font-size:12px">' + aaShort(s.signer, 10) + '</td>' +
        '<td style="font-size:12px">' + aaExpiry(s.validUntil) + '<br><span class="mono" style="font-size:10px;color:var(--text-muted)">until ' + (s.validUntil || '—') + '</span></td>' +
        '<td>' + aaPermSummary(s.permissions) + '</td>' +
        '<td class="mono" style="font-size:11px">' + (s.createdAt ? new Date(s.createdAt).toLocaleDateString('en', { month: 'short', day: 'numeric' }) : '—') + '</td>' +
        '<td style="white-space:nowrap"><button class="btn btn-sm" style="font-size:12px;padding:4px 10px" onclick="aaStartRevoke(\'' + s.sessionId + '\')" title="' + I18N.t('aa_revoke_title') + '">🚫 Revoke</button> ' +
        '<button class="btn btn-sm" style="font-size:12px;padding:4px 10px;background:var(--surface-hover)" onclick="aaStartReplace(\'' + s.sessionId + '\')" title="' + I18N.t('aa_replace_title') + '">🔄 Replace</button></td>' +
      '</tr>';
    }).join('') +
    '</tbody></table></div></div>';
}

// ── Create Session ──
function aaRenderCreateForm() {
  var pane = document.getElementById('aa-pane-create');
  if (!pane) return;
  if (!user().walletAddress) {
    pane.innerHTML = '<div class="empty">' + I18N.t('aa_connect_first') + '</div>';
    return;
  }
  var now = Math.floor(Date.now() / 1000);
  var defValid = now + 30 * 86400;
  var defPerms = '[{"target":"0x0000000000000000000000000000000000000001","selectors":["0x8a7b9a6b"],"valueLimit":"1000000000000000000","countLimit":100}]';
  pane.innerHTML =
    '<div class="panel"><div class="panel-header">' + I18N.t('aa_create_title') + '</div><div class="panel-body">' +
      '<div class="form-row" style="grid-template-columns:1fr 1fr">' +
        '<div><label style="font-size:12px;font-weight:600;color:var(--text-dim)">' + I18N.t('aa_lb_owner') + '</label><div class="addr-pill mono" style="font-size:12px;margin-top:4px">' + aaShort(user().walletAddress, 12) + '</div></div>' +
        '<div><label style="font-size:12px;font-weight:600;color:var(--text-dim)">Product</label><select class="input" id="aa-product" style="margin-top:4px"><option value="default">default</option></select></div>' +
      '</div>' +
      '<div class="form-row" style="grid-template-columns:1fr 1fr">' +
        '<div><label style="font-size:12px;font-weight:600;color:var(--text-dim)">' + I18N.t('aa_lb_valid_days') + '</label><input class="input" id="aa-valid-days" type="number" value="30" min="1" style="margin-top:4px"></div>' +
        '<div><label style="font-size:12px;font-weight:600;color:var(--text-dim)">validUntil (unix)</label><input class="input mono" id="aa-valid-until" value="' + defValid + '" style="margin-top:4px"></div>' +
      '</div>' +
      '<label style="font-size:12px;font-weight:600;color:var(--text-dim)">' + I18N.t('aa_lb_perms') + '</label>' +
      '<textarea class="input mono" id="aa-perms" rows="4" style="margin-top:4px;font-size:12px;white-space:pre">' + defPerms + '</textarea>' +
      '<div style="font-size:11px;color:var(--text-muted);margin:8px 0 12px;line-height:1.7">' + I18N.t('aa_perms_hint') + '</div>' +
      '<button class="btn btn-primary" id="aa-create-btn" onclick="aaCreateSession()">🚀 Create Session</button> ' +
      '<button class="btn btn-outline" onclick="aaFillPermPresets()">' + I18N.t('aa_fill_example') + '</button>' +
      '<div class="result-box" id="aa-create-result" style="margin-top:14px"></div>' +
    '</div></div>';
}

function aaFillPermPresets() {
  var ta = document.getElementById('aa-perms');
  if (!ta) return;
  var now = Math.floor(Date.now() / 1000);
  document.getElementById('aa-valid-until').value = now + 7 * 86400;
  ta.value = JSON.stringify([
    { target: '0x0000000000000000000000000000000000000001', selectors: [], valueLimit: '50000000000000000', countLimit: 20 },
    { target: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', selectors: ['0x095ea7b3'], valueLimit: '0', countLimit: 10 }
  ], null, 2);
}

async function aaCreateSession() {
  var owner = user().walletAddress;
  var btn = document.getElementById('aa-create-btn');
  var result = document.getElementById('aa-create-result');
  if (!owner) return showToast('Connect wallet first', 'error');
  var validUntil;
  try {
    validUntil = BigInt(document.getElementById('aa-valid-until').value.trim()).toString();
  } catch (e) { return showToast('validUntil must be a number', 'error'); }
  var permissions;
  try {
    permissions = JSON.parse(document.getElementById('aa-perms').value);
    if (!Array.isArray(permissions) || !permissions.length) throw new Error('empty');
  } catch (e) { return showToast(I18N.t('aa_perms_invalid'), 'error'); }

  btn.classList.add('btn-loading');
  result.innerHTML = '<div style="padding:10px;color:var(--text-muted)">' + I18N.t('aa_deriving') + '</div>';
  try {
    var d = await aaFetch('/v1/session', {
      method: 'POST',
      body: { chain: aaState.chain, product: aaState.product, owner: owner, permissions: permissions, validUntil: validUntil },
    });
    if (d.accountAddress) aaSaveAccount(d.accountAddress);
    // 复用/冲突处理
    if (d.reused) {
      result.innerHTML = '<div style="padding:12px;border-radius:8px;background:rgba(14,203,129,.08);border:1px solid rgba(14,203,129,.3);font-size:13px">' +
        I18N.t('aa_reused') + '<code class="mono">' + d.sessionId + '</code><br>session key: <code class="mono">' + d.sessionKey + '</code></div>';
    } else if (!d.isBound) {
      result.innerHTML = '<div style="padding:12px;border-radius:8px;background:rgba(14,203,129,.08);border:1px solid rgba(14,203,129,.3);font-size:13px">' +
        I18N.t('aa_created_local') +
        'Smart Account: <code class="mono">' + d.accountAddress + '</code><br>' +
        'Session ID: <code class="mono">' + d.sessionId + '</code><br>' +
        I18N.t('aa_key_once') + '<code class="mono">' + d.sessionKey + '</code><br><br>' +
        I18N.t('aa_next_enable') +
        I18N.t('aa_copy_calldata') +
        '<div style="display:flex;gap:8px;align-items:center;margin-top:8px"><code class="mono" id="aa-enable-cd" style="font-size:11px;word-break:break-all;flex:1">' + d.enableCallData + '</code>' +
        '<button class="btn btn-sm" onclick="copyText(document.getElementById(\'aa-enable-cd\').textContent)">📋 Copy</button></div>' +
        '<div style="font-size:11px;color:var(--text-muted);margin-top:8px">' + I18N.t('aa_enable_hint') + '</div>' +
        '</div>';
    } else {
      result.innerHTML = '<div style="padding:12px;border-radius:8px;background:rgba(246,70,93,.08);border:1px solid rgba(246,70,93,.3);font-size:13px">' +
        I18N.t('aa_conflict_prefix') + (d.needsSessionRevoke ? I18N.t('aa_need_revoke') : '') + I18N.t('aa_conflict_suffix') + '</div>';
    }
    aaLoadAll();
  } catch (e) {
    // 409 session-conflict：错误体中带 accountAddress
    if (e.data && e.data.accountAddress) aaSaveAccount(e.data.accountAddress);
    result.innerHTML = '<div style="padding:12px;border-radius:8px;background:rgba(246,70,93,.08);border:1px solid rgba(246,70,93,.3);font-size:13px;color:var(--error)">❌ ' + aaEsc(e.message || I18N.t('aa_create_failed')) + '</div>';
  } finally {
    btn.classList.remove('btn-loading');
  }
}

// ── Revoke（两阶段：disable → 签名 → revoke）──
async function aaStartRevoke(sessionId) {
  if (!confirm(I18N.t('aa_revoke_confirm_prefix') + sessionId.slice(0, 12) + I18N.t('aa_revoke_confirm_suffix'))) return;
  var msg = document.createElement('div');
  msg.style.cssText = 'margin:10px 0;padding:12px;border-radius:8px;background:var(--surface-input);font-size:13px;color:var(--text-muted)';
  msg.textContent = I18N.t('aa_building_draft');
  document.body.appendChild(msg);
  try {
    var d = await aaFetch('/v1/session/disable', {
      method: 'POST',
      body: { chain: aaState.chain, product: aaState.product, account: aaState.account, sessionId: sessionId },
    });
    msg.remove();
    if (!d || !d.draft || !d.draft.userOpHash) {
      showToast(I18N.t('aa_draft_failed'), 'warning');
      aaLoadAll();
      return;
    }
    aaState.pendingRevoke = { sessionId: sessionId, draft: d.draft };
    aaPromptSign(
      I18N.t('aa_revoke_title_prompt'),
      I18N.t('aa_revoke_desc'),
      d.draft.userOpHash,
      function(sig) { aaSubmitRevoke(sessionId, d.draft, sig); }
    );
  } catch (e) {
    msg.remove();
    showToast(e.message, 'error');
  }
}

async function aaSubmitRevoke(sessionId, draft, signature) {
  try {
    var r = await aaFetch('/v1/session/revoke', {
      method: 'POST',
      body: { chain: aaState.chain, account: aaState.account, owner: user().walletAddress, sessionId: sessionId, userOpHash: draft.userOpHash, signature: signature, op: draft.op, wait: true },
    });
    showToast(I18N.t('aa_revoked_onchain') + (r.userOpHash || '').slice(0, 12) + '…', 'success');
    aaState.pendingRevoke = null;
    aaLoadAll();
  } catch (e) {
    showToast(I18N.t('aa_revoke_failed') + e.message, 'error');
  }
}

// ── Replace（两阶段：replace → 签名 disable 旧 → submit；新 session 已落库）──
async function aaStartReplace(oldSessionId) {
  var now = Math.floor(Date.now() / 1000);
  var perms = window.prompt(
    I18N.t('aa_replace_prompt_prefix') + oldSessionId.slice(0, 12) + I18N.t('aa_replace_prompt_suffix'),
    '[{"target":"0x0000000000000000000000000000000000000001","selectors":[],"valueLimit":"50000000000000000","countLimit":20}]'
  );
  if (!perms) return;
  var permissions;
  try { permissions = JSON.parse(perms); } catch (e) { return showToast(I18N.t('aa_perms_json_invalid'), 'error'); }
  var days = window.prompt(I18N.t('aa_valid_days_prompt'), '30');
  var validUntil = now + (parseInt(days || '30', 10) || 30) * 86400;

  var msg = document.createElement('div');
  msg.style.cssText = 'margin:10px 0;padding:12px;border-radius:8px;background:var(--surface-input);font-size:13px;color:var(--text-muted)';
  msg.textContent = I18N.t('aa_replace_building');
  document.body.appendChild(msg);
  try {
    var d = await aaFetch('/v1/session/replace', {
      method: 'POST',
      body: { chain: aaState.chain, product: aaState.product, owner: user().walletAddress, oldSessionId: oldSessionId, permissions: permissions, validUntil: validUntil },
    });
    msg.remove();
    if (d.accountAddress) aaSaveAccount(d.accountAddress);
    aaState.pendingReplace = d;
    if (!d.disableDraft || !d.disableDraft.userOpHash) {
      showToast(I18N.t('aa_replace_draft_failed'), 'warning');
      aaLoadAll();
      return;
    }
    aaPromptSign(
      I18N.t('aa_replace_title_prompt'),
      I18N.t('aa_replace_desc'),
      d.disableDraft.userOpHash,
      function(sig) { aaSubmitReplace(d, sig); }
    );
  } catch (e) {
    msg.remove();
    showToast(e.message, 'error');
  }
}

async function aaSubmitReplace(d, signature) {
  try {
    var r = await aaFetch('/v1/session/replace/submit', {
      method: 'POST',
      body: { chain: aaState.chain, product: aaState.product, account: aaState.account, owner: user().walletAddress, oldSessionId: d.oldSessionId, userOpHash: d.disableDraft.userOpHash, signature: signature, op: d.disableDraft.op, wait: true },
    });
    showToast(I18N.t('aa_old_disabled') + (r.userOpHash || '').slice(0, 12) + '…', 'success');
    var note = I18N.t('aa_replace_note_prefix') + d.sessionKey + I18N.t('aa_replace_note_suffix');
    window.prompt(I18N.t('aa_new_key_prompt'), d.sessionKey);
    showToast(note, 'info');
    aaState.pendingReplace = null;
    aaLoadAll();
  } catch (e) {
    showToast(I18N.t('aa_replace_failed') + e.message, 'error');
  }
}

// ── 签名弹窗（eth_sign 失败 → 手动粘贴）──
function aaPromptSign(title, desc, userOpHash, onSigned) {
  var overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:300;display:flex;align-items:center;justify-content:center';
  overlay.innerHTML =
    '<div style="background:var(--surface-card);border:1px solid var(--border);border-radius:12px;padding:24px;width:560px;max-width:92vw">' +
      '<div style="font-size:16px;font-weight:700;margin-bottom:8px">' + aaEsc(title) + '</div>' +
      '<div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;line-height:1.7">' + aaEsc(desc) + I18N.t('aa_metamask_hint') + '</div>' +
      '<div style="font-size:11px;font-weight:600;color:var(--text-dim);margin-bottom:4px">' + I18N.t('aa_hash_label') + '</div>' +
      '<div style="display:flex;gap:8px;margin-bottom:12px"><code class="mono" id="aa-sig-hash" style="font-size:11px;word-break:break-all;flex:1;background:var(--surface-input);padding:8px 10px;border-radius:6px">' + userOpHash + '</code>' +
      '<button class="btn btn-sm" onclick="copyText(document.getElementById(\'aa-sig-hash\').textContent)">📋</button></div>' +
      '<label style="font-size:11px;font-weight:600;color:var(--text-dim)">' + I18N.t('aa_sig_label') + '</label>' +
      '<textarea class="input mono" id="aa-sig-input" rows="2" style="margin-top:4px;font-size:11px" placeholder="' + I18N.t('aa_sig_placeholder') + '"></textarea>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">' +
        '<button class="btn btn-outline btn-sm" onclick="this.closest(\'div\').parentElement.parentElement.remove()">' + I18N.t('cancel') + '</button>' +
        '<button class="btn btn-primary btn-sm" onclick="aaAutoSign()">' + I18N.t('aa_wallet_sign') + '</button>' +
        '<button class="btn btn-primary btn-sm" onclick="aaConfirmSig()">' + I18N.t('aa_confirm_sign') + '</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(overlay);

  window.aaAutoSign = function() {
    aaSignDigest(userOpHash, title).then(function(sig) {
      var ta = document.getElementById('aa-sig-input');
      if (ta) ta.value = sig;
      aaConfirmSig();
    }).catch(function(e) {
      showToast(e.message || I18N.t('aa_sign_failed'), 'error');
    });
  };
  window.aaConfirmSig = function() {
    var ta = document.getElementById('aa-sig-input');
    var sig = ta && ta.value.trim();
    if (!sig) return showToast(I18N.t('aa_sign_first'), 'warning');
    overlay.remove();
    onSigned(sig);
  };
}

// 注册 tab 渲染
(function() {
  var ui = {
    overview: aaRenderOverview,
    sessions: aaRenderSessions,
    create: aaRenderCreateForm,
  };
  document.addEventListener('click', function(e) {
    var b = e.target.closest('.tab-btn[data-aa-tab]');
    if (!b) return;
    var t = b.getAttribute('data-aa-tab');
    if (ui[t]) ui[t]();
  });
})();
