# InfraX 接入文档 — API / MCP / SDK

> 版本 `v0.7.0-20260811` | 最后更新 2026-08-11 | GitHub: [sftgroup/infraX](https://github.com/sftgroup/infraX)

## 概述

InfraX 提供三种接入方式，覆盖同一套后端能力，API 合约完全一致：

| 方式 | 适用场景 | 协议 |
|------|---------|------|
| **REST API** | 传统后端集成、自定义客户端 | HTTP JSON |
| **MCP Server** | AI Agent（Claude/OpenClaw/Cursor）直接调用 | JSON-RPC (SSE/HTTP) |
| **JS SDK** | Node.js / 前端项目快速集成 | TypeScript |

```
┌──────────────────────────────────────────────────────────────┐
│                         客户端                                │
│   REST API  │  MCP (AI Agent)  │  JS SDK                     │
└────────────┬────────────────────┬────────────────────────────┘
             │                    │
        ┌────▼────┐         ┌─────▼──────────────────────────┐
        │ Web :80 │         │ MCP Servers                     │
        │ (proxy) │         │ :9103 DC / :9105 MPC            │
        └────┬────┘         │ :9108 Vault / :9110 Wallet      │
             │              │ :3011 Session Key / :3012 RPC   │
             │              │ :3013 Market                    │
             │              └─────┬──────────────────────────┘
             │                    │
    ┌────────┼────────┬───────────┼──────────┬──────────────┐
    ▼        ▼        ▼           ▼          ▼              ▼
  WAAS    Vault     DC          MPC      Collector   Session Key
  :9109   :9107    :9102        :9104     :9101         :3500
```

## 服务端口总览

| 端口 | 服务 | 数据库 | 描述 |
|------|------|--------|------|
| `:80` | Web Proxy | — | Nginx 反向代理，统一入口 |
| `:3500` | Session Key Engine | session_key_engine | 跨项目自动化授权代签 |
| `:6003` | MPC 内部 | infrax_mpc | Agent Wallet 托管 |
| `:9101` | Collector | infrax_collector | 5 链区块扫描器 + **Market 套餐订阅面（MQ-16 T-2）** |
| `:9102` | DC (数据中心) | infrax_dc | 链上数据查询 + **数据订阅（MQ-16 T-1）** |
| `:9104` | MPC | infrax_mpc | 钱包托管 + **按量计费（MQ-16 T-4）** |
| `:9107` | Vault | infrax_vault | Safe 多签保险库 |
| `:9109` | WAAS | infrax_waas | B2B 钱包即服务 |
| `:9130` | Chain RPC | — | 链 RPC 网关 + **RPC 套餐订阅（MQ-16 T-3）**（公网入口 `rpc-gw.0xainet.top`，RPC-1） |
| `:9132` | **Payments（通用支付引擎）** | infrax_payments | chain/fiat/x402/MPP + **batch/invite/transfer（MQ-16 T-5）** |
| `:9103` | DC MCP | — | AI Agent 数据 |
| `:9105` | MPC MCP | — | AI Agent 钱包 |
| `:9108` | Vault MCP | — | AI Agent 多签 |
| `:9110` | Wallet MCP | — | AI Agent WAAS + 支付 |
| `:3011` | Session Key MCP | — | AI Agent 授权 |
| `:3012` | RPC MCP | — | AI Agent 链网关 |
| `:3013` | Market MCP | — | AI Agent 行情 + 订阅 |

> ~~`:9106` Payment（旧支付）~~ 已下线（MQ-15 T-7，代码保留 git 历史）；~~`:9111` Session Key MCP~~ 实际为 Web :9111（session-key MCP 现为 :3011）。

### Web Proxy 路由（`server.js`）

```
/api/v2/admin    → :9100 (Admin)
/api/v2/data     → :9102 (DC)
/api/v2/market   → :9101 (Collector)   ← MQ-16 新增（2026-08-11）
/api/v2/mpc      → :9104 (MPC)
/api/v2/wallet   → :9109 (WAAS)
/api/v2/waas     → :9109 (WAAS)
/api/v2/saas     → :9109 (WAAS)
/api/v2/vault    → :9107 (Vault)
/api/vault       → :9107 (Vault)
```

---

## 一、REST API

### 基础信息

```
Base URL:  https://infrax.0xainet.top
```

### 认证

#### 统一 Key 体系（B-12-1，2026-08-08 起）

平台签发 key 按 scope 前缀区分，`data POST /admin/api-keys` 签发（body `{scope, label}`，需 `ADMIN_API_KEY`；`GET /admin/api-keys` 列表/`POST /admin/api-keys/{id}/rotate` 轮换/`DELETE` 删除；`POST /api-keys/verify` 验证）：

| 前缀 | scope | 用途 |
|---|---|---|
| `dx_` | data | data 业务端点（行情/因子/ML） |
| `mx_` | mcp | MCP 入站（8 个 HTTP MCP 通用） |
| `px_` | payment | payments 通用支付引擎 |
| `vx_` | vault | vault 服务 |
| `mp_` | mpc | mpc 服务 |
| `cr_` | chain-rpc | chain-rpc 网关（读/广播） |
| `wa_` | waas | waas 服务 |

> `rx_` 读 key 由 chain-rpc 订阅面 `POST /v1/subscription/issue-key` 自行签发（X-Service-Key 管理操作）。各服务另支持 `.env` bridge key（`VAULT_API_KEY`/`MPC_API_KEY`/`WAAS_API_KEY`/…）作为服务间调用等价凭据。

#### Header 约定

| Header | 用途 | 模块 |
|--------|------|------|
| `x-api-key` / `Authorization: Bearer <key>` / `X-Service-Key: <key>` | **三选一**统一鉴权（平台签发 key 或 bridge key） | 全部 |
| `x-wallet-address` | 钱包地址（只读查询自动发送） | 全部 |
| `x-wallet-signature` | EIP-191 签名（消息 `InfraX auth: <ts>`） | WAAS 写操作 |
| `x-wallet-timestamp` | 签名时间戳（毫秒 UTC，24h TTL） | WAAS 写操作 |
| `x-dc-api-key` | DC 数据订阅 API Key | DC |
| `x-rpc-key` | chain-rpc `rx_` 读 key | chain-rpc |

> **WAAS 钱包签名鉴权（B-11-3）**：`/api/v2/wallet/*`、`/api/v2/tx/*` 需三头齐备（`x-wallet-address`/`x-wallet-signature`/`x-wallet-timestamp`），服务端按地址缓存 24h（同地址 24h 内仅需签一次）；缺任一返回 401。SDK 自 0.5.1 支持 `walletAddress`+`walletSign` 自动生成（见 SDK_INTEGRATION §2.3）。

### 响应格式

```json
{ "code": 0, "message": "ok", "data": { ... } }
```

---

### 🔐 MPC — Agent Wallet (`:6003` / `:9104`)

#### 钱包管理

| 方法 | 端点 | 描述 |
|------|------|------|
| `POST` | `/api/v2/mpc/send-code` | 发送邮箱验证码 |
| `POST` | `/api/v2/mpc/register` | 注册 MPC 钱包（需验证码） |
| `POST` | `/api/v2/mpc/recover` | 恢复 MPC 钱包（需验证码） |
| `GET` | `/api/v2/mpc/status` | 查询钱包注册状态 |

#### Agent Wallet 会话管理

| 方法 | 端点 | 描述 |
|------|------|------|
| `POST` | `/api/v2/mpc/session/unlock` | 验证码解锁 → session token（30min TTL） |
| `POST` | `/api/v2/mpc/session/lock` | 销毁 session token |
| `GET` | `/api/v2/mpc/session/status?token=xxx` | 查询会话状态 |

**流程**: `unlock(email, code)` → `token` → 所有后续操作只传 `token`

#### Agent Wallet 操作（需 session token）

| 方法 | 端点 | 描述 |
|------|------|------|
| `POST` | `/api/v2/mpc/balance` | 查询余额（原生 + ERC20） |
| `POST` | `/api/v2/mpc/sign-message` | EIP-191 签名 |
| `POST` | `/api/v2/mpc/sign-typed-data` | EIP-712 签名 |
| `POST` | `/api/v2/mpc/send-transaction` | 转账（ETH/ERC20，限额 0.1 ETH） |
| `POST` | `/api/v2/mpc/contract-read` | 合约只读调用 |
| `POST` | `/api/v2/mpc/contract-write` | 合约写（模拟 → 签名 → 广播） |
| `POST` | `/api/v2/mpc/gas-estimate` | Gas 估算 |
| `POST` | `/api/v2/mpc/sign-digest` | raw 32-byte digest 签名（2026-08-12 补录，body `{token, digest}`） |

---

### 💰 WAAS — 钱包即服务 (`:9109`)

| 方法 | 端点 | 描述 |
|------|------|------|
| `POST` | `/api/v2/saas/tenants` | 创建租户 |
| `GET` | `/api/v2/saas/tenants/my` | 查询租户 |
| `POST` | `/api/v2/saas/tenants/activate` | 激活租户 |
| `POST` | `/api/v2/saas/address` | 分配存款地址 |
| `POST` | `/api/v2/saas/addresses` | 批量分配地址 |
| `GET` | `/api/v2/saas/addresses` | 查询地址 |
| `POST` | `/api/v2/saas/sweep` | 触发归集 |
| `POST` | `/api/v2/saas/tenants/:id/apikey` | 生成 API Key |
| `POST` | `/api/v2/saas/tenants/:id/apikey/rotate` | 轮换 API Key |
| `DELETE` | `/api/v2/saas/tenants/:id/apikey` | 删除 API Key |
| `POST` | `/api/v2/saas/tenants/:id/hot-wallet` | 生成热钱包 |
| `GET` | `/api/v2/saas/withdrawals` | 提现队列 |
| `GET` | `/api/v2/wallet/balance` | 查询余额 |
| `POST` | `/api/v2/wallet/send` | 发送交易 |
| `POST` | `/api/v2/wallet/simulate` | 估算 Gas |
| `POST` | `/api/v2/wallet/rpc` | RPC 代理 |

---

### 🏦 Vault — 多签保险库 (`:9107`)

| 方法 | 端点 | 描述 |
|------|------|------|
| `GET` | `/api/vault/dashboard` | 金库总览 |
| `GET` | `/api/vault/safe/list` | 列表 |
| `POST` | `/api/vault/safe/create` | 创建多签 |
| `POST` | `/api/vault/safe/propose` | 创建交易提案 |
| `POST` | `/api/vault/safe/confirm` | 签名确认 |
| `POST` | `/api/vault/safe/execute` | 执行交易 |
| `POST` | `/api/vault/safe/sync` | 同步链上 |
| `POST` | `/api/vault/risk/check` | 风控检查 |

---

### 📡 DC — 链上数据中心 (`:9102`)

| 方法 | 端点 | 描述 |
|------|------|------|
| `GET` | `/api/v2/data/events` | 链上事件 |
| `GET` | `/api/v2/data/stats` | 统计 |
| `GET` | `/api/v2/data/checkpoints` | 扫描位点 |
| `GET` | `/api/v2/data/tokens` | 代币列表 |
| `GET` | `/api/v2/data/chains` | 链列表 |
| `GET` | `/api/v2/data/balance` | 跨链余额 |

#### DC 数据订阅（MQ-16 T-1，`x-wallet-address` 鉴权）

| 方法 | 端点 | 描述 |
|------|------|------|
| `GET` | `/api/v2/data/plans` | 套餐目录（公开） |
| `POST` | `/api/v2/data/subscribe` | 订阅（body `{planId, rail}`；免费直接激活返回 dcApiKey，付费返回 pending） |
| `POST` | `/api/v2/data/payment-check` | 轮询支付状态 |
| `POST` | `/api/v2/data/verify` | x402 确认（`{txHash}`，payer 匹配钱包） |
| `GET` | `/api/v2/data/usage` | 订阅用量（plan/quota/日聚合） |
| `POST` | `/api/v2/data/payment-callback` | 支付回调 webhook（HMAC 验签） |

### 📈 Market 行情订阅（Collector `:9101`，MQ-16 T-2）

经 Web Proxy `/api/v2/market/*` 路由（2026-08-11 新增）。数据面 `/api/v2/data/market/*` 见 §1.6。

| 方法 | 端点 | 描述 |
|------|------|------|
| `GET` | `/api/v2/market/plans` | 套餐目录（公开） |
| `POST` | `/api/v2/market/checkout` | 订阅（body `{plan_id, rail, subscriber?}`；X-API-Key 识别 keyId） |
| `POST` | `/api/v2/market/payment-check` | 轮询支付状态 |
| `POST` | `/api/v2/market/verify` | x402 确认（`{txHash}`） |
| `GET` | `/api/v2/market/usage` | 订阅用量 |

> 超限返回 **503**；`x-api-key` 为签发 key。

### 🔑 Chain RPC 套餐订阅（`:9130`，MQ-16 T-3）

| 方法 | 端点 | 描述 |
|------|------|------|
| `GET` | `/v1/subscription/plans` | 套餐目录（公开） |
| `POST` | `/v1/subscription/issue-key` | 签发 `rx_` 读 key（管理操作，X-Service-Key） |
| `POST` | `/v1/subscription/checkout` | 订阅（body `{plan_id, rail, subscriber?}`；`rx_` key 鉴权） |
| `POST` | `/v1/subscription/payment-check` | 轮询支付状态 |
| `POST` | `/v1/subscription/verify` | x402 确认（`{txHash}`） |
| `GET` | `/v1/subscription/usage` | 订阅用量 |

> 信封 `{code, message, data}`；超限返回 **503**。`rx_` key 由 issue-key 签发，读/广播分级。

### 🌐 rpc-gw 公网 HTTPS 入口（`https://rpc-gw.0xainet.top`，RPC-1）

> 2026-08-13 交付：chain-rpc 网关 `:9130` 的公网入口（nginx TLS 反代，certbot 自动续期，客户端体上限 2m）。
> **鉴权透传**：`X-API-Key`（或 `Authorization: Bearer`）原样转发至 chain-rpc，契约与内网一致（`rx_` 读 key / `bx_` 广播 key 双轨；广播 key 另一形态 = data 签发 scope=`rpc_broadcast`）。

| 路由 | 方法 | 功能 | 鉴权 |
|------|------|------|------|
| `/v1/rpc/{chain}` | POST | 任意 JSON-RPC 代理（**内容协商 RPC-9**：body 含 `jsonrpc:"2.0"` 自动标准 JSON-RPC 透传——ethers/viem 零改动直连；无 `jsonrpc` 字段走信封；`X-Json-Rpc: raw` 强制标准；batch ≤100 条） | ✅ 读 key（`rx_`） |
| `/v1/broadcast/{chain}` | POST | 广播交易（读 key 无法触达；标准 body `eth_sendRawTransaction` → `{jsonrpc,result}`） | ✅ 广播 key（`bx_`） |
| `/v1/ws` | WS | WebSocket（仅 eth_subscribe/unsubscribe，upgrade 支持） | ✅ 读 key |
| `/v1/subscription/*` | — | RPC 套餐订阅面（plans / issue-key / checkout / payment-check / verify / usage） | ✅ `rx_` key |
| `/v1/status` `/v1/plans` `/v1/planinfo` `/health` | GET | 公开元信息（免鉴权） | — |

> 其余路径透传 `:9130`；HTTP read timeout 60s，WS 3600s。

---

### 💳 Payment — 通用支付引擎 @0xinfrax/payments (`:9132`，MQ-15 T-8 迁移；旧 `:9106 /api/v2/payment/*` 已下线)

> **接入方式（2026-08-11 决策）**：通用支付 = **独立实例 + 自配凭证**。每个 B 端（调用方）自行部署/嵌入 `@0xinfrax/payments`（npm 已发布），在**自己的实例**里配置自己的收款凭证（chain `SubscriptionManager` 合约 / `STRIPE_SECRET_KEY` / `X402_PAY_TO` / `MPP_PAYEE`）——**一个实例 = 一套收款**，钱进 B 端自己的账户（x402 打到你的钱包、Stripe 进你的账号）。平台 `:9132` 仅为**平台自用实例**（配平台自身凭证，服务 waas/dc 订阅激活），不代 B 端收钱。完整接入模板（收款配置全景 / 嵌入式 / 独立服务 / 自检清单）见 `projects/payments/CALLER_SETUP.md`；以下 SDK 用法面向平台实例的消费方。

SDK 用法：`ix.payment.checkout() / a2a() / a2aSettle() / verify() / balance() / capabilities() / price()`（需配置 `paymentsUrl` + `paymentsApiKey`）。**响应为裸 JSON**（非信封）。

| 方法 | 端点 | 描述 |
|------|------|------|
| `POST` | `/payments/checkout` | Stripe fiat checkout（创建支付会话，返回 sessionUrl） |
| `POST` | `/payments/a2a` | a2a 收款意图（返回 paymentId，链上/账本支付） |
| `POST` | `/payments/a2a/settle` | 提交链上 txHash 结算（x402 验证 + 记账） |
| `POST` | `/payments/verify` | 链上支付验证（txHash → 是否打到平台收款地址） |
| `GET` | `/payments/balance?address=` | 账本余额 |
| `GET` | `/payments/capabilities` | 引擎能力探测 |
| `GET` | `/payments/price?planId=` | 链上套餐定价 |
| `POST` | `/payments/period/charge` | 订阅周期扣费（period 能力） |

#### batch 批量收款（MQ-16，batch 能力）

| 方法 | 端点 | 描述 |
|------|------|------|
| `POST` | `/payments/batch` | 创建批量收款意图（一次多 payee） |
| `POST` | `/payments/batch/settle` | 结算单笔 item（提交链上 txHash） |
| `GET` | `/payments/batch?batchId=` | 查询 batch 状态 |
| `POST` | `/payments/batch/cancel` | 取消 batch（未支付 items） |

#### invites 账单邀请（MQ-16，invite 能力）

| 方法 | 端点 | 描述 |
|------|------|------|
| `POST` | `/payments/invites` | 创建账单邀请（payer → payee） |
| `GET` | `/payments/invites?address=&role=` | 列出邀请（role: payer\|payee） |
| `GET` | `/payments/invites/:inviteId` | 邀请详情 |
| `POST` | `/payments/invites/:inviteId/cancel` | 取消未结算邀请 |
| `POST` | `/payments/invites/:inviteId/settle` | 链上结算（提交 payer txHash） |
| `POST` | `/payments/invites/:inviteId/pay` | 账本支付（payer ledger 扣款） |

#### transfers 账本内部转账（MQ-16，transfer 能力）

| 方法 | 端点 | 描述 |
|------|------|------|
| `POST` | `/payments/transfers` | 发起账本转账 |
| `POST` | `/payments/transfers/:transferId/confirm` | 确认并执行（原子入账） |
| `GET` | `/payments/transfers?address=&role=` | 列出转账（role: from\|to） |
| `GET` | `/payments/transfers/:transferId` | 转账详情 |
| `POST` | `/payments/transfers/:transferId/cancel` | 取消未执行转账 |

> SDK 0.6.0：`batchCreate/batchSettle/batchGet/batchCancel`、`inviteCreate/inviteList/inviteGet/inviteCancel/inviteSettle/invitePay`、`transferCreate/transferList/transferGet/transferConfirm/transferCancel`。

---

### 🔑 Session Key Engine (`:3500`) — v0.1.0 新增

跨项目自动化交易授权引擎。用户一次 EIP-712 签名授权，Session Key 在有效期内自动代签交易。

#### 核心流程

```
1. GET  /api/v1/nonce?user=0x...          → 获取 EIP-712 签名 nonce
2. 用户在主钱包中签名 message
3. POST /api/v1/sessions                   → 创建 Session Key（返回 sessionAddress）
4. POST /api/v1/execute                    → 有效期内自动代签交易
5. DELETE /api/v1/sessions/:id             → 手动撤销
```

#### 端点

| 方法 | 端点 | Auth | 描述 |
|------|------|:---:|------|
| `GET` | `/api/v1/nonce?user=0xUser` | — | 获取一次性签名 nonce（15 分钟 TTL） |
| `POST` | `/api/v1/sessions` | — | 创建 Session Key（需 EIP-712 签名） |
| `GET` | `/api/v1/sessions?user=0x...` | Bearer | 列出用户所有 Session |
| `GET` | `/api/v1/sessions/:id` | Bearer | 查询单个 Session 详情 |
| `DELETE` | `/api/v1/sessions/:id` | Bearer | 撤销 Session Key |
| `POST` | `/api/v1/execute` | Bearer | 通过 Session Key 执行交易 |
| `GET` | `/api/v1/health` | — | 健康检查 |

#### Create Session 请求体

```json
{
  "signature": "0x...",
  "chain": "eth",
  "permissions": {
    "contracts": ["0xUniswapRouter"],
    "functions": ["0xa9059cbb"]
  },
  "validDays": 30,
  "maxPerTx": "1000",
  "maxTotal": "10000",
  "userAddress": "0xUserWallet",
  "nonce": "abc123..."
}
```

#### Execute 请求体

```json
{
  "sessionId": "uuid",
  "chain": "eth",
  "to": "0xContract",
  "data": "0xencodedCallData",
  "value": "0",
  "gasLimit": "200000"
}
```

#### 安全机制

- **合约白名单** — permissions.contracts 精确校验
- **函数选择器白名单** — 4-byte selector 级粒度
- **三重额度** — 单笔/累计/总额度
- **私钥加密** — AES-256-GCM，密钥环境变量注入
- **分布式锁** — Redis 防并发执行
- **Nonce 防重放** — 15 分钟 TTL，一次性消费

---

### 1.6 行情市场 API（Collector /market/*）

> okxMarket v6 — 所有 /market/* 路由使用 `x-api-key` 认证

#### 行情查询（Basic/Premium tier，月免10万次）

```
GET  /api/v2/data/market/token-search     ?keyword=&chainIndex=&limit=
GET  /api/v2/data/market/token-info       ?chainIndex=&tokenAddress=
GET  /api/v2/data/market/hot-tokens       ?chainIndex=&rankingType=&rankingTimeFrame=&rankBy=&limit=
GET  /api/v2/data/market/candles          ?chainIndex=&tokenAddress=&period=&limit=
GET  /api/v2/data/market/price            ?chainIndex=&tokenAddress=
GET  /api/v2/data/market/trades           ?chainIndex=&tokenAddress=&limit=
GET  /api/v2/data/market/token-advanced   ?chainIndex=&tokenAddress=
GET  /api/v2/data/market/token-holders    ?chainIndex=&tokenAddress=&limit=
GET  /api/v2/data/market/token-top-traders ?chainIndex=&tokenAddress=
GET  /api/v2/data/market/historical-candles ?chainIndex=&tokenAddress=&period=&limit=
```

#### Meme 币 + 信号（Premium tier）

```
GET  /api/v2/data/market/mempump/list     ?chainIndex=&protocol=&sortBy=&limit=
GET  /api/v2/data/market/mempump/details  ?chainIndex=&tokenAddress=
GET  /api/v2/data/market/mempump/devinfo  ?chainIndex=&tokenAddress=
GET  /api/v2/data/market/mempump/similar  ?chainIndex=&tokenAddress=
GET  /api/v2/data/market/mempump/bundle   ?chainIndex=&tokenAddress=
GET  /api/v2/data/market/signals          ?chainIndex=&signalType=&limit=
GET  /api/v2/data/market/leaderboard      ?chainIndex=&leaderboardType=&limit=
GET  /api/v2/data/market/cluster-overview ?chainIndex=&tokenAddress=
```

#### 免费接口（Free tier, 无限制）

```
GET  /api/v2/data/market/balances         ?address=&chains=
GET  /api/v2/data/market/token-balance    ?address=&chainIndex=&tokenAddress=
GET  /api/v2/data/market/balance-total    ?address=&chains=
GET  /api/v2/data/market/transactions     ?address=&chains=&limit=
GET  /api/v2/data/market/transaction-detail ?chainIndex=&txHash=
GET  /api/v2/data/market/index-price      ?chainIndex=&tokenAddress=
GET  /api/v2/data/market/portfolio-overview ?address=&chains=
GET  /api/v2/data/market/portfolio-pnl    ?address=&chains=&limit=
GET  /api/v2/data/market/portfolio-dex-history ?address=&chains=&limit=
```

#### 热榜筛选示例

```bash
# 过去24小时按净流入排名
curl -H "x-api-key: YOUR_KEY" \
  "https://infrax.0xainet.top/api/v2/data/market/hot-tokens?chainIndex=1&rankingTimeFrame=4&rankBy=14&limit=20"

# Pump.fun 协议 Meme 币
curl -H "x-api-key: YOUR_KEY" \
  "https://infrax.0xainet.top/api/v2/data/market/mempump/list?chainIndex=501&protocol=120596&sortBy=volume24h"
```

#### DEX 策略数据（`/api/v2/data/market/dex/*`，2026-08-21 上线，dx_ key 权限）

> 数据层（R1-R10，见 `docs/requirements-infrax-dex-data.md`）：OKX OnchainOS v6 + DexScreener 双源聚合，链枚举 `ETH/BSC/BASE/SOL`，信封 `{code, message, data}`。
> 上游限制：OKX `token/toplist` 仅支持 sortBy∈{2,5,6}（trending=volume、x_mentions=按 txs 排序）；`trades`/`top-liquidity`/OKX `search` 为 x402 付费端点 → 自动降级 `{items:[], paymentRequired:true}`。

```
GET  /api/v2/data/market/dex/hot-tokens      ?source=all|okx|dexscreener&chain=ETH&ranking=trending|x_mentions&limit=
GET  /api/v2/data/market/dex/token           ?chain=ETH&address=
GET  /api/v2/data/market/dex/token/history   ?chain=ETH&address=&hours=24   # 画像快照历史序列（5min 粒度，新增 2026-08-21）
GET  /api/v2/data/market/dex/search          ?keyword=&chain=&limit=
GET  /api/v2/data/market/dex/signal          ?chain=&limit=
GET  /api/v2/data/market/dex/holders         ?chain=&address=&limit=
GET  /api/v2/data/market/dex/liquidity       ?chain=&address=
GET  /api/v2/data/market/dex/top-traders     ?chain=&address=
GET  /api/v2/data/market/dex/trades          ?chain=&address=&limit=
```

```bash
# 热门代币（OKX volume 榜）
curl -H "x-api-key: YOUR_KEY" \
  "https://infrax.0xainet.top/api/dex/hot-tokens?source=okx&chain=ETH&ranking=trending&limit=10"

# 单币画像（行情+社交+风险+池+持有者）
curl -H "x-api-key: YOUR_KEY" \
  "https://infrax.0xainet.top/api/dex/token?chain=ETH&address=0x4485dc2bb0eb690b91ad9ae5b7285789b168764d"

# 单币历史序列（价格/市值/持有者多时间窗，5min 粒度）
curl -H "x-api-key: YOUR_KEY" \
  "https://infrax.0xainet.top/api/dex/token/history?chain=ETH&address=0x4485dc2bb0eb690b91ad9ae5b7285789b168764d&hours=24"
```

> 网关路径：`https://infrax.0xainet.top/api/dex/*`（web/server.js 代理 → collector `/api/v2/data/market/dex/*`）。

### 1.7 行情 RPC（`POST /v1/market-rpc`，A-12，Collector `:9101`）

> 2026-08-15 交付：与 chain-rpc `/v1/rpc/:chain` 并列的**网关层行情入口**，12 组方法 + 多 token 批量 + 信封 `{code, message, data}`。
> **鉴权**：`X-API-Key`（或 `Authorization: Bearer` / `X-Rpc-Key`）→ `rx_` 读 key（chain-rpc `rpc_keys` 表 SHA-256 校验）；兼容 collector 既有 `pkx_` api_keys。
> 同源同缓存（A-13）：与 REST MarketAPI 同一 OKX Market client 单例，口径一致。

```
POST /v1/market-rpc
Content-Type: application/json
X-API-Key: rx_...

{ "method": "tokenSearch", "params": { "keyword": "USDT", "chainIndex": "1", "limit": 20 } }
```

| 方法 | 必填参数 | 可选参数 | 说明 |
|------|---------|---------|------|
| `tokenSearch` | `keyword` | `chainIndex`, `limit`（默认 20） | 关键词搜索代币 |
| `tokenInfo` | `chainIndex` + `tokenAddress` 或 `tokens[]` | — | 代币基本信息 |
| `hotTokens` | `chainIndex` | `limit`（默认 50），其余透传 | 热榜代币 |
| `leaderboard` | `chainIndex` | `sortBy`（默认 1=pnl）, `timeFrame`（默认 4=24h）, `limit`（默认 50） | 排行榜 |
| `signals` | `chainIndex` | `signalType`, `limit`（默认 50）, `walletType`, `minAmountUsd` | 信号列表 |
| `mempump` | `chainIndex` + `stage`（`NEW`\|`MIGRATING`\|`MIGRATED`） | `protocol`, `sortBy`（默认 `volume24h`）, `limit`（默认 50） | Meme 币（ETH 不支持，Solana 501 / BNB 56 / Robinhood 4663 等） |
| `candles` | `chainIndex` + `tokenAddress` 或 `tokens[]` | `period`（默认 `15m`）, `limit`（默认 100） | K 线 |
| `price` | `chainIndex` + `tokenAddress` 或 `tokens[]` | — | 实时价格 |
| `balances` | `address` + `chains`（数组或逗号分隔，如 `"1,56,8453"`） | — | 跨链余额 |
| `transactions` | `address` + `chains` | `limit`（默认 50） | 交易历史 |
| `trackedTokens` | — | `chain`, `enabled` | 跟踪代币列表（collector 本地表） |
| `customSigs` | — | `chain`, `enabled` | 自定义事件签名列表（collector 本地表） |

- **多 token 批量**：`tokenInfo` / `price` / `candles` 传 `params.tokens = [addr, ...]`；多元素时返回保序数组 `[{tokenAddress, data}, ...]`，单 token 用 `tokenAddress` 直接返回数据。
- **x402 门控（自建，2026-08-16）**：`tokenSearch` / `tokenInfo` / `price` / `candles` 四个方法对**匿名调用**（无有效 `rx_`/`pkx_` key）返回 **HTTP 402** `{code:-1, message:"x402 payment required: <清单>", code:402}`，并带 `X-Payment-*` 头：`X-Payment-Order-Id`（支付订单）、`X-Payment-Resource`、`X-Payment-Amount`（按次费用，批量按 token 数倍增）、`X-Payment-Network`、`X-Payment-PayTo`（平台收款地址）、`X-Payment-Verify-Url`（`/api/v2/market/verify`）。
  - 费率：`tokenSearch` $0.002 / `tokenInfo` $0.001 / `price` $0.0005 / `candles` $0.001（**按次**，`tokens[]` 批量按元素数 ×N；token 维度方法按 token 数倍增）。
  - 支付闭环：调用方按其 `amount/network/payTo` 完成链上转账 → 提交 `txHash` 到 `X-Payment-Verify-Url` 入账 → **回放原请求**携带 `X-Payment-Order-Id`（头或 body）放行。
  - **持有效 key（`rx_`/`pkx_`）调用 4 个收费方法不触发 402**（套餐配额内）；其余免费方法（`hotTokens`/`leaderboard`/`signals`/`mempump`/`balances`/`transactions`/`trackedTokens`/`customSigs`）匿名调用返回 401。
- **错误**：参数缺失/非法 → `400`；未知方法 → `404`；上游错误 → `502`。

### 1.8 行情 WebSocket 订阅（`/v1/market-ws`，A-14，Collector `:9101`）

> 2026-08-15 交付：**增量推送**——价格仅变化时推送、K 线仅最后一根 timestamp 变化时推送；对齐低延迟场景。
> **鉴权**：query `key` = `rx_` 读 key（与 market-rpc 同一校验），如 `wss://…/v1/market-ws?key=rx_...&chainIndex=1`；失败 → HTTP 401 断开。
> **x402 会话门控（自建，2026-08-16）**：无有效 key 的匿名连接 → **HTTP 402** + `X-Payment-*` 清单（会话价 $0.001，对齐 A-12）；支付后回放连接带 `paymentOrderId`（query）或 `X-Payment-Order-Id`（header）→ 101 升级放行。

订阅 / 退订协议：

```
→ {"op":"subscribe","type":"price","chainIndex":"1","tokens":["0x..", ...]}
→ {"op":"subscribe","type":"candles","chainIndex":"1","tokens":["0x.."],"period":"15m","limit":4}
→ {"op":"unsubscribe","type":"price","tokens":[...]}   // 缺 tokens → 该 type 全部退订
```

服务端推送：

```
← {"type":"connected","message":"Subscribed to market stream (price/candles)","chainIndex":"1"}  // 连接成功
← {"type":"price","chainIndex":"1","tokenAddress":"0x..","data":{...}}     // 仅价格变化时
← {"type":"candles","chainIndex":"1","tokenAddress":"0x..","data":[...]}   // 仅最后一根 K 线变化时
```

- 订阅即推当前值；轮询频率：**价格 5s / K 线 30s**（全局单实例 Timer，客户端数不影响上游调用频次）。
- 同源同缓存（A-13）：与 market-rpc / REST MarketAPI 同一 OKX Market client。

---

## 二、MCP Server

8 个 MCP Server，每个独立进程。

### 服务地址

| MCP Server | 端口 | 工具数 | 传输 |
|------------|------|--------|------|
| Wallet MCP | `:9110` | 34 | SSE |
| DC MCP | `:9103` | 11 | HTTP Streamable |
| Market MCP | `:3013` | 18 | HTTP Streamable |
| Vault MCP | `:9108` | 13 | SSE |
| MPC MCP | `:9105` | 17 | SSE |
| Session Key MCP | `:3011` | 7 | HTTP Streamable |
| Chain RPC MCP | `:3012` | 10 | SSE + HTTP |
| Hub Index | `:3008` | 13 | HTTP Streamable |

### 配置（Claude Desktop / OpenClaw）

```json
{
  "mcpServers": {
    "infrax-wallet": { "url": "http://<host>:9110/mcp/sse" },
    "infrax-dc": { "url": "http://<host>:9103/mcp/message" },
    "infrax-vault": { "url": "http://<host>:9108/mcp/sse" },
    "infrax-mpc": { "url": "http://<host>:9105/mcp/sse" },
    "infrax-session-key": { "url": "http://<host>:3011/mcp/message" },
    "infrax-market": { "url": "http://<host>:3013/mcp/message" },
    "infrax-rpc": { "url": "http://<host>:3012/mcp/message" }
  }
}
```

> 入站鉴权：所有 HTTP MCP 统一 `MCP_API_KEY` 白名单或 `mx_` key（`Authorization: Bearer` / `X-API-Key` / `X-Service-Key` 三选一），豁免 `/health` `/`。工具全量清单见 [docs/MCP_USAGE.md](./MCP_USAGE.md)。

### 工具速查

#### Wallet MCP (`:9110`) — 34 tools（MQ-16 新增 15 个 batch/invite/transfer 支付工具）

| Tool | 描述 | 参数 |
|------|------|------|
| `wallet_balance` | 查询余额 | address, chain |
| `wallet_send` | 发送代币 | to, amount, chain |
| `wallet_simulate` | 估算 Gas | from, to, amount |
| `wallet_rpc` | RPC 端点 | — |
| `wallet_health` | 健康检查 | — |
| `wallet_sweep` | 归集资金 | chain |
| `wallet_status` | 交易状态 | txHash, chain |
| `payment_info` | 通道发现（rails/价格/pay-to） | — |
| `payment_create` | 创建支付意图（fiat→Stripe Checkout） | subscriber, planId, amountCents |
| `payment_verify` | x402/stablecoin 链上验付+入账 | txHash |
| `payment_price` | 链上套餐价格 | planId |
| `payment_balance` | 模块账本余额 | address |
| `payment_access` | 订阅访问控制 | subscriber, resource |
| `payment_batch_create` | **MQ-16** 批量收款意图 | items, chain, clientReference |
| `payment_batch_settle` | **MQ-16** 结算单笔 | batchId, itemId, txHash |
| `payment_batch_get` | **MQ-16** 查询 batch | batchId |
| `payment_batch_cancel` | **MQ-16** 取消 batch | batchId |
| `payment_invite_create` | **MQ-16** 创建账单邀请 | payer, payee, amountWei |
| `payment_invite_list` | **MQ-16** 列出邀请 | address, role |
| `payment_invite_get` | **MQ-16** 邀请详情 | inviteId |
| `payment_invite_cancel` | **MQ-16** 取消邀请 | inviteId |
| `payment_invite_settle` | **MQ-16** 链上结算邀请 | inviteId, txHash |
| `payment_invite_pay` | **MQ-16** 账本支付邀请 | inviteId |
| `payment_transfer_create` | **MQ-16** 发起账本转账 | from, to, amountWei |
| `payment_transfer_list` | **MQ-16** 列出转账 | address, role |
| `payment_transfer_get` | **MQ-16** 转账详情 | transferId |
| `payment_transfer_confirm` | **MQ-16** 确认执行转账 | transferId |
| `payment_transfer_cancel` | **MQ-16** 取消转账 | transferId |
| `mpp_open` | 打开 MPP 状态通道 | payer, depositWei, salt, txHash |
| `mpp_voucher` | EIP-712 累计 voucher | channelId, cumulativeAmount, signature |
| `mpp_topup` | 通道追加充值 | channelId, txHash, additionalWei |
| `mpp_settle` | 通道批量扣减 | channelId |
| `mpp_close` | 关闭通道 | channelId |
| `mpp_session` | 通道当前状态 | channelId |

#### DC MCP (`:9103`) — 11 tools（MQ-16 订阅 4 个，x-wallet-address 鉴权）

| Tool | 描述 | 参数 |
|------|------|------|
| `dc_events` | 链上事件 | chain, address, event_type |
| `dc_stats` | 统计 | — |
| `dc_checkpoints` | 扫描位点 | chain |
| `dc_plans` | 套餐 | — |
| `dc_tokens` | 代币列表 | chain |
| `dc_chains` | 链列表 | — |
| `dc_price` | 实时价格 | symbol (ETH, BTC) |
| `dc_subscription_subscribe` | **MQ-16** 订阅数据套餐 | planId, rail, walletAddress |
| `dc_subscription_payment_check` | **MQ-16** 轮询支付状态 | walletAddress |
| `dc_subscription_verify` | **MQ-16** x402 确认 | txHash, walletAddress |
| `dc_subscription_usage` | **MQ-16** 订阅用量 | walletAddress |

#### Vault MCP (`:9108`) — 13 tools

| Tool | 描述 | 参数 |
|------|------|------|
| `vault_dashboard` | 总览 | — |
| `vault_safes` | 列表 | chain, status |
| `vault_safe_info` | 详情 | safeId |
| `vault_create_safe` | 创建 | signers, threshold, chain |
| `vault_create_tx` | 提案 | safeId, to, amount |
| `vault_confirm_tx` | 签名 | safeAddress, safeTxHash, sig |
| `vault_execute_tx` | 执行 | safeTxHash |
| `vault_sync` | 同步 | safeAddress |
| `vault_risk_check` | 风控 | to, amount |

#### MPC MCP (`:9105`) — 17 tools（MQ-16 计费 2 个）

| Tool | 描述 | 参数 |
|------|------|------|
| `mpc_send_code` | 发验证码 | email |
| `mpc_register` | 注册钱包 | email, code |
| `mpc_recover` | 恢复钱包 | email, code |
| `mpc_status` | 查询状态 | email |
| `mpc_create_wallet` | 一键创建 | email |
| `mpc_session_unlock` | 解锁 → token | email, code |
| `mpc_session_lock` | 锁定 | token |
| `mpc_session_status` | 会话状态 | token |
| `mpc_balance` | 查余额 | token, chain |
| `mpc_sign_message` | EIP-191 签名 | token, message |
| `mpc_sign_typed_data` | EIP-712 签名 | token, domain, types, value |
| `mpc_send_transaction` | 转账 | token, to, amount, chain |
| `mpc_contract_read` | 合约只读 | contractAddress, abi, method |
| `mpc_contract_write` | 合约写 | token, contractAddress, abi, method |
| `mpc_gas_estimate` | Gas 估算 | to, value, data, chain |
| `mpc_plans` | **MQ-16** 套餐价目 | — |
| `mpc_ledger_balance` | **MQ-16** 账本余额 | token |

#### Session Key MCP (`:3011`) — 7 tools (v0.1.0 新增)

| Tool | 描述 | 参数 |
|------|------|------|
| `sk_nonce` | 获取签名 nonce | user (0x...) |
| `sk_create_session` | 创建 Session Key | signature, chain, contracts, userAddress, nonce |
| `sk_list_sessions` | 列出授权 | user, chain?, status? |
| `sk_get_session` | 授权详情 | sessionId |
| `sk_revoke_session` | 撤销授权 | sessionId |
| `sk_execute` | 代签交易 | sessionId, chain, to, data, value? |
| `sk_status` | 健康检查 | — |

### 自然语言示例

```
用户: "帮我在 Sepolia 上查 0xABC 的余额"
→ wallet_balance(address="0xABC", chain="sepolia")

用户: "创建一个 2/3 多签钱包"
→ vault_create_safe(signers=[A,B,C], threshold=2, chain="sepolia")

用户: "用我的主钱包授权一个 Session Key，允许自动在 Uniswap 上 swap，每天限额 1000 USDC"
→ sk_nonce(user="0xUser") → 返回 message → 用户签名
→ sk_create_session(signature="0x...", chain="eth", contracts="0xUniswap", maxPerTx="1000", userAddress="0xUser", nonce="...")

用户: "用 Session Key 执行 swap"
→ sk_execute(sessionId="uuid", chain="eth", to="0xUniswap", data="0xswapEncoded", value="0")
```

---

## 三、JS SDK

### 安装

```bash
npm install @0xinfrax/infrax-dk
# 或
pnpm add @0xinfrax/infrax-dk
```

### 快速开始

```typescript
import { InfraX } from '@0xinfrax/infrax-dk';

const ix = new InfraX({
  baseUrl: 'https://infrax.0xainet.top',
  apiKey: 'your-waas-api-key',
  dcApiKey: 'your-dc-api-key',
});

// ═══ Wallet ═══
const b = await ix.wallet.balance({ address: '0x...', chain: 'sepolia' });
const tx = await ix.wallet.send({ from: '0x...', to: '0x...', amount: '0.01', chain: 'sepolia' });

// ═══ MPC ═══
await ix.mpc.sendCode({ email: 'user@example.com' });
const wallet = await ix.mpc.register({ email: 'user@example.com', code: '123456' });

// ═══ Vault ═══
const safe = await ix.vault.createSafe({
  signers: ['0xA...', '0xB...', '0xC...'],
  threshold: 2,
  chain: 'sepolia'
});
await ix.vault.createTransaction({ safeId: safe.data.address, to: '0x...', amount: '0.1' });

// ═══ DC ═══
const events = await ix.dc.events({ chain: 'ethereum', eventType: 'Transfer', limit: 50 });

// ═══ Payment — @0xinfrax/payments 通用支付引擎（MQ-15 T-8 迁移，旧 x402Pay 已下线）═══
// 需配置 paymentsUrl + paymentsApiKey（或由网关 /payments 反代 + apiKey）
// Stripe fiat checkout（返回跳转 URL）：
await ix.payment.checkout({ subscriber: '0xuser', amountCents: 4900, period: 'month' });
// 链上 a2a 意图 → 用户钱包支付 → 提交 txHash 结算（x402 rail 验证）：
const intent = await ix.payment.a2a({ subscriber: '0xuser', valueWei: '1000000000000000', chain: 'sepolia' });
const settled = await ix.payment.a2aSettle({ paymentId: intent.paymentId, txHash: '0x...', chain: 'sepolia' });
// 链上支付验证（等效 verify）：
const ok = await ix.payment.verify('0x...', 'sepolia');
```

### Session Key SDK

```bash
npm install @0xinfrax/session-key-client
```

```typescript
import { SessionKeyClient } from '@0xinfrax/session-key-client';

const sk = new SessionKeyClient({
  baseUrl: 'http://localhost:3500',
  apiKey: 'your-api-key',
});

// 1. Get nonce
const { nonce, message } = await sk.getNonce('0xUserAddress');

// 2. User signs in wallet → create session
const session = await sk.createSession({
  signature: '0x...',
  chain: 'eth',
  permissions: { contracts: ['0xUniswap'] },
  userAddress: '0xUser',
  nonce,
});

// 3. Execute transaction
const result = await sk.execute({
  sessionId: session.id,
  chain: 'eth',
  to: '0xUniswap',
  data: '0xswapEncoded',
});

// 4. Revoke
await sk.revokeSession(session.id);
```

### 响应格式

SDK 返回原生 `{ code, message, data }` 结构：

```typescript
const r = await ix.wallet.balance({ address: '0x...' });
if (r.code === 0) {
  console.log(r.data.balance);
} else {
  console.error(r.message);
}
```

### 模块覆盖

| 模块 | 对应服务 | 方法数 |
|------|---------|--------|
| `.wallet` | WAAS :9109 | 7 |
| `.saas` | WAAS :9109 | 13 |
| `.sub` | WAAS :9109 | 4 |
| `.vault` / `.safe` | Vault :9107 | 12 + 7 |
| `.dc` | DC :9102 | **10**（数据 6 + MQ-16 订阅 4） |
| `.payment` | **Payments :9132** | **25**（基础 10 + MQ-16 batch/invite/transfer 15） |
| `.mpc` | MPC :9104 | **16**（钱包/链上 14 + MQ-16 计费 2） |
| `.market` | Collector :9101 | **21**（数据面 16 + MQ-16 订阅 5） |
| `.chainRpc` | Chain RPC :9130 | **10**（读/广播/状态 4 + MQ-16 订阅 6） |
| `.data` / `.ml` | Data :9112 / ml :9120 | 9 + 9 |
| `SessionKeyClient` | Session Key :3500 | 7 |

### 已发布包清单（npm，2026-08-15 全量核验）

| 包 | 版本 | 说明 |
|----|------|------|
| `@0xinfrax/infrax-dk` | 0.8.2 | 全功能聚合 SDK（wallet/mpc/vault/dc/market/chainRpc/payment/data/ml/sub） |
| `@0xinfrax/ragservicer-sdk` | 2.0.0 | **RAGservicer（LightRAG）TS 客户端**（2026-08-15 新发布；Python 侧为 PyPI `lightrag-client` 2.0.0） |
| `@0xinfrax/mpc-sdk` | 0.3.0 | MPC 钱包 |
| `@0xinfrax/session-key-core` | 0.2.1 | Session Key 核心 |
| `@0xinfrax/session-key-client` | 0.1.2 | Session Key 客户端 |
| `@0xinfrax/session-key-server` | 0.1.1 | Session Key 服务端 |
| `@0xinfrax/session-key-evm` | 0.1.2 | Session Key EVM |
| `@0xinfrax/payments` | 0.1.3 | 通用支付引擎 |
| `@0xinfrax/waas-sdk` | 0.1.0 | WAAS |
| `@0xinfrax/chain-rpc-sdk` | 0.1.0 | Chain RPC 网关 |
| `@0xinfrax/dc-sdk` | 0.1.0 | DC |
| `@0xinfrax/data-sdk` | 0.1.0 | Data |
| `@0xinfrax/market-sdk` | 0.1.0 | Market |
| `@0xinfrax/vault-sdk` | 0.1.0 | Vault |
| `@0xinfrax/infrax-cp-server` | 1.1.0 | 控制平面服务器 |

---

## 四、支持的区块链

| 链 | 参数 | 状态 |
|---|------|:---:|
| Sepolia | `sepolia` | 测试 |
| Ethereum | `eth` / `ethereum` | 生产 |
| BSC | `bsc` | 生产 |
| Base | `base` | 生产 |
| Polygon | `polygon` | 生产 |
| Arbitrum | `arbitrum` | 生产 |
| Optimism | `optimism` | 生产 |
| XLayer | `xlayer` | Session Key |

---

## 五、对比速查

| 能力 | REST | MCP | SDK |
|------|:---:|:---:|:---:|
| 钱包余额 | `GET /api/v2/wallet/balance` | `wallet_balance` | `ix.wallet.balance()` |
| 发送交易 | `POST /api/v2/wallet/send` | `wallet_send` | `ix.wallet.send()` |
| 多签创建 | `POST /api/vault/safe/create` | `vault_create_safe` | `ix.vault.createSafe()` |
| 链上事件 | `GET /api/v2/data/events` | `dc_events` | `ix.dc.events()` |
| MPC 注册 | `POST /api/v2/mpc/register` | `mpc_register` | `ix.mpc.register()` |
| Session Key | `POST /api/v1/sessions` | `sk_create_session` | `sk.createSession()` |
| 代币搜索 | `GET /api/v2/data/market/token-search` | `market_search` | `ix.market.searchToken()` |
| 热门代币 | `GET /api/v2/data/market/hot-tokens` | `market_hot` | `ix.market.getHotTokens()` |
| K线数据 | `GET /api/v2/data/market/candles` | `market_candles` | `ix.market.getCandles()` |
| 余额查询 | `GET /api/v2/data/market/balances` | `market_balances` | `ix.market.getBalances()` |
| Meme 扫链 | `GET /api/v2/data/market/mempump/list` | `market_mempump` | `ix.market.getMemePumpList()` |
| AI 自然语言 | — | ✅ 全部 | — |

---

## 附：curl 测试

```bash
# WAAS 健康检查
curl http://<host>:9109/health

# DC 事件查询
curl "http://<host>/api/v2/data/events?chain=sepolia&limit=5"

# MPC 发验证码
curl -X POST http://<host>/api/v2/mpc/send-code \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com"}'

# Session Key nonce
curl "http://<host>:3500/api/v1/nonce?user=0x1234..."

# Session Key 创建
curl -X POST http://<host>:3500/api/v1/sessions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <api-key>" \
  -d '{"signature":"0x...","chain":"eth","permissions":{"contracts":["0xUni"]},"userAddress":"0x...","nonce":"..."}'
```
