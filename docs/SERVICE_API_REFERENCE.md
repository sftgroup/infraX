# InfraX 对外微服务 API 参考（API Query Reference）

> 面向外部调用方（B 端 / 数据调用方 / 集成方）的**对外可用的服务与端点清单**。
> 覆盖：VAULT / Session Key / MPC / WAAS / DATA / LightRAG / ML 七大微服务。
> 数据来源：生产代码盘点 + 生产实测（2026-08-06，`43.163.105.172`；ML 章节更新于 2026-08-08）。
> 鉴权契约：统一平台鉴权（`Authorization: Bearer` | `X-API-Key` | `X-Service-Key` 三选一，详见 §1）。

---

## 1. 统一鉴权契约（所有服务适用）

| 项 | 说明 |
|---|---|
| 请求头 | `Authorization: Bearer <key>` **或** `X-API-Key: <key>` **或** `X-Service-Key: <key>`（任一即通过） |
| 失败响应 | `401 {"detail":"unauthorized"}`（data 为 `{"code":401,"message":"unauthorized","data":null}`） |
| 豁免端点 | `/health`、`/metrics`、`/openapi.json`、`/docs`（data/ml FastAPI） |
| Key 类型 | ① 平台 bridge key（各服务 `.env` 的 `*_API_KEY`，本地常量时间比较）② 外部签发 key（data `/api-keys/verify` 实时校验，scope 匹配：`dx_`=data / `lr_`=rag / `vx_`=vault / `mp_`=mpc / `mx_`=mcp） |
| 签发入口 | admin 面板 `/admin/api-keys`（data 服务签发，前缀 `dx_` 等） |

**生产实测鉴权矩阵（2026-08-06，无 key 直连 127.0.0.1）**：

| 服务 | 端口 | 鉴权 | 实测 | 状态 |
|---|---|---|---|---|
| DATA | 9112 | ✅ app_auth 统一 | 无 key → 401 | 已闭环 |
| LightRAG(ragservicer) | 9721 | ✅ app_auth 统一 | health 200 / admin 403 | 已闭环 |
| LightRAG(knowledge-injector) | 9113 | ✅ app_auth 统一 | 无 key → 401 | 已闭环 |
| VAULT | 9107 | ✅ auth-express（vx_） | 无 key → 401 | 已闭环 |
| MPC | 9104 | ✅ auth-express（mp_） | 无 key → 401 | 已闭环 |
| Session Key | 3500 | ✅ Fastify hook | 无 key → 401 | 已闭环 |
| **WAAS** | 9109 | ⚠️ **自有 tenants/apikeys 体系，未接统一契约** | **无 key → 200（裸奔）** | **未闭环（B-12-1）** |

---

## 2. DATA 数据服务（infrax-data，:9112，nginx `/api/data/*`）

**数据目录**：详见 `docs/DATA_SERVICE_CATALOG.md`（行情/因子/ML/graph 全清单）。

| 端点 | 方法 | 功能 | 鉴权 |
|---|---|---|---|
| `/api/data/bars` | GET | K 线（OHLCV+11 技术指标+外部因子，7 timeframe） | ✅ |
| `/api/data/ticker` | GET | 实时报价（crypto/美股/外汇/期货/A股/港股，返回 market_type） | ✅ |
| `/api/data/factors/catalog` | GET | 因子目录 | ✅ |
| `/api/data/factors/current` | GET | 最新因子值 | ✅ |
| `/api/data/factors/history` | GET | 逐 bar 因子时序 | ✅ |
| `/api/data/snapshots` | GET | 复杂快照（27 类 provider/data_type） | ✅ |
| `/api/data/ml/predictions` | GET | P2 模型预测（bolt/moirai/timesfm） | ✅ |
| `/api/data/symbols` | GET | 达标符号清单 | ✅ |
| `/api/data/symbols/search` | GET | 符号模糊搜索（6 市场） | ✅ |
| `/api/data/symbol/resolve` | GET | 符号解析（BTC→BTCUSDT、EUR/USD→EURUSD=X） | ✅ |
| `/api/data/policy/broker-market` | GET | 券商市场策略（default=Binance） | ✅ |
| `/api/data/stats` | GET | 库统计 | ✅ |
| `/api/data/health` | GET | 健康（豁免） | 🔓 |
| `/api/data/metrics` | GET | Prometheus（豁免） | 🔓 |
| `/api/data/docs` `/redoc` `/openapi.json` | GET | 交互文档/OpenAPI（豁免） | 🔓 |
| `/api/data/admin/status` | GET | 采集器/熔断/新鲜度/key 概览 | ✅ admin |
| `/api/data/admin/config` | GET/PUT | API key 热配置 | ✅ admin |
| `/api/data/admin/symbols` | PUT | 交易对热管理（add/remove/set） | ✅ admin |
| `/api/data/admin/api-keys` | CRUD | 多租户 key 签发 | ✅ admin |
| `/api/data/admin/api-keys/{id}/rotate` | POST | key 轮换 | ✅ admin |
| `/api/data/api-keys/verify` | POST | 校验外部服务 key（scope 匹配） | ✅ bridge |

---

## 3. ML 预测服务（ml-service，:9120，独立推理引擎）

**功能**：独立模型推理服务，承载 **LightGBM / FinBERT / Kronos / Chronos-Bolt / Moirai 2.0 / TimesFM 2.5** 六个模型；数据来自 data-service `/bars` + `/symbols`（HTTP），不直连 SQLite。模型不可用/数据不足时 `data=null`（fail-silent，无模拟数据）。
**鉴权**：✅ app_auth 统一（`ML_API_KEY`，未配置保持开放）；豁免 `/health` `/docs` `/redoc` `/openapi.json` `/metrics` `/ml/cache/stats`。
**与 DATA 的关系**：data-service `/api/data/ml/predictions` 与 `/api/data/factors/current`（category=ml）是 ml-service 输出的**采集快照**（collector 周期拉取落库）；ml-service 直连端点返回**实时推理结果**。低延迟/稳定优先走 data 快照，实时性优先走 ml-service。

### 3.1 端点清单

| 端点 | 方法 | 功能 | 响应结构 |
|---|---|---|---|
| `/ml/tree_predictions` | GET | LightGBM 方向预测（训练+预测全 symbol） | `{generated_at, model, predictions[], macro_context?}` |
| `/ml/volatility` | GET | Kronos 波动率预测（多路径采样） | `{generated_at, n_symbols, model, avg_volatility_score, symbols[]}` |
| `/ml/bolt` | GET | Chronos-Bolt 单变量概率预测（P2） | `{generated_at, n_symbols, model, avg_prob_up, symbols[]}` |
| `/ml/moirai` | GET | Moirai 2.0 多变量跨资产预测（P2） | 同上（symbols 内多 `linked_symbols` 联动字段） |
| `/ml/timesfm` | GET | TimesFM 2.5 长上下文点预测（P2） | `{generated_at, n_symbols, model, avg_prob_up, symbols[]}` |
| `/ml/consensus` | GET | 跨模型信号共识聚合（tree+Kronos+FinBERT+P2） | `{generated_at, signals, n_symbols, avg_consensus_score, market_risk_flag, n_divergence, symbols[]}` |
| `/ml/sentiment` | POST | FinBERT 文本情绪（body: `{"articles":[...]}`） | 聚合情绪统计或 null |
| `/ml/macro_features` | GET | FRED 宏观特征 + DXY/VIX/US10Y 快照 | 特征 dict 或 null |
| `/ml/cache/stats` | GET | 缓存统计（命中/未命中/耗时/各端点缓存状态） | `{code, message, data}`（豁免鉴权，监控用） |

> 直连端点鉴权：配置 `ML_API_KEY` 后需带 `Authorization: Bearer` / `X-API-Key` / `X-Service-Key`；未配置保持开放（内网部署建议配置）。统一 401 响应 `{"detail":"unauthorized"}`。

### 3.2 异步计算 + 缓存预热（2026-08 性能改造，调用方必读）

1. **TTL 缓存**（`ML_CACHE_TTL_SEC`，默认 **1800s**）：重计算端点结果缓存，TTL 内命中秒回，不重跑分钟级推理。
2. **异步兜底**：缓存 miss 时请求**立即返回 `data=null`**，计算结果在后台 daemon 线程完成并写回缓存——请求永不因全量推理而阻塞（此前全量预测曾拖死 /health）。
3. **预热线程**（`ML_PREWARM_ENABLED=true` 默认开）：启动 `ML_PREWARM_DELAY_SEC`（60s）后周期检查（`ML_PREWARM_INTERVAL_SEC` 900s），缓存缺失/过期时后台刷新 → **缓存常满，请求几乎总是命中**。

**调用方配合**：首次请求（或重启后预热完成前）可能收到 `data=null`，属预期行为。建议 ① 优先读 data-service `/api/data/ml/predictions` 快照（30min 周期落库，更稳定）；② 对 ml-service 直连端点轮询重试（间隔 ≥ TTL，或依据 `/ml/cache/stats` 判断缓存就绪）；③ 用 `/ml/cache/stats` 观察各端点缓存命中/预热状态（豁免鉴权）。

### 3.3 统一响应结构（volatility / bolt / moirai / timesfm）

裸数组已升级为 **dict + 聚合指标**（对齐 tree_predictions / consensus 结构）：

```json
{
  "generated_at": 1786089600000,
  "n_symbols": 30,
  "model": "chronos-bolt-small",
  "avg_prob_up": 0.5231,
  "symbols": [
    {"symbol": "BTC/USDT", "direction": 1, "prob_up": 0.61,
     "point_forecast": 64512.3, "quantiles": {"0.1": 61200.5, "0.5": 64512.3, "0.9": 67890.1},
     "uncertainty": 0.21}
  ]
}
```

- `n_symbols`：覆盖 symbol 数（生产 `.env` 以 `P2_TARGET_SYMBOLS` 显式配置 **30 个目标池**，覆盖 data-service 动态 46 符号池）
- `avg_<score_key>`：全池概率/评分均值（volatility 用 `avg_volatility_score`，其余 4 端点为 `avg_prob_up`）
- `symbols[]` 内单 symbol 字段（direction/prob_up/point_forecast/quantiles/uncertainty）**保持不变**，向后兼容

---

## 4. VAULT 多签保险库（:9107，MCP :9108）

**功能**：Safe 多签管理（create/propose/confirm/execute 链上闭环）+ owner 管理（B-5 链上多签）+ 风控规则。
**鉴权**：✅ `scope=vault`（vx_ key）/ 本地 `VAULT_API_KEY`；`/health` 豁免。

| 端点 | 方法 | 功能 |
|---|---|---|
| `/health` | GET | 健康（豁免） |
| `/api/vault/dashboard` | GET | 保险库总览 |
| `/api/vault/safe/create` | POST | 创建 Safe（多链） |
| `/api/vault/safe/propose` | POST | 提议交易（Safe 非直接转账，生成 safe_transactions） |
| `/api/vault/safe/confirm` | POST | 签名确认（含 confirmSignature） |
| `/api/vault/safe/execute` | POST | 执行交易 |
| `/api/vault/safe/list` | GET | Safe 列表 |
| `/api/vault/safe/owned` | GET | 我拥有的 Safe |
| `/api/vault/safe/participating` | GET | 我参与的 Safe |
| `/api/vault/safe/status` | GET | Safe 状态 |
| `/api/vault/safe/:address` | GET | Safe 详情（owners/threshold/余额） |
| `/api/vault/safe/:address/owners` | PUT | **更新 owner（B-5 链上多签，addOwner/removeOwner/changeThreshold）** |
| `/api/vault/safe/retry` | POST | 重试失败交易 |
| `/api/vault/safe/execute-ready` | POST | 批量执行已达阈值交易 |
| `/api/vault/safe/sync` | POST | 链上同步 |
| `/api/vault/risk/rules` | GET/POST | 风控规则查询/设置 |
| `/api/vault/risk/check` | POST | 风控预检 |

**MCP**：`infrax-vault-mcp`（:9108）13 工具，见 `docs/MCP_USAGE.md`。

---

## 4. Session Key 引擎（:3500，MCP :3011）

**功能**：EIP-712 授权签名 → 会话密钥托管 → 白名单额度内代执行交易（Fastify + PostgreSQL + Redis 锁）。
**鉴权**：✅ 三层（Bearer `SESSION_KEY_API_KEY` / session 权限校验 / 白名单+额度）；豁免 `/api/v1/health`、`GET /api/v1/nonce`、`POST /api/v1/sessions`。

| 端点 | 方法 | 功能 |
|---|---|---|
| `/api/v1/health` | GET | 健康（豁免） |
| `/api/v1/nonce` | GET | 一次性 nonce（EIP-712 签名用，30min 有效） |
| `/api/v1/sessions` | POST | 创建 Session Key（用户 EIP-712 授权签名，豁免） |
| `/api/v1/sessions` | GET | 用户会话列表 |
| `/api/v1/sessions/:id` | GET | 会话详情 |
| `/api/v1/sessions/:id` | DELETE | 撤销会话 |
| `/api/v1/execute` | POST | 用会话密钥执行交易（白名单+额度三重校验） |

**MCP**：`infrax-session-key-mcp`（:3011）7 工具，见 `docs/MCP_USAGE.md`。

---

## 6. MPC 钱包（:9104，MCP :9105）

**功能**：邮箱验证码 → 注册/恢复 MPC 密钥分片托管钱包 → 会话解锁 → 签名/交易/合约调用。
**鉴权**：✅ `scope=mpc`（mp_ key）/ 本地 `MPC_API_KEY`；`/health` 豁免。

| 端点 | 方法 | 功能 |
|---|---|---|
| `/health` | GET | 健康（豁免） |
| `/api/v2/mpc/send-code` | POST | 发送邮箱验证码（6 位随机，B-1 已去硬编码） |
| `/api/v2/mpc/register` | POST | 邮箱+验证码注册钱包 |
| `/api/v2/mpc/recover` | POST | 找回钱包 |
| `/api/v2/mpc/status` | GET | 钱包状态（exists/address） |
| `/api/v2/mpc/session/unlock` | POST | 会话解锁（签名能力） |
| `/api/v2/mpc/session/lock` | POST | 会话锁定 |
| `/api/v2/mpc/session/status` | GET | 会话状态 |
| `/api/v2/mpc/balance` | POST | 余额查询 |
| `/api/v2/mpc/sign-message` | POST | 签名任意消息 |
| `/api/v2/mpc/sign-typed-data` | POST | EIP-712 typed data 签名 |
| `/api/v2/mpc/send-transaction` | POST | 发送交易 |
| `/api/v2/mpc/contract-read` | POST | 合约读 |
| `/api/v2/mpc/contract-write` | POST | 合约写 |
| `/api/v2/mpc/gas-estimate` | POST | gas 预估 |

**MCP**：`infrax-mpc-mcp`（:9105）15 工具，见 `docs/MCP_USAGE.md`。

---

## 7. WAAS 钱包即服务（:9109）

**功能**：SaaS 多租户钱包基础设施（认证/钱包/交易/风控/事件回调/套餐/数据订阅/apikey）。
**鉴权**：⚠️ **未接入平台统一契约**。自有体系：租户 `x-api-key`（`requireTenantApiKey`，saas 部分路由）+ `x-api-key` 内部 key（`requireApiKey`，internal/event 部分路由）+ admin JWT。**wallet/tx/risk/subscription/dashboard/dataSubscription/payment 大部分端点无鉴权中间件**（生产实测 `/api/v2/data/plans` 无 key 200）。

| 路由组 | 端点示例 | 功能 | 鉴权 |
|---|---|---|---|
| `/api/v2/auth/*` | POST register/login | 邮箱认证（MPC 注册入口） | ⚠️ 无 |
| `/api/v2/wallet/*` | POST create / GET list / balance | 托管钱包 | ⚠️ 无 |
| `/api/v2/tx/*` | POST create / send / GET list | 交易 | ⚠️ 无 |
| `/api/v2/risk/*` | GET/POST rules | 风控 | ⚠️ 无 |
| `/api/v2/events/*` / `/api/v2/webhooks/*` | POST register / GET list | 事件回调 | 部分 ✅ |
| `/api/v2/dashboard/*` | GET overview / stats | 总览 | ⚠️ 无 |
| `/api/v2/internal/*` | POST / GET / PUT | 内部管理（CWallet 回调等） | ✅ requireApiKey |
| `/api/v2/saas/*` | tenants / apikeys CRUD / hot-wallet / tokens | 租户管理 | ✅ requireTenantApiKey（部分） |
| `/api/v2/subscription/*` | GET plans / POST subscribe / me / check / verify / cancel | 套餐（MQ-12 支付意图化，见 §7.1） | 登录（plans/payment-callback 公开） |
| `/api/v2/data/*` | GET plans / POST subscribe / GET usage/key/docs | **数据订阅（发 DC key）** | ⚠️ 无 |
| `paymentRoutes` / `mpcRoutes` | — | 已迁移通用支付引擎 :9132（B-10-5 ✅ 2026-08-11 闭环，见 §7.5） | — |

### 7.1 WAAS 套餐订阅（MQ-12，支付意图化）

> **核心契约**：`subscriptions` 状态机 `free 直通 active` ｜ `付费 pending → active`。付费套餐不再"直接激活"——`subscribe` 只创建支付意图并返回 rail 支付信息，支付完成后经**回调 / 链上轮询 / verify 提交**三路之一激活。rail 失败 → `failed`；`cancel` → `cancelled`。
> **鉴权**：`plans`/`payment-callback` 公开；`subscribe`/`me`/`check`/`verify`/`cancel` 需用户登录态（`authenticate`）。

| 端点 | 方法 | 鉴权 | 功能 |
|---|---|---|---|
| `/api/v2/subscription/plans` | GET | 无 | 套餐目录（free/pro/enterprise） |
| `/api/v2/subscription/subscribe` | POST | 登录 | 创建支付意图：free→201 active 直通；付费→201 pending + `payment`（按 rail） |
| `/api/v2/subscription/me` | GET | 登录 | 当前 active 订阅（无则回退 free） |
| `/api/v2/subscription/check` | POST | 登录 | 轮询支付状态（chain rail 链上 escrow 兜底 → active 则激活） |
| `/api/v2/subscription/verify` | POST | 登录 | x402 rail 确认：提交 `txHash` → payments 验收入账 → 校验 payer==当前钱包 → 激活 pending |
| `/api/v2/subscription/payment-callback` | POST | 签名 | 支付引擎出站回调（见下「回调契约」） |
| `/api/v2/subscription/cancel` | POST | 登录 | 取消 active 订阅 |

**状态机**：

```
subscribe(free) ───────────────▶ active（直通）
subscribe(paid) ──▶ pending ──┬─▶ payment-callback（fiat webhook `sub:<id>` / x402 credit 按 payer 匹配）
                              ├─▶ /check（chain：SubscriptionManager escrow active → 激活）
                              ├─▶ /verify（x402：提交 txHash → 校验 payer → 激活）
                              └─▶ rail 异常 ─▶ failed
cancel ───────────────────────▶ cancelled
```

**rail 路由表**（`POST /subscribe` body `{planId, rail?}`，默认 rail 由 `DEFAULT_RAIL` 配置，平台自用实例 = chain）：

| rail | subscribe 返回（`payment`） | 支付方式 | 激活路径 |
|---|---|---|---|
| `chain`（默认） | `price`/`period`/`payToken`/`trialDays`/`subscriptionManager`/`chainId` | 向链上 `SubscriptionManager` escrow 转账 | 前端 4s 轮询 `/check`（链上 `hasActiveSubscription` 兜底） |
| `fiat` | `sessionUrl`/`paymentId` | Stripe checkout 跳转 | webhook 回调 `client_reference_id=sub:<id>` |
| `x402` | `payTo`/`priceWei`/`network` | 向平台钱包转账 | 提交 `txHash` 调 `/verify`（或 credit 回调按 payer 匹配） |

**回调契约**（`POST /payment-callback`，由 payments `WEBHOOK_FORWARD_URL` 转发指向）：
- 验签：header `x-payments-signature` = HMAC-SHA256(紧凑 JSON body, `PAYMENTS_WEBHOOK_SECRET`)，`timingSafeEqual` 比对；签名缺失/不匹配 → 401
- body：`{ type: 'webhook' | 'credit', eventId, event, forwardedAt }`
  - `webhook`：`event.object.client_reference_id` 以 `sub:` 开头 → 激活对应订阅
  - `credit`：`event.payer` 匹配最近 pending 的 x402 订阅（按用户 wallet_address）→ 激活；无法匹配仅记日志
- 幂等：`activateSubscription` 对已 active 跳过
- 响应：`{ received: true }`（200）

**回滚预案（T-10）**：waas 侧恢复"直接订阅逻辑"（subscribe 直接 active，回退到 MQ-12 前的简化行为）+ payments rails 停用（不配置 `PAYMENTS_URL`/`DEFAULT_RAIL` 或 payments 服务下线）即整体回退——waas 与 payments 业务零耦合（仅 HTTP 调用），互不影响。

**MCP**：无专属 MCP（`infrax-wallet-mcp` 代理 waas，需 `WAAS_API_KEY`，见 MCP 文档）。

---

## 7.5 Payments 通用支付引擎（:9132，`@0xinfrax/payments`，MQ-14/16）

> **接入方式（2026-08-11 决策）**：通用支付 = **独立实例 + 自配凭证**。每个 B 端（调用方）自行部署/嵌入 `@0xinfrax/payments`，在**自己的实例**里配置自己的收款凭证——**一个实例 = 一套收款**，钱进 B 端自己的账户。平台 `:9132` 仅为**平台自用实例**（配平台自身凭证，服务 waas/dc/collector/chain-rpc 订阅激活），不代 B 端收钱。完整接入模板见 `projects/payments/CALLER_SETUP.md`。
> **鉴权**：平台实例出站统一 `Authorization: Bearer` / `X-API-Key` / `X-Service-Key` 三选一（`PAYMENTS_API_KEY`）。**响应为裸 JSON**（非 `{code,message,data}` 信封），SDK 用 `postRaw/getRaw` 对接。

### 7.5.1 收款/结算（checkout / a2a / verify / balance / price / period）

| 端点 | 方法 | 功能 |
|---|---|---|
| `/payments/info` | GET | 通道发现（rails/价格/pay-to） |
| `/payments/price` | GET | 链上套餐定价（planId） |
| `/payments/checkout` | POST | Stripe fiat checkout（创建支付会话，返回 sessionUrl） |
| `/payments/a2a` | POST | a2a 收款意图（返回 paymentId，链上/账本支付） |
| `/payments/a2a/settle` | POST | 提交链上 txHash 结算（x402 验证 + 记账） |
| `/payments/verify` | POST | 链上支付验证（txHash → 是否打到平台收款地址） |
| `/payments/webhook` | POST | Stripe 等 webhook 回调 |
| `/payments/balance` | GET | 账本余额（address 维度） |
| `/payments/access` | POST | 订阅访问控制检查 |
| `/payments/period/charge` | POST | 订阅周期扣费（period 能力） |
| `/payments/period/authorization` | GET | 周期授权查询 |
| `/payments/chain-info/:chain` | GET | 链配置（收款地址等） |
| `/payments/subscription/:chain/:subscriber/:resourceId` | GET | 订阅状态查询 |
| `/payments/mpp/open` `/voucher` `/topup` `/settle` `/close` `/session` | POST/GET | MPP 状态通道全生命周期 |
| `/payments/capabilities` | GET | 引擎能力探测 |

### 7.5.2 batch 批量收款（MQ-16，batch 能力）

| 端点 | 方法 | 功能 |
|---|---|---|
| `/payments/batch` | POST | 创建批量收款意图（一次多 payee，body: `{items:[{payee, amountWei, asset?, rail?}], chain?, clientReference?}`） |
| `/payments/batch/settle` | POST | 结算 batch 中单个 item（提交该笔链上 txHash，x402 校验入账） |
| `/payments/batch?batchId=` | GET | 查询 batch 状态 |
| `/payments/batch/cancel` | POST | 取消 batch（仅未支付 items） |

### 7.5.3 invites 账单邀请（MQ-16，invite 能力）

| 端点 | 方法 | 功能 |
|---|---|---|
| `/payments/invites` | POST | 创建账单邀请（payer → payee，body: `{payer, payee, amountWei, asset?, rail?, chain?, clientReference?}`） |
| `/payments/invites?address=&role=` | GET | 列出邀请（role: payer\|payee，可选 status） |
| `/payments/invites/:inviteId` | GET | 单个邀请详情 |
| `/payments/invites/:inviteId/cancel` | POST | 取消未结算邀请 |
| `/payments/invites/:inviteId/settle` | POST | 链上结算（提交 payer 的 txHash） |
| `/payments/invites/:inviteId/pay` | POST | 账本支付（从 payer ledger 余额扣款结算） |

### 7.5.4 transfers 账本内部转账（MQ-16，transfer 能力）

| 端点 | 方法 | 功能 |
|---|---|---|
| `/payments/transfers` | POST | 发起账本转账（body: `{from, to, amountWei, asset?}`；需余额充足） |
| `/payments/transfers/:transferId/confirm` | POST | 确认并执行转账（原子入账） |
| `/payments/transfers?address=&role=` | GET | 列出转账（role: from\|to） |
| `/payments/transfers/:transferId` | GET | 单个转账详情 |
| `/payments/transfers/:transferId/cancel` | POST | 取消未执行转账 |

> **SDK 对接**：`ix.payment.batchCreate()/batchSettle()/batchGet()/batchCancel()`、`inviteCreate()/inviteList()/inviteGet()/inviteCancel()/inviteSettle()/invitePay()`、`transferCreate()/transferList()/transferGet()/transferConfirm()/transferCancel()`（`@0xinfrax/infrax-dk` v0.6.0+，全部 `postRaw/getRaw` 裸 JSON）。

---

## 7.6 MQ-16 对外套餐订阅端点（DC :9102 / Collector :9101 / Chain RPC :9130 / MPC :9104）

> 五任务 T-1~T-5 全部完成并生产部署（2026-08-11）。计费矩阵：**业务服务管"权益激活"、支付引擎管"钱"**。完整验收见 [docs/infrax_tasklist.md §9.8.9](./infrax_tasklist.md)。

### 7.6.1 DC 数据订阅（:9102，T-1）— `x-wallet-address` 鉴权，信封响应

| 端点 | 方法 | 功能 |
|---|---|---|
| `/api/v2/data/plans` | GET | 套餐目录（公开） |
| `/api/v2/data/subscribe` | POST | 订阅（body: `{planId, rail}`；免费直接激活返回 dcApiKey，付费返回 pending） |
| `/api/v2/data/payment-check` | POST | 轮询支付状态（chain rail 链上确认） |
| `/api/v2/data/verify` | POST | x402 确认（`{txHash}`，payer 需匹配 x-wallet-address） |
| `/api/v2/data/usage` | GET | 订阅用量（plan/quota/日聚合） |
| `/api/v2/data/payment-callback` | POST | 支付回调 webhook（HMAC 验签） |

### 7.6.2 Market 行情订阅（collector :9101，T-2）— `X-API-Key` 鉴权，信封响应，超限 **503**

| 端点 | 方法 | 功能 |
|---|---|---|
| `/api/v2/market/plans` | GET | 套餐目录（公开） |
| `/api/v2/market/checkout` | POST | 订阅（body: `{plan_id, rail, subscriber?}`；免费直接激活，付费返回 pending + payment） |
| `/api/v2/market/payment-check` | POST | 轮询支付状态 |
| `/api/v2/market/verify` | POST | x402 确认（`{txHash}`） |
| `/api/v2/market/usage` | GET | 订阅用量 |
| `/api/v2/market/payment-callback` | POST | 支付回调 webhook（HMAC 验签） |

> **公网代理**：web :9111 已补 `'/api/v2/market' → collector :9101` 路由（2026-08-11，生产实测 `/api/v2/market/plans` 200）。

### 7.6.3 Chain RPC 订阅（:9130，T-3）— `rx_` key 鉴权，信封 `{code,message,data}`，超限 **503**

| 端点 | 方法 | 功能 |
|---|---|---|
| `/v1/subscription/plans` | GET | 套餐目录（公开） |
| `/v1/subscription/issue-key` | POST | 签发 `rx_` 读 key（管理操作，X-Service-Key） |
| `/v1/subscription/checkout` | POST | 订阅（body: `{plan_id, rail, subscriber?}`；`rx_` key 鉴权） |
| `/v1/subscription/payment-check` | POST | 轮询支付状态 |
| `/v1/subscription/payment-callback` | POST | 支付回调 webhook |
| `/v1/subscription/verify` | POST | x402 确认（`{txHash}`） |
| `/v1/subscription/usage` | GET | 订阅用量 |

### 7.6.4 MPC 按量计费（:9104，T-4）— session 鉴权，信封响应，欠费 **402**

| 端点 | 方法 | 功能 |
|---|---|---|
| `/api/v2/mpc/plans` | GET | 套餐价目（公开：mode/billing/configured/platformAddress/fees/topup） |
| `/api/v2/mpc/ledger-balance` | POST | ledger 余额查询（body: `{token}`，返回 address/balanceWei/fees/topupHint） |

> 计费触发：签名 0.0001 ETH / 写链 0.001 ETH（pay-per-use），余额不足 402 `insufficient_balance`。

---

## 8. LightRAG 知识图谱（ragservicer :9721 `/api/rag/*` + knowledge-injector :9113）

**功能**：LightRAG 实体-关系图谱 + 向量索引 + 关键词三路检索；多租户 namespace 隔离；知识注入。
**鉴权**：✅ app_auth 统一（lr_ key）；`/api/v1/health` `/api/v1/openapi.json` 豁免（Blueprint 前缀 `/api/v1`）；admin 端点 Bearer-only（403 "Admin access required"）。

### 7.1 ragservicer（:9721，前缀 `/api/v1/`）

| 端点 | 方法 | 功能 |
|---|---|---|
| `/api/v1/health` | GET | 健康（豁免） |
| `/api/v1/namespaces/{ns}/documents` | POST | 注入文档（异步任务） |
| `/api/v1/namespaces/{ns}/documents/batch` | POST | 批量注入 |
| `/api/v1/namespaces/{ns}/documents` | GET | 文档列表（分页） |
| `/api/v1/namespaces/{ns}/documents/{doc_id}` | DELETE | 删除文档 |
| `/api/v1/namespaces/{ns}/query` | POST | 图谱混合检索（entities+relations+chunks，mode: local/global/hybrid/nl/mix/naive） |
| `/api/v1/namespaces/{ns}/retrieve` | POST | 纯检索上下文（top_k） |
| `/api/v1/namespaces/{ns}/tasks/{task_id}` | GET | 注入任务状态 |
| `/api/v1/tenants` | GET/POST | 租户列表/创建 |
| `/api/v1/tenants/{id}/keys` | GET/POST | 租户 key 签发 |
| `/api/v1/instances` | GET | 图谱实例（生产 3 实例） |
| `/api/v1/admin/config` | GET/PUT | key 热配置（Bearer admin） |
| `/api/v1/admin/tasks` | GET | 任务队列统计（Bearer admin） |
| `/api/v1/openapi.json` | GET | OpenAPI 3.0（15 paths，豁免） |

### 7.2 knowledge-injector（:9113）

| 端点 | 方法 | 功能 |
|---|---|---|
| `/status` | GET | 服务状态 |
| `/inject/{source}` | POST | 按数据源注入图谱（19 个源） |
| `/inject/all` | POST | 全量注入 |
| `/inject/parsed` | POST | 注入已解析文档 |
| `/query` | POST | 图谱查询（namespace 参数化） |
| `/injectors` | GET | 注入器列表 |
| `/stats` / `/stats/recent` | GET | 注入统计 |
| `/admin/config` | GET/PUT | key 热配置（admin） |
| `/openapi.json` | GET | OpenAPI 3.0（10 paths，豁免） |

---

## 9. 端口与服务总览

| 服务 | 端口 | nginx 前缀 | SDK | MCP |
|---|---|---|---|---|
| infrax-data | 9112 | `/api/data/*` | ✅ infrax-dk | ✅ hub-index data_* |
| infrax-ml-service | 9120 | — | ✅ OpenAPI 原生 | ⚠️ 经 hub-index data 快照（ml_predictions） |
| infrax-knowledge-injector | 9113 | — | — | — |
| infrax-ragservicer | 9721 | `/api/rag/*` | ✅ lightrag-client / ragservicer-sdk | ✅ STDIO 5 工具 |
| infrax-vault | 9107 | — | ✅ infrax-dk | ✅ :9108 13 工具 |
| infrax-mpc | 9104 | — | ✅ infrax-dk（含 plans/ledger-balance） | ✅ :9105 17 工具 |
| infrax-waas | 9109 | — | ✅ infrax-dk | ✅ wallet-mcp 34 工具（含 payments 代理） |
| infrax-collector | 9101 | — | ✅ infrax-dk market.*（订阅面） | ✅ market-mcp :3013 18 工具 |
| infrax-chain-rpc | 9130 | — | ✅ infrax-dk chainRpc.*（含订阅面） | ✅ :3012 10 工具 |
| infrax-payments | 9132 | — | ✅ infrax-dk payment.*（裸 JSON） | ✅ wallet-mcp payment_* 代理 |
| infrax-session-key | 3500 | — | ⚠️ 未覆盖 | ✅ :3011 7 工具 |
| hub-index（统一入口） | 3008 | `/mcp/*` | — | ✅ 13 工具 |

**遗留项**：WAAS 统一鉴权（B-12-1）、SDK 补 session 方法（B-12-2）。~~market-index 未部署~~ → **market-mcp 已部署（:3013，2026-08-11）**。
