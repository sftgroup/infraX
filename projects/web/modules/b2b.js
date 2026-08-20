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

function rpcInit() {
  var root = document.getElementById('rpc-root');
  if (!root || root.dataset.loaded) return;
  root.dataset.loaded = '1';
  root.innerHTML =
    '<div class="waas-intro" style="max-width:760px;margin:0 auto">' +
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
        '<div class="waas-intro-note">状态为面板健康检查结果；套餐与用量请通过管理端或 API 订阅接口查询。</div>' +
      '</div>' +
      '<div class="enhanced-card" style="margin-top:24px;text-align:left;background:var(--surface-card);border:1px solid var(--border);border-radius:var(--r-md);padding:18px 22px">' +
        '<div style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.6px;color:var(--text-tertiary);margin-bottom:4px">链上事件 · DC 解析增强</div>' +
        '<p style="font-size:12.5px;color:var(--text-muted);margin:4px 0 14px">已解码业务事件（转账 / 授权 / DEX 兑换…），RPC 原始日志之上的解析增值层。同一读 key 计费。</p>' +
        '<div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:12px">' +
          '<select id="rpc-ev-chain" style="padding:7px 10px;background:var(--surface);border:1px solid var(--border);border-radius:6px;font-size:13px">' +
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
      '</div>' +
    '</div>';
  b2bHealthBar('rpc', 'b2b-rpc-health');
  rpcLoadStats();
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
