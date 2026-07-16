# InfraX 接入文档 — API / MCP / SDK

> 版本 `v0.3.0-20260717` | 最后更新 2026-07-17 | 生产: `129.226.203.60`

## 概述

InfraX 提供三种接入方式，覆盖同一套后端能力，API 合约完全一致：

| 方式 | 适用场景 | 协议 |
|------|---------|------|
| **REST API** | 传统后端集成、自定义客户端 | HTTP JSON |
| **MCP Server** | AI Agent（OpenClaw/Claude/Cursor）直接调用 | JSON-RPC (SSE) |
| **JS SDK** | Node.js / 前端项目快速集成 | TypeScript |

```
┌─────────────────────────────────────────────────┐
│                   客户端                           │
│   REST API  │  MCP (AI Agent)  │  JS SDK         │
└────────────┬────────────────────┬─────────────────┘
             │                    │
        ┌────▼────┐         ┌─────▼──────┐
        │ Web :6100│         │ MCP Servers │
        │ (proxy) │         │ :3004~:3007 │
        └────┬────┘         └─────┬──────┘
             │                    │
    ┌────────┼────────┬───────────┼──────────┐
    ▼        ▼        ▼           ▼          ▼
  WAAS    Vault     DC          MPC      Collector
  :6001   :6002    :3001        :6003     :3008
```

## 一、REST API

### 基础信息

```
Base URL:  https://api.pocketx.ai
           http://129.226.203.60:6100/api
```

### 认证

| Header | 用途 | 模块 |
|--------|------|------|
| `x-wallet-address` | 钱包地址，只读查询自动发送 | 全部 |
| `x-api-key` | WaaS/SaaS 租户 API Key | WAAS |
| `x-dc-api-key` | DC 数据订阅 API Key | DC |

### 端点总览

#### 🔐 MPC — 密钥分片钱包 + Agent Wallet (`:6003`)

##### 钱包管理

| 方法 | 端点 | 描述 |
|------|------|------|
| `POST` | `/api/v2/mpc/send-code` | 发送邮箱验证码 |
| `POST` | `/api/v2/mpc/register` | 注册 MPC 钱包（需验证码） |
| `POST` | `/api/v2/mpc/recover` | 恢复 MPC 钱包（需验证码） |
| `GET` | `/api/v2/mpc/status` | 查询钱包注册状态 |

> `POST /api/v2/mpc/send-code` Body: `{ "email": "user@example.com" }`
> `POST /api/v2/mpc/register` Body: `{ "email": "user@example.com", "code": "123456" }`
> Response: `{ "code": 0, "data": { "address": "0x...", "email": "..." } }`

##### Agent Wallet 会话管理 (v0.3.0)

| 方法 | 端点 | 描述 |
|------|------|------|
| `POST` | `/api/v2/mpc/session/unlock` | 🔓 验证码解锁 → 返回 session token（30min TTL） |
| `POST` | `/api/v2/mpc/session/lock` | 🔒 销毁 session token |
| `GET` | `/api/v2/mpc/session/status?token=xxx` | 📊 查询会话状态 + 剩余时间 |

> **流程**: `unlock(email, code)` 返回 `token` → 后续所有操作只传 `token`，无需验证码

##### Agent Wallet 操作 (需 session token)

| 方法 | 端点 | 描述 |
|------|------|------|
| `POST` | `/api/v2/mpc/balance` | 查询余额（原生 + ERC20） |
| `POST` | `/api/v2/mpc/sign-message` | EIP-191 签名 |
| `POST` | `/api/v2/mpc/sign-typed-data` | EIP-712 签名 |
| `POST` | `/api/v2/mpc/send-transaction` | 转账（ETH/ERC20，限额 0.1 ETH） |
| `POST` | `/api/v2/mpc/contract-read` | 合约只读调用（无需 token） |
| `POST` | `/api/v2/mpc/contract-write` | 合约写调用（先模拟→签名→广播） |
| `POST` | `/api/v2/mpc/gas-estimate` | Gas 估算（无需 token） |

> `POST /api/v2/mpc/session/unlock` Body: `{ "email": "user@example.com", "code": "123456" }`
> Response: `{ "code": 0, "data": { "token": "mpc_a1b2...", "address": "0x...", "expiresAt": "..." } }`
>
> `POST /api/v2/mpc/send-transaction` Body: `{ "token": "mpc_a1b2...", "to": "0xABC", "amount": "0.01", "chain": "sepolia" }`
> Response: `{ "code": 0, "data": { "txHash": "0x...", "gasUsed": "21000" } }`
>
> `POST /api/v2/mpc/contract-write` Body: `{ "token": "...", "contractAddress": "0xD...", "abi": [...], "method": "approve", "args": ["0xS...", "1000000"] }`
> 自动 `staticCall` 模拟 → 模拟通过 → 签名广播

#### 💰 WAAS — 钱包即服务 (`:6001`)

| 方法 | 端点 | 描述 |
|------|------|------|
| `POST` | `/api/v2/saas/tenants` | 创建租户 |
| `GET` | `/api/v2/saas/tenants/my` | 查询我的租户 |
| `POST` | `/api/v2/saas/tenants/activate` | 激活租户 |
| `POST` | `/api/v2/saas/address` | 分配存款地址 |
| `POST` | `/api/v2/saas/addresses` | 批量分配地址 |
| `GET` | `/api/v2/saas/addresses` | 查询已分配地址 |
| `POST` | `/api/v2/saas/sweep` | 触发归集 |
| `POST` | `/api/v2/saas/tenants/:id/apikey` | 生成 API Key |
| `POST` | `/api/v2/saas/tenants/:id/apikey/rotate` | 轮换 API Key |
| `DELETE` | `/api/v2/saas/tenants/:id/apikey` | 删除 API Key |
| `POST` | `/api/v2/saas/tenants/:id/hot-wallet` | 生成热钱包 |
| `GET` | `/api/v2/saas/withdrawals` | 提现队列 |
| `GET` | `/api/v2/wallet/balance` | 查询余额 |

> Response 格式: `{ "code": 0, "data": { ... } }`
> 租户激活后每请求须带 `x-api-key` header

#### 🏦 Vault — 多签保险库 (`:6002`)

| 方法 | 端点 | 描述 |
|------|------|------|
| `GET` | `/api/vault/dashboard` | 金库总览 |
| `GET` | `/api/vault/safe/list` | 列出多签钱包 |
| `GET` | `/api/vault/safe/:address` | 查询 Safe 详情 |
| `POST` | `/api/vault/safe/create` | 创建多签钱包 |
| `POST` | `/api/vault/safe/propose` | 创建交易提案 |
| `POST` | `/api/vault/safe/confirm` | 签名确认 |
| `POST` | `/api/vault/safe/execute` | 执行交易 |
| `POST` | `/api/vault/safe/sync` | 同步链上状态 |
| `GET` | `/api/vault/safe/status` | Safe 服务状态 |
| `POST` | `/api/vault/risk/check` | 风控检查 |

> Safe 创建: `{ "signers": ["0x..."], "threshold": 2, "chain": "sepolia" }`

#### 📡 Data Center — 链上数据 (`:3001`)

| 方法 | 端点 | 描述 |
|------|------|------|
| `GET` | `/api/v2/data/events` | 查询链上事件 |
| `GET` | `/api/v2/data/stats` | 数据统计 |
| `GET` | `/api/v2/data/checkpoints` | 区块扫描位点 |
| `GET` | `/api/v2/data/plans` | 数据套餐 |
| `GET` | `/api/v2/data/tokens` | 代币列表 |
| `GET` | `/api/v2/data/chains` | 链列表 |
| `GET` | `/api/v2/data/balance` | 跨链余额查询 |
| `GET` | `/api/v2/data/usage` | 订阅用量 |
| `POST` | `/api/v2/data/subscribe` | 订阅数据服务 |

> 事件查询: `GET /api/v2/data/events?chain=sepolia&address=0x...&event_type=Transfer&limit=100`

#### 💳 Payment — 支付引擎 (`:6004`)

| 方法 | 端点 | 描述 |
|------|------|------|
| `POST` | `/api/v2/payment/create` | 创建支付订单 |
| `GET` | `/api/v2/payment/status` | 查询支付状态 |
| `POST` | `/api/v2/payment/x402/pay` | x402 HTTP 402 自动支付 |

---

## 二、MCP Server

4 个 MCP Server，每个独立进程，通过 SSE (Server-Sent Events) 提供 JSON-RPC 协议。

### 服务地址

| MCP Server | 端口 | 工具数 | 覆盖模块 |
|------------|------|--------|---------|
| Wallet MCP | `:3004` | 10 | WaaS 钱包/支付 |
| DC MCP | `:3005` | 7 | 数据查询/价格 |
| Vault MCP | `:3006` | 14 | Safe 多签/风控 |
| MPC MCP | `:3007` | 15 | MPC Agent Wallet |

### 配置（OpenClaw / Claude Desktop）

```json
{
  "mcpServers": {
    "pocketx-wallet": {
      "url": "http://129.226.203.60:3004/mcp/sse"
    },
    "pocketx-dc": {
      "url": "http://129.226.203.60:3005/mcp/message"
    },
    "pocketx-vault": {
      "url": "http://129.226.203.60:3006/mcp/sse"
    },
    "pocketx-mpc": {
      "url": "http://129.226.203.60:3007/mcp/sse"
    }
  }
}
```

### 工具速查

#### Wallet MCP (`:3004`) — 10 tools

| Tool | 描述 | 主要参数 |
|------|------|---------|
| `wallet_balance` | 查询钱包余额 | address, chain |
| `wallet_send` | 发送原生代币（≤0.05 ETH） | to, amount, chain |
| `wallet_simulate` | 估算 Gas | from, to, amount, chain |
| `wallet_rpc` | 获取 RPC 端点 | — |
| `wallet_health` | 健康检查 | — |
| `wallet_sweep` | 归集资金 | chain |
| `wallet_status` | 交易状态 | txHash, chain |
| `payment_create` | 创建支付 | planId, amount |
| `payment_status` | 支付状态 | paymentId |
| `x402_pay` | x402 自动支付 | recipient, amount |

#### DC MCP (`:3005`) — 7 tools

| Tool | 描述 | 主要参数 |
|------|------|---------|
| `dc_events` | 查询链上事件 | chain, address, event_type, limit |
| `dc_stats` | 数据统计 | — |
| `dc_checkpoints` | 区块位点 | chain |
| `dc_plans` | 套餐列表 | — |
| `dc_tokens` | 代币列表 | chain |
| `dc_chains` | 链列表 | — |
| `dc_price` | 实时价格（Binance） | symbol（如 ETH, BTC） |

#### Vault MCP (`:3006`) — 14 tools

| Tool | 描述 | 主要参数 |
|------|------|---------|
| `vault_dashboard` | 金库总览 | — |
| `vault_safes` | 列表 Safe | chain, status |
| `vault_safe_info` | Safe 详情 | safeId |
| `vault_create_safe` | 创建多签 | signers, threshold, chain |
| `vault_update_owners` | 更新签名人 | address, owners, threshold |
| `vault_create_tx` | 提案交易 | safeId, to, amount |
| `vault_confirm_tx` | 签名确认 | safeAddress, safeTxHash, signature |
| `vault_execute_tx` | 执行交易 | safeTxHash |
| `vault_retry` | 重试部署 | chainId |
| `vault_execute_ready` | 批量执行达标交易 | safeAddress |
| `vault_sync` | 同步链上状态 | safeAddress |
| `vault_status` | 服务状态 | walletAddress |
| `vault_risk_check` | 风控检查 | to, amount |

#### MPC MCP (`:3007`) — 15 tools (v0.3.0)

| Tool | 描述 | 主要参数 |
|------|------|---------|
| `mpc_send_code` | 发验证码 | email |
| `mpc_register` | 注册钱包 | email, code |
| `mpc_recover` | 恢复钱包 | email, code |
| `mpc_status` | 查询状态 | email |
| `mpc_create_wallet` | 全流程创建 | email |
| `mpc_session_unlock` | 🔓 解锁钱包 → 返回 session token | email, code |
| `mpc_session_lock` | 🔒 锁定钱包 | token |
| `mpc_session_status` | 📊 会话状态 | token |
| `mpc_balance` | 💰 查余额 | token, chain, tokenAddress? |
| `mpc_sign_message` | ✍️ EIP-191 签名 | token, message |
| `mpc_sign_typed_data` | ✍️ EIP-712 签名 | token, domain, types, value |
| `mpc_send_transaction` | 📤 转账（ETH/ERC20，限额 0.1 ETH） | token, to, amount, chain, tokenAddress? |
| `mpc_contract_read` | 👁️ 合约只读 | contractAddress, abi, method, args |
| `mpc_contract_write` | 📝 合约写（先模拟→签名→广播） | token, contractAddress, abi, method, args |
| `mpc_gas_estimate` | ⛽ Gas 估算 | to, value?, data?, chain |

### 使用示例

```
用户: "帮我在 Sepolia 上查一下 0xABC... 的余额"
→ AI 调 wallet_balance(address="0xABC...", chain="sepolia")

用户: "创建一个 2/3 多签钱包"
→ AI 调 vault_create_safe(signers=[A,B,C], threshold=2, chain="sepolia")

用户: "查最近 100 个 ETH Transfer 事件"
→ AI 调 dc_events(chain="ethereum", event_type="Transfer", limit="100")

用户: "BTC 现在什么价？"
→ AI 调 dc_price(symbol="BTC")

用户: "解锁我的 MPC Agent 钱包"
→ AI 调 mpc_session_unlock(email="agent@infrax.io", code="123456")
→ 返回 session token

用户: "用 MPC 钱包 approve 100 USDT 给 Router 合约"
→ AI 调 mpc_contract_write(token="mpc_xxx", contractAddress="0xUSDT", abi=[approve], method="approve", args=["0xRouter", "100000000"])
→ 自动模拟 → 签名 → 广播 → 返回 txHash

用户: "锁上 MPC 钱包"
→ AI 调 mpc_session_lock(token="mpc_xxx")
```

---

## 三、JS SDK

### 安装

```bash
npm install @pocketx/sdk
# 或
pnpm add @pocketx/sdk
```

### 快速开始

```typescript
import PocketX from '@pocketx/sdk';

const px = new PocketX({
  baseUrl: 'https://api.pocketx.ai',
  apiKey: 'your-waas-api-key',     // WAAS 操作必填
  dcApiKey: 'your-dc-api-key',     // DC 操作必填
});

// ─── MPC ───
await px.mpc.sendCode({ email: 'user@example.com' });
const wallet = await px.mpc.register({ email: 'user@example.com', code: '123456' });
console.log(wallet.data.address);  // 0x...

// ─── MPC Agent Wallet (v0.3.0) ───
const session = await px.mpc.unlockSession({ email: 'user@example.com', code: '123456' });
const token = session.data.token;

await px.mpc.getBalance({ token });
await px.mpc.signMessage({ token, message: 'Hello InfraX' });
await px.mpc.sendTransaction({ token, to: '0xABC', amount: '0.01', chain: 'sepolia' });
await px.mpc.contractWrite({ token, contractAddress: '0xUSDT', abi: [...], method: 'approve', args: ['0xRouter', '1000000'] });
await px.mpc.lockSession({ token });

// ─── WAAS ───
const balance = await px.wallet.balance({ address: '0x...', chain: 'sepolia' });
const tx = await px.wallet.send({ from: '0x...', to: '0x...', amount: '0.01', chain: 'sepolia' });

// ─── Vault ───
const safe = await px.vault.createSafe({
  signers: ['0xA...', '0xB...', '0xC...'],
  threshold: 2,
  chain: 'sepolia'
});
await px.vault.createTransaction({
  safeId: safe.data.address,
  to: '0x...',
  amount: '0.1'
});

// ─── DC ───
const events = await px.dc.events({ chain: 'ethereum', eventType: 'Transfer', limit: 50 });
const price = await px.dc.tokens({ symbol: 'USDT' });
```

### 响应格式

SDK 返回原生 `{ code, message, data }` 结构：

```typescript
const r = await px.wallet.balance({ address: '0x...' });
if (r.code === 0) {
  console.log(r.data.balance);   // 业务数据
} else {
  console.error(r.message);       // 错误信息
}
```

### 模块覆盖

| SDK 模块 | 对应后端 | 方法数 |
|---------|---------|--------|
| `.mpc` | MPC :6003 | 12（sendCode/register/recover/status/createWallet + Agent 7） |
| `.wallet` | WAAS :6001 | 7（balance/send/simulate/rpc/sweep/txStatus/health） |
| `.saas` | WAAS :6001 | 13（CRUD tenants, API keys, usage, stats） |
| `.sub` | WAAS :6001 | 4（plans/current/subscribe/cancel） |
| `.vault` / `.safe` | Vault :6002 | 12（CRUD safes, tx lifecycle, risk） |
| `.dc` | DC :3001 | 6（events/stats/checkpoints/tokens/chains/plans） |
| `.payment` | Payment :6004 | 4（create/status/confirm/x402） |

---

## 四、支持的区块链

| 链 | chain 参数值 | 状态 | 用途 |
|---|-------------|------|------|
| **Sepolia** | `sepolia` | 🟢 测试网 | 开发/免费试用 |
| **Ethereum** | `ethereum` / `eth` | 🟢 | 生产主网 |
| **BSC** | `bsc` | 🟢 | Binance Smart Chain |
| **Solana** | `solana` | 🟢 | Solana |
| **Base** | `base` | 🟢 | Coinbase L2 |
| **OxaChain** | `oxa` | 🟢 | 0xAINet L1 sovereign chain (Chain ID 19505) |
| **Polygon** | `polygon` | 🟢 | Polygon POS |
| **Arbitrum** | `arbitrum` | 🟢 | Arbitrum One |
| **Optimism** | `optimism` | 🟢 | OP Mainnet |

> DC Free 套餐仅限 Sepolia 测试网。Pro/Enterprise 支持全链。

---

## 五、对比速查

| 能力 | REST API | MCP | SDK |
|------|----------|-----|-----|
| 钱包余额查询 | ✅ `GET /api/v2/wallet/balance` | `wallet_balance` | `px.wallet.balance()` |
| 发送交易 | ✅ `POST /api/v2/tx` | `wallet_send` | `px.wallet.send()` |
| 多签创建 | ✅ `POST /api/vault/safe/create` | `vault_create_safe` | `px.vault.createSafe()` |
| 事件查询 | ✅ `GET /api/v2/data/events` | `dc_events` | `px.dc.events()` |
| 实时币价 | ❌ | `dc_price` | `px.dc.tokens()` |
| MPC 注册 | ✅ `POST /api/v2/mpc/register` | `mpc_register` | `px.mpc.register()` |
| AI 自然语言 | ❌ | ✅ | ❌ |

---

## 附：测试工具

```bash
# 健康检查
curl http://129.226.203.60:6001/health  # WAAS
curl http://129.226.203.60:6002/health  # Vault
curl http://129.226.203.60:3001/health  # DC
curl http://129.226.203.60:3004/health  # Wallet MCP
curl http://129.226.203.60:3005/health  # DC MCP
curl http://129.226.203.60:3006/health  # Vault MCP

# MPC 发验证码
curl -X POST http://129.226.203.60:6100/api/v2/mpc/send-code \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com"}'

# DC 事件查询
curl "http://129.226.203.60:6100/api/v2/data/events?chain=sepolia&limit=5"
```
