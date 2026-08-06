# InfraX 对外微服务 API 参考（API Query Reference）

> 面向外部调用方（B 端 / 数据调用方 / 集成方）的**对外可用的服务与端点清单**。
> 覆盖：VAULT / Session Key / MPC / WAAS / DATA / LightRAG 六大微服务。
> 数据来源：生产代码盘点 + 生产实测（2026-08-06，`43.163.105.172`）。
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

## 3. VAULT 多签保险库（:9107，MCP :9108）

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

## 5. MPC 钱包（:9104，MCP :9105）

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

## 6. WAAS 钱包即服务（:9109）

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
| `/api/v2/subscription/*` | GET plans / POST upgrade | 套餐 | ⚠️ 无 |
| `/api/v2/data/*` | GET plans / POST subscribe / GET usage/key/docs | **数据订阅（发 DC key）** | ⚠️ 无 |
| `paymentRoutes` / `mpcRoutes` | — | **已定义未挂载（B-10-5）** | — |

**MCP**：无专属 MCP（`infrax-wallet-mcp` 代理 waas，需 `WAAS_API_KEY`，见 MCP 文档）。

---

## 7. LightRAG 知识图谱（ragservicer :9721 `/api/rag/*` + knowledge-injector :9113）

**功能**：LightRAG 实体-关系图谱 + 向量索引 + 关键词三路检索；多租户 namespace 隔离；知识注入。
**鉴权**：✅ app_auth 统一（lr_ key）；`/health` `/openapi.json` 豁免；admin 端点 Bearer-only（403 "Admin access required"）。

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

## 8. 端口与服务总览

| 服务 | 端口 | nginx 前缀 | SDK | MCP |
|---|---|---|---|---|
| infrax-data | 9112 | `/api/data/*` | ✅ infrax-dk | ✅ hub-index data_* |
| infrax-knowledge-injector | 9113 | — | — | — |
| infrax-ragservicer | 9721 | `/api/rag/*` | ✅ lightrag-client / ragservicer-sdk | ✅ STDIO 5 工具 |
| infrax-vault | 9107 | — | ✅ infrax-dk | ✅ :9108 13 工具 |
| infrax-mpc | 9104 | — | ✅ infrax-dk | ✅ :9105 15 工具 |
| infrax-waas | 9109 | — | ✅ infrax-dk | ✅ wallet-mcp 10 工具 |
| infrax-session-key | 3500 | — | ⚠️ 未覆盖 | ✅ :3011 7 工具 |
| hub-index（统一入口） | 3008 | — | — | ✅ 13 工具 |

**遗留项**：WAAS 统一鉴权（B-12-1）、waas paymentRoutes/mpcRoutes 挂载（B-10-5）、SDK 补 session 方法（B-12-2）、market-index 未部署。
