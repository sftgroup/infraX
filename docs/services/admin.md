# Admin 聚合管理后台 使用指南（:9100）

> 最后更新：2026-08-11 | 生产状态：🟢 已验证可用（2026-08-11 生产实测）

## 1. 服务定位

**Admin（聚合管理后台）**是 InfraX 的跨模块管理 API（`projects/admin/server/index.ts`，独立后端 + React 前端静态托管），跨 **7 个数据库**（mpc / admin / waas / dc / vault / payments / collector）聚合：

- **概览**：`dashboard`（用户/租户/事件/收益）、`revenue`（分模块收益拆解）、`api-usage`（30 日调用聚合）。
- **服务状态**：`status` 探测 **12 个服务**（collector/waas/dc/vault/mpc/payments/admin/web/wallet-mcp/dc-mcp/vault-mcp/mpc-mcp）的 `/health`。
- **业务管理**：WaaS 租户（`tenants` 增查改）、交易（`transactions`）、Webhook（`webhooks`）、Sweep（`sweeps`）、DC 订阅（`dc-subscriptions`）、RPC 配置（`rpc`）、风控规则 / Token 黑名单 / 审计日志。
- **分模块面板**：WaaS（`waas/stats`、`waas/subscriptions`）、DC（`dc/stats`、`dc/checkpoints`）、Vault（`vault/stats`、`vault/safes`、`vault/transactions`）、MPC（`mpc/stats`、`mpc/wallets`）、OKX 数据管线（`okx/accounts`、`okx/health`）、数据栈（`/api/v2/data/*`，经 `dataRoutes` 转发 data :9112 等）。
- **生产实测（2026-08-11）**：`POST /api/v2/admin/login` 成功返回 token ✅；`dashboard` 为跨库聚合查询，含大表 COUNT（`events` 1 亿+ 行），**响应较慢属性能观察项**，前端轮询场景需设置宽松超时。

## 2. 鉴权方式

| 端点 | 鉴权 |
|---|---|
| `POST /api/v2/admin/login`、`/health` | **公开** |
| 其余全部端点 | **`requireAdmin`**：`x-admin-token` header **或** `admin_token` cookie（`httpOnly`），二选一通过即放行 |

- 登录：`POST /api/v2/admin/login`（body：`username` + `password`，对应服务端 `ADMIN_USER` / `ADMIN_PASS` 环境变量）→ 返回 `data.token`（32 字节 hex）+ 写入 `admin_token` cookie，会话有效期 **8 小时**。
- 失败：凭据错误 → 401 `code:4001`；未携带/无效/过期 token → 401 `code:4001`。
- **SDK 无封装（仅 REST）**；前端由 admin 面板直接调用。

## 3. 端点清单（`/api/v2/admin`）

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/api/v2/admin/login` | 公开 | 登录（username+password）→ token + httpOnly cookie（生产实测 ✅） |
| POST | `/api/v2/admin/logout` | token/cookie | 登出，清除会话 |
| GET | `/api/v2/admin/dashboard` | requireAdmin | 总览（totalUsers / activeTenants / totalEvents / totalRevenue） |
| GET | `/api/v2/admin/revenue` | requireAdmin | 收益拆解（activeTenants / dcSubscribers / subscriptions / 30 日 payments） |
| GET | `/api/v2/admin/api-usage` | requireAdmin | 30 日 API 调用聚合（waas `api_usage_daily`，≤500 行） |
| GET | `/api/v2/admin/status` | requireAdmin | 12 服务健康探测（collector/waas/dc/vault/mpc/payments/admin/web/wallet-mcp/dc-mcp/vault-mcp/mpc-mcp） |
| GET | `/api/v2/admin/rpc` | requireAdmin | RPC 配置列表（admin_rpc_config） |
| POST | `/api/v2/admin/rpc` | requireAdmin | 新增 RPC（chain+url+priority+enabled） |
| PATCH | `/api/v2/admin/rpc/:id` | requireAdmin | 更新 RPC（enabled/priority） |
| GET | `/api/v2/admin/tenants` | requireAdmin | WaaS 租户列表（含 addresses/withdrawals 计数） |
| GET | `/api/v2/admin/tenants/:id` | requireAdmin | 租户详情（addresses/withdrawals/sweeps） |
| PATCH | `/api/v2/admin/tenants/:id` | requireAdmin | 更新租户（status/review_mode/sweep_threshold/sweep_address/webhook_url） |
| GET | `/api/v2/admin/transactions` | requireAdmin | 交易列表（status 过滤，limit ≤200，分页 offset） |
| PATCH | `/api/v2/admin/transactions/:id` | requireAdmin | 更新交易状态 |
| GET | `/api/v2/admin/webhooks` | requireAdmin | Webhook 事件列表 |
| GET | `/api/v2/admin/sweeps` | requireAdmin | 最近 100 条 Sweep 记录 |
| GET | `/api/v2/admin/dc-subscriptions` | requireAdmin | DC 订阅租户（data_plan_id / dc_api_key） |
| GET | `/api/v2/admin/settings` | requireAdmin | tokens / chains / fee_configs |
| GET | `/api/v2/admin/risk-rules` | requireAdmin | 风控规则 |
| GET | `/api/v2/admin/token-blacklist` | requireAdmin | Token 黑名单 |
| GET | `/api/v2/admin/audit` | requireAdmin | 审计日志（collector→waas→dc 依次探测） |
| GET | `/api/v2/admin/waas/stats` | requireAdmin | WaaS 统计（users/wallets/transactions/activeSubs） |
| GET | `/api/v2/admin/waas/subscriptions` | requireAdmin | WaaS 订阅列表（≤100） |
| GET | `/api/v2/admin/dc/stats` | requireAdmin | DC 面板（totalEvents/checkpoints/totalSubs/totalTokens） |
| GET | `/api/v2/admin/dc/checkpoints` | requireAdmin | DC 扫描检查点 |
| GET | `/api/v2/admin/vault/stats` | requireAdmin | Vault 统计（safes/transactions/signatures） |
| GET | `/api/v2/admin/vault/safes` | requireAdmin | Safe 列表（≤100） |
| GET | `/api/v2/admin/vault/transactions` | requireAdmin | Safe 交易列表（≤100） |
| GET | `/api/v2/admin/mpc/stats` | requireAdmin | MPC 统计（total/registered/recovered） |
| GET | `/api/v2/admin/mpc/wallets` | requireAdmin | MPC 钱包列表（≤100） |
| GET | `/api/v2/admin/okx/accounts` | requireAdmin | OKX ChainOS 账户列表 |
| GET | `/api/v2/admin/okx/health` | requireAdmin | OKX 数据管线健康（最近快照） |
| * | `/api/v2/admin/data/*` | requireAdmin | 数据栈管理（dataRoutes 转发 data :9112 等） |
| GET | `/health` | 公开 | 服务健康（service: infrax-admin） |

## 4. 样例代码

### 4.1 curl

```bash
# ① 登录（公开；生产实测 200，返回 token）
curl -s -X POST http://127.0.0.1:9100/api/v2/admin/login \
  -H "Content-Type: application/json" \
  -d '{"username":"<ADMIN_USER>","password":"<ADMIN_PASS>"}'
# 响应：{code:0, data:{token:"<ADMIN_TOKEN>"}, message:"Login successful"}
# 同时 Set-Cookie: admin_token=<token>; HttpOnly; Max-Age=28800

# ② 带 token 调 dashboard（x-admin-token header；跨库聚合，大表 count 较慢）
curl -s http://127.0.0.1:9100/api/v2/admin/dashboard \
  -H "x-admin-token: <ADMIN_TOKEN>"
# 响应：{code:0, data:{totalUsers, activeTenants, totalEvents, totalRevenue}}

# ③ 带 token 调 revenue（分模块收益拆解）
curl -s http://127.0.0.1:9100/api/v2/admin/revenue \
  -H "x-admin-token: <ADMIN_TOKEN>"

# ④ 12 服务健康探测
curl -s http://127.0.0.1:9100/api/v2/admin/status \
  -H "x-admin-token: <ADMIN_TOKEN>"

# ⑤ 也可用 cookie 方式（-c/-b 保存会话）
curl -s -c cookies.txt -X POST http://127.0.0.1:9100/api/v2/admin/login \
  -H "Content-Type: application/json" -d '{"username":"<ADMIN_USER>","password":"<ADMIN_PASS>"}'
curl -s -b cookies.txt http://127.0.0.1:9100/api/v2/admin/dashboard
```

### 4.2 JS SDK

**无 SDK 封装（仅 REST）**，直接 `fetch` 即可：

```ts
// 登录 → token → 带 x-admin-token 调 dashboard / revenue
const base = 'http://127.0.0.1:9100';

const login = await fetch(base + '/api/v2/admin/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: process.env.ADMIN_USER, password: process.env.ADMIN_PASS }),
});
const { data } = await login.json() as { data: { token: string } };
const token = data.token;

const adminGet = (path: string) =>
  fetch(base + path, { headers: { 'x-admin-token': token } }).then(r => r.json());

const dashboard = await adminGet('/api/v2/admin/dashboard');  // 跨库聚合，响应较慢
const revenue   = await adminGet('/api/v2/admin/revenue');
const status    = await adminGet('/api/v2/admin/status');     // 12 服务状态
```

### 4.3 常见错误码

| HTTP | code | 含义 |
|---|---|---|
| 400 | -1 | PATCH 无更新字段、缺 status |
| 401 | 4001 | 登录凭据错误；未携带 / 无效 / 过期 token（x-admin-token 或 cookie） |
| 404 | - | 资源不存在（如租户详情、RPC id） |
| 5xx | - | 跨库查询失败（dashboard/revenue 等大表聚合；单个库失败已降级返回 0 或空数组，不阻断整体） |
| — | — | ⚠️ dashboard 等跨 7 DB 聚合接口响应慢属预期（events 大表 COUNT），客户端需放宽超时 |
