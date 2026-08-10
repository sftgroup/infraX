# DC 套餐订阅前端交互备注（MQ-16 T-1）

> 2026-08-11 · 记录 [datacenter.js](../projects/web/modules/datacenter.js) / [index.html](../projects/web/index.html) 中 DC 套餐订阅的交互逻辑，重点是 **pending 态 intro 提示与「刷新支付状态」按钮** 的设计与流转。后端契约见 [SERVICE_API_REFERENCE.md](SERVICE_API_REFERENCE.md)（DC /api/v2/data/*）。

## 1. 页面两级状态机

```
                 dcInit()
                    │
        ┌───────────┴────────────┐
  无钱包地址              有钱包地址 ── dcRefreshUsage()
        │                        │
   intro 显示「连接钱包」     ┌────┴─────────────┐
                        dcSubStatus=active  dcSubStatus=pending
                        │                   │
                   dcLoadDashboard()    intro 显示 + 待支付提示 + 「刷新支付状态」按钮
                    （dashboard 区块）     （dashboard 隐藏）
```

- 无订阅/免费态与付费待支付态都停留在 **intro**，只有 `dc_sub_status=active` 才进入 **dashboard**。
- `dcUsage.dcSubStatus` 由 `GET /api/v2/data/usage?walletAddress=` 返回（新增字段，见 [dc/index.ts](../projects/dc/index.ts)）。

## 2. pending 态 intro 提示 + 刷新按钮（本次备注重点）

`dcInit()` 在 `dcRefreshUsage()` 成功后判断：

```js
if (dcUsage.dcSubStatus === 'pending') {
  // 在 intro 显示待支付提示 + 刷新按钮，dashboard 保持隐藏
  var sEl = document.getElementById('dc-sub-status');
  sEl.innerHTML = '<span style="color:var(--warning)">⏳ 订阅待支付确认</span> ' +
    '<button class="btn btn-sm btn-primary" onclick="dcRecheckPayment()" ...>刷新支付状态</button>';
  dc-intro 显示 / dc-dash 隐藏
}
```

关键点：

- **挂载点**：`<div id="dc-sub-status">` 位于 intro 区「🚀 Activate Data Center」按钮下方（[index.html](../projects/web/index.html)），同时复用于订阅反馈（成功/失败/等待链上确认文案）。
- **触发**：仅当 `dcSubStatus === 'pending'`（付费套餐支付意图已创建、引擎支付未确认）。免费套餐直通 active，不经过此分支。
- **刷新按钮** → `dcRecheckPayment()`：`POST /api/v2/data/payment-check`（chain rail 轮询引擎 `hasActiveSubscription`）→ `status=active` 则 `dcRefreshUsage()` + `dcLoadDashboard()`（进 dashboard 并 toast「支付已确认」）；仍 pending 则 toast「支付仍在确认中…」。
- **回归路径**：链上确认后任何一次进入页面 `dcInit()` 都会自然进 dashboard，无需手动清理 pending 标记。

## 3. dcSubscribe(planId) 三 rail 分支

`POST /api/v2/data/subscribe` 后按返回分流：

| 返回 | 分支 | 交互 |
| --- | --- | --- |
| `dcSubStatus=active` + `dcApiKey`（免费） | 直通 | 显示 ✅ + toast → `dcRefreshUsage()` → `dcLoadDashboard()` |
| `payment.rail=chain` | 链上订阅 | 显示 chainId/SubscriptionManager/金额 → toast「等待链上支付确认」→ `dcPollSubscription()`（每 4s 轮询 `payment-check`，5min 超时） |
| `payment.rail=fiat` | 跳转支付 | 显示「⏳ 跳转支付页」→ `window.location.href = pay.sessionUrl`（Stripe 会话，成功后由引擎 webhook 回调激活） |
| `payment.rail=x402` | 转账确认 | 显示 payTo/金额/network → `dcSubmitX402()`：prompt 输入 txHash → `POST /api/v2/data/verify` → `verified && activated` 则刷新进 dashboard |

## 4. 辅助函数清单

| 函数 | 职责 |
| --- | --- |
| `dcRefreshUsage()` | 拉 `/usage`（plan/quota/currentUsage/dailyBreakdown/dcApiKey/dcSubStatus）刷新 `dcPlan`/`dcUsage` |
| `dcPollSubscription()` | chain rail 轮询，确认 active 后刷新并进 dashboard（模块级 `dcPollTimer` 单例，超时置错误提示） |
| `dcSubmitX402(network)` | x402 rail 提交 txHash 并 verify |
| `dcRecheckPayment()` | pending 态「刷新支付状态」按钮入口（手动 poll 一次） |

## 5. 与后端配合

- `dc_sub_status` 由 `activateDcSubscription()`（pending→active 幂等，激活时补发 `dc_api_key`）维护；链上确认走 `payment-check`/引擎 escrow，fiat/x402 走 `payment-callback`（HMAC 验签）/`verify`。
- 前端**不持有** pending 订阅的任何本地持久化，全部以 `/usage` 返回的 `dcSubStatus` 为准，保证多端一致。
