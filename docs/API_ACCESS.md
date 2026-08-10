# InfraX 接入文档 — API / MCP / SDK

> 版本 `v0.5.0-20260801` | 最后更新 2026-08-01 | GitHub: [sftgroup/infraX](https://github.com/sftgroup/infraX)

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
             │              │ :9111 Session Key                │
             │              └─────┬──────────────────────────┘
             │                    │
    ┌────────┼────────┬───────────┼──────────┬──────────────┐
    ▼        ▼        ▼           ▼          ▼              ▼
  WAAS    Vault     DC          MPC      Collector    Session Key
  :9109   :9107    :9102        :9104     :9101         :3500
  (17表)  (2表)    (4表)       (1表)     (4表)        (2表)
```

## 服务端口总览

| 端口 | 服务 | 数据库 | 描述 |
|------|------|--------|------|
| `:80` | Web Proxy | — | Nginx 反向代理，统一入口 |
| `:3500` | Session Key Engine | session_key_engine | 跨项目自动化授权代签 |
| `:6003` | MPC 内部 | pocketx_mpc | Agent Wallet 托管 |
| `:9101` | Collector | pocketx_collector | 5 链区块扫描器 |
| `:9102` | DC (数据中心) | pocketx_dc | 链上数据查询 |
| `:9106` | Payment | pocketx_payment | x402 支付引擎 |
| `:9107` | Vault | pocketx_vault | Safe 多签保险库 |
| `:9109` | WAAS | pocketx_waas | B2B 钱包即服务 |
| `:9103` | DC MCP | — | AI Agent 数据 |
| `:9105` | MPC MCP | — | AI Agent 钱包 |
| `:9108` | Vault MCP | — | AI Agent 多签 |
| `:9110` | Wallet MCP | — | AI Agent WAAS |
| `:9111` | Session Key MCP | — | AI Agent 授权 |
| `:3007` | Market MCP | — | AI Agent 行情分析 |

---

## 一、REST API

### 基础信息

```
Base URL:  https://api.infrax.io
```

### 认证

| Header | 用途 | 模块 |
|--------|------|------|
| `x-wallet-address` | 钱包地址，只读查询自动发送 | 全部 |
| `x-api-key` | WaaS/SaaS 租户 API Key | WAAS |
| `x-dc-api-key` | DC 数据订阅 API Key | DC |
| `Authorization: Bearer <token>` | Session Key Engine API Key | Session Key |

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
| `POST` | `/api/v2/data/subscribe` | 订阅 |

---

### 💳 Payment — 通用支付引擎 @0xinfrax/payments (`:9132`，MQ-15 T-8 迁移；旧 `:9106 /api/v2/payment/*` 已下线)

SDK 用法：`ix.payment.checkout() / a2a() / a2aSettle() / verify() / balance() / capabilities() / price()`（需配置 `paymentsUrl` + `paymentsApiKey`）。

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
| `POST` | `/payments/invites` | agent 自动收费邀请（invite 能力） |
| `POST` | `/payments/transfers` | 账本内转账（transfer 能力） |
| `POST` | `/payments/batch` | 批量收款（batch 能力） |

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
  "https://api.infrax.io/api/v2/data/market/hot-tokens?chainIndex=1&rankingTimeFrame=4&rankBy=14&limit=20"

# Pump.fun 协议 Meme 币
curl -H "x-api-key: YOUR_KEY" \
  "https://api.infrax.io/api/v2/data/market/mempump/list?chainIndex=501&protocol=120596&sortBy=volume24h"
```

---

## 二、MCP Server

6 个 MCP Server，每个独立进程。

### 服务地址

| MCP Server | 端口 | 工具数 | 传输 |
|------------|------|--------|------|
| Wallet MCP | `:9110` | 10 | SSE |
| DC MCP | `:9103` | 7 | HTTP Streamable |
| Market MCP | `:3007` | 13 | HTTP Streamable |
| Vault MCP | `:9108` | 14 | SSE |
| MPC MCP | `:9105` | 15 | SSE |
| Session Key MCP | `:9111` | 7 | HTTP Streamable |

### 配置（Claude Desktop / OpenClaw）

```json
{
  "mcpServers": {
    "infrax-wallet": { "url": "http://<host>:9110/mcp/sse" },
    "infrax-dc": { "url": "http://<host>:9103/mcp/message" },
    "infrax-vault": { "url": "http://<host>:9108/mcp/sse" },
    "infrax-mpc": { "url": "http://<host>:9105/mcp/sse" },
    "infrax-session-key": { "url": "http://<host>:9111/mcp/message" }
  }
}
```

### 工具速查

#### Wallet MCP (`:9110`) — 10 tools

| Tool | 描述 | 参数 |
|------|------|------|
| `wallet_balance` | 查询余额 | address, chain |
| `wallet_send` | 发送代币 | to, amount, chain |
| `wallet_simulate` | 估算 Gas | from, to, amount |
| `wallet_rpc` | RPC 端点 | — |
| `wallet_health` | 健康检查 | — |
| `wallet_sweep` | 归集资金 | chain |
| `wallet_status` | 交易状态 | txHash, chain |
| `payment_create` | 创建支付 | planId, amount |
| `payment_status` | 支付状态 | paymentId |
| `x402_pay` | x402 自动付 | recipient, amount |

#### DC MCP (`:9103`) — 7 tools

| Tool | 描述 | 参数 |
|------|------|------|
| `dc_events` | 链上事件 | chain, address, event_type |
| `dc_stats` | 统计 | — |
| `dc_checkpoints` | 扫描位点 | chain |
| `dc_plans` | 套餐 | — |
| `dc_tokens` | 代币列表 | chain |
| `dc_chains` | 链列表 | — |
| `dc_price` | 实时价格 | symbol (ETH, BTC) |

#### Vault MCP (`:9108`) — 14 tools

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

#### MPC MCP (`:9105`) — 15 tools

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

#### Session Key MCP (`:9111`) — 7 tools (v0.1.0 新增)

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
  baseUrl: 'https://api.infrax.io',
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
| `.vault` / `.safe` | Vault :9107 | 12 |
| `.dc` | DC :9102 | 6 |
| `.payment` | Payment :9106 | 4 |
| `.mpc` | MPC :9104/6003 | 12 |
| `.market` | Collector :9101 | 16 |
| `SessionKeyClient` | Session Key :3500 | 7 |

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
