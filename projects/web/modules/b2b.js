/**
 * InfraX B2B API Services — Chain RPC / LightRAG 服务介绍页
 * Dependencies: core.js, infrax.css
 */

// ─── 公共：健康状态条 ───────────────────────────────────────────────
function b2bHealthBar(svc, elId) {
  var el = document.getElementById(elId);
  if (!el) return;
  fetch(svc === 'rpc' ? '/api/v2/rpc/health' : '/api/rag/health')
    .then(function (r) { el.innerHTML = r.ok ? '<span class="status success">🟢 Up</span>' : '<span class="status failed">🔴 Down</span>'; })
    .catch(function () { el.innerHTML = '<span class="status failed">🔴 Down</span>'; });
}

function b2bFeature(icon, title, sub) {
  return '<div class="waas-feature">' +
    '<div class="waas-feature-icon">' + icon + '</div>' +
    '<div class="waas-feature-title">' + title + '</div>' +
    (sub ? '<div class="waas-feature-sub">' + sub + '</div>' : '') +
    '</div>';
}

function b2bAccess(rows) {
  var html = '<div style="text-align:left;margin:0 auto;max-width:560px;background:var(--surface-card);border:1px solid var(--border);border-radius:var(--r-md);padding:18px 22px">' +
    '<div style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.6px;color:var(--text-tertiary);margin-bottom:12px">接入方式</div>';
  for (var i = 0; i < rows.length; i++) {
    html += '<div style="display:flex;gap:10px;align-items:baseline;margin-bottom:8px">' +
      '<span style="min-width:76px;font-size:12px;color:var(--text-tertiary)">' + rows[i][0] + '</span>' +
      '<code style="font-size:12.5px;color:var(--gold-light);word-break:break-all">' + rows[i][1] + '</code></div>';
  }
  html += '</div>';
  return html;
}

// ─── Chain RPC ──────────────────────────────────────────────────────
const RPC_CHAINS = ['sepolia', 'ethereum', 'bsc', 'base', 'oxa', 'polygon', 'arbitrum', 'optimism', 'xlayer', 'solana'];

// W-8: 套餐静态默认（/v1/subscription/plans 拉取真实目录后刷新）
const RPC_DEFAULT_PLANS = [
  { id: 'rpc_free', name: 'Free', price: 0, badge: 'Free', emoji: '🆓', features: ['10,000 calls/mo', '5GB bandwidth', '10 concurrent'] },
  { id: 'rpc_pro', name: 'Pro', price: 79, badge: 'Popular', emoji: '⚡', features: ['100,000 calls/mo', '50GB bandwidth', '50 concurrent'] },
  { id: 'rpc_enterprise', name: 'Enterprise', price: 299, badge: 'Enterprise', emoji: '🏭', features: ['1,000,000 calls/mo', '500GB bandwidth', '200 concurrent'] },
];

function rpcPlanCard(p) {
  var featured = p.id === 'rpc_free' ? ' style="border-color:var(--brand)"' : (p.id === 'rpc_pro' ? ' class="waas-plan-pro"' : '');
  return '<div class="waas-plan"' + featured + ' data-plan="' + p.id + '" onclick="rpcSubscribe(\'' + p.id + '\')">' +
    '<div class="waas-plan-badge">' + p.badge + '</div>' +
    '<div class="waas-plan-name">' + p.emoji + ' RPC ' + p.name + '</div>' +
    '<div class="waas-plan-price">$' + p.price + '</div><div class="waas-plan-period">/mo</div>' +
    '<div class="waas-plan-features">' + p.features.join('<br>') + '</div>' +
    '<button class="btn btn-primary" style="margin-top:12px;width:100%">' + (p.price === 0 ? 'Get Started' : 'Subscribe') + '</button>' +
    '</div>';
}

// W-8d: 两阶段状态 —— rpc-intro（介绍+订阅套餐） / rpc-dash（详情页：获取 key + 功能状态）
var rpcSubState = null;

function rpcIntroHtml() {
  return '<div class="waas-intro" style="max-width:820px;margin:0 auto">' +
    '<div class="waas-intro-hero">' +
      '<div class="waas-intro-icon">🔗</div>' +
      '<h2>Chain RPC — 多链 JSON-RPC 网关</h2>' +
      '<p>B 端业务直连链网关，ethers / viem 零改动接入。读接口（<code>rx_</code> key）与广播接口（<code>bx_</code> key）分离，按套餐订阅计费。</p>' +
      '<div id="b2b-rpc-health" style="margin-bottom:20px;font-size:13px"></div>' +
      '<div class="waas-feature-row">' +
        b2bFeature('🌐', '10 条链', 'Sepolia · Ethereum · BSC · Base · OxaChain · Polygon · Arbitrum · Optimism · XLayer · Solana') +
        b2bFeature('⚡', '标准 JSON-RPC', 'eth_* / sol_* 全兼容') +
        b2bFeature('🔑', '读写分离', 'rx_ 读 · bx_ 广播') +
      '</div>' +
      b2bAccess([
        ['公网入口', 'https://rpc-gw.0xainet.top'],
        ['内网入口', 'http://&lt;host&gt;:9130'],
        ['认证', 'X-API-Key: rx_xxxx（读）/ bx_xxxx（广播）'],
      ]) +
    '</div>' +
    '<div id="rpc-intro-sub">' +
      '<div style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.6px;color:var(--text-tertiary);margin:28px 0 12px;text-align:center">选择套餐 · 自助订阅</div>' +
      '<div class="waas-plan-row" id="rpc-plan-row">' +
        RPC_DEFAULT_PLANS.map(rpcPlanCard).join('') +
      '</div>' +
      '<div style="text-align:center;margin-top:8px">' +
        '<button class="btn btn-primary btn-lg" style="padding:14px 40px;font-size:15px" onclick="rpcSubscribe(\'rpc_free\')">🚀 Activate Chain RPC</button>' +
      '</div>' +
      '<div id="rpc-sub-status" style="text-align:center;margin-bottom:16px;font-size:13px;min-height:20px"></div>' +
      '<p class="waas-intro-note" style="text-align:center">Free tier：10,000 calls/mo · 5GB bandwidth · 10 concurrent。付费套餐支持链上 / 法币 / x402 支付，随时升级。</p>' +
    '</div>' +
  '</div>';
}

function rpcEventsHtml() {
  return '<div class="enhanced-card" style="margin-top:24px;text-align:left;background:var(--surface-card);border:1px solid var(--border);border-radius:var(--r-md);padding:18px 22px">' +
    '<div style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.6px;color:var(--text-tertiary);margin-bottom:4px">链上事件 · DC 解析增强</div>' +
    '<p style="font-size:12.5px;color:var(--text-muted);margin:4px 0 14px">已解码业务事件（转账 / 授权 / DEX 兑换…），RPC 原始日志之上的解析增值层。同一读 key 计费。</p>' +
    '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:12px">' +
      '<select id="rpc-ev-chain" class="select" style="width:180px">' +
        RPC_CHAINS.map(function (c) { return '<option value="' + c + '">' + c + '</option>'; }).join('') +
      '</select>' +
      '<input id="rpc-ev-addr" placeholder="地址 / 合约（可选）" style="flex:1;min-width:200px;padding:7px 10px;background:var(--surface);border:1px solid var(--border);border-radius:6px;font-size:13px">' +
      '<button class="btn btn-sm" onclick="rpcLoadEvents()">查询</button>' +
    '</div>' +
    '<div id="rpc-ev-cats" style="margin-bottom:14px"></div>' +
    '<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12.5px">' +
      '<thead><tr style="color:var(--text-tertiary);text-align:left">' +
        '<th style="padding:6px 10px">Chain</th><th style="padding:6px 10px">Block</th><th style="padding:6px 10px">Type</th>' +
        '<th style="padding:6px 10px">From</th><th style="padding:6px 10px">To</th><th style="padding:6px 10px">Amount</th><th style="padding:6px 10px">Tx</th>' +
      '</tr></thead><tbody id="rpc-ev-tbody">' +
      '<tr><td colspan="7" style="text-align:center;padding:18px;color:var(--text-muted)">输入条件后查询</td></tr>' +
      '</tbody></table></div>' +
  '</div>';
}

function rpcDashHtml() {
  return '<div style="max-width:1100px;margin:0 auto">' +
    '<div class="kpi-grid" style="display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:20px">' +
      '<div class="kpi"><div class="kpi-icon" style="font-size:20px;line-height:1;margin-bottom:8px">⚡</div><div class="kpi-label">Plan</div><div class="kpi-val gold" id="rpc-plan-name" style="font-size:20px;font-weight:700">—</div></div>' +
      '<div class="kpi"><div class="kpi-icon" style="font-size:20px;line-height:1;margin-bottom:8px">📡</div><div class="kpi-label">API Calls</div><div class="kpi-val" id="rpc-usage-count" style="font-size:20px;font-weight:700">—</div></div>' +
      '<div class="kpi"><div class="kpi-icon" style="font-size:20px;line-height:1;margin-bottom:8px">🎯</div><div class="kpi-label">Monthly Quota</div><div class="kpi-val" id="rpc-quota" style="font-size:20px;font-weight:700">—</div></div>' +
      '<div class="kpi"><div class="kpi-icon" style="font-size:20px;line-height:1;margin-bottom:8px">🔌</div><div class="kpi-label">可用链</div><div class="kpi-val" id="rpc-status-kpi" style="font-size:20px;font-weight:700">—</div></div>' +
    '</div>' +
    '<div class="panel" style="margin-bottom:16px">' +
      '<div class="panel-header">🔑 API Key <span class="stat-chip" style="margin-left:auto">明文仅签发时展示一次</span></div>' +
      '<div class="panel-body"><div id="rpc-key-box" style="font-size:13px">Loading…</div></div>' +
    '</div>' +
    '<div class="tab-row">' +
      '<button class="tab-btn active" data-sub="rpc-sub">📋 我的订阅</button>' +
      '<button class="tab-btn" data-sub="rpc-events">🔎 链上事件</button>' +
      '<button class="tab-btn" data-sub="rpc-status">📊 节点状态</button>' +
      '<button class="tab-btn" data-sub="rpc-docs">📖 API Docs</button>' +
    '</div>' +
    '<div class="sub-panel active" id="sub-rpc-sub" style="text-align:left"><div id="rpc-my-sub"></div></div>' +
    '<div class="sub-panel" id="sub-rpc-events" style="text-align:left">' + rpcEventsHtml() + '</div>' +
    '<div class="sub-panel" id="sub-rpc-status" style="text-align:left">' + rpcStatusHtml() + '</div>' +
    '<div class="sub-panel" id="sub-rpc-docs" style="text-align:left">' + rpcDocsHtml() + '</div>' +
  '</div>';
}

function rpcInit() {
  var root = document.getElementById('rpc-root');
  if (!root || root.dataset.loaded) return;
  root.dataset.loaded = '1';
  root.innerHTML =
    '<div id="rpc-intro">' + rpcIntroHtml() + '</div>' +
    '<div id="rpc-dash" style="display:none">' + rpcDashHtml() + '</div>';
  b2bHealthBar('rpc', 'b2b-rpc-health');
  rpcLoadStats();
  rpcLoadPlans();
  rpcLoadStatus();
  rpcRefreshSub();
}

// W-8d: 查询订阅状态 —— 已订阅进入详情页（获取 key / 功能状态）；未订阅停留介绍页选套餐
function rpcRefreshSub() {
  var intro = document.getElementById('rpc-intro');
  var dash = document.getElementById('rpc-dash');
  if (!intro || !dash) return;
  var wallet = rpcWallet();
  if (!wallet) {
    var sub = document.getElementById('rpc-intro-sub');
    if (sub) sub.innerHTML =
      '<div style="text-align:center;padding:32px 24px;background:var(--surface);border:1px solid var(--border);border-radius:var(--r-md)">' +
        '<div style="font-size:40px;margin-bottom:10px">🔌</div>' +
        '<div style="font-size:15px;color:var(--gold-light);margin-bottom:6px">Connect wallet to subscribe &amp; get your rx_ key</div>' +
        '<a href="/connect.html" style="color:var(--gold);font-size:14px">→ Go to Connect</a>' +
        '<div style="margin-top:18px"><button class="btn btn-secondary" onclick="rpcSkipToStatus()">📊 直接查看节点状态（无需订阅）</button></div>' +
      '</div>';
    intro.style.display = 'block';
    dash.style.display = 'none';
    return;
  }
  afetch('/api/v2/rpc/v1/subscription/wallet-me', { auth: 'wallet' })
    .then(function (d) {
      rpcSubState = d;
      var keys = (d && Array.isArray(d.keys)) ? d.keys : [];
      if (keys.length) {
        rpcLoadDashboard();
      } else {
        intro.style.display = 'block';
        dash.style.display = 'none';
        var st = document.getElementById('rpc-sub-status');
        if (st) st.innerHTML = '';
      }
    })
    .catch(function (e) {
      intro.style.display = 'block';
      dash.style.display = 'none';
      var st = document.getElementById('rpc-sub-status');
      if (st) st.innerHTML = '<span style="color:var(--error)">订阅状态查询失败：' + (e.message || '请重试') + '</span>';
    });
}

// W-8d: 进入详情页 —— 隐藏介绍，展示 KPI + key + 功能状态 tab
function rpcLoadDashboard() {
  var intro = document.getElementById('rpc-intro');
  var dash = document.getElementById('rpc-dash');
  if (intro) intro.style.display = 'none';
  if (dash) dash.style.display = 'block';
  var st = document.getElementById('rpc-sub-status');
  if (st) st.innerHTML = '';
  rpcRenderKpi();
  rpcRenderKeyBox();
  rpcLoadMySub();
}

function rpcRenderKpi() {
  var d = rpcSubState || {};
  var keys = Array.isArray(d.keys) ? d.keys : [];
  var top = keys[0] || {};
  var status = top.status || '';
  setHtml('rpc-plan-name', (top.planName || '—') + (status && status !== 'active' ? '<br><span style="font-size:11px;color:var(--warning)">' + status + '</span>' : ''));
  setHtml('rpc-usage-count', formatNumber(top.currentUsage || 0));
  setHtml('rpc-quota', formatNumber(top.monthlyQuota || 0));
}

function rpcRenderKeyBox() {
  var box = document.getElementById('rpc-key-box');
  if (!box) return;
  var saved = '';
  try { saved = localStorage.getItem('px_rpc_key') || ''; } catch (e) {}
  var d = rpcSubState || {};
  var keys = Array.isArray(d.keys) ? d.keys : [];
  var html;
  if (saved) {
    html = '<div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">' +
      '<div style="flex:1;min-width:280px;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px 14px">' +
        '<div style="font-size:11px;color:var(--text-tertiary);margin-bottom:4px">你的 rx_ key（明文 · 本浏览器保存）</div>' +
        '<code class="dc-mono" style="color:var(--gold-light);font-size:13px;word-break:break-all">' + saved + '</code>' +
      '</div>' +
      '<button class="btn btn-primary" onclick="rpcCopyKey()">📋 复制 key</button>' +
      '<span style="font-size:12px;color:var(--text-tertiary)">读写分离：广播接口需另发 <code>bx_</code> key（联系管理员）</span>' +
    '</div>';
  } else if (keys.length) {
    html = '<div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">' +
      '<div style="flex:1;min-width:280px;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px 14px">' +
        '<div style="font-size:11px;color:var(--text-tertiary);margin-bottom:4px">你的 rx_ key（掩码）</div>' +
        '<code class="dc-mono" style="color:var(--gold-light);font-size:13px">' + keys[0].maskedKey + '</code>' +
      '</div>' +
      '<span style="font-size:12px;color:var(--warning)">key 明文仅签发时展示一次，服务端只存哈希 —— 请使用当时保存的 key</span>' +
    '</div>';
  } else {
    html = '<div style="text-align:center;padding:14px">' +
      '<div style="font-size:13px;color:var(--text-tertiary);margin-bottom:12px">还没有 rx_ 读 key，先签发一个</div>' +
      '<button class="btn btn-primary" onclick="rpcIssueKey(\'rpc_free\')">🔑 签发免费 rx_ key</button>' +
    '</div>';
  }
  box.innerHTML = html;
}

function rpcCopyKey() {
  var saved = '';
  try { saved = localStorage.getItem('px_rpc_key') || ''; } catch (e) {}
  if (!saved) { showToast('没有可复制的明文 key', 'warning'); return; }
  navigator.clipboard.writeText(saved).then(function () { showToast('rx_ key copied', 'success'); });
}

// W-8d: 未订阅也可直接浏览功能状态（节点状态 / API Docs）
function rpcSkipToStatus() {
  var intro = document.getElementById('rpc-intro');
  var dash = document.getElementById('rpc-dash');
  if (intro) intro.style.display = 'none';
  if (dash) dash.style.display = 'block';
  var btn = document.querySelector('#rpc-dash .tab-btn[data-sub="rpc-status"]');
  if (btn) btn.click();
  rpcLoadStatus();
}

// W-8: 拉取真实套餐目录（价格/配额随后端更新）
function rpcLoadPlans() {
  fetch('/api/v2/rpc/v1/subscription/plans')
    .then(function (r) { return r.json(); })
    .then(function (j) {
      if (!j || !j.data || !Array.isArray(j.data)) return;
      var row = document.getElementById('rpc-plan-row');
      if (!row) return;
      row.innerHTML = j.data.map(function (p) {
        var f = [
          formatNumber(p.features.callsPerMonth) + ' calls/mo',
          p.features.bandwidth + ' bandwidth',
          p.features.concurrent + ' concurrent',
        ];
        var card = {
          id: p.id, badge: p.id === 'rpc_pro' ? 'Popular' : (p.name.split(' ')[1] || p.id.split('_')[1]),
          emoji: p.id === 'rpc_free' ? '🆓' : (p.id === 'rpc_pro' ? '⚡' : '🏭'),
          name: p.name.split(' ').slice(1).join(' ') || p.name, price: p.price, features: f,
        };
        return rpcPlanCard(card);
      }).join('');
    })
    .catch(function () {});
}

// W-8e: 节点状态内容页（用户视角：只展示我们提供的 RPC 端点状态，不暴露内部池/上游明细）
function rpcStatusHtml() {
  return '<div class="panel" style="margin-top:24px">' +
    '<div class="panel-header">📊 节点状态 · 我们提供的 RPC 端点</div>' +
    '<div class="panel-body">' +
      '<p style="font-size:12.5px;color:var(--text-muted);margin:0 0 14px">各链对外 JSON-RPC 端点实时状态（<code>X-API-Key</code> 认证访问；读 <code>rx_</code> / 广播 <code>bx_</code> 读写分离）。</p>' +
      '<div id="rpc-status-root"><div style="text-align:center;padding:24px;color:var(--text-muted)">Loading node status…</div></div>' +
    '</div></div>';
}

function rpcLoadStatus() {
  var el = document.getElementById('rpc-status-root');
  if (!el) return;
  fetch('/api/v2/rpc/v1/status')
    .then(function (r) { return r.json(); })
    .then(function (j) {
      var chains = j && j.data && j.data.chains ? j.data.chains : null;
      if (!chains || !Object.keys(chains).length) {
        el.innerHTML = '<div style="text-align:center;padding:18px;color:var(--text-tertiary)">暂无节点状态数据</div>';
        return;
      }
      // 用户视角：只展示对外提供的端点状态，健康=池内至少 1 个 healthy 上游
      var chainOk = 0, chainTotal = 0;
      var rows = Object.keys(chains).map(function (c) {
        var s = chains[c];
        var eps = Array.isArray(s.endpoints) ? s.endpoints : [];
        var healthy = eps.filter(function (e) { return e.status === 'healthy'; }).length;
        chainTotal++;
        var color, text;
        if (healthy > 0) { chainOk++; color = 'var(--success)'; text = '● 正常'; }
        else if (eps.length > 0) { color = 'var(--error)'; text = '● 不可用'; }
        else { color = 'var(--text-tertiary)'; text = '● 未配置'; }
        return '<tr>' +
          '<td style="padding:8px 12px"><b>' + c + '</b>' +
            (s.chainId ? ' <span style="color:var(--text-tertiary);font-weight:400;font-size:12px">chainId ' + s.chainId + '</span>' : '') + '</td>' +
          '<td style="padding:8px 12px"><code class="dc-mono" style="font-size:12px">https://rpc-gw.0xainet.top/v1/rpc/' + c + '</code></td>' +
          '<td style="padding:8px 12px;color:' + color + ';font-weight:600">' + text + '</td>' +
        '</tr>';
      }).join('');
      // W-8d: 详情页 KPI —— 可用链 x/y
      setHtml('rpc-status-kpi', chainOk + '/' + chainTotal + ' 链');
      el.innerHTML = '<table class="dc-api-table" style="width:100%">' +
        '<thead><tr><th style="padding:8px 12px">Chain</th><th style="padding:8px 12px">我们的 RPC 端点</th><th style="padding:8px 12px">状态</th></tr></thead>' +
        '<tbody>' + rows + '</tbody></table>';
    })
    .catch(function () {
      el.innerHTML = '<div style="text-align:center;padding:18px;color:var(--error)">节点状态加载失败</div>';
    });
}

// W-8c: API Docs 内容页（接入文档：认证 / 端点 / 示例 / 广播 / 配额限制）
function rpcDocsHtml() {
  return '<div style="margin-top:24px">' +
    '<div class="panel"><div class="panel-header">🔐 Authentication</div><div class="panel-body">' +
      '<p style="font-size:13px;color:var(--text-secondary);margin:0 0 12px">所有 JSON-RPC 请求通过 <code>X-API-Key</code> 头认证。读接口用 <code>rx_</code> key，广播接口用 <code>bx_</code> key —— 读写分离，读 key 永远无法触达广播端点。</p>' +
      '<div class="dc-code-block"><pre>curl -H "X-API-Key: rx_YOUR_KEY" \\\n  https://rpc-gw.0xainet.top/v1/rpc/sepolia \\\n  -d \'{"method":"eth_blockNumber","params":[]}\'</pre></div>' +
    '</div></div>' +
    '<div class="panel" style="margin-top:16px"><div class="panel-header">📡 Endpoints</div><div class="panel-body">' +
      '<table class="dc-api-table">' +
        '<tr><th>用途</th><th>路径</th></tr>' +
        '<tr><td>读（信封格式）</td><td><code>POST /v1/rpc/:chain</code></td></tr>' +
        '<tr><td>读（标准 JSON-RPC，viem/ethers 直连）</td><td><code>POST /v1/rpc/:chain</code> + 头 <code>X-Json-Rpc: raw</code></td></tr>' +
        '<tr><td>广播</td><td><code>POST /v1/broadcast/:chain</code></td></tr>' +
        '<tr><td>池状态</td><td><code>GET /v1/status</code></td></tr>' +
        '<tr><td>订阅 / 签发 key</td><td><code>POST /v1/subscription/wallet-issue-key</code>（钱包签名）</td></tr>' +
      '</table>' +
      '<p style="font-size:12.5px;color:var(--text-muted);margin:10px 0 0">支持链：sepolia / ethereum / bsc / base / oxa / polygon / arbitrum / optimism / xlayer / solana</p>' +
    '</div></div>' +
    '<div class="panel" style="margin-top:16px"><div class="panel-header">💻 Quick Start</div><div class="panel-body">' +
      '<p style="font-size:13px;color:var(--text-secondary);margin:0 0 12px">标准 JSON-RPC（<code>X-Json-Rpc: raw</code>）示例：</p>' +
      '<div class="dc-code-block"><pre>curl -X POST https://rpc-gw.0xainet.top/v1/rpc/sepolia \\\n  -H "X-API-Key: rx_YOUR_KEY" -H "X-Json-Rpc: raw" -H "Content-Type: application/json" \\\n  -d \'{"jsonrpc":"2.0","id":1,"method":"eth_getBalance","params":["0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B","latest"]}\'</pre></div>' +
      '<p style="font-size:13px;color:var(--text-secondary);margin:16px 0 8px">ethers v6：</p>' +
      '<div class="dc-code-block"><pre>import { JsonRpcProvider } from "ethers";\nconst p = new JsonRpcProvider(\n  "https://rpc-gw.0xainet.top/v1/rpc/sepolia",\n  undefined,\n  { headers: { "X-API-Key": "rx_YOUR_KEY" } },\n);\nconsole.log(await p.getBlockNumber());</pre></div>' +
      '<p style="font-size:13px;color:var(--text-secondary);margin:16px 0 8px">viem：</p>' +
      '<div class="dc-code-block"><pre>import { createPublicClient, http } from "viem";\nimport { sepolia } from "viem/chains";\nconst c = createPublicClient({\n  chain: sepolia,\n  transport: http("https://rpc-gw.0xainet.top/v1/rpc/sepolia", {\n    fetchOptions: { headers: { "X-API-Key": "rx_YOUR_KEY" } },\n  }),\n});\nconsole.log(await c.getBlockNumber());</pre></div>' +
    '</div></div>' +
    '<div class="panel" style="margin-top:16px"><div class="panel-header">🚀 Broadcast</div><div class="panel-body">' +
      '<p style="font-size:13px;color:var(--text-secondary);margin:0 0 12px">使用 <code>bx_</code> key，信封格式支持 <code>wait</code> 确认轮询：</p>' +
      '<div class="dc-code-block"><pre>curl -X POST https://rpc-gw.0xainet.top/v1/broadcast/base \\\n  -H "X-API-Key: bx_YOUR_KEY" -H "Content-Type: application/json" \\\n  -d \'{"rawTransaction":"0x02f8...","wait":true,"timeoutMs":30000}\'</pre></div>' +
    '</div></div>' +
    '<div class="panel" style="margin-top:16px"><div class="panel-header">📊 套餐与限制</div><div class="panel-body">' +
      '<table class="dc-api-table">' +
        '<tr><th>套餐</th><th>价格</th><th>Calls/月</th><th>带宽</th><th>并发</th></tr>' +
        '<tr><td>RPC Free</td><td>$0</td><td>10,000</td><td>5GB</td><td>10</td></tr>' +
        '<tr><td>RPC Pro</td><td>$79</td><td>100,000</td><td>50GB</td><td>50</td></tr>' +
        '<tr><td>RPC Enterprise</td><td>$299</td><td>1,000,000</td><td>500GB</td><td>200</td></tr>' +
      '</table>' +
      '<p style="font-size:12.5px;color:var(--text-muted);margin:10px 0 0">按自然月结算；超配额返回 <code>503</code> + 升级提示。错误码：401 无效 key / 403 方法不在读白名单 / 400 参数错误 / 502 上游 RPC 错误。</p>' +
    '</div></div>' +
  '</div>';
}

// W-8: 钱包维度"我的订阅"（keys 掩码 + 套餐 + 当月用量）
function rpcWallet() { try { return user().walletAddress || ''; } catch (e) { return ''; } }

function rpcMySubHtml(noWallet) {
  if (noWallet) {
    return '<div style="text-align:center;padding:24px;background:var(--surface);border:1px solid var(--border);border-radius:var(--r-md)">' +
      '<div style="font-size:34px;margin-bottom:10px">🔌</div>' +
      '<div style="font-size:15px;color:var(--gold-light);margin-bottom:6px">Connect wallet to subscribe &amp; get your rx_ key</div>' +
      '<a href="/connect.html" style="color:var(--gold);font-size:14px">→ Go to Connect</a></div>';
  }
  return '<div style="text-align:center;padding:14px;color:var(--text-muted);font-size:13px">Loading your subscription…</div>';
}

function rpcLoadMySub() {
  var el = document.getElementById('rpc-my-sub');
  if (!el) return;
  var wallet = rpcWallet();
  if (!wallet) { el.innerHTML = rpcMySubHtml(true); return; }
  el.innerHTML = rpcMySubHtml(false);
  afetch('/api/v2/rpc/v1/subscription/wallet-me', { auth: 'wallet' })
    .then(function (d) {
      var keys = (d && Array.isArray(d.keys)) ? d.keys : [];
      if (!keys.length) {
        el.innerHTML = '<div style="text-align:center;padding:22px;background:var(--surface);border:1px solid var(--border);border-radius:var(--r-md)">' +
          '<div style="font-size:30px;margin-bottom:10px">🔑</div>' +
          '<div style="font-size:15px;color:var(--gold-light);margin-bottom:4px">还没有 rx_ 读 key</div>' +
          '<div style="font-size:12.5px;color:var(--text-tertiary);margin-bottom:14px">点击上方套餐卡片，免费套餐即刻签发可用</div>' +
          '<button class="btn btn-primary" onclick="rpcIssueKey(\'rpc_free\')">🔑 签发免费 rx_ key</button></div>';
        return;
      }
      el.innerHTML = '<div style="background:var(--surface-card);border:1px solid var(--border);border-radius:var(--r-md);padding:16px 20px;text-align:left">' +
        '<div style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.6px;color:var(--text-tertiary);margin-bottom:12px">我的订阅（' + keys.length + '）</div>' +
        keys.map(function (k) {
          var pct = k.monthlyQuota ? Math.min(100, Math.round((k.currentUsage / k.monthlyQuota) * 100)) : 0;
          var st = k.status === 'active'
            ? '<span class="status success">● active</span>'
            : '<span style="color:var(--warning)">● ' + (k.status || 'pending') + '</span>';
          return '<div style="display:flex;gap:14px;align-items:center;padding:10px 0;border-bottom:1px solid var(--border);flex-wrap:wrap">' +
            '<code class="dc-mono" style="color:var(--gold-light)">' + k.maskedKey + '</code>' +
            '<span style="font-size:13px">' + k.planName + '</span>' + st +
            '<span style="font-size:12px;color:var(--text-tertiary)">' + formatNumber(k.currentUsage) + ' / ' + formatNumber(k.monthlyQuota) + '</span>' +
            '<div style="flex:1;min-width:120px;height:8px;background:var(--surface);border-radius:4px;overflow:hidden">' +
              '<div style="width:' + pct + '%;height:100%;background:linear-gradient(90deg,var(--gold,#F0B90B),#d98e04)"></div></div>' +
          '</div>';
        }).join('') +
        '<div style="font-size:11.5px;color:var(--text-tertiary);margin-top:10px">key 明文仅签发时展示一次（服务端只存哈希）。升级付费套餐需使用已保存的明文 key。</div>' +
      '</div>';
    })
    .catch(function (e) {
      el.innerHTML = '<div style="text-align:center;padding:14px;color:var(--error);font-size:13px">加载失败：' + (e.message || '请重新连接钱包') + '</div>';
    });
}

// W-8: 确保钱包有 rx_ key（无则签发），返回 { key(明文|空), maskedKey, existing }
function rpcEnsureKey() {
  var saved = '';
  try { saved = localStorage.getItem('px_rpc_key') || ''; } catch (e) {}
  if (saved) return Promise.resolve({ key: saved, maskedKey: saved.slice(0, 8) + '…' + saved.slice(-4), existing: true });
  return afetch('/api/v2/rpc/v1/subscription/wallet-issue-key', { method: 'POST', auth: 'wallet', body: {} })
    .then(function (d) {
      if (d && d.rpcKey) {
        try { localStorage.setItem('px_rpc_key', d.rpcKey); } catch (e) {}
        return { key: d.rpcKey, maskedKey: d.maskedKey, existing: false };
      }
      if (d && d.alreadyExists) {
        // 已有 key 但明文丢失（未在本浏览器签发）
        throw new Error('你已有 rx_ key（' + d.maskedKey + '），但明文仅签发时展示一次，无法在浏览器恢复。请使用当时保存的 key。');
      }
      throw new Error('签发失败，请重试');
    });
}

// W-8: 签发 key 并展示（点击套餐卡片走 rpcSubscribe）
function rpcIssueKey(planId) {
  if (!rpcWallet()) {
    showToast('请先连接钱包，正在跳转…', 'warning');
    setTimeout(function () { window.location.href = '/connect.html'; }, 400);
    return;
  }
  var st = document.getElementById('rpc-sub-status');
  if (st) st.innerHTML = '<span style="color:var(--text-muted)">⏳ 正在签发…</span>';
  rpcEnsureKey()
    .then(function (r) {
      if (st) st.innerHTML = '<span style="color:var(--success)">✅ rx_ key 已就绪：<code class="dc-mono" style="color:var(--gold-light)">' + r.key + '</code></span>';
      showToast('rx_ key issued — store it securely', 'success');
      rpcRefreshSub();
    })
    .catch(function (e) {
      if (st) st.innerHTML = '<span style="color:var(--error)">❌ ' + (e.message || '签发失败') + '</span>';
    });
}

// W-8: 订阅入口——免费直接激活；付费先确保 key 再 checkout；未连接钱包跳转 connect
function rpcSubscribe(planId) {
  if (!rpcWallet()) {
    showToast('请先连接钱包，正在跳转…', 'warning');
    setTimeout(function () { window.location.href = '/connect.html'; }, 400);
    return;
  }
  var st = document.getElementById('rpc-sub-status');
  function setStatus(html, ok) {
    if (st) st.innerHTML = '<span style="color:' + (ok ? 'var(--success)' : 'var(--error)') + '">' + html + '</span>';
  }
  rpcEnsureKey()
    .then(function (r) {
      if (planId === 'rpc_free') {
        setStatus('✅ Free 套餐已激活，rx_ key：<code class="dc-mono">' + r.key + '</code>', true);
        showToast('RPC Free plan activated!', 'success');
        rpcRefreshSub();
        return;
      }
      return rpcCheckout(planId, r.key, setStatus);
    })
    .catch(function (e) { setStatus('❌ ' + (e.message || '订阅失败'), false); });
}

// W-8: 付费套餐发起支付（rx_ key 鉴权），对齐 DC 订阅支付流程
function rpcCheckout(planId, key, setStatus) {
  return afetch('/api/v2/rpc/v1/subscription/checkout', {
    method: 'POST', auth: 'wallet',
    headers: { 'x-rpc-key': key },
    body: { plan_id: planId },
  }).then(function (d) {
    if (d.rpcSubStatus === 'active') {
      if (setStatus) setStatus('✅ 套餐已激活', true);
      showToast('RPC plan activated!', 'success');
      rpcRefreshSub();
      return;
    }
    var pay = d.payment;
    if (!pay) { if (setStatus) setStatus('❌ 订阅失败，请重试', false); return; }
    if (pay.rail === 'chain') {
      var isNative = !pay.payToken || pay.payToken === '0x0000000000000000000000000000000000000000';
      var amount = pay.price !== undefined ? (Number(pay.price) / 1e18).toFixed(4) + ' ' + (isNative ? 'ETH' : pay.payToken) : '';
      if (setStatus) setStatus('⏳ 请在钱包完成链上订阅（chainId ' + pay.chainId + '）<br>' +
        'SubscriptionManager: <code>' + pay.subscriptionManager + '</code><br>金额: <b>' + amount + '</b> / month<br>' +
        '<small>支付确认后自动生效，请保持页面打开</small>', true);
      showToast('等待链上支付确认…', 'info');
      rpcPollSub(key, setStatus);
    } else if (pay.rail === 'fiat') {
      if (setStatus) setStatus('⏳ 跳转支付页…', true);
      window.location.href = pay.sessionUrl;
    } else if (pay.rail === 'x402') {
      var amountEth = pay.priceWei ? (Number(pay.priceWei) / 1e18).toFixed(4) : '';
      if (setStatus) setStatus('⏳ 请向 <code>' + pay.payTo + '</code> 转账 ' + amountEth + ' ETH（' + pay.network + '）<br><small>转账完成后提交 txHash</small>', true);
      rpcSubmitX402(key);
    } else {
      if (setStatus) setStatus('❌ 不支持的支付方式：' + pay.rail, false);
    }
  }).catch(function (e) {
    if (setStatus) setStatus('❌ ' + (e.message || '支付发起失败'), false);
  });
}

// W-8: chain rail 支付状态轮询
var rpcPollTimer = null;
function rpcPollSub(key, setStatus) {
  var started = Date.now();
  if (rpcPollTimer) { clearInterval(rpcPollTimer); rpcPollTimer = null; }
  rpcPollTimer = setInterval(function () {
    afetch('/api/v2/rpc/v1/subscription/payment-check', {
      method: 'POST', auth: 'wallet', headers: { 'x-rpc-key': key }, body: {},
    }).then(function (d) {
      if (d.status === 'active') {
        clearInterval(rpcPollTimer); rpcPollTimer = null;
        if (setStatus) setStatus('✅ 支付确认，套餐已激活', true);
        showToast('RPC plan activated!', 'success');
        rpcRefreshSub();
      }
    }).catch(function () {});
    if (Date.now() - started > 5 * 60 * 1000) {
      clearInterval(rpcPollTimer); rpcPollTimer = null;
      if (setStatus) setStatus('⏰ 等待支付超时，请确认已支付后重试', false);
    }
  }, 4000);
}

// W-8: x402 rail — 提示输入 txHash 并 verify 激活
function rpcSubmitX402(key) {
  var txHash = window.prompt('请输入链上转账的交易哈希（txHash）:');
  if (!txHash) return;
  afetch('/api/v2/rpc/v1/subscription/verify', {
    method: 'POST', auth: 'wallet', headers: { 'x-rpc-key': key }, body: { txHash: txHash },
  }).then(function (d) {
    if (d.verified && d.activated) {
      showToast('支付已确认，套餐已激活!', 'success');
      rpcRefreshSub();
    } else if (d.verified) {
      showToast('支付已确认，但未找到待处理订阅', 'error');
    } else {
      showToast('支付未确认', 'error');
    }
  }).catch(function (e) { showToast(e.message || '支付确认失败', 'error'); });
}

// 分类分布（event-stats，聚合表 O(1) 不扫事件表）
function rpcLoadStats() {
  fetch('/api/v2/enhanced/event-stats')
    .then(function (r) { return r.json(); })
    .then(function (j) {
      var el = document.getElementById('rpc-ev-cats');
      if (!el || !j || !j.data || !j.data.categories) return;
      var rows = (j.data.categories || []).slice(0, 5);
      var max = rows.length ? Math.max.apply(null, rows.map(function (c) { return c.count; })) : 1;
      el.innerHTML = '<div style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-tertiary);margin-bottom:8px">事件分类分布（全链）</div>' +
        rows.map(function (c) {
          var pct = Math.round((c.count / max) * 100);
          return '<div style="display:flex;align-items:center;gap:8px;margin-bottom:5px;font-size:12px">' +
            '<span style="min-width:130px;color:var(--text-secondary)">' + c.chain + ' · ' + c.category_id + '</span>' +
            '<div style="flex:1;height:8px;background:var(--surface);border-radius:4px;overflow:hidden"><div style="width:' + pct + '%;height:100%;background:linear-gradient(90deg,var(--gold,#F0B90B),#d98e04)"></div></div>' +
            '<span class="dc-mono" style="min-width:80px;text-align:right">' + formatNumber(c.count) + '</span>' +
          '</div>';
        }).join('');
    })
    .catch(function () {});
}

// 事件查询（GET /api/v2/enhanced/events → chain-rpc :9130 代理 DC :9102）
function rpcLoadEvents() {
  var chain = document.getElementById('rpc-ev-chain').value;
  var addr = (document.getElementById('rpc-ev-addr').value || '').trim();
  var params = new URLSearchParams();
  params.set('chain', chain);
  if (addr) params.set('address', addr);
  params.set('page_size', '10');
  var tbody = document.getElementById('rpc-ev-tbody');
  tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:18px;color:var(--text-muted)">Loading…</td></tr>';
  fetch('/api/v2/enhanced/events?' + params.toString())
    .then(function (r) { return r.json(); })
    .then(function (j) {
      var rows = (j && j.data && Array.isArray(j.data.data)) ? j.data.data : [];
      if (!rows.length) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:18px;color:var(--text-muted)">无事件</td></tr>';
        return;
      }
      tbody.innerHTML = rows.map(function (e) {
        var sf = (e.from_address || '—').slice(0, 10) + '...';
        var st = (e.to_address || '—').slice(0, 10) + '...';
        var sx = (e.tx_hash || '').slice(0, 8) + '...';
        return '<tr style="border-bottom:1px solid var(--border)">' +
          '<td style="padding:6px 10px"><span class="dc-chain-badge dc-chain-' + e.chain + '">' + e.chain + '</span></td>' +
          '<td style="padding:6px 10px" class="dc-mono">' + formatNumber(e.block_number) + '</td>' +
          '<td style="padding:6px 10px">' + e.event_type + '</td>' +
          '<td style="padding:6px 10px" class="dc-mono">' + sf + '</td>' +
          '<td style="padding:6px 10px" class="dc-mono">' + st + '</td>' +
          '<td style="padding:6px 10px">' + (e.amount || '—') + ' ' + (e.token_symbol || '') + '</td>' +
          '<td style="padding:6px 10px" class="dc-mono">' + sx + '</td></tr>';
      }).join('');
    })
    .catch(function () {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:18px;color:var(--binance-red,#F6465D)">查询失败</td></tr>';
    });
}

// ─── LightRAG ───────────────────────────────────────────────────────
function lightragInit() {
  var root = document.getElementById('lightrag-root');
  if (!root || root.dataset.loaded) return;
  root.dataset.loaded = '1';
  root.innerHTML =
    '<div class="waas-intro" style="max-width:760px;margin:0 auto">' +
      '<div class="waas-intro-hero">' +
        '<div class="waas-intro-icon">🔎</div>' +
        '<h2>LightRAG — 多租户知识图谱 RAG</h2>' +
        '<p>B 端文档知识库：上传 → 图谱索引 → 语义检索。按「租户 + 命名空间」隔离，支持 <code>X-Tenant-ID</code> 多租户分片，REST + MCP 双协议。</p>' +
        '<div id="b2b-lightrag-health" style="margin-bottom:20px;font-size:13px"></div>' +
        '<div class="waas-feature-row">' +
          b2bFeature('🏢', '多租户隔离', '(tenant_id, namespace) 数据空间') +
          b2bFeature('🔀', 'X-Tenant-ID 分片', '共享 key 服务账号模式') +
          b2bFeature('🔌', 'REST + MCP', 'Flask :9721 · STDIO') +
        '</div>' +
        b2bAccess([
          ['公网入口', 'https://infrax.0xainet.top/api/rag'],
          ['认证', 'X-API-Key: lr_xxxx（或 Bearer）'],
          ['多租户', 'X-Tenant-ID: &lt;botId&gt;（共享 key 时）'],
        ]) +
        '<div class="waas-intro-note">租户由 Admin 接口预创建，不隐式自动创建；越权访问返回 403 TENANT_FORBIDDEN。</div>' +
      '</div>' +
    '</div>';
  b2bHealthBar('lightrag', 'b2b-lightrag-health');
}
