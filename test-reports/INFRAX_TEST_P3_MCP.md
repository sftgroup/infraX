# InfraX 端到端全场景测试文档 — P3: MCP 接入测试

> v0.3.3-20260720 | 生产 `43.156.99.215` | 文档版本 v1.0

## 概述

以 **AI Agent 开发者**视角验证 InfraX MCP Server 接入全链路：
```
MCP 配置 → SSE 连接 → Tool 调用 → 结果返回 → 多轮对话 → 错误处理
```
覆盖 **4 个 MCP Server、46 个 Tools**。

### MCP 服务拓扑

```
┌─ Wallet MCP  :9110  (10 tools) ── pocketx_waas DB
├─ DC MCP      :9103  ( 7 tools) ── pocketx_dc / collector DB
├─ Vault MCP   :9108  (14 tools) ── pocketx_vault DB
└─ MPC MCP     :9105  (15 tools) ── pocketx_mpc DB
```

### 参考文档
- `docs/API_ACCESS.md` §二 — MCP Server 配置、工具速查、使用示例
- `docs/MCP_REQUIREMENTS.md` — 需求文档、路由图、设计原则

---

## 场景 1: MCP 连接 & 初始化

### 1.1 Wallet MCP (`:9110`)

| 步骤 | 操作 | 预期 |
|------|------|------|
| 1.1a | GET `http://43.156.99.215:9110/mcp/sse` | SSE stream 建立，返回 `endpoint` 事件 |
| 1.1b | POST JSON-RPC `initialize` | 返回 `{ serverInfo: { name: "pocketx-wallet", version: "0.3.2" } }` |
| 1.1c | POST `tools/list` | 返回 10 个 tool 定义 |

### 1.2 DC MCP (`:9103`)

| 步骤 | 操作 | 预期 |
|------|------|------|
| 1.2a | GET `http://43.156.99.215:9103/mcp/message` | SSE 连接成功 |
| 1.2b | `initialize` | `{ name: "pocketx-dc", version: "0.3.2" }` |
| 1.2c | `tools/list` | 返回 7 个 tool 定义 |

### 1.3 Vault MCP (`:9108`)

| 步骤 | 操作 | 预期 |
|------|------|------|
| 1.3a | GET `http://43.156.99.215:9108/mcp/sse` | SSE 连接成功 |
| 1.3b | `initialize` | `{ name: "pocketx-vault", version: "0.3.2" }` |
| 1.3c | `tools/list` | 返回 14 个 tool 定义 |

### 1.4 MPC MCP (`:9105`)

| 步骤 | 操作 | 预期 |
|------|------|------|
| 1.4a | GET `http://43.156.99.215:9105/mcp/sse` | SSE 连接成功 |
| 1.4b | `initialize` | `{ name: "pocketx-mpc", version: "0.3.2" }` |
| 1.4c | `tools/list` | 返回 15 个 tool 定义 |

### 验证点
- [ ] 4 个 MCP Server 全部 SSE 连接成功
- [ ] `tools/list` 返回正确数量 (10/7/14/15 = 46)
- [ ] 版本号统一 (`0.3.2`)

---

## 场景 2: Wallet MCP — 10 Tools

### Tool 清单

| # | Tool | 参数 | 映射 REST |
|---|------|------|------|
| 2.1 | `wallet_balance` | `address, chain` | `GET /api/v2/wallet/balance` |
| 2.2 | `wallet_send` | `to, amount, chain` (≤0.05 ETH) | `POST /api/v2/tx` |
| 2.3 | `wallet_simulate` | `from, to, amount, chain` | Gas 估算 |
| 2.4 | `wallet_rpc` | — | RPC 端点 |
| 2.5 | `wallet_health` | — | 健康检查 |
| 2.6 | `wallet_sweep` | `chain` | `POST /api/v2/saas/sweep` |
| 2.7 | `wallet_status` | `txHash, chain` | 交易状态 |
| 2.8 | `payment_create` | `planId, amount` | `POST /api/v2/payment/create` |
| 2.9 | `payment_status` | `paymentId` | `GET /api/v2/payment/status` |
| 2.10 | `x402_pay` | `recipient, amount` | `POST /api/v2/payment/x402/pay` |

### 测试: AI 自然语言 → Tool 调用映射

| 用户话语 | 预期 Tool 调用 | 预期返回 |
|------|------|------|
| "查一下 0xcaCD... 在 Sepolia 上的余额" | `wallet_balance(address="0xcaCD...", chain="sepolia")` | `{ balance, symbol, tokens }` |
| "给 0xABC 转 0.01 ETH" | `wallet_send(to="0xABC", amount="0.01", chain="sepolia")` | `{ txHash }` |
| "这笔交易 0xDEF... 怎么样了" | `wallet_status(txHash="0xDEF...", chain="sepolia")` | `{ status: "confirmed" }` |
| "归集 Sepolia 上的资金" | `wallet_sweep(chain="sepolia")` | `{ txHash }` |
| "估算转 0.01 ETH 的 Gas" | `wallet_simulate(from="0x...", to="0xABC", amount="0.01", chain="sepolia")` | `{ gasLimit, gasPrice, totalCost }` |

### 验证点
- [ ] 5 个自然语言场景全部正确路由到 Tool
- [ ] `wallet_send` 限额 0.05 ETH 生效
- [ ] 返回格式自然语言友好（非裸 DB 字段）

---

## 场景 3: DC MCP — 7 Tools

### Tool 清单

| # | Tool | 参数 | 映射 |
|---|------|------|------|
| 3.1 | `dc_events` | `chain, address?, event_type?, limit?` | `GET /api/v2/data/events` |
| 3.2 | `dc_stats` | — | `GET /api/v2/data/stats` |
| 3.3 | `dc_checkpoints` | `chain` | `GET /api/v2/data/checkpoints` |
| 3.4 | `dc_plans` | — | `GET /api/v2/data/plans` |
| 3.5 | `dc_tokens` | `chain` | `GET /api/v2/data/tokens` |
| 3.6 | `dc_chains` | — | `GET /api/v2/data/chains` |
| 3.7 | `dc_price` | `symbol` (如 BTC, ETH) | Binance API |

### 测试: AI 自然语言 → Tool 调用映射

| 用户话语 | 预期 Tool 调用 | 预期返回 |
|------|------|------|
| "Sepolia 上最近 50 个 Transfer 事件" | `dc_events(chain="sepolia", event_type="Transfer", limit=50)` | `{ events: [...总览...] }` |
| "ETH 现在什么价" | `dc_price(symbol="ETH")` | `{ price, change24h }` |
| "数据套餐有哪些" | `dc_plans()` | `[Free, Pro, Enterprise]` |
| "支持哪些链" | `dc_chains()` | `[{ sepolia, ethereum, bsc, base, solana, ... }]` |
| "Sepolia 扫到多少区块了" | `dc_checkpoints(chain="sepolia")` | `{ latestBlock, lag }` |

### 验证点
- [ ] 5 个自然语言场景路由正确
- [ ] `dc_price` 返回实时 Binance 价格
- [ ] `dc_checkpoints.lag` ≤ 20 blocks（不落后太多）

---

## 场景 4: Vault MCP — 14 Tools

### Tool 清单

| # | Tool | 参数 | 映射 |
|---|------|------|------|
| 4.1 | `vault_dashboard` | — | `GET /api/vault/dashboard` |
| 4.2 | `vault_safes` | `chain?, status?` | `GET /api/vault/safe/list` |
| 4.3 | `vault_safe_info` | `safeId` | `GET /api/vault/safe/:address` |
| 4.4 | `vault_create_safe` | `signers, threshold, chain` | `POST /api/vault/safe/create` |
| 4.5 | `vault_update_owners` | `address, owners, threshold` | — |
| 4.6 | `vault_create_tx` | `safeId, to, amount` | `POST /api/vault/safe/propose` |
| 4.7 | `vault_confirm_tx` | `safeAddress, safeTxHash, signature` | `POST /api/vault/safe/confirm` |
| 4.8 | `vault_execute_tx` | `safeTxHash` | `POST /api/vault/safe/execute` |
| 4.9 | `vault_retry` | `chainId` | 重试部署 |
| 4.10 | `vault_execute_ready` | `safeAddress` | 批量执行 |
| 4.11 | `vault_sync` | `safeAddress` | `POST /api/vault/safe/sync` |
| 4.12 | `vault_status` | `walletAddress` | `GET /api/vault/safe/status` |
| 4.13 | `vault_risk_check` | `to, amount` | `POST /api/vault/risk/check` |

### 测试: 2/3 多签全流程 → MCP

```
用户: "帮我在 Sepolia 上创建 2/3 多签，owners 是 A, B, C"
→ vault_create_safe(signers=[A,B,C], threshold=2, chain="sepolia")
→ 返回 Safe 地址 0xSAFE...

用户: "在这个 Safe 里提一个给 0xRECIPIENT 转 0.5 ETH 的提案"
→ vault_create_tx(safeId="0xSAFE...", to="0xRECIPIENT", amount="0.5")
→ 返回 { safeTxHash: "0xABOD..." }

用户 (Owner A): "我确认这个提案"
→ vault_confirm_tx(safeAddress="0xSAFE...", safeTxHash="0xABOD...", signature=A_sig)
→ 返回 { approvals: ["A"], thresholdMet: false }

用户 (Owner B): "我也确认"
→ vault_confirm_tx(...)
→ 返回 { approvals: ["A","B"], thresholdMet: true }

用户: "现在执行"
→ vault_execute_tx(safeTxHash="0xABOD...")
→ 返回 { chainTxHash: "0xOK...", status: "executed" }
```

### 验证点
- [ ] `vault_dashboard` 返回总览数据
- [ ] `vault_create_safe` → `vault_create_tx` → `vault_confirm_tx`×2 → `vault_execute_tx` 完整闭环
- [ ] 阈值未达时 `vault_execute_tx` 被拒绝
- [ ] `vault_sync` 同步链上状态
- [ ] `vault_risk_check` 返回风险评估

---

## 场景 5: MPC MCP — 15 Tools (v0.3.0)

### Tool 清单

| # | 类别 | Tool | 认证 | 说明 |
|---|------|------|:--:|------|
| 5.1 | 钱包 | `mpc_send_code` | JWT | 发验证码 |
| 5.2 | 钱包 | `mpc_register` | JWT | 注册 |
| 5.3 | 钱包 | `mpc_recover` | JWT | 恢复 |
| 5.4 | 钱包 | `mpc_status` | JWT | 查询状态 |
| 5.5 | 钱包 | `mpc_create_wallet` | JWT | 一键创建 |
| 5.6 | 会话 | `mpc_session_unlock` | JWT | 解锁→token |
| 5.7 | 会话 | `mpc_session_lock` | Session | 锁定 |
| 5.8 | 会话 | `mpc_session_status` | Session | 查询会话 |
| 5.9 | 操作 | `mpc_balance` | Session | 查余额 |
| 5.10 | 操作 | `mpc_sign_message` | Session | EIP-191 |
| 5.11 | 操作 | `mpc_sign_typed_data` | Session | EIP-712 |
| 5.12 | 操作 | `mpc_send_transaction` | Session | 转账 ≤0.1 ETH |
| 5.13 | 操作 | `mpc_contract_read` | JWT | 合约只读 |
| 5.14 | 操作 | `mpc_contract_write` | Session | 合约写 |
| 5.15 | 操作 | `mpc_gas_estimate` | JWT | Gas 估算 |

### 测试: Agent Wallet 全流程

```
用户: "帮我创建 MPC 钱包"
→ mpc_create_wallet(email="agent@infrax.io")
→ 发码 → 等待 → 注册完成 → 返回 { address: "0xcaCD..." }

用户: "查一下 MPC 钱包余额"
→ mpc_balance(token="mpc_xxx", chain="sepolia")
→ 返回 { native: "0.5 ETH", tokens: [...] }

用户: "解锁钱包，我要做交易"
→ mpc_session_unlock(email="agent@infrax.io", code="123456")
→ 返回 { token: "mpc_a1b2...", expiresAt }

用户: "用 AI 签名 'Hello InfraX'"
→ mpc_sign_message(token="mpc_a1b2...", message="Hello InfraX")
→ 返回 { signature: "0x..." }

用户: "approve 100 USDT 给 Router 合约"
→ mpc_contract_write(token="mpc_a1b2...", contractAddress="0xUSDT", abi: [...], method: "approve", args: ["0xRouter", "100000000"])
→ 自动 staticCall 模拟 → 签名 → 广播 → 返回 { txHash }

用户: "转账完成，锁上钱包"
→ mpc_session_lock(token="mpc_a1b2...")
→ 返回 locked → 后续操作返回 session expired
```

### 验证点
- [ ] 15 tools 全部可调用
- [ ] Session token 30min TTL 生效
- [ ] `lock` 后操作被拒绝
- [ ] `mpc_contract_write` 先模拟再执行
- [ ] 转账限额 0.1 ETH 生效
- [ ] `mpc_sign_message` / `mpc_sign_typed_data` 返回有效签名

---

## 场景 6: MCP 配置集成 (OpenClaw / Claude Desktop)

### 6.1 OpenClaw 配置

```json
{
  "mcpServers": {
    "pocketx-wallet": { "url": "http://43.156.99.215:9110/mcp/sse" },
    "pocketx-dc": { "url": "http://43.156.99.215:9103/mcp/message" },
    "pocketx-vault": { "url": "http://43.156.99.215:9108/mcp/sse" },
    "pocketx-mpc": { "url": "http://43.156.99.215:9105/mcp/sse" }
  }
}
```

### 验证点
- [ ] OpenClaw Gateway 加载 4 MCP Server 配置无报错
- [ ] `tools/list` 发现 46 tools
- [ ] AI 可以用自然语言调用所有 tools

---

## 场景 7: MCP 跨 Tool 联动测试

### 7.1 "全面了解我的账户"
```
用户: "给我一个完整的账户总览"

AI 调用:
→ wallet_health()                          // 服务状态
→ mpc_status(email="agent@infrax.io")      // MPC 注册状态
→ wallet_balance(address="0x...", chain)   // 钱包余额
→ vault_dashboard()                        // Vault 概览
→ dc_plans()                               // 数据套餐
→ dc_usage()                               // 用量

→ 汇总输出: "您的 InfraX 账户: MPC ✓ 已注册 | 余额 0.5 ETH | Vault 0 Safe | DC Free 套餐 0/10000"
```

### 7.2 "帮我部署 + 交易 + 监控"
```
用户: "在 Sepolia 上用 MPC 钱包创建一个 2/3 Safe, 转 0.01 ETH 进去, 然后看这笔交易"

AI 调用:
→ mpc_session_unlock(email, code)           // 解锁
→ vault_create_safe(signers, threshold)     // 创建 Safe
→ wallet_send(to=safeAddress, amount)       // 转账
→ wallet_status(txHash)                     // 查状态
→ vault_safe_info(safeId)                   // 确认余额
→ mpc_session_lock(token)                   // 锁定

→ 每步输出 txHash, 最终输出 Safe 余额确认
```

### 验证点
- [ ] 跨 3 MCP Server 的无缝切换
- [ ] 多个 tool 的返回整合正确
- [ ] 最终输出自然语言汇总

---

## 场景 8: MCP 错误处理

| # | 场景 | 预期 |
|---|------|------|
| 8.1 | SSE 断开重连 | 自动重连, `tools/list` 恢复 |
| 8.2 | `wallet_send` 超限额 (>0.05) | `{ error: "Exceeds wallet_send limit of 0.05 ETH" }` |
| 8.3 | `mpc_session_unlock` 错误 code | `{ error: "Invalid verification code" }` |
| 8.4 | `vault_confirm_tx` 非 owner | `{ error: "Not a safe owner" }` |
| 8.5 | `dc_events` 不支持 chain | `{ error: "Unsupported chain: xxx" }` |
| 8.6 | Session token 过期 | `{ error: "Session expired, please unlock again" }` |
| 8.7 | MCP Server 崩溃恢复 | systemd 自动重启, 10s 内 `tools/list` 恢复 |

### 验证点
- [ ] 7 种错误场景按预期返回
- [ ] 错误信息可读（非 404、非裸 HTTP 状态码）
- [ ] 自动恢复机制有效

---

## Tool 覆盖率总表

| MCP Server | 端口 | Tools | 状态 | 测试覆盖 |
|------------|:---:|:-----:|:----:|:----:|
| Wallet MCP | 9110 | 10 | 🟢 Running | 10/10 |
| DC MCP | 9103 | 7 | 🟢 Running | 7/7 |
| Vault MCP | 9108 | 14 | 🟢 Running | 14/14 |
| MPC MCP | 9105 | 15 | 🟢 Running | 15/15 |
| **合计** | — | **46** | 🟢 | **46/46** |

### 测试通过标准

| 类别 | 标准 |
|------|------|
| 连接 | 4 Server SSE 全部 `200` |
| Tool 发现 | `tools/list` 返回 46 tools |
| 自然语言 | 10+ 话语场景正确映射到 Tool |
| 跨模块 | 2 条多 Tool 联动链路通过 |
| 错误处理 | 7 种错误场景按预期 |
| 配置 | OpenClaw `mcpServers` 正确加载 |
| 恢复 | SSE 断连 → 自动重连 <20s |

---

> **下一文档**: P4 — Admin 管理后台 (12 服务监控 + 租户/交易管理)
