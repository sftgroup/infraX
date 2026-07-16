# InfraX MCP 化 — 需求文档

> v0.3.0-20260717 | stevenwang | team6

## 背景

将 WAAS、Vault、DC、MPC 四个后端服务做成 MCP Server，供 AI（OpenClaw、Claude Desktop、Cursor 等）直接调用。用户用自然语言操作 Web3 能力，AI 不必理解 REST 路由和参数格式。

## 架构

```
                         ┌─ vault-mcp  (:3006) ── pocketx_vault DB
                         │
AI Agent ── MCP 协议 ──┼─ waas-mcp   (:3004) ── pocketx_waas DB
                         │
                         ├─ dc-mcp     (:3005) ── pocketx_dc / pocketx_collector DB
                         │
                         └─ mpc-mcp    (:3007) ── pocketx_mpc DB (15 tools, v0.3.0)
```

每个 MCP Server 是独立运行的 Express 进程（SSE 模式），通过 `systemd` 托管，复用对应 DB 连接池。

## 路由图

### Phase 1: Vault MCP（已完成）

**Tools (14 个)**:

| Tool | 对应 API | 描述 |
|------|---------|------|
| `vault_dashboard` | GET /api/vault/dashboard | 金库总览 |
| `vault_safes` | GET /api/vault/safe/list | 列出多签钱包 |
| `vault_safe_info` | GET /api/vault/safe/:address | Safe 详情 |
| `vault_create_safe` | POST /api/vault/safe/create | 创建多签 |
| `vault_update_owners` | — | 更新签名人 |
| `vault_create_tx` | POST /api/vault/safe/propose | 创建交易提案 |
| `vault_confirm_tx` | POST /api/vault/safe/confirm | 签名确认 |
| `vault_execute_tx` | POST /api/vault/safe/execute | 执行交易 |
| `vault_retry` | — | 重试部署 |
| `vault_execute_ready` | — | 批量执行达标交易 |
| `vault_sync` | POST /api/vault/safe/sync | 同步链上状态 |
| `vault_status` | GET /api/vault/safe/status | 服务状态 |
| `vault_risk_check` | POST /api/vault/risk/check | 风控检查 |

**用户场景示例**:
> "帮我在 Sepolia 上创建一个 2/3 多签钱包，owner 是 A、B、C 三个地址"

→ AI 调 `vault_create_safe(chain="sepolia", signers=[A,B,C], threshold=2)` → 返回 Safe 地址

### Phase 2: WAAS MCP（已完成）

**Tools (10 个)**:

| Tool | 对应 API | 描述 |
|------|---------|------|
| `wallet_balance` | GET /api/v2/wallet/balance | 查询余额 |
| `wallet_send` | POST /api/v2/tx | 发送原生代币（≤0.05 ETH） |
| `wallet_simulate` | — | 估算 Gas |
| `wallet_rpc` | — | 获取 RPC 端点 |
| `wallet_health` | — | 健康检查 |
| `wallet_sweep` | POST /api/v2/saas/sweep | 归集资金 |
| `wallet_status` | — | 交易状态 |
| `payment_create` | POST /api/v2/payment/create | 创建支付 |
| `payment_status` | GET /api/v2/payment/status | 支付状态 |
| `x402_pay` | POST /api/v2/payment/x402/pay | x402 自动支付 |

**用户场景示例**:
> "给 0xABC 转 0.01 ETH"

→ AI 调 `wallet_send(to="0xABC", amount="0.01", chain="sepolia")` → 返回 tx hash

### Phase 3: DC MCP（已完成）

**Tools (7 个)**:

| Tool | 对应 API | 描述 |
|------|---------|------|
| `dc_events` | GET /api/v2/data/events | 查询链上事件 |
| `dc_stats` | GET /api/v2/data/stats | 链上统计 |
| `dc_checkpoints` | GET /api/v2/data/checkpoints | 区块扫描位点 |
| `dc_plans` | GET /api/v2/data/plans | 数据套餐 |
| `dc_tokens` | GET /api/v2/data/tokens | 代币列表 |
| `dc_chains` | GET /api/v2/data/chains | 链列表 |
| `dc_price` | Binance API | 实时价格（ETH, BTC 等） |

### Phase 4: MPC MCP — Agent Wallet（v0.3.0 新增，已完成）

**Tools (15 个)**:

##### 钱包管理（5 个）

| Tool | 描述 |
|------|------|
| `mpc_send_code` | 发送邮箱验证码 |
| `mpc_register` | 注册 MPC 钱包 |
| `mpc_recover` | 恢复 MPC 钱包 |
| `mpc_status` | 查询钱包注册状态 |
| `mpc_create_wallet` | 一键全流程创建 |

##### Agent Wallet 会话管理（3 个）

| Tool | 描述 |
|------|------|
| `mpc_session_unlock` | 🔓 验证码解锁 → 返回 session token（30min TTL） |
| `mpc_session_lock` | 🔒 销毁 session |
| `mpc_session_status` | 📊 查询会话状态 + 剩余时间 |

##### Agent Wallet 操作（7 个）

| Tool | 描述 |
|------|------|
| `mpc_balance` | 💰 查询原生 + ERC20 余额 |
| `mpc_sign_message` | ✍️ EIP-191 签名 |
| `mpc_sign_typed_data` | ✍️ EIP-712 签名 |
| `mpc_send_transaction` | 📤 转账 ETH/ERC20（限额 0.1 ETH） |
| `mpc_contract_read` | 👁️ 合约只读调用 |
| `mpc_contract_write` | 📝 合约写（模拟 → 签名 → 广播） |
| `mpc_gas_estimate` | ⛽ Gas 估算 |

**用户场景示例**:
> "解锁我的 MPC Agent 钱包，然后 approve 100 USDT 给 Router"

→ AI 调 `mpc_session_unlock(email="...", code="...")` 拿到 token
→ 再调 `mpc_contract_write(token="...", contractAddress="0xUSDT", method="approve", args=["0xRouter","100000000"])`
→ 服务端自动 staticCall 模拟 → 签名 → 广播 → 返回 txHash

## 技术选型

| 项 | 选择 | 理由 |
|----|------|------|
| MCP SDK | `@modelcontextprotocol/sdk` | 官方，TypeScript 原生 |
| 传输模式 | **SSE** | 可复用现有 Express 端口 |
| 认证 | 无（当前内网模式） | 后续可加 API Key |
| 部署 | systemd unit，独立进程 | 崩溃自动重启 |
| 端口 | :3004 (Wallet) / :3005 (DC) / :3006 (Vault) / :3007 (MPC) |

## MCP Tool 设计原则

1. **一个 Tool 做一件事** — 不和 REST endpoint 1:1，合并查询逻辑
2. **参数有默认值** — `limit` 默认 20，`chain` 默认 ethereum
3. **返回值是自然语言友好的 JSON** — 避免裸数据库字段名
4. **错误信息可读** — "Safe not found: 0xABC"，不是 "404"
5. **敏感操作确认** — `mpc_send_transaction` 先模拟再执行

## 配置（Claude Desktop / OpenClaw）

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

## 当前状态

| MCP Server | 端口 | Tools | systemd unit | 状态 |
|------------|------|-------|-------------|------|
| Wallet MCP | 3004 | 10 | `infrax-wallet-mcp` | 🟢 |
| DC MCP | 3005 | 7 | `infrax-dc-mcp` | 🟢 |
| Vault MCP | 3006 | 14 | `infrax-vault-mcp` | 🟢 |
| MPC MCP | 3007 | 15 | `infrax-mpc-mcp` | 🟢 |

## 风险

| 风险 | 缓解 |
|------|------|
| MCP SDK 不稳定 | 用 HTTP SSE 模式，不依赖 stdio |
| DB 连接池竞争 | MCP 复用已有 Pool，不新建连接 |
| AI 误操作（发错交易） | `mpc_send_transaction` 设为需要确认；0.1 ETH 限额 |
