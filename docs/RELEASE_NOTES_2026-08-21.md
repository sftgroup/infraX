# InfraX 平台发布说明 — v2026-08-21

> 发布范围：DEX 策略数据层（collector/data）+ 外部 key 鉴权 + aa-relay 计费异步化（P1/P2）+ `@0xinfrax/aa-sdk@0.1.3`（InfraXEscrow 充值 helper）
> 发布窗口：2026-08-21（北京时间）
> 关联提交：`d28c748` → `7d912f9`（master 分支，共 18 commits）
> 关联文档：[AA_RELAY_BILLING.md](./AA_RELAY_BILLING.md) / [API_ACCESS.md](./API_ACCESS.md) §1.6 / [AA_SDK_QUICKSTART.md](./AA_SDK_QUICKSTART.md) §6 / [DATA_SERVICE_CATALOG.md](./DATA_SERVICE_CATALOG.md)

---

## 1. 发布概述

本日发布覆盖 **AItrader DEX 策略数据需求（R1-R10）** 收尾、**AgentX 自动续订 REQ-3 价目与结算语义确认** 的代码落地，以及 SDK 充值构建补全：

| 类别 | 内容 |
|---|---|
| DEX 数据面 | 9 端点全部上线（hot-tokens/token/history/search/signal/holders/liquidity/top-traders/trades）+ 热门代币画像自动快照（5min 粒度历史序列） |
| 鉴权 | collector 外部 `dx_` 类 key 实时校验（E-1c），修复 SDK 直连 401 |
| 数据覆盖 | OKX 热门代币每链 10 → **30** |
| aa-relay 计费 | P1：`wait:false` → **202** + 后台异步结算退差；P2：结算重试 / 状态机 / 限额透出 |
| SDK | `@0xinfrax/aa-sdk@0.1.3`：InfraXEscrow 充值构建 helper（REQ-1/REQ-5） |
| 基础设施 | nginx `/api/v2/data/market/dex/` 公网路由修复（404 → 200） |

**影响面**：AItrader（DEX 策略数据）、AgentX（AA 自动续订计费）、PocketX 等 aa-sdk 调用方。

---

## 2. 变更清单

### 2.1 DEX 策略数据层（R1-R10，2026-08-21 上线）

| # | 变更 | 代码引用 |
|---|---|---|
| DEX-1 | `GET /api/v2/data/market/dex/*` 9 端点（hot-tokens / token / token/history / search / signal / holders / liquidity / top-traders / trades），数据源 OKX OnchainOS v6 + DexScreener，链枚举 ETH/BSC/BASE/SOL，上游付费端点自动降级 `{items:[], paymentRequired:true}` | [apiKeyAuth.ts](file:///home/steven/infraX/projects/collector/src/middleware/apiKeyAuth.ts) |
| DEX-2 | 热门代币画像自动快照：profiles 表 + `token/history`（5min 粒度历史价格序列） | collector `okxMarketScheduler` |
| DEX-3 | 每链热门代币 10 → **30**（`OKX_MARKET_CANDLE_TOKENS`，覆盖 hot/candles/profiles/mempump） | [config.ts](file:///home/steven/infraX/projects/collector/src/config.ts#L66) |
| DEX-4 | 公网 nginx 规则：`location /api/v2/data/market/dex/ → web :9111`（最长前缀优先于 `/api/v2/data/ → dc :9102`），修复 SDK 直连 404；`/api/dex/*`（web/server.js 代理）与 SDK 方法双路径均验证通过 | nginx `/etc/nginx/sites-enabled/infrax` |

### 2.2 外部 key 鉴权（E-1c）

| # | 变更 | 说明 |
|---|---|---|
| AUTH-1 | collector `apiKeyAuth`：本地表未命中且 `dx_/mx_/ar_/cr_/wa_/px_/vx_/mp_` 前缀 → 实时调 data `/api-keys/verify`（Bearer `DATA_API_KEY`，fail-closed 5s） | 修复外部 `dx_` key 401；通过后设 `req.apiKey={external:true, marketPlanId:'market_free'}` |

### 2.3 aa-relay 计费（REQ-3 P1/P2 落地）

| # | 变更 | 说明 |
|---|---|---|
| AA-1 | `POST /v1/userops` 支持 `wait`：`wait:false` → **202 Accepted** + `{userOpHash, bundlerUrl, receipt:null}`，后台 `asyncSettle` 轮询收据后按 `固定费+actualGasCost` 多退少补（与同步同口径） | 广播失败全额退；120s 无收据保留预扣仅告警 |
| AA-2 | `GET /v1/userops/:hash` 状态机：`status: pending/confirmed/reverted` + `receipt` | |
| AA-3 | 结算/退款失败重试：`retrySettle` 3 次指数退避（800ms/1.6s/3.2s），402 业务错误不重试，接入全部 settle/refund 调用点 | |
| AA-4 | `GET /v1/plans` 透出 `limits`（perTx=1 / perDay=10 OXA 合约默认；自动续订 ~0.0025 OXA/次，默认限额日支撑 ~4000 次续订） | |

### 2.4 SDK 发布 `@0xinfrax/aa-sdk@0.1.3`

| # | 变更 | 说明 |
|---|---|---|
| SDK-1 | 新增 `src/escrow.ts`：`InfraXEscrowAbi` + `encodeDepositFor*` 编码 helper + `buildDepositFor*UserOp`（组合 Kernel v3 execute/executeBatch） | REQ-1（EOA 代充）/ REQ-5（批量）/ REQ-4（session 自付兜底） |
| SDK-2 | 13 新增单测（134 全绿），typecheck + build 通过；barrel 导出 | |

---

## 3. 部署与验证

- **生产部署**：aa-relay（`accade2`）+ collector（`d016fe1`/`29aa586`）服务 active；`GET /v1/plans` 返回 `limits`、`GET /v1/userops/:hash` 状态机 pending、202 端到端待 AgentX 集成验证。
- **DEX 双路径验证**：collector 测试 8/8 + SDK 实测（OKX 100 币榜 / SOL 新币榜 / search / token 画像）+ `/api/dex/*` 公网路径 200。
- **npm 发布**：`@0xinfrax/aa-sdk@0.1.3`（`prepublishOnly` 自动 build）。

---

## 4. 遗留事项

- AgentX 前端按 REQ-1 落地（SDK 0.1.3 `buildDepositForUserOp` / `InfraXEscrowAbi` + 续订资金预检告警）；202 异步结算端到端待 AgentX 集成验证。
- 测试用 dx_ key（label `dex-verify-20260821`）待清理。
