// ============================================================================
// InfraX Insights · 数据面浏览（Graph / Factors / RAG / ML）
// 后端经 web server.js 反代：
//   知识图谱   GET  /factors/graph/entities?symbol=&namespace=market&limit=
//   相关性图   GET  /factors/graph/edges?symbols=&limit=
//   最新因子   GET  /factors/current?symbols=&category=
//   因子历史   GET  /factors/graph/history?symbols=&days=      （gf_* 日频序列）
//   因子目录   GET  /factors/catalog
//   RAG 检索   POST /rag/retrieve {query, namespaces, top_k}
//   ML 预测    GET  /ml/tree_predictions|volatility|consensus|bolt|moirai|timesfm
// data-service 响应直接为业务 JSON（无 code 包裹）；ml-service 为 {code, data} 包裹。
// 全部 fail-silent：后端不可用/无数据 → 空态 + meta.warning。
// ============================================================================

var INS_STATE = {
  tab: 'graph',
  graphSymbol: '',
  graphNs: 'market',
  edgeSymbols: '',
  factorSymbols: 'BTC,ETH',
  factorCategory: '',
  histSymbol: '',
  histFactor: '',
  ragQuery: 'Bitcoin on-chain liquidity',
  ragNs: ['market', 'onchain'],
  mlSymbols: '',
};

function insEsc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function(c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function insShort(s, n) { s = s || ''; n = n || 14; return s.length > n + 4 ? s.slice(0, n) + '…' : s; }

// 统一请求：ml-service {code,data} 解包；data-service 直通
async function insFetch(url, opts) {
  if (!opts) opts = {};
  if (opts.body && typeof opts.body === 'object') {
    opts.body = JSON.stringify(opts.body);
    if (!opts.headers) opts.headers = {};
    if (!opts.headers['Content-Type']) opts.headers['Content-Type'] = 'application/json';
  }
  var r = await fetch(url, opts);
  var j; try { j = await r.json(); } catch (e) { throw new Error('Invalid response'); }
  if (j && typeof j === 'object' && 'code' in j && j.code !== 0) throw new Error(j.message || 'data service error');
  return j && typeof j === 'object' && 'data' in j && 'code' in j ? j.data : j;
}

// ── 入口 ──
async function insightsInit() {
  var root = document.getElementById('insights-root');
  if (!root) return;
  insRenderShell();
  insLoadTab(INS_STATE.tab);
}

function insRenderShell() {
  var root = document.getElementById('insights-root');
  if (!root) return;
  root.innerHTML =
    '<div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap">' +
      '<div style="font-size:15px;font-weight:700">📡 Insights · Data Plane</div>' +
      '<span style="font-size:11px;padding:2px 10px;border-radius:999px;background:rgba(14,203,129,.12);color:#4ade80">' + I18N.t('ins_dx_badge') + '</span>' +
    '</div>' +
    '<div class="tab-row">' +
      '<button class="tab-btn active" data-ins-tab="graph">🕸️ Graph</button>' +
      '<button class="tab-btn" data-ins-tab="factors">📈 Factors</button>' +
      '<button class="tab-btn" data-ins-tab="rag">🔎 RAG</button>' +
      '<button class="tab-btn" data-ins-tab="ml">' + robotIcon(13) + ' ML</button>' +
    '</div>' +
    '<div class="ins-pane active" id="ins-pane-graph"><div style="padding:6px"><div class="skeleton" style="height:26px;width:45%;margin:18px auto 10px;border-radius:8px"></div><div class="skeleton-card" style="height:150px;max-width:680px;margin:0 auto 12px"></div><div class="skeleton-text" style="width:70%;margin:0 auto"></div><div class="skeleton-text short" style="margin:0 auto"></div></div></div>' +
    '<div class="ins-pane" id="ins-pane-factors"></div>' +
    '<div class="ins-pane" id="ins-pane-rag"></div>' +
    '<div class="ins-pane" id="ins-pane-ml"></div>';

  root.querySelectorAll('.tab-btn[data-ins-tab]').forEach(function(b) {
    b.onclick = function() {
      root.querySelectorAll('.tab-btn[data-ins-tab]').forEach(function(x) { x.classList.remove('active'); });
      root.querySelectorAll('.ins-pane').forEach(function(x) { x.classList.remove('active'); });
      b.classList.add('active');
      var t = b.getAttribute('data-ins-tab');
      INS_STATE.tab = t;
      var pane = document.getElementById('ins-pane-' + t);
      if (pane) pane.classList.add('active');
      insLoadTab(t);
    };
  });
}

function insLoadTab(t) {
  if (t === 'graph') insLoadGraph();
  else if (t === 'factors') insLoadFactors();
  else if (t === 'rag') insRenderRagForm();
  else if (t === 'ml') insLoadMl();
}

// ── Graph：知识图谱力导向图 + 相关性边表 ──
async function insLoadGraph() {
  var pane = document.getElementById('ins-pane-graph');
  if (!pane) return;
  pane.innerHTML =
    '<div class="panel" style="margin-bottom:14px"><div class="panel-body" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">' +
      '<input class="input" id="ins-g-symbol" placeholder="' + I18N.t('ins_g_symbol_ph') + '" value="' + insEsc(INS_STATE.graphSymbol) + '" style="width:160px;font-size:12px">' +
      '<select class="input" id="ins-g-ns" style="width:130px;font-size:12px">' +
        '<option value="market"' + (INS_STATE.graphNs === 'market' ? ' selected' : '') + '>market</option>' +
        '<option value="onchain"' + (INS_STATE.graphNs === 'onchain' ? ' selected' : '') + '>onchain</option>' +
        '<option value="default"' + (INS_STATE.graphNs === 'default' ? ' selected' : '') + '>default</option>' +
      '</select>' +
      '<button class="btn btn-sm btn-primary" onclick="insLoadGraph()">' + I18N.t('ins_load') + '</button>' +
      '<span style="font-size:11px;color:var(--text-muted)">' + I18N.t('ins_graph_hint') + '</span>' +
    '</div></div>' +
    '<div style="display:grid;grid-template-columns:1.4fr 1fr;gap:14px">' +
      '<div class="panel"><div class="panel-header">' + I18N.t('ins_graph_entities') + '</div><div class="panel-body" id="ins-graph-viz" style="height:520px;padding:0"></div></div>' +
      '<div class="panel"><div class="panel-header">' + I18N.t('ins_edges_title') + '</div><div class="panel-body" id="ins-edges-table" style="padding:0;max-height:520px;overflow:auto"></div></div>' +
    '</div>';

  INS_STATE.graphSymbol = document.getElementById('ins-g-symbol').value.trim();
  INS_STATE.graphNs = document.getElementById('ins-g-ns').value;

  var viz = document.getElementById('ins-graph-viz');
  var edgesEl = document.getElementById('ins-edges-table');
  var results = await Promise.allSettled([
    insFetch('/factors/graph/entities?symbol=' + encodeURIComponent(INS_STATE.graphSymbol) + '&namespace=' + encodeURIComponent(INS_STATE.graphNs) + '&limit=150'),
    insFetch('/factors/graph/edges?symbols=' + encodeURIComponent(INS_STATE.edgeSymbols) + '&limit=200'),
  ]);

  if (results[0].status === 'fulfilled') insRenderGraphViz(viz, results[0].value);
  else viz.innerHTML = insEmpty(I18N.t('ins_entities_unavail') + insEsc(results[0].reason && results[0].reason.message));
  if (results[1].status === 'fulfilled') insRenderEdgesMaybePoll(edgesEl, results[1].value, INS_STATE.edgeSymbols);
  else edgesEl.innerHTML = insEmpty(I18N.t('ins_edges_unavail') + insEsc(results[1].reason && results[1].reason.message));
}

// GP-2：edges 冷态（meta.status=building）→ 展示「生成中」并轮询（最多 12 次 × 5s）
function insRenderEdgesMaybePoll(el, data, symbols) {
  if (!el) return;
  if (data && data.meta && data.meta.status === 'building') {
    var tries = 0;
    el.innerHTML = insEmpty(I18N.t('ins_graph_building') + (data.meta.job_id ? '（job ' + data.meta.job_id + '）' : '') + I18N.t('ins_graph_building_suffix'));
    var timer = setInterval(async function() {
      tries++;
      try {
        var d = await insFetch('/factors/graph/edges?symbols=' + encodeURIComponent(symbols || '') + '&limit=200');
        if (d && d.meta && d.meta.status === 'building' && tries < 12) return; // 继续轮询
        clearInterval(timer);
        insRenderEdges(el, d);
      } catch (e) {
        clearInterval(timer);
        el.innerHTML = insEmpty(I18N.t('ins_edges_unavail') + insEsc(e && e.message));
      }
    }, 5000);
    return;
  }
  insRenderEdges(el, data);
}

function insEmpty(msg) {
  return '<div style="padding:40px;text-align:center;color:var(--text-muted);font-size:12px">' + insEsc(msg || 'no data') + '</div>';
}

// 力导向图：斥力 + 弹簧 + 中心引力（纯 SVG，无外部依赖）
function insRenderGraphViz(el, data) {
  if (!el) return;
  if (!data || !data.nodes || !data.nodes.length) {
    el.innerHTML = insEmpty((data && data.meta && data.meta.warning) || 'graph entities unavailable');
    return;
  }
  var nodes = data.nodes;
  var edges = data.edges || [];
  var W = el.clientWidth || 720, H = el.clientHeight || 520;

  // 节点 id → index 映射；id 字段兼容 id/source/target/label
  var idx = {}, i;
  var deg = {};
  for (i = 0; i < nodes.length; i++) {
    var nid = nodes[i].id != null ? String(nodes[i].id) : String(i);
    idx[nid] = i;
    deg[nid] = 0;
  }
  var eList = [];
  for (i = 0; i < edges.length; i++) {
    var e = edges[i];
    var s = e.source != null ? String(e.source) : null;
    var t = e.target != null ? String(e.target) : null;
    if (s == null || t == null || !(s in idx) || !(t in idx)) continue;
    eList.push([idx[s], idx[t], Number(e.weight || e.value || 1)]);
    deg[s]++; deg[t]++;
  }

  // 初始随机散布 + 中心
  var pos = nodes.map(function(_, k) { return { x: W / 2 + (Math.random() - 0.5) * W * 0.6, y: H / 2 + (Math.random() - 0.5) * H * 0.6, vx: 0, vy: 0 }; });
  var RE = 4000, SPRING = 0.06, CENTER = 0.02, DT = 0.5;
  for (var iter = 0; iter < 90; iter++) {
    for (i = 0; i < pos.length; i++) {
      var a = pos[i];
      a.vx += (W / 2 - a.x) * CENTER * DT;
      a.vy += (H / 2 - a.y) * CENTER * DT;
      for (var j = i + 1; j < pos.length; j++) {
        var b = pos[j];
        var dx = a.x - b.x, dy = a.y - b.y;
        var d2 = dx * dx + dy * dy + 0.01;
        var f = RE / d2;
        if (d2 > 40000) f = 0;
        a.vx += dx / Math.sqrt(d2) * f * DT; a.vy += dy / Math.sqrt(d2) * f * DT;
        b.vx -= dx / Math.sqrt(d2) * f * DT; b.vy -= dy / Math.sqrt(d2) * f * DT;
      }
    }
    for (var k = 0; k < eList.length; k++) {
      var e0 = eList[k], u = pos[e0[0]], v = pos[e0[1]];
      var dx2 = v.x - u.x, dy2 = v.y - u.y;
      var dl = Math.sqrt(dx2 * dx2 + dy2 * dy2 + 0.01);
      var sf = (dl - 90) * SPRING * DT;
      var sx = dx2 / dl * sf, sy = dy2 / dl * sf;
      u.vx += sx; u.vy += sy; v.vx -= sx; v.vy -= sy;
    }
    for (i = 0; i < pos.length; i++) {
      pos[i].x += pos[i].vx * DT; pos[i].y += pos[i].vy * DT;
      pos[i].x = Math.max(18, Math.min(W - 18, pos[i].x));
      pos[i].y = Math.max(18, Math.min(H - 18, pos[i].y));
      pos[i].vx *= 0.85; pos[i].vy *= 0.85;
    }
  }

  var maxDeg = 1;
  Object.keys(deg).forEach(function(k) { if (deg[k] > maxDeg) maxDeg = deg[k]; });
  var palette = ['#a78bfa', '#4ade80', '#fbbf24', '#38bdf8', '#f472b6', '#fb7185'];
  var nodeHtml = '', edgeHtml = '';
  for (i = 0; i < eList.length; i++) {
    var eu = pos[eList[i][0]], ev = pos[eList[i][1]];
    var wgt = eList[i][2];
    var opacity = Math.min(0.5, 0.08 + wgt * 0.3);
    edgeHtml += '<line x1="' + eu.x.toFixed(1) + '" y1="' + eu.y.toFixed(1) + '" x2="' + ev.x.toFixed(1) + '" y2="' + ev.y.toFixed(1) + '" stroke="#8b5cf6" stroke-opacity="' + opacity.toFixed(2) + '" stroke-width="' + (1 + wgt).toFixed(1) + '"/>';
  }
  for (i = 0; i < nodes.length; i++) {
    var p = pos[i];
    var d = deg[String(nodes[i].id != null ? nodes[i].id : i)];
    var r = 3.5 + d / maxDeg * 6;
    var color = palette[d % palette.length];
    var label = nodes[i].name_en || nodes[i].name || nodes[i].label || String(nodes[i].id || i);
    nodeHtml += '<circle cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="' + r.toFixed(1) + '" fill="' + color + '" stroke="#0f1224" stroke-width="1">' +
      '<title>' + insEsc(label) + '</title></circle>' +
      '<text x="' + (p.x + r + 3).toFixed(1) + '" y="' + (p.y + 3).toFixed(1) + '" font-size="9" fill="#9aa0b5">' + insEsc(insShort(label, 14)) + '</text>';
  }

  el.innerHTML =
    '<svg width="100%" height="100%" viewBox="0 0 ' + W + ' ' + H + '" style="display:block">' +
      '<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#8b5cf6"/></marker></defs>' +
      edgeHtml + nodeHtml +
    '</svg>' +
    '<div style="position:absolute;left:10px;bottom:10px;font-size:10px;color:var(--text-muted);background:rgba(15,18,36,.7);padding:4px 10px;border-radius:6px">' + nodes.length + ' nodes · ' + eList.length + ' edges · ' + I18N.t('ins_viz_hint') + '</div>';
}

function insRenderEdges(el, data) {
  if (!el) return;
  if (!data || !data.edges || !data.edges.length) {
    el.innerHTML = insEmpty((data && data.meta && data.meta.warning) || 'edges unavailable');
    return;
  }
  var rows = data.edges.slice(0, 100).map(function(e) {
    var w = Number(e.weight || e.value || 0);
    var bar = Math.min(100, Math.round(Math.abs(w) * 100));
    var color = w >= 0 ? 'var(--success)' : 'var(--error)';
    return '<div style="display:flex;align-items:center;gap:8px;padding:6px 12px;border-bottom:1px solid var(--border);font-size:11px">' +
      '<span class="mono">' + insEsc(String(e.source || '')) + '</span>' +
      '<span style="color:var(--text-muted)">⇄</span>' +
      '<span class="mono">' + insEsc(String(e.target || '')) + '</span>' +
      '<span style="margin-left:auto;width:70px;height:4px;border-radius:2px;background:var(--surface-input)"><span style="display:block;height:4px;width:' + bar + '%;border-radius:2px;background:' + color + '"></span></span>' +
      '<span class="mono" style="width:44px;text-align:right;color:' + color + '">' + (w > 0 ? '+' : '') + w.toFixed(2) + '</span>' +
    '</div>';
  }).join('');
  el.innerHTML = '<div style="padding:8px 12px;font-size:10px;color:var(--text-muted);border-bottom:1px solid var(--border)">' + (data.meta && data.meta.updated_at ? I18N.t('ins_updated') + new Date(data.meta.updated_at).toLocaleString() : '') + '</div>' + rows;
}

// ── Factors：最新因子表 + gf_* 历史曲线 ──
async function insLoadFactors() {
  var pane = document.getElementById('ins-pane-factors');
  if (!pane) return;
  pane.innerHTML =
    '<div class="panel" style="margin-bottom:14px"><div class="panel-body" style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">' +
      '<input class="input" id="ins-f-symbols" value="' + insEsc(INS_STATE.factorSymbols) + '" style="width:150px;font-size:12px" placeholder="' + I18N.t('ins_f_symbols_ph') + '">' +
      '<select class="input" id="ins-f-cat" style="width:150px;font-size:12px">' +
        '<option value="">' + I18N.t('ins_all_factors') + '</option>' +
        '<option value="external"' + (INS_STATE.factorCategory === 'external' ? ' selected' : '') + '>external (fear_greed/vix/dxy/us10y)</option>' +
        '<option value="sentiment"' + (INS_STATE.factorCategory === 'sentiment' ? ' selected' : '') + '>sentiment</option>' +
        '<option value="news"' + (INS_STATE.factorCategory === 'news' ? ' selected' : '') + '>news</option>' +
        '<option value="snapshot"' + (INS_STATE.factorCategory === 'snapshot' ? ' selected' : '') + '>snapshot</option>' +
      '</select>' +
      '<button class="btn btn-sm btn-primary" onclick="insLoadFactors()">' + I18N.t('ins_load') + '</button>' +
    '</div></div>' +
    '<div class="panel" style="margin-bottom:14px"><div class="panel-header">' + I18N.t('ins_latest_factors') + '</div><div class="panel-body" style="padding:0;max-height:360px;overflow:auto" id="ins-factors-table"></div></div>' +
    '<div class="panel"><div class="panel-header">' + I18N.t('ins_hist_title') + '</div>' +
      '<div class="panel-body" style="display:flex;gap:10px;align-items:center;padding-bottom:0">' +
        '<select class="input" id="ins-h-symbol" style="width:110px;font-size:12px"></select>' +
        '<select class="input" id="ins-h-factor" style="width:180px;font-size:12px"></select>' +
        '<button class="btn btn-sm" onclick="insRenderHistory()">' + I18N.t('ins_plot') + '</button>' +
      '</div>' +
      '<div class="panel-body" style="height:300px" id="ins-history-chart"></div>' +
    '</div>';

  INS_STATE.factorSymbols = document.getElementById('ins-f-symbols').value.trim() || 'BTC,ETH';
  INS_STATE.factorCategory = document.getElementById('ins-f-cat').value;

  var tbl = document.getElementById('ins-factors-table');
  var results = await Promise.allSettled([
    insFetch('/factors/current?symbols=' + encodeURIComponent(INS_STATE.factorSymbols) + (INS_STATE.factorCategory ? '&category=' + encodeURIComponent(INS_STATE.factorCategory) : '')),
    insFetch('/factors/graph/history?symbols=' + encodeURIComponent(INS_STATE.factorSymbols) + '&days=90'),
  ]);

  if (results[0].status === 'fulfilled') insRenderFactorsTable(tbl, results[0].value);
  else tbl.innerHTML = insEmpty(I18N.t('ins_factors_unavail') + insEsc(results[0].reason && results[0].reason.message));

  INS_STATE.histRaw = results[1].status === 'fulfilled' ? results[1].value : null;
  insPopulateHistorySelects();
  insRenderHistory();
}

function insScalar(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') { var n = Number(v); return isNaN(n) ? null : n; }
  return null;
}

function insRenderFactorsTable(el, data) {
  if (!el) return;
  var factors = data && data.factors ? data.factors : null;
  if (!factors || !Object.keys(factors).length) {
    el.innerHTML = insEmpty('factors empty');
    return;
  }
  // 收集所有因子键
  var keys = {};
  Object.keys(factors).forEach(function(sym) {
    var v = factors[sym];
    if (v && typeof v === 'object') Object.keys(v).forEach(function(k) {
      if (!(k in keys) && (typeof v[k] === 'number' || typeof v[k] === 'string')) keys[k] = 1;
    });
  });
  var klist = Object.keys(keys);
  var head = '<tr><th style="position:sticky;top:0">SYMBOL</th>' + klist.slice(0, 14).map(function(k) { return '<th style="position:sticky;top:0">' + insEsc(k) + '</th>'; }).join('') + '</tr>';
  var rows = Object.keys(factors).map(function(sym) {
    var v = factors[sym];
    return '<tr><td class="mono" style="font-weight:600">' + insEsc(sym) + '</td>' + klist.slice(0, 14).map(function(k) {
      var val = v[k];
      if (typeof val === 'number') {
        var txt = Math.abs(val) >= 1000 ? val.toExponential(2) : Number(val).toFixed(4);
        return '<td class="mono">' + txt + '</td>';
      }
      if (typeof val === 'string' && val.length <= 24) return '<td>' + insEsc(val) + '</td>';
      return '<td style="color:var(--text-muted)">—</td>';
    }).join('') + '</tr>';
  }).join('');
  el.innerHTML = '<table class="data-table"><thead>' + head + '</thead><tbody>' + rows + '</tbody></table>' +
    (data.meta && data.meta.warning ? '<div style="padding:8px 12px;font-size:11px;color:var(--warning)">⚠️ ' + insEsc(data.meta.warning) + '</div>' : '');
}

function insPopulateHistorySelects() {
  var hist = INS_STATE.histRaw;
  var sSel = document.getElementById('ins-h-symbol');
  var fSel = document.getElementById('ins-h-factor');
  if (!sSel || !fSel || !hist || !hist.series) return;
  var syms = Object.keys(hist.series);
  if (!syms.length) return;
  var s1 = INS_STATE.histSymbol && syms.indexOf(INS_STATE.histSymbol) >= 0 ? INS_STATE.histSymbol : syms[0];
  sSel.innerHTML = syms.map(function(s) { return '<option value="' + insEsc(s) + '"' + (s === s1 ? ' selected' : '') + '>' + insEsc(s) + '</option>'; }).join('');
  INS_STATE.histSymbol = s1;
  var fs = Object.keys(hist.series[s1] || {});
  if (fs.length) {
    var f1 = INS_STATE.histFactor && fs.indexOf(INS_STATE.histFactor) >= 0 ? INS_STATE.histFactor : fs[0];
    fSel.innerHTML = fs.map(function(f) { return '<option value="' + insEsc(f) + '"' + (f === f1 ? ' selected' : '') + '>' + insEsc(f) + '</option>'; }).join('');
    INS_STATE.histFactor = f1;
  }
}

function insRenderHistory() {
  var chart = document.getElementById('ins-history-chart');
  if (!chart) return;
  var hist = INS_STATE.histRaw;
  if (!hist || !hist.series) { chart.innerHTML = insEmpty('graph history unavailable'); return; }
  var sym = document.getElementById('ins-h-symbol').value;
  var fac = document.getElementById('ins-h-factor').value;
  if (!sym || !fac) { chart.innerHTML = insEmpty('no series'); return; }
  var series = ((hist.series[sym] || {})[fac] || []).filter(function(p) { return p && p.length >= 2 && insScalar(p[1]) != null; });
  if (series.length < 2) { chart.innerHTML = insEmpty('series data too short'); return; }
  var W = chart.clientWidth || 700, H = chart.clientHeight || 280;
  var padL = 46, padR = 12, padT = 12, padB = 22;
  var vals = series.map(function(p) { return Number(p[1]); });
  var ts0 = Number(series[0][0]), ts1 = Number(series[series.length - 1][0]);
  var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
  if (min === max) { min -= 1; max += 1; }
  var X = function(ts) { return padL + (ts - ts0) / Math.max(1, ts1 - ts0) * (W - padL - padR); };
  var Y = function(v) { return padT + (max - v) / (max - min) * (H - padT - padB); };
  var path = series.map(function(p, i) { return (i ? 'L' : 'M') + X(Number(p[0])).toFixed(1) + ',' + Y(Number(p[1])).toFixed(1); }).join(' ');
  var grid = '', g;
  for (g = 0; g <= 4; g++) {
    var gy = padT + g / 4 * (H - padT - padB);
    var gv = max - (max - min) * g / 4;
    grid += '<line x1="' + padL + '" y1="' + gy.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + gy.toFixed(1) + '" stroke="#232741" stroke-width="1"/>' +
      '<text x="4" y="' + (gy + 3).toFixed(1) + '" font-size="9" fill="#9aa0b5">' + (Math.abs(gv) >= 1000 ? gv.toExponential(1) : gv.toFixed(3)) + '</text>';
  }
  var last = series[series.length - 1];
  chart.innerHTML =
    '<svg width="100%" height="100%" viewBox="0 0 ' + W + ' ' + H + '" style="display:block">' +
      grid +
      '<path d="' + path + '" fill="none" stroke="#a78bfa" stroke-width="1.8" stroke-linejoin="round"/>' +
      '<circle cx="' + X(Number(last[0])).toFixed(1) + '" cy="' + Y(Number(last[1])).toFixed(1) + '" r="3" fill="#4ade80"/>' +
      '<text x="' + X(Number(last[0])).toFixed(1) + '" y="' + (Y(Number(last[1])) - 6).toFixed(1) + '" font-size="9" fill="#4ade80" text-anchor="end">' + Number(last[1]).toFixed(4) + '</text>' +
      '<text x="' + padL + '" y="' + (H - 8) + '" font-size="9" fill="#9aa0b5">' + insEsc(sym) + ' · ' + insEsc(fac) + ' · ' + new Date(ts0).toLocaleDateString() + ' → ' + new Date(ts1).toLocaleDateString() + '</text>' +
    '</svg>';
}

// ── RAG 检索 ──
function insRenderRagForm() {
  var pane = document.getElementById('ins-pane-rag');
  if (!pane) return;
  pane.innerHTML =
    '<div class="panel"><div class="panel-header">' + I18N.t('ins_rag_title') + '</div><div class="panel-body">' +
      '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">' +
        '<input class="input" id="ins-rag-q" value="' + insEsc(INS_STATE.ragQuery) + '" style="flex:1;min-width:240px;font-size:13px" placeholder="' + I18N.t('ins_rag_q_ph') + '">' +
        '<label style="font-size:12px;display:flex;align-items:center;gap:4px"><input type="checkbox" id="ins-rag-m" ' + (INS_STATE.ragNs.indexOf('market') >= 0 ? 'checked' : '') + '> market</label>' +
        '<label style="font-size:12px;display:flex;align-items:center;gap:4px"><input type="checkbox" id="ins-rag-o" ' + (INS_STATE.ragNs.indexOf('onchain') >= 0 ? 'checked' : '') + '> onchain</label>' +
        '<button class="btn btn-primary" onclick="insDoRag()">🔎 Retrieve</button>' +
      '</div>' +
      '<div id="ins-rag-result" style="margin-top:14px"></div>' +
    '</div></div>';
}

async function insDoRag() {
  var q = document.getElementById('ins-rag-q').value.trim();
  if (!q) return showToast(I18N.t('ins_rag_need_q'), 'warning');
  var ns = [];
  if (document.getElementById('ins-rag-m').checked) ns.push('market');
  if (document.getElementById('ins-rag-o').checked) ns.push('onchain');
  INS_STATE.ragQuery = q;
  INS_STATE.ragNs = ns;
  var box = document.getElementById('ins-rag-result');
  box.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted)">' + I18N.t('ins_rag_searching') + '</div>';
  try {
    var d = await insFetch('/rag/retrieve', { method: 'POST', body: { query: q, namespaces: ns.length ? ns : null, top_k: 8 } });
    if (!d || !d.results || !d.results.length) {
      box.innerHTML = insEmpty((d && d.meta && d.meta.warning) || 'no results');
      return;
    }
    box.innerHTML = d.results.map(function(r) {
      var c = String(r.context || '').trim();
      var nsLabel = { market: '📊 Market', onchain: '⛓️ Onchain', default: '📚 Default' }[r.namespace] || r.namespace;
      return '<div class="panel" style="margin-bottom:10px"><div class="panel-header" style="font-size:12px">' + nsLabel +
        '<span style="margin-left:auto;font-size:10px;color:var(--text-muted)">top_k=' + (r.top_k || 8) + '</span></div>' +
        '<div class="panel-body" style="font-size:12px;line-height:1.7;color:var(--text-secondary);max-height:180px;overflow:auto;white-space:pre-wrap">' + insEsc(c) + '</div></div>';
    }).join('');
  } catch (e) {
    box.innerHTML = insEmpty(I18N.t('ins_rag_failed') + insEsc(e.message));
  }
}

// ── ML 预测 ──
// 端点结构（ml-service）：
//   tree_predictions: {generated_at, model, predictions:[{symbol,direction,prob_up,...}]}（无顶层 avg/symbols）
//   volatility:       {generated_at, n_symbols, model, avg_volatility_score, symbols:[{symbol,volatility_score,...}]}
//   consensus:        {generated_at, signals, n_symbols, avg_consensus_score, symbols:[{symbol,consensus_score,...}]}
//   bolt/moirai/timesfm: {generated_at, n_symbols, model, avg_prob_up, symbols:[{symbol,direction,prob_up,...}]}
// 渲染统一：arrKey 取数组；聚合取 d[agg]，缺失时从数组 aggKey 计算均值回退。
var INS_ML_ENDPOINTS = [
  { key: 'tree_predictions', labelKey: 'ins_ml_lgb', agg: 'avg_prob_up', aggKey: 'prob_up', aggLabel: 'avg prob_up', arrKey: 'predictions' },
  { key: 'volatility', labelKey: 'ins_ml_kronos', agg: 'avg_volatility_score', aggKey: 'volatility_score', aggLabel: 'avg vol score', arrKey: 'symbols' },
  { key: 'consensus', labelKey: 'ins_ml_consensus', agg: 'avg_consensus_score', aggKey: 'consensus_score', aggLabel: 'avg consensus', arrKey: 'symbols' },
  { key: 'bolt', labelKey: 'ins_ml_bolt', agg: 'avg_prob_up', aggKey: 'prob_up', aggLabel: 'avg prob_up', arrKey: 'symbols' },
  { key: 'moirai', labelKey: 'ins_ml_moirai', agg: 'avg_prob_up', aggKey: 'prob_up', aggLabel: 'avg prob_up', arrKey: 'symbols' },
  { key: 'timesfm', labelKey: 'ins_ml_timesfm', agg: 'avg_prob_up', aggKey: 'prob_up', aggLabel: 'avg prob_up', arrKey: 'symbols' },
];

async function insLoadMl() {
  var pane = document.getElementById('ins-pane-ml');
  if (!pane) return;
  pane.innerHTML = '<div class="panel"><div class="panel-header">' + robotIcon(14) + ' ' + I18N.t('ins_ml_title') + '</div><div class="panel-body" id="ins-ml-cards"><div style="text-align:center;padding:24px;color:var(--text-muted)">' + I18N.t('ins_ml_loading') + '</div></div></div>';

  var results = await Promise.allSettled(INS_ML_ENDPOINTS.map(function(e) {
    return insFetch('/ml/' + e.key);
  }));

  var cards = document.getElementById('ins-ml-cards');
  var html = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px">';
  INS_ML_ENDPOINTS.forEach(function(e, i) {
    var r = results[i];
    if (r.status !== 'fulfilled' || r.value == null) {
      html += '<div class="panel" style="min-height:120px"><div class="panel-header" style="font-size:12px">' + I18N.t(e.labelKey) + '</div><div class="panel-body" style="font-size:11px;color:var(--text-muted)">' + insEsc((r.status === 'fulfilled' ? '' : (r.reason && r.reason.message)) || I18N.t('ins_ml_null')) + '</div></div>';
      return;
    }
    var d = r.value;
    var rows = (d && (d[e.arrKey] || d.symbols || d.predictions)) || [];
    // 聚合：优先顶层字段，缺失时从数组 aggKey 计算均值（tree_predictions 无顶层 avg）
    var aggVal = d ? d[e.agg] : null;
    if (aggVal == null && rows.length) {
      var vals = rows.map(function(x) { return Number(x && x[e.aggKey]); }).filter(function(v) { return isFinite(v); });
      if (vals.length) aggVal = vals.reduce(function(a, b) { return a + b; }, 0) / vals.length;
    }
    var aggHtml = aggVal != null
      ? '<div class="kpi" style="background:var(--surface-input);border-radius:8px;padding:8px 12px;margin-bottom:8px"><div class="kpi-label" style="font-size:10px">' + e.aggLabel + '</div><div class="kpi-val mono" style="font-size:18px;font-weight:700;color:' + (aggVal >= 0.5 ? 'var(--success)' : 'var(--warning)') + '">' + Number(aggVal).toFixed(3) + '</div></div>'
      : '';
    var symRows = rows.slice(0, 12).map(function(s) {
      if (typeof s === 'string') return '<tr><td class="mono">' + insEsc(s) + '</td><td style="color:var(--text-muted)">—</td></tr>';
      var val = Number(s[e.aggKey]);
      var valTxt = isFinite(val)
        ? '<td class="mono">' + val.toFixed(4) + '</td>'
        : (s.direction
            ? '<td><span style="color:' + (String(s.direction).toLowerCase() === 'up' ? 'var(--success)' : 'var(--error)') + '">' + insEsc(String(s.direction)) + '</span></td>'
            : '<td style="color:var(--text-muted)">—</td>');
      return '<tr><td class="mono" style="font-weight:600">' + insEsc(s.symbol || '?') + '</td>' + valTxt + '</tr>';
    }).join('');
    // model 字段可能是对象（tree_predictions 的 model: {name, params,...}），提取 name 避免渲染成 [object Object]
    var m = d.model;
    var modelLabel = (m && typeof m === 'object') ? (m.name || m.model || '') : (m || '');
    html += '<div class="panel" style="min-height:120px"><div class="panel-header" style="font-size:12px">' + I18N.t(e.labelKey) +
      '<span style="margin-left:auto;font-size:10px;color:var(--text-muted)">' + insEsc(modelLabel) + ' · ' + (d.n_symbols || rows.length) + ' syms</span></div>' +
      '<div class="panel-body" style="padding-top:10px">' + aggHtml +
      (symRows ? '<table class="data-table"><thead><tr><th>Symbol</th><th>Signal</th></tr></thead><tbody>' + symRows + '</tbody></table>' : '<div style="font-size:11px;color:var(--text-muted)">no symbols</div>') +
      '<div style="font-size:9px;color:var(--text-muted);margin-top:6px">' + (d.generated_at ? 'generated: ' + new Date(d.generated_at * 1000 || d.generated_at).toLocaleString() : '') + '</div>' +
      '</div></div>';
  });
  html += '</div>';
  cards.innerHTML = html;
}
