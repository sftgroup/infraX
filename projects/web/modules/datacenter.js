/**
 * InfraX Data Center — B2B On-chain Data API Module
 * Dependencies: core.js, infrax.css
 */

function obscureKey(key) { return key && key.length > 16 ? key.slice(0,14) + '…' + key.slice(-8) : key; }

// ─── State ───────────────────────────────────────────────────────────
let dcPlan = null;
let dcUsage = null;
let dcEventsPageToken = null;

const DC_CHAINS = [
  { name: 'Sepolia', img: '/img/chain-sepolia.svg', color: '#6366f1' },
  { name: 'Ethereum', img: '/img/chain-ethereum.svg', color: '#627eea' },
  { name: 'BSC', img: '/img/chain-bsc.svg', color: '#f0b90b' },
  { name: 'Base', img: '/img/chain-base.svg', color: '#0052ff' },
  { name: 'OxaChain', img: '/img/chain-oxa.svg', color: '#ff6b35' },
];

// ─── Init ────────────────────────────────────────────────────────────
async function dcInit() {
  const sel = document.getElementById('dc-filter-chain');
  if (sel) {
    sel.innerHTML = '<option value="">All Chains</option>' + 
      DC_CHAINS.map(c => '<option value="' + c.name.toLowerCase() + '">' + c.name + '</option>').join('');
  }

  var addr = '';
  try { addr = user().walletAddress || ''; } catch(e) {}

  if (!addr) {
    var intro = document.getElementById('dc-intro');
    if (intro) {
      intro.innerHTML = '<div style="text-align:center;padding:60px">' +
        '<div style="font-size:48px;margin-bottom:12px">🔌</div>' +
        '<div style="font-size:16px;color:var(--gold-light);margin-bottom:8px">Connect wallet to view Data & Insights</div>' +
        '<a href="/connect.html" style="color:var(--gold);font-size:14px">→ Go to Connect</a>' +
        '<div style="margin-top:20px"><button class="btn btn-secondary" onclick="dcSkipToInsights()">📈 浏览 Insights（无需钱包）</button></div></div>';
    }
    return;
  }

  try {
    const ok = await dcRefreshUsage();
    if (ok) {
      // MQ-16 T-1: 付费订阅待支付 → 停留在 intro 并提示等待支付确认
      if (dcUsage.dcSubStatus === 'pending') {
        var sEl = document.getElementById('dc-sub-status');
        if (sEl) sEl.innerHTML = '<span style="color:var(--warning)">⏳ 订阅待支付确认</span> <button class="btn btn-sm btn-primary" onclick="dcRecheckPayment()" style="margin-left:8px">刷新支付状态</button>';
        var ie = document.getElementById('dc-intro');
        var de = document.getElementById('dc-dash');
        if (ie) ie.style.display = 'block';
        if (de) de.style.display = 'none';
      } else {
        await dcLoadDashboard();
      }
      return;
    }
  } catch (e) {
    console.log('dcInit error:', e.message);
  }
  var ie = document.getElementById('dc-intro');
  var de = document.getElementById('dc-dash');
  if (ie) ie.style.display = 'block';
  if (de) de.style.display = 'none';
}

// MQ-16 T-1: 拉取真实用量（plan/quota/usage/订阅状态）并刷新本地状态
async function dcRefreshUsage() {
  var addr = '';
  try { addr = user().walletAddress || ''; } catch(e) {}
  if (!addr) return false;
  const usage = await afetch('/api/v2/data/usage?walletAddress=' + encodeURIComponent(addr), { auth: 'none' });
  if (usage && usage.planId) {
    dcPlan = { id: usage.planId, name: usage.planName };
    dcUsage = usage;
    return true;
  }
  return false;
}

// ─── Subscribe ───────────────────────────────────────────────────────
async function dcSubscribe(planId) {
  const wallet = (typeof user !== 'undefined' && user()?.walletAddress) || '';
  if (!wallet) { showToast('Connect wallet first', 'error'); return; }
  var statusEl = document.getElementById('dc-sub-status');
  function setStatus(html, ok) {
    if (statusEl) statusEl.innerHTML = '<span style="color:' + (ok ? 'var(--success)' : 'var(--error)') + '">' + html + '</span>';
  }
  try {
    const resp = await afetch('/api/v2/data/subscribe', {
      method: 'POST', auth: 'none',
      headers: { 'Content-Type': 'application/json', 'x-wallet-address': wallet },
      body: JSON.stringify({ planId }),
    });
    // MQ-16 T-1: free 套餐直通 active（返回 dcApiKey）；付费套餐走引擎支付流程（pending）
    if (resp.dcSubStatus === 'active' && resp.dcApiKey) {
      setStatus('✅ ' + ((resp.plan && resp.plan.name) || planId) + ' plan activated', true);
      showToast('Data plan activated!', 'success');
      await dcRefreshUsage();
      await dcLoadDashboard();
      return;
    }
    var pay = resp.payment;
    if (!pay) { setStatus('❌ Subscribe failed — please try again', false); showToast('Subscribe failed — please try again', 'error'); return; }
    if (pay.rail === 'chain') {
      var isNative = !pay.payToken || pay.payToken === '0x0000000000000000000000000000000000000000';
      var amount = pay.price !== undefined ? (Number(pay.price) / 1e18).toFixed(4) + ' ' + (isNative ? 'ETH' : pay.payToken) : '';
      setStatus('⏳ 请在钱包中完成链上订阅（chainId ' + pay.chainId + '）<br>' +
        'SubscriptionManager: <code>' + pay.subscriptionManager + '</code><br>' +
        '金额: <b>' + amount + '</b> / ' + (pay.period || 'month') + '<br>' +
        '<small>当前钱包即 subscriber，支付确认后自动生效</small>', true);
      showToast('等待链上支付确认…', 'info');
      dcPollSubscription();
    } else if (pay.rail === 'fiat') {
      setStatus('⏳ 跳转支付页…', true);
      window.location.href = pay.sessionUrl;
    } else if (pay.rail === 'x402') {
      var amountEth = pay.priceWei ? (Number(pay.priceWei) / 1e18).toFixed(4) : '';
      setStatus('⏳ 请向 <code>' + pay.payTo + '</code> 转账 ' + amountEth + ' ETH（' + pay.network + '）<br>' +
        '<small>转账完成后请输入交易哈希（txHash）确认</small>', true);
      showToast('完成转账后提交 txHash', 'info');
      dcSubmitX402(pay.network);
    }
  } catch (e) {
    setStatus('❌ ' + (e.message || 'Network error'), false);
    showToast(e.message || 'Network error', 'error');
  }
}

// MQ-16 T-1: chain rail — 轮询支付状态（payment-check），确认后刷新 dashboard
var dcPollTimer = null;
function dcPollSubscription(timeoutMs) {
  var started = Date.now();
  if (dcPollTimer) { clearInterval(dcPollTimer); dcPollTimer = null; }
  dcPollTimer = setInterval(async function () {
    try {
      var d = await afetch('/api/v2/data/payment-check', { method: 'POST', auth: 'none' });
      if (d.status === 'active') {
        clearInterval(dcPollTimer); dcPollTimer = null;
        await dcRefreshUsage();
        showToast('Data plan activated!', 'success');
        var statusEl = document.getElementById('dc-sub-status');
        if (statusEl) statusEl.innerHTML = '<span style="color:var(--success)">✅ 支付确认，套餐已激活</span>';
        await dcLoadDashboard();
      }
    } catch (_) {}
    if (Date.now() - started > (timeoutMs || 5 * 60 * 1000)) {
      clearInterval(dcPollTimer); dcPollTimer = null;
      var statusEl = document.getElementById('dc-sub-status');
      if (statusEl) statusEl.innerHTML = '<span style="color:var(--error)">⏰ 等待支付超时，请确认已支付后重试</span>';
    }
  }, 4000);
}

// MQ-16 T-1: x402 rail — 提示用户输入链上转账 txHash 并调 /verify 激活订阅
async function dcSubmitX402(network) {
  var txHash = window.prompt('请输入 ' + (network || '链上') + ' 转账的交易哈希（txHash）:');
  if (!txHash) return;
  try {
    var d = await afetch('/api/v2/data/verify', { method: 'POST', auth: 'none', body: { txHash: txHash } });
    if (d.verified && d.activated) {
      showToast('支付已确认，套餐已激活!', 'success');
      await dcRefreshUsage();
      var statusEl = document.getElementById('dc-sub-status');
      if (statusEl) statusEl.innerHTML = '<span style="color:var(--success)">✅ 支付确认，套餐已激活</span>';
      await dcLoadDashboard();
    } else if (d.verified) {
      showToast('支付已确认，但未找到待处理订阅', 'error');
    } else {
      showToast('支付未确认', 'error');
    }
  } catch (e) { showToast(e.message, 'error'); }
}

// MQ-16 T-1: 手动刷新支付状态（pending 态 intro 按钮）
async function dcRecheckPayment() {
  try {
    var d = await afetch('/api/v2/data/payment-check', { method: 'POST', auth: 'none' });
    if (d.status === 'active') {
      await dcRefreshUsage();
      showToast('支付已确认，套餐已激活!', 'success');
      await dcLoadDashboard();
    } else {
      showToast('支付仍在确认中…', 'warning');
    }
  } catch (e) { showToast(e.message, 'error'); }
}

// ─── Load Dashboard ──────────────────────────────────────────────────
async function dcLoadDashboard() {
  var ie = document.getElementById('dc-intro');
  var de = document.getElementById('dc-dash');

  if (dcUsage && dcPlan) {
    if (ie) ie.style.display = 'none';
    if (de) de.style.display = 'block';

    setHtml('dc-plan-name', dcPlan.name + (dcUsage.dcSubStatus && dcUsage.dcSubStatus !== 'active' ? '<br><span style="font-size:11px;color:var(--warning)">' + dcUsage.dcSubStatus + '</span>' : ''));
    setHtml('dc-usage-count', formatNumber(dcUsage.currentUsage || 0));
    setHtml('dc-quota', formatNumber(dcUsage.monthlyQuota || 0));

    // Overview 真实数据（/stats /event-stats /events，替代 mock）
    var hdrs = {};
    if (dcUsage && dcUsage.dcApiKey) hdrs['x-dc-api-key'] = dcUsage.dcApiKey;
    await dcLoadOverview(hdrs);

    var apiKey = dcUsage?.dcApiKey || '—';
    var ki = document.getElementById('dc-api-key');
    if (ki) ki.value = apiKey;
  } else {
    if (ie) ie.style.display = 'block';
    if (de) de.style.display = 'none';
  }
}

// ─── Overview 真实数据（/stats 总量 /event-stats /events，替代 mock）───
async function dcLoadOverview(hdrs) {
  // 链上事件总量（/stats，event_checkpoints 增量统计，O(1)）
  try {
    var s = await afetch('/api/v2/data/stats', { auth: 'none', headers: hdrs });
    var total = s && typeof s.total === 'number' ? s.total : 0;
    setHtml('dc-total-events', formatNumber(total));
  } catch (_) {}
  // 事件分类分布（/event-stats，O(1) event_category_stats）
  try {
    var es = await afetch('/api/v2/data/event-stats', { auth: 'none', headers: hdrs });
    var cats = (es && Array.isArray(es.categories)) ? es.categories : [];
    var names = {};
    try {
      var cc = await afetch('/api/v2/data/event-categories', { auth: 'none', headers: hdrs });
      if (Array.isArray(cc)) cc.forEach(function(c) { if (!names[c.category_id]) names[c.category_id] = c.name; });
    } catch (_) {}
    var catBox = document.getElementById('dc-cat-stats');
    var catTotal = document.getElementById('dc-cat-total');
    if (!cats.length) {
      if (catBox) catBox.innerHTML = '<div class="empty" style="padding:20px 0;color:var(--text-muted)">暂无分类数据</div>';
      if (catTotal) catTotal.textContent = '';
    } else {
      var sum = cats.reduce(function(a, c) { return a + (c.count || 0); }, 0);
      if (catTotal) catTotal.textContent = formatNumber(sum) + ' events';
      if (catBox) {
        catBox.innerHTML = cats.map(function(c) {
          var pct = sum ? Math.round((c.count / sum) * 100) : 0;
          var nm = names[c.category_id] || c.category_id;
          return '<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">' +
            '<span style="width:130px;font-size:12px;color:var(--text-secondary);text-align:right">' + nm + '</span>' +
            '<div style="flex:1;height:10px;border-radius:5px;background:var(--bg-sub,#242a36);overflow:hidden"><div style="width:' + pct + '%;height:100%;background:var(--brand,#F0B90B);border-radius:5px"></div></div>' +
            '<span style="width:110px;font-size:12px" class="dc-mono">' + formatNumber(c.count) + ' · ' + pct + '%</span>' +
          '</div>';
        }).join('');
      }
    }
  } catch (_) {}
  // 最近事件（/events）
  try {
    var ev = await afetch('/api/v2/data/events?page_size=8', { auth: 'none', headers: hdrs });
    var rows = (ev && Array.isArray(ev.data)) ? ev.data : [];
    var tbody = document.getElementById('dc-recent-tbody');
    var hint = document.getElementById('dc-recent-hint');
    if (!rows.length) {
      if (tbody) tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:20px;color:var(--text-muted)">暂无事件</td></tr>';
      if (hint) hint.textContent = '';
      return;
    }
    if (hint) hint.textContent = '最新 ' + rows.length + ' 条';
    if (tbody) {
      tbody.innerHTML = rows.map(function(e) {
        var sf = (e.from_address || '').slice(0, 10) + '...';
        var st = (e.to_address || '').slice(0, 10) + '...';
        var sx = (e.tx_hash || '').slice(0, 8) + '...';
        return '<tr style="border-bottom:1px solid var(--border)"><td style="padding:6px 10px"><span class="dc-chain-badge dc-chain-' + e.chain + '">' + e.chain + '</span></td><td style="padding:6px 10px" class="dc-mono">' + formatNumber(e.block_number) + '</td><td style="padding:6px 10px">' + e.event_type + '</td><td style="padding:6px 10px" class="dc-mono">' + sf + '</td><td style="padding:6px 10px" class="dc-mono">' + st + '</td><td style="padding:6px 10px">' + (e.amount || '—') + ' ' + (e.token_symbol || '') + '</td><td style="padding:6px 10px" class="dc-mono">' + sx + '</td></tr>';
      }).join('');
    }
  } catch (_) {}
}

// ─── Explorer ────────────────────────────────────────────────────────
async function dcQueryEvents(pageToken) {
  const chain = document.getElementById('dc-filter-chain')?.value || '';
  const address = document.getElementById('dc-filter-addr')?.value || '';
  const eventType = document.getElementById('dc-filter-type')?.value || '';
  const params = new URLSearchParams();
  if (chain) params.set('chain', chain);
  if (address) params.set('address', address);
  if (eventType) params.set('event_type', eventType);
  params.set('page_size', '20');
  if (pageToken) params.set('page_token', pageToken);
  const tbody = document.getElementById('dc-events-tbody');
  if (tbody) tbody.innerHTML = '<tr><td colspan="7" style="padding:14px 20px"><div class="skeleton-text" style="width:95%"></div><div class="skeleton-text" style="width:70%"></div><div class="skeleton-text short"></div></td></tr>';
  try {
    const headers = {};
    if (dcUsage && dcUsage.dcApiKey) headers['x-dc-api-key'] = dcUsage.dcApiKey;
    const resp = await afetch('/api/v2/data/events?' + params.toString(), { auth: 'none', headers: headers });
    if (!resp || !resp.data) {
      if (tbody) tbody.innerHTML = '<tr><td colspan="7" style="color:var(--text-muted);text-align:center;padding:24px">No results</td></tr>';
      return;
    }
    const { data, next_page_token } = resp;
    dcEventsPageToken = next_page_token;
    if (!data || data.length === 0) {
      if (tbody) tbody.innerHTML = '<tr><td colspan="7" style="color:var(--text-muted);text-align:center;padding:24px">No events found</td></tr>';
      return;
    }
    if (tbody) {
      tbody.innerHTML = data.map(function(e) {
        var sf = (e.from_address || '').slice(0, 10) + '...';
        var st = (e.to_address || '').slice(0, 10) + '...';
        var sx = (e.tx_hash || '').slice(0, 8) + '...';
        return '<tr><td><span class="dc-chain-badge dc-chain-' + e.chain + '">' + e.chain + '</span></td><td>' + formatNumber(e.block_number) + '</td><td>' + e.event_type + '</td><td><span class="dc-mono">' + sf + '</span></td><td><span class="dc-mono">' + st + '</span></td><td>' + (e.amount || '—') + ' ' + (e.token_symbol || '') + '</td><td><span class="dc-mono">' + sx + '</span></td></tr>';
      }).join('');
    }
    const pager = document.getElementById('dc-explorer-pager');
    if (pager) {
      pager.innerHTML = next_page_token ? '<button class="btn btn-sm" onclick="dcQueryEvents(\'' + next_page_token + '\')">Next Page →</button>' : '<span style="color:var(--text-muted);font-size:12px">End of results</span>';
    }
  } catch (e) {
    if (tbody) tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:24px;color:var(--binance-red,#F6465D)">Query failed</td></tr>';
  }
}

// ─── Copy Key ────────────────────────────────────────────────────────
function dcCopyKey() {
  const input = document.getElementById('dc-api-key');
  if (!input || !input.value || input.value === '—') return;
  navigator.clipboard.writeText(input.value).then(function() { showToast('API Key copied', 'success'); });
}

// ─── Tab Switch ──────────────────────────────────────────────────────
function dcSkipToInsights() {
  var ie = document.getElementById('dc-intro');
  var de = document.getElementById('dc-dash');
  if (ie) ie.style.display = 'none';
  if (de) de.style.display = 'block';
  dcSwitchTab('dc-insights');
}

function dcSwitchTab(sub) {
  document.querySelectorAll('#dc-dash .tab-btn').forEach(function(b) { b.classList.remove('active'); });
  document.querySelectorAll('#dc-dash .sub-panel').forEach(function(p) { p.classList.remove('active'); });
  const btn = document.querySelector('#dc-dash [data-sub="' + sub + '"]');
  const panel = document.getElementById('sub-' + sub);
  if (btn) btn.classList.add('active');
  if (panel) panel.classList.add('active');
  if (sub === 'dc-apikey') myKeysLoad(); // B-11-3：进入 API Key 页加载用户级 keys
  if (sub === 'dc-insights' && !window._insInitDone) { // dx_ key 数据能力合并：首次进入渲染 Insights
    window._insInitDone = true;
    if (typeof insightsInit === 'function') insightsInit();
  }
  if (sub === 'dc-market' && !window._dcMarketInitDone) { // 金融行情（/ticker /bars）：首次进入渲染
    window._dcMarketInitDone = true;
    dcRenderMarket();
  }
}

// ─── Market Data（金融行情：/ticker 实时报价 + /bars K线，data :9112 直通）──
function dcRenderMarket() {
  var root = document.getElementById('dc-market-root');
  if (!root) return;
  var inputStyle = 'width:170px;font-size:12px;padding:7px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-card,#1b1f27);color:var(--text,#e8eaed)';
  var selStyle = 'font-size:12px;padding:7px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-card,#1b1f27);color:var(--text,#e8eaed)';
  root.innerHTML =
    '<div class="panel" style="margin-bottom:14px"><div class="panel-body" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">' +
      '<input id="dc-m-symbol" placeholder="Symbol · 如 BTC/USDT" value="BTC/USDT" style="' + inputStyle + '">' +
      '<select id="dc-m-market" style="' + selStyle + 'width:120px">' +
        '<option value="crypto" selected>crypto</option><option value="usstock">usstock</option><option value="forex">forex</option><option value="futures">futures</option><option value="cnstock">cnstock</option><option value="hkstock">hkstock</option>' +
      '</select>' +
      '<select id="dc-m-type" style="' + selStyle + 'width:96px">' +
        '<option value="">auto</option><option value="spot">spot</option><option value="swap">swap</option>' +
      '</select>' +
      '<select id="dc-m-tf" style="' + selStyle + 'width:84px">' +
        '<option value="1h">1h</option><option value="4h">4h</option><option value="1d" selected>1d</option>' +
      '</select>' +
      '<button class="btn btn-sm btn-primary" onclick="dcLoadMarket()">🔄 查询</button>' +
      '<span style="font-size:11px;color:var(--text-muted)">金融行情 · /ticker /bars（data :9112）</span>' +
    '</div></div>' +
    '<div id="dc-market-result"></div>';
  dcLoadMarket();
}

async function dcLoadMarket() {
  var box = document.getElementById('dc-market-result');
  if (!box) return;
  box.innerHTML = '<div style="padding:14px 4px"><div class="skeleton-text" style="width:92%"></div><div class="skeleton-text" style="width:66%"></div><div class="skeleton-text short"></div></div>';
  var symbol = (document.getElementById('dc-m-symbol').value || 'BTC/USDT').trim();
  var market = document.getElementById('dc-m-market').value;
  var mtype = document.getElementById('dc-m-type').value;
  var tf = document.getElementById('dc-m-tf').value;
  var mtypeQ = mtype ? '&market_type=' + encodeURIComponent(mtype) : '';
  try {
    var tResp = await afetch('/ticker?symbol=' + encodeURIComponent(symbol) + '&market=' + encodeURIComponent(market) + mtypeQ, { auth: 'none' });
    var bResp = await afetch('/bars?symbol=' + encodeURIComponent(symbol) + '&timeframe=' + encodeURIComponent(tf) + mtypeQ + '&limit=15', { auth: 'none' });
    var t = tResp && typeof tResp.price === 'number' ? tResp : null;
    var bars = (bResp && Array.isArray(bResp.bars)) ? bResp.bars : [];
    var html = '';
    if (t) {
      var up = (t.changePercent || 0) >= 0;
      var color = up ? '#0ecb81' : '#F6465D';
      var arrow = up ? '▲' : '▼';
      html += '<div class="panel" style="margin-bottom:14px"><div class="panel-header">💹 ' + esc(symbol) + ' · 实时报价' +
        '<span style="margin-left:auto;font-weight:700;color:' + color + '">' + arrow + ' ' + formatNumber(t.changePercent) + '%</span></div>' +
        '<div class="panel-body"><div class="kpi-grid" style="display:grid;grid-template-columns:repeat(5,1fr);gap:12px">' +
        '<div class="kpi"><div class="kpi-label">Price</div><div class="kpi-val" style="color:' + color + '">' + formatNumber(t.price) + '</div></div>' +
        '<div class="kpi"><div class="kpi-label">Change</div><div class="kpi-val">' + formatNumber(t.change) + '</div></div>' +
        '<div class="kpi"><div class="kpi-label">High</div><div class="kpi-val">' + formatNumber(t.high) + '</div></div>' +
        '<div class="kpi"><div class="kpi-label">Low</div><div class="kpi-val">' + formatNumber(t.low) + '</div></div>' +
        '<div class="kpi"><div class="kpi-label">Open</div><div class="kpi-val">' + formatNumber(t.open) + '</div></div>' +
        '</div></div></div>';
    } else {
      html += '<div class="panel" style="margin-bottom:14px"><div class="panel-body" style="color:var(--text-muted);font-size:13px">' + esc(symbol) + '（' + esc(market) + '）无实时报价 — crypto 用 BTC/USDT，其余市场用对应代码</div></div>';
    }
    if (bars.length) {
      html += '<div class="panel"><div class="panel-header">📊 ' + esc(symbol) + ' · ' + esc(tf) + ' K线（近 ' + bars.length + ' 根）</div>' +
        '<div class="panel-body" style="padding:0;overflow:auto"><table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr style="text-align:left;color:var(--text-muted)"><th style="padding:8px 10px;border-bottom:1px solid var(--border)">时间</th><th style="padding:8px 10px;border-bottom:1px solid var(--border)">开盘</th><th style="padding:8px 10px;border-bottom:1px solid var(--border)">最高</th><th style="padding:8px 10px;border-bottom:1px solid var(--border)">最低</th><th style="padding:8px 10px;border-bottom:1px solid var(--border)">收盘</th><th style="padding:8px 10px;border-bottom:1px solid var(--border)">成交量</th></tr></thead><tbody>' +
        bars.map(function(b) {
          var ts = b.ts || b.timestamp || 0;
          var time = ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '—';
          return '<tr style="border-bottom:1px solid var(--border)"><td class="dc-mono">' + time + '</td><td style="padding:6px 10px">' + formatNumber(b.open) + '</td><td style="padding:6px 10px">' + formatNumber(b.high) + '</td><td style="padding:6px 10px">' + formatNumber(b.low) + '</td><td style="padding:6px 10px">' + formatNumber(b.close) + '</td><td style="padding:6px 10px">' + formatNumber(b.volume) + '</td></tr>';
        }).join('') + '</tbody></table></div></div>';
    } else {
      html += '<div class="panel"><div class="panel-body" style="color:var(--text-muted);font-size:13px">' + esc(symbol) + ' · ' + esc(tf) + ' 无 K 线数据</div></div>';
    }
    box.innerHTML = html;
  } catch (e) {
    box.innerHTML = '<div class="panel"><div class="panel-body" style="color:var(--binance-red,#F6465D)">加载失败：' + esc(e && e.message ? e.message : String(e)) + '</div></div>';
  }
}

// ─── My Keys（B-11-3 用户级 key 自助管理，钱包签名鉴权）───────────────
var myKeysNewKey = null;
function myKeysMsg(text, ok) {
  const el = document.getElementById('mykeys-msg');
  if (!el) return;
  if (myKeysNewKey) {
    el.innerHTML = '<div style="padding:10px;border:1px solid var(--border);border-radius:8px;background:rgba(14,203,129,0.06)">' +
      '<div style="font-weight:700;margin-bottom:4px">新 key —— 仅此一次显示，请立即复制保存</div>' +
      '<div class="mono" style="word-break:break-all;margin-bottom:6px">' + esc(myKeysNewKey) + '</div>' +
      '<button class="btn btn-xs" onclick="myKeysCopyNew()">📋 复制</button></div>';
    myKeysNewKey = null;
    return;
  }
  el.textContent = text || '';
  el.style.color = ok ? 'var(--green,#0ecb81)' : 'var(--binance-red,#F6465D)';
}
function myKeysCopyNew() {
  const el = document.querySelector('#mykeys-msg .mono');
  if (el) navigator.clipboard.writeText(el.textContent).then(function() { showToast('Copied', 'success'); });
}
function myKeysRender(resp) {
  const tbody = document.getElementById('mykeys-tbody');
  const hint = document.getElementById('mykeys-hint');
  if (!tbody) return;
  if (hint) hint.textContent = user().walletAddress ? ('owner: ' + user().walletAddress.slice(0, 6) + '…' + user().walletAddress.slice(-4)) : '未连接钱包';
  const keys = (resp && resp.keys) || [];
  if (!keys.length) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:20px;color:var(--text-muted)">暂无 key，在上方签发第一个</td></tr>';
    return;
  }
  tbody.innerHTML = keys.map(function(k) {
    var scopeBadge = k.scope === 'mcp' ? 'mx_' : k.scope === 'payment' ? 'px_' : k.scope === 'vault' ? 'vx_' : k.scope === 'mpc' ? 'mp_' : k.scope === 'chain-rpc' ? 'cr_' : k.scope === 'waas' ? 'wa_' : 'dx_';
    return '<tr>' +
      '<td style="font-weight:600">' + esc(k.label) + '</td>' +
      '<td><span class="dc-chain-badge">' + esc(k.scope || 'data') + '（' + scopeBadge + '）</span></td>' +
      '<td class="mono">' + esc(k.key_masked) + '</td>' +
      '<td>' + (k.enabled ? '<span style="color:var(--green,#0ecb81)">启用</span>' : '<span style="color:var(--binance-red,#F6465D)">禁用</span>') + '</td>' +
      '<td class="mono">' + k.rate_limit + '/min</td>' +
      '<td class="mono">' + (k.request_count || 0) + '</td>' +
      '<td class="mono">' + fmtTime(k.last_used_at) + '</td>' +
      '<td><span style="display:inline-flex;gap:6px">' +
        '<button class="btn btn-xs" title="轮换" onclick="myKeysRotate(' + k.id + ')">🔄</button>' +
        '<button class="btn btn-xs" title="吊销" onclick="myKeysDelete(' + k.id + ')">🗑️</button>' +
      '</span></td>' +
    '</tr>';
  }).join('');
}
async function myKeysLoad() {
  var wa = user().walletAddress;
  if (!wa || wa === 'undefined' || !/^0x[a-fA-F0-9]+$/i.test(wa)) return;
  try {
    const resp = await afetch('/api/v2/data/my-keys', { auth: 'wallet' });
    myKeysRender(resp || { keys: [] });
    myKeysMsg('');
  } catch (e) {
    myKeysMsg('加载失败：' + e.message, false);
  }
}
async function myKeysCreate() {
  if (!user().walletAddress) { myKeysMsg('请先连接钱包', false); return; }
  const labelEl = document.getElementById('mykeys-label');
  const label = (labelEl && labelEl.value || '').trim();
  if (!label) { myKeysMsg('请填写 label', false); return; }
  myKeysNewKey = null;
  try {
    const resp = await afetch('/api/v2/data/my-keys', { method: 'POST', auth: 'wallet', body: { label: label, scope: 'data' } });
    if (resp && resp.api_key) {
      myKeysNewKey = resp.api_key;
      myKeysMsg('签发成功（新 key 仅显示一次）', true);
      if (labelEl) labelEl.value = '';
      myKeysLoad();
      showToast('New key issued — copy below', 'success');
    } else {
      myKeysMsg('签发失败：服务端未返回 key', false);
    }
  } catch (e) {
    myKeysMsg('签发失败：' + e.message, false);
  }
}
async function myKeysRotate(id) {
  try {
    const resp = await afetch('/api/v2/data/my-keys/' + id + '/rotate', { method: 'POST', auth: 'wallet' });
    if (resp && resp.api_key) { myKeysNewKey = resp.api_key; myKeysMsg('已轮换（新 key 仅显示一次）', true); }
    myKeysLoad();
  } catch (e) { myKeysMsg('轮换失败：' + e.message, false); }
}
async function myKeysDelete(id) {
  if (!confirm('确认吊销该 key？吊销后立即失效')) return;
  try {
    await afetch('/api/v2/data/my-keys/' + id, { method: 'DELETE', auth: 'wallet' });
    myKeysMsg('已吊销', true);
    myKeysLoad();
  } catch (e) { myKeysMsg('吊销失败：' + e.message, false); }
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }


// ─── Helpers ─────────────────────────────────────────────────────────
function formatNumber(n) { return n == null ? '—' : Number(n).toLocaleString(); }
function setHtml(id, html) { const el = document.getElementById(id); if (el) el.innerHTML = html; }

// ─── Register ────────────────────────────────────────────────────────
(function() {
  document.addEventListener('click', function(e) {
    const btn = e.target.closest('#dc-dash .tab-btn');
    if (btn) { var s = btn.getAttribute('data-sub'); if (s) dcSwitchTab(s); }
  });
})();
