/**
 * InfraX Service Status — 全平台统一服务状态监控页（WSG-2）
 * Dependencies: core.js, infrax.css
 * 探测由 web 后端聚合（/api/v2/system/status：内网直连各服务 + 30s 进程缓存），
 * 前端仅请求单接口渲染，避免每用户每刷新打 9 个公网请求；fail-silent 降级。
 */

// 服务清单：name 展示名 / url 内网健康探测目标（展示用）— 实际探测由 web 后端聚合
//（/api/v2/system/status，内网直连各服务 /health + 30s 缓存），本列表顺序与后端 STATUS_SERVICES 一致。
// 监控展示的是系统自身客观运行状态（进程存活 + 延迟），不涉及任何 API key 鉴权。
var STATUS_SERVICES = [
  { name: '🔗 Chain RPC', url: ':9130 /health' },
  { name: '🔎 LightRAG', url: ':9721 /api/v1/health' },
  { name: '📡 Data Service', url: ':9112 /health' },
  { name: '🧠 ML Service', url: ':9120 /health' },
  { name: '🔐 MPC Wallet', url: ':9104 /health' },
  { name: '🛡️ Safe Vault', url: ':9107 /health' },
  { name: '🏢 WaaS', url: ':9109 /health' },
  { name: '📡 Data & Insights', url: ':9102 /health' },
  { name: robotIcon(13) + ' Smart Account', url: ':9131 /health' }
];

var _statusTimer = null;

function statusInit() {
  var root = document.getElementById('status-root');
  if (!root) return;
  if (_statusTimer) { clearInterval(_statusTimer); _statusTimer = null; }
  root.innerHTML =
    '<div style="max-width:1100px;margin:0 auto">' +
      '<div style="margin-bottom:16px">' +
        '<div style="font-size:20px;font-weight:700;margin-bottom:6px">' + I18N.t('st_title') + '</div>' +
        '<div style="font-size:12.5px;color:var(--text-tertiary)">' + I18N.t('st_desc') + '</div>' +
      '</div>' +
      '<div class="kpi-grid" style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:20px">' +
        '<div class="kpi"><div class="kpi-icon" style="font-size:20px;line-height:1;margin-bottom:8px">🟢</div><div class="kpi-label">' + I18N.t('st_kpi_up') + '</div><div class="kpi-val gold" id="st-kpi-up" style="font-size:20px;font-weight:700">—</div></div>' +
        '<div class="kpi"><div class="kpi-icon" style="font-size:20px;line-height:1;margin-bottom:8px">🔴</div><div class="kpi-label">' + I18N.t('st_kpi_down') + '</div><div class="kpi-val" id="st-kpi-down" style="font-size:20px;font-weight:700">—</div></div>' +
        '<div class="kpi"><div class="kpi-icon" style="font-size:20px;line-height:1;margin-bottom:8px">⚡</div><div class="kpi-label">' + I18N.t('st_kpi_latency') + '</div><div class="kpi-val" id="st-kpi-lat" style="font-size:20px;font-weight:700">—</div></div>' +
      '</div>' +
      '<div style="display:flex;gap:10px;align-items:center;margin-bottom:14px">' +
        '<button class="btn btn-primary" onclick="statusRefresh()">' + I18N.t('st_refresh') + '</button>' +
        '<span style="font-size:12px;color:var(--text-tertiary)">⏱ ' + I18N.t('st_auto') + '</span>' +
      '</div>' +
      '<div class="panel"><div class="table-wrap" style="overflow:auto">' +
        '<table style="min-width:640px"><thead><tr>' +
          '<th>' + I18N.t('st_th_service') + '</th><th>' + I18N.t('st_th_status') + '</th><th>' + I18N.t('st_th_latency') + '</th><th>' + I18N.t('st_th_detail') + '</th>' +
        '</tr></thead><tbody id="st-tbody">' +
          '<tr><td colspan="4" style="padding:14px 20px;color:var(--text-muted)">' + I18N.t('st_loading') + '</td></tr>' +
        '</tbody></table></div></div>' +
    '</div>';
  statusRefresh();
  _statusTimer = setInterval(statusRefresh, 30000);
}

function statusRefresh() {
  var tbody = document.getElementById('st-tbody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="4" style="padding:14px 20px;color:var(--text-muted)">' + I18N.t('st_loading') + '</td></tr>';
  fetch('/api/v2/system/status', { method: 'GET' })
    .then(function (r) { return r.json(); })
    .then(function (payload) {
      var results = (payload && payload.services) || [];
      var up = 0, warn = 0, down = 0, totalMs = 0;
      var rows = results.map(function (svc, i) {
        var meta = STATUS_SERVICES[i] || { name: '#' + i, url: '' };
        var r = { status: svc.status || 0, ms: svc.ms || 0 };
        var cls, label;
        if (r.status >= 200 && r.status < 300) { cls = 'success'; label = I18N.t('st_ok'); up++; }
        else if (r.status >= 400 && r.status < 500) { cls = 'pending'; label = I18N.t('st_warn'); warn++; }
        else { cls = 'failed'; label = r.status ? I18N.t('st_down') + ' (' + r.status + ')' : I18N.t('st_unreachable'); down++; }
        totalMs += r.ms;
        return '<tr><td>' + meta.name + '</td>' +
          '<td><span class="status ' + cls + '">' + label + '</span></td>' +
          '<td class="mono">' + r.ms + ' ' + I18N.t('st_ms') + '</td>' +
          '<td class="mono" style="font-size:12px">' + meta.url + (r.status ? '' : ' — ' + I18N.t('st_unreachable')) + '</td></tr>';
      }).join('');
      tbody.innerHTML = rows;
      setHtml('st-kpi-up', up + '/' + STATUS_SERVICES.length);
      setHtml('st-kpi-down', (down + warn) + '/' + STATUS_SERVICES.length);
      setHtml('st-kpi-lat', Math.round(totalMs / (results.length || 1)) + ' ' + I18N.t('st_ms'));
    }).catch(function (e) {
      tbody.innerHTML = '<tr><td colspan="4" style="padding:14px 20px;color:var(--error)">' + I18N.t('st_load_failed') + ': ' + (e.message || '') + '</td></tr>';
    });
}
