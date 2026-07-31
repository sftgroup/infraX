# InfraX MCP — AI Agent 接入文档

> v0.4.0-20260731 | @0xinfrax

## 架构

```
                          ┌─ vault-mcp    (:9108) ── pocketx_vault DB
                          │
                          ├─ waas-mcp     (:9110) ── pocketx_waas DB
                          │
AI Agent ── MCP 协议 ──┼─ dc-mcp       (:9103) ── pocketx_dc / collector DB
                          │
                          ├─ mpc-mcp      (:9105) ── pocketx_mpc DB
                          │
                          └─ session-key-mcp (:9111) ── session_key_engine DB
```

每个 MCP Server 是独立运行的进程（SSE 或 HTTP Streamable 模式），通过 `systemd` 托管，复用对应 DB 连接池。

## 服务状态

| MCP Server | 端口 | Tools | systemd unit | 传输 | 状态 |
|------------|------|-------|-------------|------|:---:|
| Wallet MCP | `:9110` | 10 | `infrax-wallet-mcp` | SSE | 运行中 |
| DC MCP | `:9103` | 7 | `infrax-dc-mcp` | HTTP Streamable | 运行中 |
| Vault MCP | `:9108` | 14 | `infrax-vault-mcp` | SSE | 运行中 |
| MPC MCP | `:9105` | 15 | `infrax-mpc-mcp` | SSE | 运行中 |
| Session Key MCP | `:9111` | 7 | `infrax-session-key-mcp` | HTTP Streamable | 新增 |

## 配置（Claude Desktop / OpenClaw / Cursor）

```json
{
  "mcpServers": {
    "infrax-wallet": {
      "url": "http://<host>:9110/mcp/sse"
    },
    "infrax-dc": {
      "url": "http://<host>:9103/mcp/message"
    },
    "infrax-vault": {
      "url": "http://<host>:9108/mcp/sse"
    },
    "infrax-mpc": {
      "url": "http://<host>:9105/mcp/sse"
    },
    "infrax-session-key": {
      "url": "http://<host>:9111/mcp/message"
    }
  }
}
```

也可以使用 npm 包方式（npx 启动）：

```json
{
  "mcpServers": {
    "infrax": {
      "command": "npx",
      "args": ["-y", "@0xinfrax/infrax-cp-server"]
    }
  }
}
```

---

## 一、Wallet MCP (`:9110`) — 10 tools

| Tool | 描述 | 参数 |
|------|------|------|
| `wallet_balance` | 查询钱包余额（原生 + ERC20） | address, chain?, token? |
| `wallet_send` | 发送原生代币 | to, amount, chain? |
| `wallet_simulate` | 估算 Gas | from, to, amount?, chain? |
| `wallet_rpc` | 获取 RPC 端点 | — |
| `wallet_health` | 健康检查 | — |
| `wallet_sweep` | 归集资金 | chain?, toAddress? |
| `wallet_status` | 交易状态查询 | txHash, chain? |
| `payment_create` | 创建支付订单 | planId, amount, method? |
| `payment_status` | 支付状态查询 | paymentId |
| `x402_pay` | x402 自动支付 | recipient, amount, token?, chain? |

### 使用示例

```
用户: "帮我在 Sepolia 上查 0xABC 的余额"
→ wallet_balance(address="0xABC", chain="sepolia")

用户: "给 0xDEF 转 0.01 ETH"
→ wallet_send(to="0xDEF", amount="0.01", chain="sepolia")

用户: "用 USDC 支付 10U 给 0xService"
→ x402_pay(recipient="0xService", amount="10", token="USDC")
```

---

## 二、DC MCP (`:9103`) — 7 tools

| Tool | 描述 | 参数 |
|------|------|------|
| `dc_events` | 查询链上事件 | chain?, address?, event_type?, limit? |
| `dc_stats` | 数据统计 | — |
| `dc_checkpoints` | 区块扫描位点 | chain? |
| `dc_plans` | 数据套餐列表 | — |
| `dc_tokens` | 代币列表查询 | chain?, symbol? |
| `dc_chains` | 支持的链列表 | — |
| `dc_price` | 实时价格（Binance） | symbol (ETH, BTC, USDT) |

### 使用示例

```
用户: "查最近 100 个 ETH Transfer"
→ dc_events(chain="ethereum", event_type="Transfer", limit="100")

用户: "BTC 现在什么价？"
→ dc_price(symbol="BTC")
```

---

## 三、Vault MCP (`:9108`) — 14 tools

| Tool | 描述 | 参数 |
|------|------|------|
| `vault_dashboard` | 金库总览 | — |
| `vault_safes` | 列出 Safe | chain?, status? |
| `vault_safe_info` | Safe 详情 | safeId |
| `vault_create_safe` | 创建多签 | signers, threshold, chain |
| `vault_update_owners` | 更新签名人 | address, owners, threshold |
| `vault_create_tx` | 创建交易提案 | safeId, to, amount, tokenAddress?, data? |
| `vault_confirm_tx` | 签名确认 | safeAddress, safeTxHash, signature |
| `vault_execute_tx` | 执行交易 | safeTxHash |
| `vault_retry` | 重试部署 | chainId |
| `vault_execute_ready` | 批量执行已达标交易 | safeAddress |
| `vault_sync` | 同步链上状态 | safeAddress |
| `vault_status` | 服务状态 | walletAddress? |
| `vault_risk_check` | 风控检查 | to, amount?, chain? |

### 使用示例

```
用户: "创建一个 2/3 多签钱包"
→ vault_create_safe(signers=["0xA","0xB","0xC"], threshold=2, chain="sepolia")

用户: "给多签 0xSafe 提案转 0.1 ETH 给 0xRecipient"
→ vault_create_tx(safeId="0xSafe", to="0xRecipient", amount="0.1")
```

---

## 四、MPC MCP (`:9105`) — 15 tools (Agent Wallet v0.3.0)

### 钱包管理（5 个）

| Tool | 描述 | 参数 |
|------|------|------|
| `mpc_send_code` | 发送邮箱验证码 | email |
| `mpc_register` | 注册 MPC 钱包 | email, code |
| `mpc_recover` | 恢复 MPC 钱包 | email, code |
| `mpc_status` | 查询注册状态 | email |
| `mpc_create_wallet` | 一键全流程创建 | email |

### 会话管理（3 个）

| Tool | 描述 | 参数 |
|------|------|------|
| `mpc_session_unlock` | 解锁钱包 → session token (30min) | email, code |
| `mpc_session_lock` | 锁定钱包 | token |
| `mpc_session_status` | 会话状态 + 剩余时间 | token |

### Agent Wallet 操作（7 个）

| Tool | 描述 | 参数 |
|------|------|------|
| `mpc_balance` | 余额查询（原生 + ERC20） | token, chain?, tokenAddress? |
| `mpc_sign_message` | EIP-191 签名 | token, message |
| `mpc_sign_typed_data` | EIP-712 签名 | token, domain, types, value |
| `mpc_send_transaction` | 转账（限额 0.1 ETH） | token, to, amount, chain?, tokenAddress? |
| `mpc_contract_read` | 合约只读调用 | contractAddress, abi, method, args |
| `mpc_contract_write` | 合约写（模拟→签名→广播） | token, contractAddress, abi, method, args |
| `mpc_gas_estimate` | Gas 估算 | to, value?, data?, chain? |

### 使用示例

```
用户: "解锁我的 MPC 钱包，给 0xABC 转 0.01 ETH"
→ mpc_session_unlock(email="agent@infrax.io", code="888888")
→ 拿到 token
→ mpc_send_transaction(token="mpc_xxx", to="0xABC", amount="0.01", chain="sepolia")

用户: "用 MPC 钱包 approve 100 USDT"
→ mpc_contract_write(
    token="mpc_xxx",
    contractAddress="0xUSDT",
    abi=[approve],
    method="approve",
    args=["0xRouter", "100000000"]
  )
→ 自动 staticCall 模拟 → 通过 → 签名广播 → 返回 txHash
```

---

## 五、Session Key MCP (`:9111`) — 7 tools (v0.1.0 新增)

跨项目自动化交易授权。用户一次 EIP-712 签名，Session Key 在有效期内自动代签交易。

### 工具列表

| Tool | 描述 | 参数 |
|------|------|------|
| `sk_nonce` | 获取一次性签名 nonce（15min TTL） | user (0x...) |
| `sk_create_session` | 创建 Session Key 授权 | signature, chain, contracts, functions?, validDays?, maxPerTx?, maxTotal?, userAddress, nonce |
| `sk_list_sessions` | 列出用户所有 Session | user, chain?, status? |
| `sk_get_session` | 查询单个 Session 详情 | sessionId |
| `sk_revoke_session` | 撤销 Session Key | sessionId |
| `sk_execute` | 通过 Session Key 执行交易 | sessionId, chain, to, data, value?, gasLimit? |
| `sk_status` | 健康检查 | — |

### 授权流程

```
1. sk_nonce(user) → { nonce, message }
2. 用户在主钱包中 EIP-712 签名 message
3. sk_create_session(signature, chain, contracts, userAddress, nonce) → { id, sessionAddress, validUntil }
4. sk_execute(sessionId, to, data) → { txHash }  // 有效期内可多次调用
5. sk_revoke_session(sessionId)                    // 手动撤销
```

### 使用示例

```
用户: "授权 Session Key 在 Uniswap 上自动 swap，30 天有效，每次最多 1000 USDC"
→ sk_nonce(user="0xUserAddress")
→ 用户签名返回的 message
→ sk_create_session(
    signature="0x...",
    chain="eth",
    contracts="0xUniswapRouter",
    validDays="30",
    maxPerTx="1000",
    userAddress="0xUserAddress",
    nonce="..."
  )

用户: "用 Session Key swap 100 USDC 换 ETH"
→ sk_execute(
    sessionId="session-uuid",
    chain="eth",
    to="0xUniswapRouter",
    data="0xswapEncodedCallData"
  )

用户: "这个 Session Key 已经用完了，撤销它"
→ sk_revoke_session(sessionId="session-uuid")
```

### 安全机制

- **合约白名单**: permissions.contracts 精确校验目标地址
- **函数选择器白名单**: 4-byte selector 级粒度控制
- **三重额度**: 单笔(maxPerTx) / 累计 / 总额度(maxTotal)
- **私钥加密**: AES-256-GCM，密钥从 ENCRYPTION_KEY 环境变量注入
- **分布式锁**: Redis `lock:session:{id}` NX 防并发
- **Nonce 防重放**: 15 分钟 TTL，一次性消费

### 环境变量

```bash
SESSION_KEY_URL=http://localhost:3500
SESSION_KEY_API_KEY=your-api-key
```

---

## 技术选型

| 项 | 选择 | 理由 |
|----|------|------|
| MCP SDK | `@modelcontextprotocol/sdk` | 官方，TypeScript 原生 |
| 传输模式 | SSE / HTTP Streamable | 可复用 Express 端口 |
| 认证 | 内网模式（可按服务配 API Key） | 后续可加统一认证 |
| 部署 | systemd unit，独立进程 | 崩溃自动重启 |
| 端口 | :9103/:9105/:9108/:9110/:9111 | 按服务独立 |

## MCP Tool 设计原则

1. **一个 Tool 做一件事** — 合并查询逻辑，不和 REST endpoint 1:1
2. **参数有默认值** — `limit` 默认 20，`chain` 默认 ethereum
3. **返回值自然语言友好** — 避免裸数据库字段名
4. **错误信息可读** — "Safe not found: 0xABC"，不返回 "404"
5. **敏感操作确认** — `mpc_send_transaction` 先模拟再执行；Session Key 有三重额度校验
