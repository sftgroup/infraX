# InfraX 端到端全场景测试文档 — P2: REST API 全链路

> v0.3.3-20260720 | 生产 `43.156.99.215:9111` | 文档版本 v1.0

## 概述

以**后端开发者**视角验证 InfraX REST API 全链路：
```
服务发现 → 认证获取 API Key → 各模块端点调用 → 错误处理 → 限流 → 性能基线
```
覆盖 **12 个服务、80+ 端点**。

### 参考文档
- `docs/API_ACCESS.md` — REST/MCP/SDK 三合一接入指南
- `DEPLOYMENT.md` — 端口与 systemd 服务表
- `README.md` — 架构总览 ($6 API 层详解)

---

## 场景 1: 服务发现 & 健康检查

### 1.1 Web Proxy 统一健康检查
```
GET http://43.156.99.215:9111/api/health
```
**预期**: `200 { "status": "ok", "uptime": <seconds>, "services": { "mpc": "ok", "waas": "ok", ... } }` 

### 1.2 各服务独立健康检查 (10 个)

| 服务 | 端口 | 健康端点 | 预期 |
|------|:---:|------|------|
| DC (Data Center) | 9102 | `GET :9102/health` | `{ status: "ok" }` |
| Scanner | 9103 | `GET :9103/health` | `{ status: "ok" }` |
| MPC | 9104 | `GET :9104/health` | `{ status: "ok" }` |
| Account | 9105 | `GET :9105/health` | `{ status: "ok" }` |
| Security | 9106 | `GET :9106/health` | `{ status: "ok" }` |
| Vault | 9107 | `GET :9107/health` | `{ status: "ok" }` |
| Notification | 9108 | `GET :9108/health` | `{ status: "ok" }` |
| WAAS | 9109 | `GET :9109/health` | `{ status: "ok" }` |
| Payment | 9110 | `GET :9110/health` | `{ status: "ok" }` |
| Collector | 31210 | `GET :31210/health` | `{ status: "ok" }` |

### 验证点
- [ ] Web Proxy `/api/health` 聚合 10+ 服务状态，全部 `ok`
- [ ] 每个服务独立 health 端口 200
- [ ] `uptime` 为有效正数

---

## 场景 2: API 认证 & 鉴权

### 2.1 无认证 → 401

| 步骤 | 操作 | 预期 |
|------|------|------|
| 2.1a | `GET /api/v2/data/events?chain=sepolia` (无 header) | `401 { code: 401, message: "Missing authentication" }` |
| 2.1b | `POST /api/v2/mpc/register` (无 header) | `401` |

### 2.2 API Key 认证

| 步骤 | 操作 | 预期 |
|------|------|------|
| 2.2a | `GET /api/v2/data/usage` + `x-api-key: sk-invalid` | `401 { message: "Invalid API key" }` |
| 2.2b | `GET /api/v2/data/usage` + `x-api-key: sk-***` (有效) | `200 { code: 0, data: {...} }` |

### 2.3 钱包签名认证 (EIP-4361)

| 步骤 | 操作 | 预期 |
|------|------|------|
| 2.3a | 生成 nonce: `GET /api/v2/auth/nonce` | `{ nonce: "...", expiresAt: "..." }` |
| 2.3b | `POST /api/v2/auth/login` `{ address, signature, nonce }` | `201 { token: "jwt...", expiresIn: 3600 }` |
| 2.3c | `GET /api/v2/account/me` + `Authorization: Bearer <token>` | `200 { address, plan, stats }` |
| 2.3d | 签名过期 (5min old nonce) | `400 { message: "Nonce expired" }` |
| 2.3e | 签名不匹配 | `401 { message: "Invalid signature" }` |

### 验证点
- [ ] 未认证全部返回 401
- [ ] 无效 Key 返回 401
- [ ] EIP-4361 nonce → 签名 → JWT 完整流程通过
- [ ] Nonce 5min 过期机制有效

---

## 场景 3: 全局错误处理 & 限流

### 3.1 HTTP 错误码矩阵

| HTTP | 触发 | 预期响应体 |
|:---:|------|------|
| 400 | 参数缺失/格式错误 | `{ code: 400, message: "...", detail: "..." }` |
| 401 | 未认证 | `{ code: 401, message: "Missing authentication" }` |
| 403 | 操作他人资源 | `{ code: 403, message: "Forbidden" }` |
| 404 | 不存在端点/资源 | `{ code: 404, message: "..." }` |
| 429 | 触发限流 | `{ code: 429, message: "Rate limit exceeded", retryAfter: 60 }` |
| 500 | 服务器内部错误 | `{ code: 500, message: "Internal error" }` |
| 502 | 上游不可达 | `{ code: 502, message: "Service unavailable" }` |

### 3.2 限流测试

| 步骤 | 操作 | 预期 |
|------|------|------|
| 3.2a | 60s 内发送 200 次 `GET /api/v2/mpc/status` | 前 ~100 次 200，之后 `429` + `retryAfter` |
| 3.2b | 等待 `retryAfter` 秒重试 | `200` 恢复 |

### 3.3 CORS 跨域

| 步骤 | 操作 | 预期 |
|------|------|------|
| 3.3a | `OPTIONS /api/v2/mpc/status` → 无 Origin | `204` + CORS headers |
| 3.3b | `Origin: https://infrax.io` | `Access-Control-Allow-Origin: https://infrax.io` |
| 3.3c | `Origin: https://evil.com` | 拒绝或返回白名单域名 |

### 3.4 安全头 (所有 /api/ 路径)

| Header | 预期值 |
|--------|-------|
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains; preload` |
| `X-Frame-Options` | `DENY` |
| `X-Content-Type-Options` | `nosniff` |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |

### 验证点
- [ ] 7 种错误码全部验证
- [ ] 限流 > 触发 > 恢复闭环通过
- [ ] CORS Origin 白名单正确
- [ ] 4 个安全头全部设置

---

## 场景 4: MPC Agent Wallet — 全端点 (10 个)

### 端点清单

| # | 方法 | 端点 | 认证 | 说明 |
|---|------|------|:--:|------|
| 4.1 | `GET` | `/api/v2/mpc/status?address=0x...` | JWT | 查询注册状态 |
| 4.2 | `POST` | `/api/v2/mpc/send-code` | JWT | 发验证码 |
| 4.3 | `POST` | `/api/v2/mpc/register` | JWT | 注册钱包 |
| 4.4 | `POST` | `/api/v2/mpc/recover` | JWT | 恢复钱包 |
| 4.5 | `POST` | `/api/v2/mpc/session/unlock` | JWT | 解锁 → session token |
| 4.6 | `POST` | `/api/v2/mpc/session/lock` | Session | 锁定 token |
| 4.7 | `GET` | `/api/v2/mpc/session/status?token=...` | Session | 查询会话 |
| 4.8 | `POST` | `/api/v2/mpc/balance` | Session | 查余额 |
| 4.9 | `POST` | `/api/v2/mpc/sign-message` | Session | EIP-191 签名 |
| 4.10 | `POST` | `/api/v2/mpc/sign-typed-data` | Session | EIP-712 签名 |
| 4.11 | `POST` | `/api/v2/mpc/send-transaction` | Session | 转账 |
| 4.12 | `POST` | `/api/v2/mpc/contract-read` | JWT | 合约只读 |
| 4.13 | `POST` | `/api/v2/mpc/contract-write` | Session | 合约写 |
| 4.14 | `POST` | `/api/v2/mpc/gas-estimate` | JWT | Gas 估算 |

### 测试流程

| 步骤 | 端点 | 操作 | 预期响应 |
|------|------|------|------|
| 4.1 | `GET /status` | `?address=0xcaCD...` (已注册) | `{ registered: true, mpcAddress, email }` |
| 4.2 | `GET /status` | `?address=0xNEW...` (未注册) | `{ registered: false }` |
| 4.3 | `POST /send-code` | `{ email: "agent@infrax.io" }` | `{ message: "Verification code sent" }` |
| 4.4 | `POST /register` | `{ email, code }` | `{ address, email }` |
| 4.5 | `POST /recover` | `{ email, code }` | `{ address, email }` |
| 4.6 | `POST /session/unlock` | `{ email, code }` | `{ token: "mpc_...", expiresAt, ttl: 1800 }` |
| 4.7 | `GET /session/status` | `?token=mpc_...` | `{ active: true, remainingSeconds }` |
| 4.8 | `POST /session/lock` | `{ token: "mpc_..." }` | `200 destroyed` → 后续调用返回 401 |
| 4.9 | `POST /balance` | `{ token, chain: "sepolia" }` | `{ native: "1.5 ETH", tokens: [...] }` |
| 4.10 | `POST /sign-message` | `{ token, message: "Hello" }` | `{ signature: "0x..." }` |
| 4.11 | `POST /send-transaction` | `{ token, to, amount: "0.01", chain }` | `{ txHash, gasUsed }` |
| 4.12 | `POST /contract-read` | `{ contractAddress, abi, method, args }` | `{ result }` |
| 4.13 | `POST /contract-write` | `{ token, contractAddress, abi, method, args }` | `{ txHash, simulated, result }` |
| 4.14 | `POST /gas-estimate` | `{ to, value, chain }` | `{ gasLimit, gasPrice, totalCost }` |

### 负面测试

| # | 场景 | 预期 |
|---|------|------|
| N-4.1 | send-code 无效邮箱 | `400 { message: "Invalid email" }` |
| N-4.2 | register 错误验证码 | `400 { message: "Invalid code" }` |
| N-4.3 | register 重复邮箱 | `400 { message: "Wallet already registered" }` |
| N-4.4 | recover 未注册 | `400 { message: "Wallet not found" }` |
| N-4.5 | send-transaction 超限额 (>0.1 ETH) | `400 { message: "Exceeds limit" }` |
| N-4.6 | send-transaction 余额不足 | `400 { message: "Insufficient balance" }` |
| N-4.7 | session token 过期 (>30min) | `401 { message: "Session expired" }` |
| N-4.8 | lock 后操作 | `401 { message: "Session locked" }` |
| N-4.9 | contract-write 模拟失败 | `400 { message: "Simulation failed", reason: "..." }` |

---

## 场景 5: WAAS — 全端点 (13 个)

### 端点清单

| # | 方法 | 端点 | 说明 |
|---|------|------|------|
| 5.1 | `POST` | `/api/v2/saas/tenants` | 创建租户 |
| 5.2 | `GET` | `/api/v2/saas/tenants/my` | 我的租户 |
| 5.3 | `POST` | `/api/v2/saas/tenants/activate` | 激活租户 |
| 5.4 | `POST` | `/api/v2/saas/address` | 分配存款地址 |
| 5.5 | `POST` | `/api/v2/saas/addresses` | 批量分配 |
| 5.6 | `GET` | `/api/v2/saas/addresses` | 查询地址 |
| 5.7 | `POST` | `/api/v2/saas/sweep` | 触发归集 |
| 5.8 | `POST` | `/api/v2/saas/tenants/:id/apikey` | 生成 API Key |
| 5.9 | `POST` | `/api/v2/saas/tenants/:id/apikey/rotate` | 轮换 Key |
| 5.10 | `DELETE` | `/api/v2/saas/tenants/:id/apikey` | 删除 Key |
| 5.11 | `POST` | `/api/v2/saas/tenants/:id/hot-wallet` | 热钱包 |
| 5.12 | `GET` | `/api/v2/saas/withdrawals` | 提现队列 |
| 5.13 | `GET` | `/api/v2/wallet/balance?address=...` | 余额查询 |

### 测试流程

| 步骤 | 端点 | 操作 | 预期 |
|------|------|------|------|
| 5.1 | `POST /tenants` | `{ name: "MyApp" }` | `{ tenantId, name, status: "inactive" }` |
| 5.2 | `GET /tenants/my` | — | `{ tenants: [...] }` |
| 5.3 | `POST /tenants/activate` | `{ tenantId }` | `200 activated` |
| 5.4 | `POST /address` | `{ tenantId, chain: "sepolia" }` | `{ allocationId, depositAddress }` |
| 5.5 | `POST /addresses` | `{ tenantId, chain, count: 5 }` | `{ allocated: 5, addresses: [...] }` |
| 5.6 | `GET /addresses` | `?tenantId=...` | `{ total, addresses }` |
| 5.7 | `POST /tenants/:id/apikey` | — | `{ apiKey: "sk-...", prefix: "sk-abc1" }` |
| 5.8 | `POST /tenants/:id/apikey/rotate` | — | 新 Key + 旧 Key 30min 内仍可用 |
| 5.9 | `DELETE /tenants/:id/apikey` | — | `200 deleted` → Key 失效 |
| 5.10 | `POST /sweep` | `{ chain: "sepolia" }` | `{ txHash }` |
| 5.11 | `GET /wallet/balance` | `?address=0x...&chain=sepolia` | `{ balance, symbol }` |

### 负面测试

| # | 场景 | 预期 |
|---|------|------|
| N-5.1 | 重复创建同名租户 | `400 { message: "Tenant name exists" }` |
| N-5.2 | 未激活租户调用分配地址 | `400 { message: "Tenant not active" }` |
| N-5.3 | 无效 chain | `400 { message: "Unsupported chain" }` |
| N-5.4 | 批量分配 count > 100 | `400 { message: "Max 100 per batch" }` |

---

## 场景 6: Vault 多签保险库 — 全端点 (9 个)

### 端点清单

| # | 方法 | 端点 | 说明 |
|---|------|------|------|
| 6.1 | `GET` | `/api/vault/dashboard` | 金库总览 |
| 6.2 | `GET` | `/api/vault/safe/list` | Safe 列表 |
| 6.3 | `GET` | `/api/vault/safe/:address` | Safe 详情 |
| 6.4 | `POST` | `/api/vault/safe/create` | 创建 Safe |
| 6.5 | `POST` | `/api/vault/safe/propose` | 创建提案 |
| 6.6 | `POST` | `/api/vault/safe/confirm` | 签名确认 |
| 6.7 | `POST` | `/api/vault/safe/execute` | 执行交易 |
| 6.8 | `POST` | `/api/vault/safe/sync` | 同步链上 |
| 6.9 | `POST` | `/api/vault/risk/check` | 风控检查 |

### 测试流程 — 2/3 多签全生命周期

| 步骤 | 端点 | Request Body | 预期 |
|------|------|------|------|
| 6.1 | `GET /dashboard` | — | `{ totalSafes, totalValue, activeTxs }` |
| 6.2 | `POST /safe/create` | `{ signers: [A,B,C], threshold: 2, chain: "sepolia" }` | `{ address: "0xSAFE..." }` |
| 6.3 | `GET /safe/0xSAFE...` | — | `{ balance, owners: 3, threshold: 2 }` |
| 6.4 | `POST /safe/propose` | `{ safe: "0xSAFE...", to: "0x...", amount: "0.1" }` | `{ safeTxHash }` |
| 6.5 | `POST /safe/confirm` | A 签名 `{ safeTxHash, signature }` | `{ approvals: 1/2 }` |
| 6.6 | `POST /safe/confirm` | B 签名 | `{ approvals: 2/2, executable: true }` |
| 6.7 | `POST /safe/execute` | `{ safeTxHash }` | `{ chainTxHash, status: "executed" }` |

### 负面测试

| # | 场景 | 预期 |
|---|------|------|
| N-6.1 | 1 owner 创建 Safe | `400 { message: "At least 2 owners" }` |
| N-6.2 | threshold > owners | `400 { message: "threshold <= owners" }` |
| N-6.3 | 重复签名 | `400 { message: "Already confirmed" }` |
| N-6.4 | 阈值未达执行 | `400 { message: "Threshold not met" }` |
| N-6.5 | 非 owner 签名 | `403 { message: "Not a safe owner" }` |

---

## 场景 7: Data Center — 全端点 (8 个)

| # | 方法 | 端点 | 说明 |
|---|------|------|------|
| 7.1 | `GET` | `/api/v2/data/events` | 查询链上事件 |
| 7.2 | `GET` | `/api/v2/data/stats` | 统计数据 |
| 7.3 | `GET` | `/api/v2/data/checkpoints` | 区块位点 |
| 7.4 | `GET` | `/api/v2/data/plans` | 套餐列表 |
| 7.5 | `GET` | `/api/v2/data/tokens` | 代币列表 |
| 7.6 | `GET` | `/api/v2/data/chains` | 链列表 |
| 7.7 | `GET` | `/api/v2/data/balance?address=...` | 跨链余额 |
| 7.8 | `GET` | `/api/v2/data/usage` | 订阅用量 |
| 7.9 | `POST` | `/api/v2/data/subscribe` | 订阅服务 |

### 测试流程

| 步骤 | 端点 | 操作 | 预期 |
|------|------|------|------|
| 7.1 | `GET /events` | `?chain=sepolia&address=0xCAFE...&event_type=Transfer&limit=20` | `{ total, events: [...] }` |
| 7.2 | `GET /checkpoints` | `?chain=sepolia` | `{ chain, latestBlock, lag }` |
| 7.3 | `GET /plans` | — | `[{ name: "Free", monthlyQuota: 10000 }, { name: "Pro", ... }]` |
| 7.4 | `GET /tokens` | `?chain=ethereum` | `[...]` |
| 7.5 | `GET /chains` | — | `[{ chainId, name, status }...]` |
| 7.6 | `GET /usage` | — | `{ currentUsage, maxQuota, resetDate }` |
| 7.7 | `POST /subscribe` | `{ planId, chain: "sepolia" }` | `{ subscriptionId, status }` |

### 负面测试

| # | 场景 | 预期 |
|---|------|------|
| N-7.1 | events 无 chain 参数 | `400 { message: "chain required" }` |
| N-7.2 | 无效 chain | `400 { message: "Unsupported chain" }` |
| N-7.3 | limit > 1000 | 自动截断为 1000 或 `400` |
| N-7.4 | 超配额使用 | `429 { message: "Quota exceeded" }` |

---

## 场景 8: Payment + Scanner + Security + Account + Notification (快速覆盖)

### 8.1 Payment (6 端点)

| 方法 | 端点 | 用途 |
|------|------|------|
| `POST` | `/api/v2/payment/create` | 创建订单 |
| `GET` | `/api/v2/payment/status?orderId=...` | 查询状态 |
| `POST` | `/api/v2/payment/x402/pay` | x402 支付 |

### 8.2 Scanner (4 端点)

| 方法 | 端点 | 用途 |
|------|------|------|
| `GET` | `/api/v2/scanner/search?q=...` | 模糊搜索 |
| `GET` | `/api/v2/scanner/address/:address` | 地址详情 |
| `GET` | `/api/v2/scanner/tx/:hash` | 交易详情 |

### 8.3 Security (3 端点)

| 方法 | 端点 | 用途 |
|------|------|------|
| `POST` | `/api/v2/security/audit` | 合约审计 |
| `GET` | `/api/v2/security/audit/:id` | 审计结果 |
| `GET` | `/api/v2/security/risk?address=...` | 地址风险 |

### 8.4 Account (2 端点)

| 方法 | 端点 | 用途 |
|------|------|------|
| `GET` | `/api/v2/account/me` | 用户信息 |
| `PUT` | `/api/v2/account/me` | 更新信息 |

### 8.5 Notification (4 端点)

| 方法 | 端点 | 用途 |
|------|------|------|
| `GET` | `/api/v2/notification/list` | 通知列表 |
| `PUT` | `/api/v2/notification/:id/read` | 已读 |
| `POST` | `/api/v2/notification/settings` | 偏好设置 |

### 验证点
- [ ] Payment 创建 → 查询 → x402 链路
- [ ] Scanner 搜索 + 地址详情 + 交易详情
- [ ] 所有模块 `code: 0` 响应格式一致

---

## 场景 9: 跨模块集成测试 (3 条链路)

### 9.1 MPC → Vault 联动 (钱包 → 多签)
```
MPC 注册 → MPC Session Unlock → Vault Create Safe(MPC 为 owner)
  → Safe 充值 → Propose 转账 → MPC Sign → Owner2 Sign → Execute
  → MPC 交易历史含 Safe 交互
```

### 9.2 WAAS → Payment 联动 (托管 → 收款)
```
WAAS Create Tenant → Generate API Key → Allocate Deposit Address
  → Payment Deposit to Address → WAAS Query Balance → Sweep to Master
  → Payment Tx History → Sweep 记录
```

### 9.3 DC → Collector → Scanner 联动 (数据订阅闭环)
```
DC Subscribe Transfer Events → Collector Push Events via Webhook
  → Scanner Search Event → DC Usage Count +1 → DC Checkpoint Updated
```

### 验证点
- [ ] 3 条跨模块链路无断点
- [ ] 数据在模块间正确传递
- [ ] 所有模块 API 返回格式 `{ code: 0, data: {...} }` 一致

---

## 场景 10: 性能基线

| 端点 | QPS | P50 | P99 | 数据源 |
|------|:---:|:---:|:---:|------|
| `GET /api/health` | 500 | <10ms | <50ms | Web Proxy 缓存 |
| `GET /api/v2/mpc/status` | 100 | <50ms | <200ms | MPC DB |
| `GET /api/v2/data/events` | 50 | <200ms | <1s | Collector DB |
| `GET /api/v2/data/balance` | 30 | <500ms | <2s | 多链 RPC |
| `POST /api/v2/mpc/send-transaction` | 10 | <2s | <5s | MPC 签名 + 广播 |

### 负载测试命令
```bash
autocannon -c 10 -d 30 -H "Authorization: Bearer $TOKEN" \
  http://43.156.99.215:9111/api/v2/mpc/status?address=0xcaCDbE995F5AbFf92968D7C45F622E3976a9547A
```

---

## 负面场景总表

| # | 类别 | 场景 | 预期 |
|---|------|------|------|
| N1 | 认证 | 无 header | 401 |
| N2 | 认证 | 无效 Key/Token | 401 |
| N3 | 认证 | Nonce/Session 过期 | 400/401 |
| N4 | 认证 | 签名不匹配 | 401 |
| N5 | 限流 | 超频 | 429 + retryAfter |
| N6 | 参数 | 必填缺失 | 400 + detail |
| N7 | 参数 | 格式/值非法 | 400 |
| N8 | 参数 | 超出范围 (limit, count) | 自动截断或 400 |
| N9 | 资源 | 不存在 | 404 |
| N10 | 权限 | 操作他人资源 | 403 |
| N11 | 容量 | DC 月配额用尽 | 429 |
| N12 | 容量 | MPC 转超出限额 | 400 |
| N13 | 业务 | 重复操作 (duplicate) | 400 |
| N14 | 超时 | 上游 15s 无响应 | 502 |

### 测试通过标准

| 类别 | 标准 |
|------|------|
| 健康检查 | 10 服务全部 green |
| 认证 | EIP-4361 登录 + API Key + Session Token 三项认证正确 |
| 端点 | 12 服务 80+ 端点全部 `code: 0` |
| 错误处理 | 14 种负面场景全部按预期 |
| CORS | Origin 白名单正确 |
| 安全头 | HSTS / X-Frame-Options / nosniff / Referrer-Policy 到位 |
| 性能 | 5 个核心端点满足基线 |
| 跨模块 | 3 条链路闭环通过 |

---

> **下一文档**: P3 — MCP 接入测试 (46 Tools)
