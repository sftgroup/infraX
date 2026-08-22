# InfraX 平台架构与微服务功能手册（内部文档）

> 版本 `v0.7.0-20260812` | 最后更新 2026-08-12 | 面向团队内部：平台总体架构 + 每个微服务的当前功能列表。
> 对外接入契约见 [API_ACCESS.md](./API_ACCESS.md)（REST 矩阵）、[SDK_INTEGRATION.md](./SDK_INTEGRATION.md)（SDK）、[MCP_USAGE.md](./MCP_USAGE.md)（MCP）、[SERVICE_API_REFERENCE.md](./SERVICE_API_REFERENCE.md)（端点详情）。

---

## 1. 平台定位

InfraX = **AI Agent 钱包与数据基础设施平台**，对外提供三类接入（REST API / MCP Server / JS·Python SDK），底层是 14 个微服务分「数据栈」与「区块链栈」两大域：

- **数据栈**：行情/因子/宏观/ML 预测 + 知识图谱 RAG
- **区块链栈**：钱包托管（MPC/WAAS/Vault）、链上数据（DC/Collector）、RPC 网关、智能账户（aa-relay）、支付引擎（Payments）、会话密钥（Session Key）

```
┌────────────────────────────────────────────────────────────────┐
│                            客户端                                │
│   REST API   │   MCP (AI Agent: Claude/Claw/Cursor)   │   SDK    │
└──────┬───────┴─────────────┬──────────────────────────┴────┬─────┘
       │                     │                               │
  Web Proxy :80 (nginx)      │                        @0xinfrax/* npm
  /api/v2/* 路由分发          │                        8 个 SDK 包
       │                     │                               │
┌──────▼─────────────────────▼───────────────────────────────▼──────┐
│                        MCP 层（8 HTTP MCP + 1 STDIO）              │
│  hub-index:3008 │ vault:9108 │ mpc:9105 │ session-key:3011 │      │
│  dc:9103 │ wallet:9110 │ chain-rpc:3012 │ market:3013 │ RAG STDIO │
└──────┬────────────────────────────┬───────────────────────────────┘
       │                            │
┌──────▼─────────────┐   ┌──────────▼───────────────────────────────┐
│   数据栈            │   │  区块链栈                                  │
│ data:9112          │   │  waas:9109 │ vault:9107 │ mpc:9104        │
│ ml-service:9120*   │   │  dc:9102 │ collector:9101 │ chain-rpc:9130│
│ injector:9113      │   │  payments:9132 │ session-key:3500         │
│ ragservicer:9721   │   │  aa-relay:9131 │ admin:9100 │ web         │
└──────┬─────────────┘   └──────────┬───────────────────────────────┘
       │                            │
  PostgreSQL / SQLite / Redis       PostgreSQL（各服务独立库）
  （数据域）                        （infrax_* 系列库）
└────────────────────────────────────────────────────────────────────┘
* ml-service 独立服务器 43.156.25.197:9120（2C4G）
```

---

## 2. 生产部署拓扑

| 服务器 | 角色 | 承载 |
|---|---|---|
| `43.163.105.172`（新加坡·腾讯云，单机） | 主服务器 | 全部数据栈 + 区块链栈 + 8 个 HTTP MCP + nginx + admin + web |
| `43.156.25.197`（2C4G） | ML 推理机 | ml-service :9120（LightGBM/FinBERT/Kronos 三模型常开） |

- 服务管理：systemd（`infrax-*` 单元），代码位于 `/home/ubuntu/infraX-1/`，systemd 实际 WorkingDirectory 以 `systemctl cat <unit>` 为准
- 入口：nginx :80（`/api/v2/*` 分发到各服务；hub-index `/mcp/*`）；部分 HTTP MCP 端口（9108/9105/9103/9110/3011/3012/3013）直连受信方，未经 nginx
- 数据库：PostgreSQL（各服务独立库 `infrax_*`）+ data 侧 SQLite + Redis（session-key 分布式锁）

---

## 3. 微服务总览

| 端口 | 服务 | 域 | 数据库 | SDK | MCP |
|---|---|---|---|---|---|
| `:9112` | data | 数据 | SQLite | infrax-dk | hub-index data_* |
| `:9120` | ml-service | 数据 | — | infrax-dk / OpenAPI | hub-index ml_predictions |
| `:9113` | knowledge-injector | 数据 | — | — | hub-index injector_* |
| `:9721` | ragservicer | 数据 | — | lightrag-client / ragservicer-sdk | STDIO 5 工具 |
| `:9109` | waas | 链 | pocketx_waas | infrax-dk | wallet-mcp :9110 |
| `:9107` | vault | 链 | pocketx_vault | infrax-dk | vault-mcp :9108 |
| `:9104` | mpc | 链 | pocketx_mpc | infrax-dk / mpc-sdk | mpc-mcp :9105 |
| `:9102` | dc | 链 | pocketx_dc | infrax-dk / dc-sdk | dc-mcp :9103 |
| `:9101` | collector | 链 | pocketx_collector | infrax-dk / market-sdk | market-mcp :3013 |
| `:9130` | chain-rpc | 链 | — | infrax-dk / chain-rpc-sdk | chain-rpc-mcp :3012 |
| `:9132` | payments | 链 | pocketx_payments | infrax-dk / payments-sdk | wallet-mcp payment_* |
| `:3500` | session-key | 链 | session_key_engine | session-key-client | session-key-mcp :3011 |
| `:9131` | aa-relay | 链 | — | aa-sdk | — |
| `:3008` | hub-index | 数据·MCP | — | — | 13 工具 |
| `:9100` | admin | 平台 | — | — | — |

---

## 4. 数据栈微服务

### 4.1 data（:9112，infrax-data）

**职责**：行情/因子/宏观/ML 快照的聚合与对外数据面；多租户 key 签发中心（B-12-1）。

| 功能 | 端点 | 说明 |
|---|---|---|
| K 线 | `GET /api/data/bars` | OHLCV + 11 技术指标 + 外部因子，7 timeframe |
| 实时报价 | `GET /api/data/ticker` | crypto/美股/外汇/期货/A股/港股，返回 market_type |
| 因子 | `/api/data/factors/catalog` `current` `history` | 因子目录 / 最新值 / 逐 bar 时序（技术/宏观/链上） |
| 快照 | `GET /api/data/snapshots` | 27 类 provider/data_type（macro/onchain/defi/indices…） |
| ML 预测快照 | `GET /api/data/ml/predictions` | bolt/moirai/timesfm 预测（data 侧 30min 拉取落库） |
| 符号 | `/symbols` `symbols/search` `symbol/resolve` | 达标清单 / 模糊搜索（6 市场）/ 解析（BTC→BTCUSDT） |
| 券商策略 | `GET /api/data/policy/broker-market` | 默认 Binance |
| 宏观历史 | `GET /api/data/macro/history` | FRED 宏观时序 |
| 管理 | `/admin/status` `admin/config` `admin/symbols` `admin/api-keys*` | 采集器/熔断/新鲜度、key 热配置、交易对热管理、多租户 key 签发（`dx_`/`mx_`/`px_`/`vx_`/`mp_`/`cr_`/`wa_` 7 scope） |
| key 验证 | `POST /api/data/api-keys/verify` | 外部服务 key 实时校验（scope 匹配） |
| 用户级 key | `/api/v2/data/my-keys`（GET/POST/rotate/delete） | B-11-3 钱包签名自助签发（EIP-191 三头） |
| 统计/健康 | `/stats` `/health` `/metrics` `/docs` | 库统计 / Prometheus / OpenAPI |

**内部**：采集器拉取交易所 + ML 快照落库；`/api-keys/verify` 被 MCP 入站复用。

### 4.2 ml-service（:9120）

**职责**：三模型实时推理（LightGBM 树模型 / FinBERT 情绪 / Kronos 时间序列），独立 2C4G 机器。

| 功能 | 端点 | 说明 |
|---|---|---|
| 树模型 | `/ml/tree-predictions` | LightGBM 方向/概率 |
| 波动率 | `/ml/volatility` | Kronos 波动率预测 |
| 时序 | `/ml/bolt` `/ml/moirai` `/ml/timesfm` | 三时序模型统一 dict 输出 |
| 共识 | `/ml/consensus` | 多模型聚合 |
| 情绪 | `/ml/sentiment` | FinBERT 文本情绪 |
| 宏观特征 | `/ml/macro-features` | 宏观因子特征 |
| 缓存 | `/ml/cache/stats` | 缓存状态（免鉴权） |

> **性能改造（2026-08）**：异步化 + 缓存预热——缓存 miss 立即返回 `data=null`，后台计算 + 预热线程保缓存常满；生产场景优先走 data 快照。

### 4.3 knowledge-injector（:9113）

**职责**：将数据源注入知识图谱（每 6h 周期）。

| 功能 | 端点 | 说明 |
|---|---|---|
| 服务状态 | `GET /status` | 健康 |
| 注入触发 | `POST /inject` | 按 source 触发注入（写操作，后台任务） |
| 注入统计 | `GET /stats` | 注入统计 |

### 4.4 ragservicer（:9721，前缀 `/api/v1/`）

**职责**：LightRAG 实体-关系图谱 + 向量 + 关键词三路检索；多租户 namespace 隔离；知识注入。

| 功能 | 端点 | 说明 |
|---|---|---|
| 文档注入 | `POST /namespaces/{ns}/documents` `documents/batch` | 异步任务 |
| 文档列表/删除 | `GET /namespaces/{ns}/documents` `DELETE /documents/{doc_id}` | 分页 / 删除 |
| 图谱检索 | `POST /namespaces/{ns}/query` | mode: local/global/hybrid/nl/mix/naive |
| 纯检索 | `POST /namespaces/{ns}/retrieve` | top_k 上下文 |
| 任务状态 | `GET /namespaces/{ns}/tasks/{task_id}` | 注入进度 |
| 租户 | `/tenants` `/tenants/{id}/keys` | 租户 + key 签发（`lr_`） |
| 实例 | `GET /instances` | 图谱实例（生产 3 实例） |
| 管理 | `GET/PUT /admin/config` `GET /admin/tasks` | key 热配置 / 任务队列（Bearer admin） |
| OpenAPI | `GET /openapi.json` | 15 paths（豁免） |

---

## 5. 区块链栈微服务

### 5.1 waas（:9109，pocketx_waas）

**职责**：SaaS 多租户钱包基础设施（认证/钱包/交易/风控/事件回调/套餐/数据订阅）。

| 路由组 | 功能 | 鉴权 |
|---|---|---|
| `/api/v2/auth/*` | 登录（fail-closed）+ 支付密码 | login 公开；其余钱包签名 |
| `/api/v2/wallet/*` | 托管钱包 create/import/rpc/custom-token/balance/transactions/nfts/:chainId | ✅ 钱包签名 |
| `/api/v2/tx/*` | send/estimate-gas/sweep/batch/confirm·reject/status/pending | ✅ 钱包签名（batch 加 admin） |
| `/api/v2/risk/*` | 风控规则/黑名单 | ✅ |
| `/api/v2/events/*` `/webhooks/*` | 事件回调注册/列表 | 部分公开 |
| `/api/v2/dashboard/*` | 金库总览/统计 | ✅ + admin |
| `/api/v2/internal/*` | 内部管理（CWallet 回调等） | ✅ requireApiKey |
| `/api/v2/saas/*` | 租户 CRUD/apikey/提现/热钱包/tokens/addresses（27 路由） | ✅ requireTenantApiKey |
| `/api/v2/subscription/*` | 套餐 plans/subscribe/me/check/verify/cancel（MQ-12 支付意图化） | plans/callback 公开；其余登录 |
| `/api/v2/data/*` | 数据订阅 plans/subscribe/usage/key/docs（发 DC key） | ✅ 钱包签名 |

> 无 `register` 端点（邮箱注册在 mpc）；payment/mpc 路由已迁移 :9132（B-10-5）。

### 5.2 vault（:9107，pocketx_vault）

**职责**：Safe 多签保险库（创建/提案/确认/执行链上闭环 + owner 管理 + 风控）。

| 功能 | 端点 | 说明 |
|---|---|---|
| 金库总览 | `GET /api/vault/dashboard` | safe/tx/待签/规则数 |
| Safe 列表 | `GET /api/vault/safe/list` | 按 userId |
| 创建多签 | `POST /api/vault/safe/create` | body `{chainId, owners, threshold, name}` |
| 交易提案 | `POST /api/vault/safe/propose` | 创建提案 |
| 签名确认 | `POST /api/vault/safe/confirm` | EIP-191 验签 |
| 执行交易 | `POST /api/vault/safe/execute` | 阈值达成后执行 |
| 链上同步 | `POST /api/vault/safe/sync` | 同步链上状态 |
| 风控检查 | `POST /api/vault/risk/check` | 金额/链预检 |

### 5.3 mpc（:9104，pocketx_mpc）

**职责**：邮箱验证码 → 注册/恢复 MPC 密钥分片托管钱包（cggmp21 真 TSS）→ 会话解锁 → 签名/交易/合约 + MQ-16 按量计费。

| 功能 | 端点 | 说明 |
|---|---|---|
| 验证码 | `POST /api/v2/mpc/send-code` | 6 位随机，SMTP/console 下发 |
| 注册/恢复 | `POST /register` `/recover` | 邮箱+验证码 |
| 钱包状态 | `GET /status` `/wallets` | 状态 / 邮箱下全部钱包 |
| 会话 | `POST /session/unlock` `/lock` `GET /session/status` | token 30min TTL |
| 链上 | `/balance` `/sign-message` `/sign-typed-data` `/send-transaction` `/contract-read` `/contract-write` `/gas-estimate` `/sign-digest` | 签名/交易/合约（限额 0.1 ETH） |
| 计费（MQ-16） | `GET /plans` `POST /ledger-balance` | 费率表 / 账本余额 |

> TSS 签名：cggmp21，生产分片服务 :9200/9201，签名全程无完整私钥重建；TEE 硬件隔离延后。

### 5.4 dc（:9102，pocketx_dc）

**职责**：链上 DEX 数据（事件/统计/检查点/代币/链/跨链余额）+ MQ-16 数据订阅（T-1）。

| 功能 | 端点 | 说明 |
|---|---|---|
| 链上事件 | `GET /api/v2/data/events` | 按 chain/address/event_type |
| 统计/检查点 | `/stats` `/checkpoints` | 索引统计 / 扫描位点 |
| 代币/链 | `/tokens` `/chains` | 支持列表 |
| 跨链余额 | `GET /api/v2/data/balance` | `{address, chainBalances, total}` |
| 订阅（T-1） | `/plans` `/subscribe` `/payment-check` `/verify` `/usage` `/payment-callback` | x-wallet-address 鉴权，free 直通/付费 pending |

### 5.5 collector（:9101，pocketx_collector）

**职责**：5 链区块扫描器 + OKX ChainOS v6 行情数据面 + MQ-16 Market 订阅面（T-2）。

| 功能 | 端点 | 说明 |
|---|---|---|
| 行情查询 | `/api/v2/data/market/token-search` `token-info` `hot-tokens` `candles` `price` `trades` `token-advanced` `token-holders` `token-top-traders` `historical-candles` | Basic/Premium，月免 10 万次 |
| Meme+信号 | `/market/mempump/*`（list/details/devinfo/similar/bundle）`/signals` `/leaderboard` `/cluster-overview` | Premium |
| 免费接口 | `/market/balances` `token-balance` `supported-chains` `top-liquidity` `price-info` `index-price-history` `signal-chains` `leaderboard-chains` `cluster-list` `cluster-top-holders` | Free 无限制 |
| 订阅（T-2） | `/api/v2/market/plans` `checkout` `payment-check` `verify` `usage` | X-API-Key 识别 keyId，超限 503 |

### 5.6 chain-rpc（:9130）

**职责**：多链 RPC 网关（读/广播分级 key）+ MQ-16 RPC 订阅（T-3）。

| 功能 | 端点 | 说明 |
|---|---|---|
| 读 | `POST /v1/rpc/:chain` | eth_* 读白名单 + Solana get*；读 key（`rx_`/`cr_`） |
| 广播 | `POST /v1/broadcast/:chain` | eth_sendRawTransaction / Solana sendTransaction；**独立广播 key**，fail-closed |
| 状态 | `GET /v1/status` `/v1/health` | 池状态（脱敏）/ 健康 |
| 订阅（T-3） | `/v1/subscription/plans` `issue-key` `checkout` `payment-check` `verify` `usage` | issue-key 签发 `rx_` 读 key（X-Service-Key 管理操作） |
| WebSocket | `/v1/ws` | 实时推送 |

### 5.7 payments（:9132，pocketx_payments）

**职责**：通用支付引擎（chain/fiat/x402/MPP/batch/invite/transfer/period），独立实例自配凭证。

| 功能 | 端点 | 说明 |
|---|---|---|
| fiat checkout | `POST /payments/checkout` | Stripe 会话 |
| a2a | `POST /payments/a2a` `/a2a/settle` | 两阶段链上验 tx 入账 |
| 验付 | `POST /payments/verify` | txHash → 是否打到收款地址 |
| 账本 | `GET /payments/balance` | 账本余额 |
| 能力/价格 | `GET /capabilities` `/price` | 能力探测 / 套餐定价 |
| period | `POST /period/charge` | 订阅周期扣费 |
| batch（MQ-16） | `/batch` `/batch/settle` `/batch?batchId=` `/batch/cancel` | 批量收款 |
| invites（MQ-16） | `/invites`（create/list/get/cancel/settle/pay） | 账单邀请 |
| transfers（MQ-16） | `/transfers`（create/list/get/confirm/cancel） | 账本内部转账 |
| MPP | `/mpp/open` `voucher` `topup` `settle` `close` `session` | 状态通道 |

> **接入模型**：一个实例 = 一套收款，钱进 B 端自己账户；平台 `:9132` 为自用实例（服务订阅激活），不代 B 端收钱。响应为**裸 JSON**（非信封）。

### 5.8 session-key（:3500，session_key_engine）

**职责**：EIP-712 授权签名 → 会话密钥托管 → 白名单额度内代执行交易（Fastify + PG + Redis 锁）。

| 功能 | 端点 | 说明 |
|---|---|---|
| nonce | `GET /api/v1/nonce` | 一次性 EIP-712 签名 nonce（15min TTL） |
| 会话 | `POST/GET /api/v1/sessions` `GET/DELETE /:id` | 创建/列表/详情/撤销 |
| 执行 | `POST /api/v1/execute` | 合约白名单 + 函数选择器 + 三重额度校验 |
| 健康 | `GET /api/v1/health` | 豁免 |

### 5.9 aa-relay（:9131，@0xinfrax/aa-sdk）

**职责**：ERC-4337 UserOp 中继（Kernel v3 + EntryPoint v0.7）+ 链上 session + Paymaster 代理 + AA 计费。

| 功能 | 端点 | 说明 |
|---|---|---|
| UserOp | `POST /v1/userops` `GET /v1/userops/:hash` | 提交（eth_sendUserOperation）/ 状态 |
| 预估 | `POST /v1/estimate` | gas 预估 |
| Paymaster | `POST /v1/paymaster` | 代理（apikey 服务端注入，未配 URL → 503） |
| 链上 session | `POST/GET /v1/session` `POST /session/disable` `POST /session/validate` | 创建/查询/禁用/校验 |
| 计费 | `GET /v1/plans` `POST /v1/ledger-balance` | 套餐（公开）/ 账本余额 |

> E2E 12/12 全绿（aa-session-e2e.ts）；OxaChain Pimlico bundler 为 v0.6 协议 → E2E 走 handleOps 直连交易绕过（v0.7 bundler 自建待办）。

---

## 6. MCP 层（8 HTTP + 1 STDIO）

| MCP | 端口 | 工具数 | 后端 |
|---|---|---|---|
| hub-index（统一入口） | 3008 | 13 | data/injector/ragservicer |
| vault-mcp | 9108 | 13 | vault :9107 |
| mpc-mcp | 9105 | 17 | mpc :9104 |
| session-key-mcp | 3011 | 7 | session-key :3500 |
| dc-mcp | 9103 | 11 | dc :9102 |
| wallet-mcp | 9110 | 34 | waas :9109 + payments :9132 |
| chain-rpc-mcp | 3012 | 10 | chain-rpc :9130 |
| market-mcp | 3013 | 18 | collector :9101 |
| LightRAG STDIO | — | 5 | ragservicer :9721 |

**入站鉴权**：全部挂 `inboundAuth`（mcp-auth.ts）——`MCP_API_KEY` 白名单（timingSafeEqual）或 data 签发 `mx_` key 经 `/api-keys/verify` 实时校验；header 三选一 `Authorization: Bearer`/`X-API-Key`/`X-Service-Key`；豁免 `/health` `/`。**出站**：各 MCP 携带对应 bridge key 调后端（VAULT_API_KEY/MPC_API_KEY/…）。

---

## 7. SDK 层（npm 8 包 + PyPI 2 包）

| 包 | 版本 | 覆盖 |
|---|---|---|
| `@0xinfrax/infrax-dk` | 0.7.1 | 统一入口：data/ml/vault/mpc/wallet/dc/market/chainRpc/payment/saas/sub + 订阅面（14 API 类） |
| `@0xinfrax/waas-sdk` | 0.1.0 | wallet+safe+saas+sub |
| `@0xinfrax/vault-sdk` | 0.1.0 | vault |
| `@0xinfrax/dc-sdk` | 0.1.0 | dc（含订阅） |
| `@0xinfrax/market-sdk` | 0.1.0 | market（数据+订阅） |
| `@0xinfrax/chain-rpc-sdk` | 0.1.0 | chainRpc（读/广播/订阅） |
| `@0xinfrax/payments-sdk` | 0.1.0 | payment（引擎 15+订阅） |
| `@0xinfrax/data-sdk` | 0.1.0 | data+ml |
| `@0xinfrax/mpc-sdk` | 0.3.0 | MPC 16 方法（钱包/会话/链上），E2E 22/22 |
| `@0xinfrax/session-key-{core,client,evm,server}` | 0.2.0/0.1.x | Session Key + `Aa`（aa-sdk 并入） |
| `lightrag-client`（PyPI） | 2.0.0 | LightRAG |
| `infra-data-client`（PyPI） | 0.2.0 | DATA |

---

## 8. 统一鉴权体系（B-12-1 / B-11-3）

1. **统一 key**：data `POST /admin/api-keys` 签发（body `{scope,label}`，需 `ADMIN_API_KEY`），前缀按 scope：`dx_`(data)/`mx_`(mcp)/`px_`(payment)/`vx_`(vault)/`mp_`(mpc)/`cr_`(chain-rpc)/`wa_`(waas)；chain-rpc 订阅另签发 `rx_`。bridge key（`.env` 注入）等价。
2. **三选一 header**：`Authorization: Bearer <key>` / `X-API-Key: <key>` / `X-Service-Key: <key>`。
3. **钱包签名（B-11-3）**：waas 写操作 + data 用户级 key 要求 `x-wallet-address`/`x-wallet-signature`/`x-wallet-timestamp`（EIP-191 消息 `InfraX auth: <ts>`，24h TTL 缓存）。
4. **豁免**：各服务 `/health`；公开端点（plans 目录、payment-callback、nonce 等）按需。

---

## 9. 关键数据流

```
行情/因子：交易所 → data 采集器 → SQLite → REST/SDK/MCP 数据面
ML 预测：ml-service 推理 → data 30min 快照 → ml_predictions → hub-index
知识图谱：injector(6h) → ragservicer 图谱 → query/retrieve → hub-index STDIO
钱包创建：mpc register(邮箱+验证码) → TSS 分片 :9200/9201 → 钱包地址
签名/交易：session unlock → token → sign/send → 链上广播
订阅支付：subscribe(rail) → pending → [fiat webhook | chain 轮询 | x402 verify] → active
UserOp：agent → aa-relay /v1/userops → EntryPoint v0.7 → Kernel v3 账户
```

---

## 10. 外部阻塞与延后项（截至 2026-08-12）

| 事项 | 状态 |
|---|---|
| A-4 Paymaster 对接 | 物料清单已定稿待发送，收到 InfraX 回传后闭环（EntryPoint v0.7 验证 → 配 `AA_OXACHAIN_PAYMASTER_URL` → E2E） |
| B-2 Alto executor 充值 | 运营操作：向 executor 转 ≥1 OXA，随后 aa-relay 生产 E2E |
| x402 rail 凭证 | 各 B 端实例自配凭证启用（平台只提供通道与工具） |
| 9.6 Phase 1/2.1~2.3/3 | DC 事件分类（未排期）/ TEE 钱包（延后，待环境审批）/ 多市场发布（未排期） |
| v0.7 bundler 自建 | OxaChain bundler 升级后 UserOp 走 eth_sendUserOperation（当前 E2E 走 handleOps） |
