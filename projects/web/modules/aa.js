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
  chain: 'base-sepolia',
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
        reason + '\n\n请签名以下 userOpHash（raw digest，ethers: signer.signMessage({raw: hash})）\n' + userOpHash + '\n\n粘贴签名（0x…）:\n',
        ''
      );
      if (manual && manual.trim().length > 10) resolve(manual.trim());
      else reject(new Error('签名已取消'));
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
  aaState.chain = localStorage.getItem('px_aa_chain') || 'base-sepolia';
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
      '<div style="font-size:15px;font-weight:700">🤖 AA Session Manager</div>' +
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
    if (pane) pane.innerHTML = '<div style="text-align:center;padding:60px"><div style="font-size:44px;margin-bottom:12px">🤖</div><div style="font-size:15px;color:var(--warning)">Connect wallet to manage AA sessions</div><a href="/connect.html" style="color:var(--gold);font-size:13px">→ Go to Connect</a></div>';
    return;
  }

  // ① 派生智能账户（只读）
  if (!aaState.account) {
    try {
      var d = await aaFetch('/v1/account/derive', { method: 'POST', body: { chain: aaState.chain, owner: owner } });
      if (d && d.accountAddress) aaSaveAccount(d.accountAddress);
    } catch (e) {
      aaRenderOverviewError('账户派生失败：' + (e.message || 'aa-relay 不可达') + '（确认后端 aa-relay 已启动）');
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
    ? '<span style="color:var(--warning)">escrow-onchain（链上托管）</span>'
    : '<span style="color:var(--text-brand)">session-subscription</span>';

  var feeHtml = (p.fees && p.fees.length)
    ? p.fees.map(function(f) {
        return '<tr><td>' + aaEsc(f.label) + '</td><td class="mono" style="text-align:right">' + aaFmtWei(f.feeWei) + ' ' + (f.operation === 'userop' ? 'OXA' : 'ETH') + '</td></tr>';
      }).join('')
    : '<tr><td colspan="2" style="text-align:center;color:var(--text-muted)">free (billing not configured)</td></tr>';

  var topupHtml = '';
  if (p.topup && p.topup.method && p.topup.method !== 'n/a') {
    topupHtml = '<div class="panel" style="margin-top:14px"><div class="panel-header">💰 充值引导 · ' + aaEsc(p.topup.method) + '</div><div class="panel-body" style="font-size:13px;line-height:1.9">' +
      (p.topup.steps || []).map(function(s, i) { return '<div style="display:flex;gap:10px;margin-bottom:6px"><span class="mono" style="color:var(--brand);font-weight:700">' + (i + 1) + '</span><span>' + aaEsc(s) + '</span></div>'; }).join('') +
      '</div></div>';
  }

  var fundsHtml = '';
  if (p.mode === 'escrow-onchain' && funds) {
    var escrow = aaFmtWei(funds.escrowWei);
    var epDep = funds.epDepositWei != null ? aaFmtWei(funds.epDepositWei) : '—';
    var native = funds.nativeWei != null ? aaFmtWei(funds.nativeWei) : '—';
    var low = Number(funds.escrowWei || 0) === 0;
    fundsHtml = '<div class="panel" style="margin-top:14px"><div class="panel-header">📦 托管资金明细（escrow）</div><div class="panel-body">' +
      '<div class="kpi-grid" style="grid-template-columns:repeat(3,1fr)">' +
        '<div class="kpi"><div class="kpi-label">Escrow 余额</div><div class="kpi-val mono" style="font-size:20px;font-weight:700;color:' + (low ? 'var(--error)' : 'var(--success)') + '">' + escrow + ' OXA</div></div>' +
        '<div class="kpi"><div class="kpi-label">EntryPoint 存款</div><div class="kpi-val mono" style="font-size:20px;font-weight:700">' + epDep + ' ETH</div></div>' +
        '<div class="kpi"><div class="kpi-label">账户原生余额</div><div class="kpi-val mono" style="font-size:20px;font-weight:700">' + native + ' ETH</div></div>' +
      '</div>' +
      (low ? '<div style="margin-top:10px;padding:10px 12px;border-radius:8px;background:rgba(246,70,93,.08);border:1px solid rgba(246,70,93,.3);font-size:12px;color:var(--error)">⚠️ Escrow 余额为 0 —— 广播 UserOp 前需先充值（见下方充值引导），否则计费预扣将失败（402）。</div>' : '') +
      '</div></div>';
  } else if (l.balance) {
    fundsHtml = '<div class="panel" style="margin-top:14px"><div class="panel-header">📒 Ledger 余额</div><div class="panel-body"><div class="mono" style="font-size:22px;font-weight:700;color:var(--success)">' + aaFmtWei(l.balanceWei) + ' ETH</div></div></div>';
  }

  var accountHtml = aaState.account
    ? '<div class="addr-pill" style="font-size:13px;cursor:pointer" onclick="copyText(\'' + aaState.account + '\')" title="点击复制">🤖 ' + aaState.account.slice(0, 12) + '…' + aaState.account.slice(-8) + '</div>'
    : '<span class="text-dim">—</span>';

  pane.innerHTML =
    '<div class="kpi-grid" style="grid-template-columns:repeat(4,1fr)">' +
      '<div class="kpi-card" style="border-top:3px solid var(--brand-purple)"><div class="kpi-label">Smart Account</div><div class="kpi-val" style="font-size:14px;font-weight:700;margin-top:6px">' + accountHtml + '</div><div class="kpi-sub" style="font-size:11px;color:var(--text-muted);margin-top:6px">Kernel v3 · owner=' + aaShort(user().walletAddress, 6) + '</div></div>' +
      '<div class="kpi-card" style="border-top:3px solid var(--success)"><div class="kpi-label">Ledger Balance</div><div class="kpi-val mono" style="font-size:22px;font-weight:700;margin-top:4px">' + aaFmtWei(l.balanceWei) + ' <span style="font-size:12px;color:var(--text-muted)">ETH</span></div><div class="kpi-sub" style="font-size:11px;color:var(--text-muted);margin-top:4px">paymaster 代付余额</div></div>' +
      '<div class="kpi-card" style="border-top:3px solid var(--warning)"><div class="kpi-label">Billing Mode</div><div class="kpi-val" style="font-size:14px;font-weight:700;margin-top:8px">' + modeHtml + '</div><div class="kpi-sub" style="font-size:11px;color:var(--text-muted);margin-top:6px">' + (p.configured ? '计费已配置' : '计费未配置（免费）') + '</div></div>' +
      '<div class="kpi-card" style="border-top:3px solid var(--brand)"><div class="kpi-label">Sessions</div><div class="kpi-val mono" style="font-size:22px;font-weight:700;margin-top:4px">' + (aaState.sessions.length || 0) + '</div><div class="kpi-sub" style="font-size:11px;color:var(--text-muted);margin-top:4px">链上绑定: ' + (aaState.sessions.length ? (aaState.sessions[0].isBound ? '✅' : '⚠️ 未部署') : '—') + '</div></div>' +
    '</div>' +
    '<div class="panel"><div class="panel-header">💳 计费费率（' + aaEsc(p.mode || 'n/a') + '）</div><div class="panel-body" style="padding:0"><table class="data-table"><thead><tr><th>Operation</th><th>Fee</th></tr></thead><tbody>' + feeHtml + '</tbody></table></div></div>' +
    '<div class="panel" style="margin-top:14px"><div class="panel-header">🤖 Auto-Renew 自动续订</div><div class="panel-body" style="font-size:13px;color:var(--text-secondary);line-height:1.8">' +
      'Session 自动续订由平台网关 daemon 在到期前用 session key 签发 UserOp 续订订阅。<br>' +
      '<span style="color:var(--text-muted)">本面板提供支撑能力：轮换（replace）可无缝更换 session key；撤销（revoke）可立即吊销。续订前请确保 <b>escrow 余额充足</b>（上方托管明细）。</span>' +
    '</div></div>' +
    fundsHtml +
    topupHtml;
}

// ── Sessions ──
function aaRenderSessions() {
  var pane = document.getElementById('aa-pane-sessions');
  if (!pane) return;
  if (!aaState.account) {
    pane.innerHTML = '<div class="empty">Account 未初始化（先进入 Overview 派生）</div>';
    return;
  }
  var list = aaState.sessions || [];
  if (!list.length) {
    pane.innerHTML = '<div class="empty" style="padding:48px"><div class="empty-icon" style="font-size:44px">🔑</div><div class="empty-text">No sessions</div><div class="empty-sub">Create your first session in the ➕ Create Session tab</div></div>';
    return;
  }
  pane.innerHTML =
    '<div class="panel"><div class="panel-header">🔑 Session 列表 <span style="font-size:11px;font-weight:400;color:var(--text-muted);margin-left:auto">' + list.length + ' 条 · account=' + aaShort(aaState.account, 8) + '</span></div>' +
    '<div class="panel-body" style="padding:0"><table class="data-table">' +
    '<thead><tr><th>Session ID</th><th>Signer (key)</th><th>有效期</th><th>权限</th><th>创建时间</th><th>操作</th></tr></thead><tbody>' +
    list.map(function(s) {
      return '<tr>' +
        '<td class="mono" style="font-size:12px">' + aaShort(s.sessionId, 12) + '</td>' +
        '<td class="mono" style="font-size:12px">' + aaShort(s.signer, 10) + '</td>' +
        '<td style="font-size:12px">' + aaExpiry(s.validUntil) + '<br><span class="mono" style="font-size:10px;color:var(--text-muted)">until ' + (s.validUntil || '—') + '</span></td>' +
        '<td>' + aaPermSummary(s.permissions) + '</td>' +
        '<td class="mono" style="font-size:11px">' + (s.createdAt ? new Date(s.createdAt).toLocaleDateString('en', { month: 'short', day: 'numeric' }) : '—') + '</td>' +
        '<td style="white-space:nowrap"><button class="btn btn-sm" style="font-size:12px;padding:4px 10px" onclick="aaStartRevoke(\'' + s.sessionId + '\')" title="两阶段撤销（本地停用 + 签名上链）">🚫 Revoke</button> ' +
        '<button class="btn btn-sm" style="font-size:12px;padding:4px 10px;background:var(--surface-hover)" onclick="aaStartReplace(\'' + s.sessionId + '\')" title="轮换 session key（两笔 UserOp）">🔄 Replace</button></td>' +
      '</tr>';
    }).join('') +
    '</tbody></table></div></div>';
}

// ── Create Session ──
function aaRenderCreateForm() {
  var pane = document.getElementById('aa-pane-create');
  if (!pane) return;
  if (!user().walletAddress) {
    pane.innerHTML = '<div class="empty">请先连接钱包</div>';
    return;
  }
  var now = Math.floor(Date.now() / 1000);
  var defValid = now + 30 * 86400;
  var defPerms = '[{"target":"0x0000000000000000000000000000000000000001","selectors":["0x8a7b9a6b"],"valueLimit":"1000000000000000000","countLimit":100}]';
  pane.innerHTML =
    '<div class="panel"><div class="panel-header">➕ 创建 Session</div><div class="panel-body">' +
      '<div class="form-row" style="grid-template-columns:1fr 1fr">' +
        '<div><label style="font-size:12px;font-weight:600;color:var(--text-dim)">Owner（当前连接钱包）</label><div class="addr-pill mono" style="font-size:12px;margin-top:4px">' + aaShort(user().walletAddress, 12) + '</div></div>' +
        '<div><label style="font-size:12px;font-weight:600;color:var(--text-dim)">Product</label><select class="input" id="aa-product" style="margin-top:4px"><option value="default">default</option></select></div>' +
      '</div>' +
      '<div class="form-row" style="grid-template-columns:1fr 1fr">' +
        '<div><label style="font-size:12px;font-weight:600;color:var(--text-dim)">有效天数</label><input class="input" id="aa-valid-days" type="number" value="30" min="1" style="margin-top:4px"></div>' +
        '<div><label style="font-size:12px;font-weight:600;color:var(--text-dim)">validUntil (unix)</label><input class="input mono" id="aa-valid-until" value="' + defValid + '" style="margin-top:4px"></div>' +
      '</div>' +
      '<label style="font-size:12px;font-weight:600;color:var(--text-dim)">Permissions（JSON 数组）</label>' +
      '<textarea class="input mono" id="aa-perms" rows="4" style="margin-top:4px;font-size:12px;white-space:pre">' + defPerms + '</textarea>' +
      '<div style="font-size:11px;color:var(--text-muted);margin:8px 0 12px;line-height:1.7">字段：<code>target</code> 授权合约地址 · <code>selectors</code> 函数选择器（空=全部）· <code>valueLimit</code> 单笔转账额度(wei) · <code>countLimit</code> 调用次数上限。target=哨兵 <code>0x…0001</code> 表示原生币任意转账授权。</div>' +
      '<button class="btn btn-primary" id="aa-create-btn" onclick="aaCreateSession()">🚀 Create Session</button> ' +
      '<button class="btn btn-outline" onclick="aaFillPermPresets()">✨ 填充示例</button>' +
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
  } catch (e) { return showToast('Permissions 必须是合法 JSON 数组', 'error'); }

  btn.classList.add('btn-loading');
  result.innerHTML = '<div style="padding:10px;color:var(--text-muted)">⏳ 派生账户 + 生成 session key…</div>';
  try {
    var d = await aaFetch('/v1/session', {
      method: 'POST',
      body: { chain: aaState.chain, product: aaState.product, owner: owner, permissions: permissions, validUntil: validUntil },
    });
    if (d.accountAddress) aaSaveAccount(d.accountAddress);
    // 复用/冲突处理
    if (d.reused) {
      result.innerHTML = '<div style="padding:12px;border-radius:8px;background:rgba(14,203,129,.08);border:1px solid rgba(14,203,129,.3);font-size:13px">' +
        '✅ 复用既有兼容 session（零链上交易）<br><code class="mono">' + d.sessionId + '</code><br>session key: <code class="mono">' + d.sessionKey + '</code></div>';
    } else if (!d.isBound) {
      result.innerHTML = '<div style="padding:12px;border-radius:8px;background:rgba(14,203,129,.08);border:1px solid rgba(14,203,129,.3);font-size:13px">' +
        '<b>✅ Session 已生成（本地）</b><br>' +
        'Smart Account: <code class="mono">' + d.accountAddress + '</code><br>' +
        'Session ID: <code class="mono">' + d.sessionId + '</code><br>' +
        'Session Key <span style="color:var(--warning)">（仅此一次）</span>: <code class="mono">' + d.sessionKey + '</code><br><br>' +
        '<b>下一步：链上 enable（需 owner 签名 + UserOp 广播）</b><br>' +
        '复制下方 enableCallData，使用 SDK/CLI 组装 UserOp 并调 <code>POST /v1/userops</code> 上链后，session 才真正生效：<br>' +
        '<div style="display:flex;gap:8px;align-items:center;margin-top:8px"><code class="mono" id="aa-enable-cd" style="font-size:11px;word-break:break-all;flex:1">' + d.enableCallData + '</code>' +
        '<button class="btn btn-sm" onclick="copyText(document.getElementById(\'aa-enable-cd\').textContent)">📋 Copy</button></div>' +
        '<div style="font-size:11px;color:var(--text-muted);margin-top:8px">💡 提示：enable 需在撤销/替换上链确认后构建（digest 绑定 nonce）。参考 SDK 快速开始文档的两笔轮换流程。</div>' +
        '</div>';
    } else {
      result.innerHTML = '<div style="padding:12px;border-radius:8px;background:rgba(246,70,93,.08);border:1px solid rgba(246,70,93,.3);font-size:13px">' +
        '⚠️ 账户已绑定不兼容 session（' + (d.needsSessionRevoke ? '需先撤销' : '') + '）。请到 Sessions 页对旧 session 执行 Revoke 后重试。</div>';
    }
    aaLoadAll();
  } catch (e) {
    // 409 session-conflict：错误体中带 accountAddress
    if (e.data && e.data.accountAddress) aaSaveAccount(e.data.accountAddress);
    result.innerHTML = '<div style="padding:12px;border-radius:8px;background:rgba(246,70,93,.08);border:1px solid rgba(246,70,93,.3);font-size:13px;color:var(--error)">❌ ' + aaEsc(e.message || '创建失败') + '</div>';
  } finally {
    btn.classList.remove('btn-loading');
  }
}

// ── Revoke（两阶段：disable → 签名 → revoke）──
async function aaStartRevoke(sessionId) {
  if (!confirm('确认撤销 session ' + sessionId.slice(0, 12) + '…？\n阶段1：本地停用 + 构建上链撤销 UserOp。')) return;
  var msg = document.createElement('div');
  msg.style.cssText = 'margin:10px 0;padding:12px;border-radius:8px;background:var(--surface-input);font-size:13px;color:var(--text-muted)';
  msg.textContent = '⏳ 构建撤销 draft…';
  document.body.appendChild(msg);
  try {
    var d = await aaFetch('/v1/session/disable', {
      method: 'POST',
      body: { chain: aaState.chain, product: aaState.product, account: aaState.account, sessionId: sessionId },
    });
    msg.remove();
    if (!d || !d.draft || !d.draft.userOpHash) {
      showToast('draft 构建失败（已本地停用）', 'warning');
      aaLoadAll();
      return;
    }
    aaState.pendingRevoke = { sessionId: sessionId, draft: d.draft };
    aaPromptSign(
      '撤销上链确认',
      '签名以下 disable UserOp 的 userOpHash（owner EOA，raw digest）：',
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
    showToast('✅ Session 已撤销 on-chain: ' + (r.userOpHash || '').slice(0, 12) + '…', 'success');
    aaState.pendingRevoke = null;
    aaLoadAll();
  } catch (e) {
    showToast('撤销上链失败：' + e.message, 'error');
  }
}

// ── Replace（两阶段：replace → 签名 disable 旧 → submit；新 session 已落库）──
async function aaStartReplace(oldSessionId) {
  var now = Math.floor(Date.now() / 1000);
  var perms = window.prompt(
    '轮换 session ' + oldSessionId.slice(0, 12) + '…\n请输入新 session 的 permissions（JSON 数组）:\n',
    '[{"target":"0x0000000000000000000000000000000000000001","selectors":[],"valueLimit":"50000000000000000","countLimit":20}]'
  );
  if (!perms) return;
  var permissions;
  try { permissions = JSON.parse(perms); } catch (e) { return showToast('Permissions JSON 非法', 'error'); }
  var days = window.prompt('有效天数（默认 30）:', '30');
  var validUntil = now + (parseInt(days || '30', 10) || 30) * 86400;

  var msg = document.createElement('div');
  msg.style.cssText = 'margin:10px 0;padding:12px;border-radius:8px;background:var(--surface-input);font-size:13px;color:var(--text-muted)';
  msg.textContent = '⏳ 阶段1：生成新 session key + 构建 disable 旧 draft…';
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
      showToast('disable draft 构建失败（新 session 已本地落库）', 'warning');
      aaLoadAll();
      return;
    }
    aaPromptSign(
      '轮换确认（阶段2/2）',
      '签名 disable 旧 session 的 userOpHash（新 session key 已生成，将在此次上链后接管）：',
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
    showToast('✅ 旧 session 已上链禁用: ' + (r.userOpHash || '').slice(0, 12) + '…', 'success');
    var note = '轮换完成（阶段1/2）。新 session key 已保存可用于复用：\n' + d.sessionKey +
      '\n\n阶段2：新 session 链上 enable 需用 SDK buildEnableSessionUserOp 组装 UserOp 并 POST /v1/userops 广播（enable digest 绑定阶段1的 nonce，需在阶段1确认后构建）。';
    window.prompt('新 session key（复制保存）', d.sessionKey);
    showToast(note, 'info');
    aaState.pendingReplace = null;
    aaLoadAll();
  } catch (e) {
    showToast('轮换上链失败：' + e.message, 'error');
  }
}

// ── 签名弹窗（eth_sign 失败 → 手动粘贴）──
function aaPromptSign(title, desc, userOpHash, onSigned) {
  var overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:300;display:flex;align-items:center;justify-content:center';
  overlay.innerHTML =
    '<div style="background:var(--surface-card);border:1px solid var(--border);border-radius:12px;padding:24px;width:560px;max-width:92vw">' +
      '<div style="font-size:16px;font-weight:700;margin-bottom:8px">' + aaEsc(title) + '</div>' +
      '<div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;line-height:1.7">' + aaEsc(desc) + '<br>MetaMask 默认禁用 eth_sign，签名失败时会切换为手动模式。</div>' +
      '<div style="font-size:11px;font-weight:600;color:var(--text-dim);margin-bottom:4px">userOpHash（raw digest）</div>' +
      '<div style="display:flex;gap:8px;margin-bottom:12px"><code class="mono" id="aa-sig-hash" style="font-size:11px;word-break:break-all;flex:1;background:var(--surface-input);padding:8px 10px;border-radius:6px">' + userOpHash + '</code>' +
      '<button class="btn btn-sm" onclick="copyText(document.getElementById(\'aa-sig-hash\').textContent)">📋</button></div>' +
      '<label style="font-size:11px;font-weight:600;color:var(--text-dim)">签名（0x…）</label>' +
      '<textarea class="input mono" id="aa-sig-input" rows="2" style="margin-top:4px;font-size:11px" placeholder="钱包 eth_sign 自动填入，或手动粘贴"></textarea>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">' +
        '<button class="btn btn-outline btn-sm" onclick="this.closest(\'div\').parentElement.parentElement.remove()">取消</button>' +
        '<button class="btn btn-primary btn-sm" onclick="aaAutoSign()">🦊 钱包签名</button>' +
        '<button class="btn btn-primary btn-sm" onclick="aaConfirmSig()">确认签名</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(overlay);

  window.aaAutoSign = function() {
    aaSignDigest(userOpHash, title).then(function(sig) {
      var ta = document.getElementById('aa-sig-input');
      if (ta) ta.value = sig;
      aaConfirmSig();
    }).catch(function(e) {
      showToast(e.message || '签名失败', 'error');
    });
  };
  window.aaConfirmSig = function() {
    var ta = document.getElementById('aa-sig-input');
    var sig = ta && ta.value.trim();
    if (!sig) return showToast('请先签名', 'warning');
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
