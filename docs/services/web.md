# Web 代理层 使用指南（:9111）

> 最后更新：2026-08-11 | 生产状态：🟢 已验证可用（2026-08-11 生产实测）

## 1. 服务定位

**Web（Web 代理层）**是 InfraX 的公网入口之一（`projects/web/server.js`，零依赖纯 Node http），nginx（80/443）→ web（:9111）→ 各后端微服务：

- **静态文件服务**：托管 SPA / Landing / Admin 前端（`/` 与未命中路径回退 `index.html`）。
- **API 反向代理**：按路径前缀转发到各微服务（见 §3 路由表），后端响应原样透传。
- **安全头**：所有响应统一注入 HSTS / X-Frame-Options / X-Content-Type-Options / Referrer-Policy / CSP 等安全头。
- **健康检查**：`/health` 返回服务状态 + 完整后端路由表（生产可直接访问）。

> 生产架构：外部请求 → nginx 80/443 → **web :9111** → 各服务（绑定 127.0.0.1）；web 是前端静态资源与 API 的统一公网入口。

## 2. 鉴权方式

| 面 | 鉴权 |
|---|---|
| `/health` | **公开** |
| 静态文件（SPA/Landing/Admin） | **公开** |
| API 代理 | 代理时**自动注入 `X-Service-Key: <SERVICE_API_KEY>`**（平台 bridge key），前端无需携带 key；调用方若自带 `X-API-Key` / `x-dc-api-key` / `x-wallet-address` 等 header 会原样透传到后端 |

- **后端鉴权责任在后端**：web 只注入 `X-Service-Key`，但各后端鉴权契约不同——DC 数据面认 `x-dc-api-key`、collector 行情认 `X-API-Key`、DC 订阅面认 `x-wallet-address`、admin 认 `x-admin-token`/cookie。因此**经 web 调用这些受保护端点时，调用方仍需自行携带对应 header**（随请求透传）。
- 后端不可达 → **502** `{"error":"backend unreachable"}`；后端超时（15s）→ **504** `{"error":"backend timeout"}`。

## 3. 端点清单

### 3.1 代理路由表（server.js `API_ROUTES`）

| 方法 | 路径前缀 | 目标服务（端口） | 说明 |
|---|---|---|---|
| 任意 | `/api/v2/data/*` | **DC（9102）** | 链上数据中心（events/stats/plans/subscribe…） |
| 任意 | `/api/v2/market/*` | **Collector（9101）** | Market 行情订阅面（plans/checkout/usage…） |
| 任意 | `/api/v2/mpc/*` | **MPC（9104）** | MPC 钱包（send-code/plans/ledger-balance…） |
| 任意 | `/api/v2/wallet/*`、`/api/v2/waas/*`、`/api/v2/saas/*`、`/api/v2/subscription/*` | **WAAS（9109）** | 钱包 / 支付 / SaaS / 订阅 |
| 任意 | `/api/vault/*`、`/api/v2/vault/*` | **VAULT（9107）** | 多签 Safe |
| 任意 | `/api/v2/admin/*` | **Admin（9100）** | 聚合管理后台 |

> 注：`/api/v2/data/market/*`（collector 行情数据面）经 **DC :9102** 路由前缀匹配，会先命中 web 的 `/api/v2/data` 路由转发到 DC——此时请**直连 collector :9101** 或确认 DC 侧已挂载对应路由，避免误解（web 代理按最外层前缀匹配）。

### 3.2 其它端点

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/health` | 公开 | 健康检查（status/service/uptime/version/backends 路由表） |
| GET | `/` 及任意静态路径 | 公开 | SPA/Landing/Admin 静态文件（未命中回退 `index.html`） |

## 4. 样例代码

### 4.1 curl

```bash
# ① 健康检查（公开；返回完整后端路由表，生产可访问）
curl -s http://<host>:9111/health
# 响应：{status:"ok", service:"infrax-web", version:"2.1.0",
#        backends:{"/api/v2/admin":"localhost:9100","/api/v2/data":"localhost:9102",
#                  "/api/v2/market":"localhost:9101","/api/v2/mpc":"localhost:9104",
#                  "/api/v2/wallet":"localhost:9109",...,"/api/vault":"localhost:9107"}}

# ② 公网经 web 代理调用后端公开 API（Market 套餐目录，无需 key）
curl -s http://<host>:9111/api/v2/market/plans
# web 自动注入 X-Service-Key 透传至 collector :9101 → 返回套餐列表

# ③ 经 web 调用受保护端点：携带后端所需 header（自动注入 X-Service-Key 之外的 header 原样透传）
curl -s http://<host>:9111/api/v2/data/stats \
  -H "x-dc-api-key: <DC_API_KEY>"        # DC 数据面仍需 x-dc-api-key
curl -s http://<host>:9111/api/v2/market/usage \
  -H "X-API-Key: <MARKET_API_KEY>"       # collector 行情/订阅面需 X-API-Key
curl -s http://<host>:9111/api/v2/mpc/plans     # MPC 费率表（公开，免 key）

# ④ 经 web 登录 admin（login 公开；返回 token 后可带 x-admin-token 调受保护端点）
curl -s -X POST http://<host>:9111/api/v2/admin/login \
  -H "Content-Type: application/json" \
  -d '{"username":"<ADMIN_USER>","password":"<ADMIN_PASS>"}'
```

### 4.2 JS SDK

SDK 的 `baseUrl` 指向 web 代理即可覆盖全部命名空间（DC / Market / MPC / Admin-REST）：

```ts
import { InfraX } from '@0xinfrax/infrax-dk';

// 内网：直连 http://127.0.0.1:9111；公网：http://<公网host>:9111（经 nginx 80/443 → web）
const infrax = new InfraX({
  baseUrl: 'http://<host>:9111',          // web 代理统一入口
  apiKey: process.env.INFRAX_API_KEY,     // 平台 key：自动带 x-api-key，透传到后端
  dcApiKey: process.env.DC_API_KEY,       // DC 数据面：x-dc-api-key（经代理透传）
});

// 经 web 代理调用后端（web 自动注入 X-Service-Key）
const mpcPlans = await infrax.mpc.plans();                    // 公开费率表
const marketPlans = await infrax.market.plans();              // 公开套餐目录
const dcStats = await infrax.dc.stats();                      // 需 dcApiKey
const dcEvents = await infrax.dc.events({ chain: 'sepolia', limit: 1 });

// 静态入口：http://<host>:9111/ 即 SPA（Landing/Admin 由前端路由接管）
```

### 4.3 常见错误码

| HTTP | 含义 |
|---|---|
| 200 | 正常透传（后端状态码原样返回，如 400/401/429/503 均来自后端） |
| 401/403/429/503 | 后端服务鉴权/配额响应（web 原样透传，语义见各服务文档） |
| 502 | 后端不可达（`{"error":"backend unreachable","service":"host:port"}`）——目标服务未启动或端口错误 |
| 504 | 后端超时（代理 15s 超时，`{"error":"backend timeout"}`）——大表查询/慢接口需优化或直连后端 |
| 500 | 静态文件读取异常（非 ENOENT） |
| — | 代理 15s 超时对 dashboard 等慢聚合接口偏短，前端可直连 admin :9100 或接受 504 后重试 |
