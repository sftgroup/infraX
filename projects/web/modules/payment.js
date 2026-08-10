// MODULE 5: Payment — 已并入 WaaS 订阅流程（MQ-15 T-1）
// ============================================================
// 原四端点全部停用，改走 WaaS 订阅（/api/v2/subscription/* → infrax-payments :9132）：
//   /api/v2/payment/x402/request  →  套餐卡片选择 + subscribe（waasUpgradePlan）
//   /api/v2/payment/create-order  →  waasUpgradePlan（不再建任意金额订单）
//   /api/v2/payment/orders        →  /api/v2/subscription/me（当前套餐状态）
//   /api/v2/payment/methods       →  /api/v2/subscription/plans（套餐列表）
// 旧服务（infrax-payment :9106）将随 MQ-15 下线；本模块最终由 WaaS 订阅页取代（T-3）。

// Payment 页加载：直接展示套餐列表 + 当前订阅状态（不再依赖旧支付服务）
function paymentInit() {
  paymentLoadMethods();
  paymentLoadHistory();
}

// 兼容保留：pay-method 下拉不再影响后端（旧 UI 在 T-3 移除）
function paymentMethodChange() {}

// 兼容保留：旧 Enable 按钮 → 引导跳转 WaaS 订阅
function paymentEnable() {
  switchToWaasSubscription();
}

// 替代 create-order / x402/request：订阅当前所选套餐（默认 pro）
async function paymentCreateOrder() {
  var planId = waasSelectedPlan || 'pro';
  var names = { free: 'Free', pro: 'Pro', enterprise: 'Enterprise' };
  var statusEl = document.getElementById('pay-result');
  if (statusEl) statusEl.innerHTML = '<div style="font-size:12px;color:var(--text-muted)">正在订阅 <b>' + (names[planId] || planId) + '</b> 套餐…</div>';
  try {
    // WaaS 订阅：free 直通 active；chain 轮询；fiat 跳转 sessionUrl；x402 输 txHash
    await waasUpgradePlan(planId);
  } catch (e) {
    if (statusEl) statusEl.innerHTML = '<span style="color:var(--error)">❌ ' + e.message + '</span>';
  }
}

// 套餐卡片购买按钮
function paymentSubscribe(planId) {
  waasSelectedPlan = planId;
  waasUpgradePlan(planId);
}

// 替代 /orders → /api/v2/subscription/me：显示当前套餐状态
async function paymentLoadHistory() {
  var el = document.getElementById('pay-history-list');
  try {
    var d = await afetch('/api/v2/subscription/me', { auth: 'none' });
    var statusMap = { active: '🟢 Active', pending: '🟡 Pending', cancelled: '⚪ Cancelled', failed: '🔴 Failed' };
    var planName = (d.plan || {}).name || d.planName || 'Free Trial';
    var expires = d.expiresAt ? new Date(d.expiresAt).toLocaleDateString() : '—';
    el.innerHTML = '<div class="card" style="padding:12px 16px;margin-bottom:8px">' +
      '<div style="display:flex;justify-content:space-between;align-items:center">' +
      '<div><div style="font-weight:600">📦 ' + planName + '</div>' +
      '<div style="font-size:11px;color:var(--text-muted)">' + (d.billingCycle || 'monthly') + ' · 到期 ' + expires + '</div></div>' +
      '<div style="font-size:12px;font-weight:600;color:' + (d.status === 'active' ? 'var(--success)' : 'var(--warning)') + '">' + (statusMap[d.status] || d.status || '—') + '</div>' +
      '</div></div>';
  } catch (e) { el.innerHTML = '<div class="empty" style="color:var(--error)">Failed to load</div>'; }
}

// 替代 /methods → /api/v2/subscription/plans：渲染套餐列表，点击直接订阅
async function paymentLoadMethods() {
  var el = document.getElementById('pay-methods-info');
  try {
    var d = await afetch('/api/v2/subscription/plans');
    var plans = d.plans || d || [];
    if (!plans.length) { el.innerHTML = '<div class="empty">No plans</div>'; return; }
    el.innerHTML = plans.map(function (p) {
      return '<div class="card" style="padding:16px;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center">' +
        '<div><div style="font-size:16px;font-weight:600;margin-bottom:4px">' + p.name + '</div>' +
        '<div style="font-size:12px;color:var(--text-secondary);margin-bottom:4px">' + (p.description || '') + '</div>' +
        '<div style="font-size:11px;color:var(--text-muted)">' + (p.features || []).join(' · ') + '</div></div>' +
        '<div style="text-align:right"><div style="font-size:16px;font-weight:700;color:var(--text-brand)">' + (p.price || 0) + ' USD</div>' +
        '<button class="btn btn-primary" style="margin-top:8px;padding:6px 16px" onclick="paymentSubscribe(\'' + p.id + '\')">Subscribe</button></div>' +
        '</div>';
    }).join('');
  } catch (e) { el.innerHTML = '<div class="empty" style="color:var(--error)">Failed to load</div>'; }
}

// Payment 导航 → 跳转 WaaS 订阅页（替代进入 page-payment）
function switchToWaasSubscription() {
  var waasPage = document.getElementById('page-waas');
  if (!waasPage) { paymentInit(); return; }
  document.querySelectorAll('.nav-item').forEach(function (x) { x.classList.remove('active'); });
  document.querySelectorAll('.page').forEach(function (x) { x.classList.remove('active'); });
  // 高亮保留在 Payment 导航项（入口仍是 Payment）
  var navPayment = document.querySelector('.nav-item[data-page="payment"]');
  if (navPayment) navPayment.classList.add('active');
  waasPage.classList.add('active');
  document.getElementById('page-title').textContent = PAGE_TITLES.waas;
  waasInit();
}
