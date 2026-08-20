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
    '</div>';
  b2bHealthBar('rpc', 'b2b-rpc-health');
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
