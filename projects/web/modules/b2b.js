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

function rpcInit() {
  var root = document.getElementById('rpc-root');
  if (!root || root.dataset.loaded) return;
  root.dataset.loaded = '1';
  root.innerHTML =
    '<div class="waas-intro" style="max-width:820px;margin:0 auto">' +
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
        // W-8: 套餐订阅 + 自助签发 key（解决"进入后看不到选择套餐"）
        '<div style="margin-top:28px;text-align:left">' +
          '<div style="font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.6px;color:var(--text-tertiary);margin-bottom:12px">选择套餐 · 自助订阅</div>' +
          '<div class="waas-plan-row" id="rpc-plan-row">' +
            RPC_DEFAULT_PLANS.map(rpcPlanCard).join('') +
          '</div>' +
          '<div id="rpc-sub-status" style="text-align:center;margin-bottom:16px;font-size:13px;min-height:20px"></div>' +
          '<div id="rpc-my-sub"></div>' +
        '</div>' +
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
  rpcLoadPlans();
  rpcLoadMySub();
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
  if (!rpcWallet()) { showToast('Connect wallet first', 'error'); return; }
  var st = document.getElementById('rpc-sub-status');
  if (st) st.innerHTML = '<span style="color:var(--text-muted)">⏳ 正在签发…</span>';
  rpcEnsureKey()
    .then(function (r) {
      if (st) st.innerHTML = '<span style="color:var(--success)">✅ rx_ key 已就绪：<code class="dc-mono" style="color:var(--gold-light)">' + r.key + '</code></span>';
      showToast('rx_ key issued — store it securely', 'success');
      rpcLoadMySub();
    })
    .catch(function (e) {
      if (st) st.innerHTML = '<span style="color:var(--error)">❌ ' + (e.message || '签发失败') + '</span>';
    });
}

// W-8: 订阅入口——免费直接激活；付费先确保 key 再 checkout
function rpcSubscribe(planId) {
  if (!rpcWallet()) { showToast('Connect wallet first', 'error'); return; }
  var st = document.getElementById('rpc-sub-status');
  function setStatus(html, ok) {
    if (st) st.innerHTML = '<span style="color:' + (ok ? 'var(--success)' : 'var(--error)') + '">' + html + '</span>';
  }
  rpcEnsureKey()
    .then(function (r) {
      if (planId === 'rpc_free') {
        setStatus('✅ Free 套餐已激活，rx_ key：<code class="dc-mono">' + r.key + '</code>', true);
        showToast('RPC Free plan activated!', 'success');
        rpcLoadMySub();
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
      rpcLoadMySub();
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
        rpcLoadMySub();
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
      rpcLoadMySub();
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
