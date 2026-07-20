# InfraX 端到端全场景测试文档 — P6: 业务模块深度测试

> v0.3.3-20260720 | 生产 `43.156.99.215` | 文档版本 v1.0

## 概述

以**业务集成者**视角深度验证 WaaS、Vault、Data Center、Payment、Collector 五大模块：
```
WAAS 租户全生命周期 → Vault 多签全流程 → DC 数据订阅闭环
→ Payment 支付引擎 → Collector 事件采集
```
覆盖 **5 个模块、50+ 端点**。

### 参考文档
- `docs/API_ACCESS.md` §WAAS, Vault, DC, Payment, Collector
- `docs/MCP_REQUIREMENTS.md` §Phase 1-3
- `DEPLOYMENT.md` — 各服务 DB 与 systemd

---

# PART A: WaaS (Wallet-as-a-Service) — :9109

## 场景 A1: 租户创建 & 激活

| 步骤 | 端点 | 操作 | 预期 |
|------|------|------|------|
| A1.1 | `POST /saas/tenants` | `{ name: "MyDApp", contactEmail: "dev@mydapp.io" }` | `{ tenantId, name, status: "inactive" }` |
| A1.2 | `GET /saas/tenants/my` | — | `{ tenants: [{ tenantId, name, status }] }` |
| A1.3 | `POST /saas/tenants/activate` | `{ tenantId }` | `200 activated` |
| A1.4 | 重复创建同名 | — | `400 { message: "Tenant name exists" }` |
| A1.5 | 未激活直接分配地址 | `POST /saas/address` | `400 { message: "Tenant not active" }` |

## 场景 A2: 存款地址管理

| 步骤 | 端点 | 操作 | 预期 |
|------|------|------|------|
| A2.1 | `POST /saas/address` | `{ tenantId, chain: "sepolia" }` | `{ allocationId, depositAddress }` |
| A2.2 | `POST /saas/addresses` 批量 | `{ tenantId, chain, count: 10 }` | `{ allocated: 10, addresses: [...] }` |
| A2.3 | `GET /saas/addresses?tenantId=...` | 查询 | `{ total: 11, addresses }` |
| A2.4 | 批量 count > 100 | `{ count: 200 }` | `400 { message: "Max 100 per batch" }` |
| A2.5 | 无效 chain `{ chain: "moonbeam" }` | — | `400 { message: "Unsupported chain" }` |

## 场景 A3: API Key 管理

| 步骤 | 端点 | 操作 | 预期 |
|------|------|------|------|
| A3.1 | `POST /saas/tenants/:id/apikey` | 生成 Key | `{ apiKey: "sk-...", prefix: "sk-abc1", createdAt }` |
| A3.2 | 用新 Key 调 API | `x-api-key: sk-...` | `200` → 该 Key 绑定此 tenant |
| A3.3 | `POST /saas/tenants/:id/apikey/rotate` | 轮换 Key | 新 Key 生效, 旧 Key 30min 缓冲期 |
| A3.4 | 旧 Key 在缓冲期后 | — | `401 { message: "API key expired" }` |
| A3.5 | `DELETE /saas/tenants/:id/apikey` | 吊销 Key | Key 立即失效 |

## 场景 A4: 热钱包 & 归集

| 步骤 | 端点 | 操作 | 预期 |
|------|------|------|------|
| A4.1 | `POST /saas/tenants/:id/hot-wallet` | 生成热钱包 | `{ hotWalletAddress, chain }` |
| A4.2 | `POST /saas/sweep` | `{ chain: "sepolia" }` | `{ txHash, count, totalAmount }` |
| A4.3 | Sweep 后查余额 | `GET /wallet/balance?address=hotWallet` | 余额归零 (已归集) |
| A4.4 | Sweep 无余额 | — | `{ message: "Nothing to sweep" }` |

## 场景 A5: 提现队列

| 步骤 | 端点 | 操作 | 预期 |
|------|------|------|------|
| A5.1 | `GET /saas/withdrawals?tenantId=...` | 查询队列 | `{ total, withdrawals: [...] }` |
| A5.2 | 筛选状态 | `?status=pending` | 只显示 pending |

---

# PART B: Vault 多签保险库 — :9107

## 场景 B1: 创建 Safe & 基础操作

| 步骤 | 端点 | 操作 | 预期 |
|------|------|------|------|
| B1.1 | `POST /safe/create` | `{ signers: [A,B,C], threshold: 2, chain: "sepolia" }` | `{ address: "0xSAFE..." }` |
| B1.2 | `GET /safe/list?signer=A` | — | `{ safes: [{ address, owners, threshold }] }` |
| B1.3 | `GET /safe/:address` | 查询详情 | `{ balance, owners, threshold, nonce }` |
| B1.4 | 1 owner 创建 | `{ signers: [A], threshold: 1 }` | `400 { message: "At least 2 owners" }` |
| B1.5 | threshold > owners | `{ signers: [A,B], threshold: 3 }` | `400 { message: "threshold <= owners" }` |

## 场景 B2: 多签交易全流程

| 步骤 | 端点 | 操作 | 预期 |
|------|------|------|------|
| B2.1 | `POST /safe/propose` | `{ safeAddress, to: RECIPIENT, value: "0.5", data: "" }` | `{ safeTxHash, nonce }` |
| B2.2 | 重复提交相同 nonce | — | `400 { message: "Nonce already used" }` |
| B2.3 | `POST /safe/confirm` | Owner A 签名 `{ safeAddress, safeTxHash }` | `{ confirmations: 1, threshold: 2, executable: false }` |
| B2.4 | Owner B 签名 | — | `{ confirmations: 2, executable: true }` |
| B2.5 | Owner A 重复签名 | — | `400 { message: "Already confirmed" }` |
| B2.6 | 非 owner C 签名 | `{ owner: "0xNOT_OWNER" }` | `403 { message: "Not a safe owner" }` |
| B2.7 | 阈值未达执行 | `POST /safe/execute` | `400 { message: "Threshold not met" }` |
| B2.8 | 阈值达到后执行 | `POST /safe/execute` | `{ chainTxHash, status: "executed" }` |

## 场景 B3: Safe 管理

| 步骤 | 端点 | 操作 | 预期 |
|------|------|------|------|
| B3.1 | `GET /dashboard` | 金库总览 | `{ totalSafes, totalValue, activeTxs, pendingTxs }` |
| B3.2 | `POST /safe/sync` | `{ safeAddress }` | 同步链上 owner/threshold/nonce |
| B3.3 | `POST /risk/check` | `{ to, amount, tokenAddress }` | `{ riskLevel: "low"\|"medium"\|"high", factors }` |
| B3.4 | `GET /safe/status?walletAddress=...` | Safe 服务状态 | `{ deployed, ready }` |

## 场景 B4: Vault 批量操作

| 步骤 | 端点 | 操作 | 预期 |
|------|------|------|------|
| B4.1 | `vault_execute_ready` (admin) | 批量执行所有达到阈值的 safe tx | `{ executed: 2, failed: 0 }` |

---

# PART C: Data Center 链上数据 — :9102

## 场景 C1: 事件查询

| 步骤 | 端点 | 操作 | 预期 |
|------|------|------|------|
| C1.1 | `GET /events` | `?chain=sepolia&contract=0xUSDT&event_type=Transfer&limit=20` | `{ total, events: [{ txHash, blockNumber, from, to, value }] }` |
| C1.2 | 多合约查询 | `?chain=sepolia&contract=0xA,0xB` | 返回两个合约的事件（或仅支持单合约 400） |
| C1.3 | limit 默认值 | 不传 limit | 默认 100 |
| C1.4 | limit=0 | — | `400` 或自动回退到 1 |
| C1.5 | 不支持的 chain | `?chain=moonbeam` | `400 { message: "Unsupported chain" }` |
| C1.6 | 无效合约地址 | `?contract=0xINVALID` | `400 { message: "Invalid contract address" }` |

## 场景 C2: 区块位点 & 统计

| 步骤 | 端点 | 操作 | 预期 |
|------|------|------|------|
| C2.1 | `GET /checkpoints?chain=sepolia` | — | `{ chain, latestBlock, scannedBlock, lag }` |
| C2.2 | `GET /stats` | — | `{ totalEvents, totalChains, totalSubscriptions, uptime }` |
| C2.3 | scanner 落后 | `lag > 20` | 告警 (scanner 可能宕机) |

## 场景 C3: 数据套餐

| 步骤 | 端点 | 操作 | 预期 |
|------|------|------|------|
| C3.1 | `GET /plans` | — | `[{ name: "Free", monthlyQuota: 10000, price: 0 }, ...]` |
| C3.2 | `GET /tokens?chain=ethereum` | — | `[{ address, symbol, name, decimals }]` |
| C3.3 | `GET /chains` | — | `[{ chainId, name, status, rpcUrl }]` |
| C3.4 | `GET /balance?address=...` | 跨链余额 | `{ balances: [{ chain, native, tokens }] }` |
| C3.5 | `GET /usage` | — | `{ currentUsage, monthlyQuota, resetDate }` |

## 场景 C4: 数据订阅

| 步骤 | 端点 | 操作 | 预期 |
|------|------|------|------|
| C4.1 | `POST /subscribe` | `{ planId, chain: "sepolia", eventTypes: ["Transfer"], webhookUrl: "https://mydapp.io/webhook" }` | `{ subscriptionId }` |
| C4.2 | 等待事件 → webhook 推送 | — | 收到 `POST https://mydapp.io/webhook` (Transfer 事件) |
| C4.3 | Usage 计数 | `GET /usage` | `currentUsage += 1` |
| C4.4 | 超配额订阅 | — | `429 { message: "Quota exceeded" }` |
| C4.5 | 取消订阅 | `DELETE /subscriptions/:id` | `200` |

---

# PART D: Payment 支付引擎 — :9110

## 场景 D1: 支付订单

| 步骤 | 端点 | 操作 | 预期 |
|------|------|------|------|
| D1.1 | `POST /payment/create` | `{ planId, amount, chain: "sepolia" }` | `{ orderId, paymentAddress, amount, expiresAt }` |
| D1.2 | `GET /payment/status?orderId=...` | 查询订单 | `{ status: "pending"\|"paid"\|"expired" }` |
| D1.3 | 向 paymentAddress 转账 | — | 订单自动确认 → status: "paid" |
| D1.4 | 订单过期 (超过 expireAt) | — | status: "expired" |

## 场景 D2: x402 HTTP 支付

| 步骤 | 端点 | 操作 | 预期 |
|------|------|------|------|
| D2.1 | 访问付费内容端点 | 返回 HTTP 402 | `{ paymentRequired: true, orderId }` |
| D2.2 | `POST /payment/x402/pay` | `{ orderId }` | `{ paid: true, accessToken }` |
| D2.3 | 用 accessToken 重试 | — | 200 内容返回 |

---

# PART E: Collector 事件采集 — :31210

## 场景 E1: 采集器状态

| 步骤 | 端点 | 操作 | 预期 |
|------|------|------|------|
| E1.1 | `GET /collector/status` | — | `{ chains: { sepolia: { latestBlock, rate, lag } }, uptime }` |
| E1.2 | `GET /collector/chains` | — | `[{ name, status, latestBlock, events }]` |

## 场景 E2: 事件查询 (直接)

| 步骤 | 端点 | 操作 | 预期 |
|------|------|------|------|
| E2.1 | `GET /collector/events?chain=sepolia&contract=0xUSDT` | — | `{ total, events }` |
| E2.2 | `GET /collector/stats` | — | `{ eventsCollected, eventsPerSecond, errors }` |

---

# PART F: 跨模块端到端集成

## 场景 F1: WaaS → Payment (托管收款闭环)

```
1. Create Tenant → Generate API Key
2. Allocate 5 deposit addresses (sepolia)
3. Payment: Create Order (Pro Plan)
4. User sends ETH to one deposit address
5. WAAS detects deposit → Payment status: "paid"
6. WAAS sweep all deposit addresses → hot wallet
7. Verify hot wallet balance = sweep amount
8. Admin views Payment revenue → new order reflected
```

## 场景 F2: MPC → Vault → Scanner (多签操作验证)

```
1. MPC unlock → query balance: 0.5 ETH
2. Vault: Create Safe (MPC address as owner + 2 others)
3. Transfer 0.1 ETH from MPC → Safe address (MPC send-transaction)
4. Scanner: search Safe address → balance = 0.1 ETH
5. Vault: propose Safe transfer 0.05 ETH → MPC sign → execute
6. Scanner: search Safe tx → confirmed
7. MPC: check tx history → Safe interaction visible
```

## 场景 F3: DC → Collector → Payment (数据订阅付费闭环)

```
1. User subscribes to DC Pro plan via Payment
2. DC: create data subscription → webhook endpoint
3. Collector: push Transfer events to webhook
4. DC: usage count per event → visible in /usage
5. Monthly: Payment charges for Pro plan (if exceeded Free quota)
```

## 场景 F4: Admin 全平台监控

```
1. Admin: 12 service health → all green
2. Admin: tenant list → new tenant from F1 visible
3. Admin: MPC wallet list → new MPC from F2 visible
4. Admin: Vault safe list → new Safe from F2 visible
5. Admin: transactions → F1 sweep + F2 transfer visible
6. Admin: revenue dashboard → F3 payment visible
7. Admin: audit log → all admin actions recorded
```

---

## 负面测试总表

| # | 模块 | 场景 | 预期 |
|---|------|------|------|
| NB1 | WAAS | 重复 tenant name | 400 |
| NB2 | WAAS | 未激活分配地址 | 400 |
| NB3 | WAAS | 批量 count > 100 | 400 |
| NB4 | WAAS | 无效 chain | 400 |
| NB5 | WAAS | 吊销的 Key 调用 | 401 |
| NB6 | WAAS | sweep 无余额 | 200 空归集 |
| NB7 | Vault | 1 owner safe | 400 |
| NB8 | Vault | threshold > owners | 400 |
| NB9 | Vault | 重复签名 | 400 |
| NB10 | Vault | 非 owner 签名 | 403 |
| NB11 | Vault | 阈值未达执行 | 400 |
| NB12 | DC | 无效 chain events | 400 |
| NB13 | DC | 无效合约地址 | 400 |
| NB14 | DC | 超配额订阅 | 429 |
| NB15 | Payment | 订单过期 | status expired |
| NB16 | Payment | 重复支付 | 幂等处理或 400 |
| NB17 | Collector | 不支持 chain | 400 |

---

## 性能基线

| 端点 | QPS | P50 | P99 |
|------|:---:|:---:|:---:|
| `GET /saas/tenants/my` | 50 | <100ms | <500ms |
| `GET /vault/safe/list` | 50 | <100ms | <500ms |
| `GET /data/events` | 20 | <500ms | <2s |
| `POST /payment/create` | 20 | <200ms | <1s |
| `GET /collector/events` | 10 | <1s | <5s |

### 测试通过标准

| 类别 | 标准 |
|------|------|
| WAAS | Tenant create → activate → address → API Key → sweep 全链路 |
| Vault | Safe create → propose → confirm(2) → execute 2/3 多签闭环 |
| DC | events 查询 + plans + subscription + webhook 推送 |
| Payment | create → 支付 → status 确认 |
| Collector | 状态/链/事件查询 |
| 集成 | 4 条跨模块链路全部通过 |
| 负面 | 17 种错误场景按预期返回 |

---

> 📋 **InfraX 6 份测试文档总索引**
>
> | # | 文档 | 视角 | 场景 | 端点 |
> |---|------|------|:--:|:--:|
> | P1 | [入驻+Dashboard](INFRAX_TEST_P1_ONBOARDING.md) | 新用户 | 10 | 8 |
> | P2 | [REST API 全链路](INFRAX_TEST_P2_REST_API.md) | 后端开发者 | 10 | 80+ |
> | P3 | [MCP 接入](INFRAX_TEST_P3_MCP.md) | AI Agent | 8 | 46 tools |
> | P4 | [Admin 管理](INFRAX_TEST_P4_ADMIN.md) | 平台管理员 | 10 | 20+ |
> | P5 | [MPC 深度](INFRAX_TEST_P5_MPC_DEEP.md) | 终端用户 | 9 | 14 |
> | P6 | [业务模块深度](INFRAX_TEST_P6_MODULES.md) | 集成开发者 | 20 | 50+ |
> | **合计** | — | — | **67** | **160+** |
