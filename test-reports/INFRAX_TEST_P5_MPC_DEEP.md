# InfraX 端到端全场景测试文档 — P5: MPC Agent Wallet 深度测试

> v0.3.3-20260720 | 生产 `43.156.99.215` | 文档版本 v1.0

## 概述

以**终端用户**视角深度验证 InfraX MPC Agent Wallet，覆盖 Session Token 生命周期、签名体系、合约交互、安全限额、错误恢复。

**MPC 核心机制**: 密钥分片（用户持有分片 + InfraX 持有分片），用户解锁 → 获取 30min session token → 所有操作无需私钥。

### 参考文档
- `docs/API_ACCESS.md` §MPC Agent Wallet (v0.3.0)
- `docs/MCP_REQUIREMENTS.md` §Phase 4 MPC MCP
- `projects/mpc/server.ts` — MPC Server 源码 (POST /send-code, /register, /session/*, /send-transaction, /contract-write, etc.)

---

## 场景 1: MPC 注册生命周期

### 1.1 新用户注册

| 步骤 | 操作 | 端点/方法 | 预期 |
|------|------|------|------|
| 1.1a | 检查注册状态 | `GET /api/v2/mpc/status?address=0xNEW...` | `{ registered: false }` |
| 1.1b | 发送验证码 | `POST /api/v2/mpc/send-code` `{ email: "new@infrax.io" }` | `{ code: 0, message: "Sent" }` |
| 1.1c | 输入错误验证码 | `POST /api/v2/mpc/register` `{ email, code: "000000" }` | `400 { message: "Invalid code" }` |
| 1.1d | 输入正确验证码 | `POST /api/v2/mpc/register` `{ email, code: "123456" }` | `{ code: 0, data: { address: "0x...", email } }` |
| 1.1e | 再次查询状态 | `GET /api/v2/mpc/status` | `{ registered: true, mpcAddress: "0x..." }` |
| 1.1f | 重复注册 | `POST /api/v2/mpc/register` (相同邮箱) | `400 { message: "Wallet already registered" }` |

### 1.2 钱包恢复

| 步骤 | 操作 | 预期 |
|------|------|------|
| 1.2a | 清除 localStorage | 本地 MPC 状态丢失 |
| 1.2b | send-code → 输入 code → recover | `POST /api/v2/mpc/recover` → `{ address, email }` |
| 1.2c | 验证恢复后地址一致 | 与注册时的地址相同 |
| 1.2d | 恢复未注册邮箱 | `400 { message: "Wallet not found" }` |

### 验证点
- [ ] 注册 → 恢复 地址一致（密钥分片正确恢复）
- [ ] 错误验证码 3 次后锁定（如有防暴力破解）
- [ ] 验证码过期时间（通常 5min）有效
- [ ] 邮箱格式验证 `notanemail` → `400`

---

## 场景 2: Session Token 生命周期 (核心)

> MPC 的所有写操作（签名/转账/合约写）依赖 session token。token 30min TTL，是 Agent Wallet 安全体系的核心。

### 2.1 Session 完整流转

```
                  ┌── 验证码过期 (5min) ──┐
                  ▼                        │
send-code ──► register ──► unlock ──► [操作中... 30min] ──► 过期/lock
                                    │
                                    ├─ balance
                                    ├─ sign-message
                                    ├─ sign-typed-data
                                    ├─ send-transaction (≤0.1 ETH)
                                    ├─ contract-read (无需 token)
                                    └─ contract-write (模拟→签名→广播)
```

### 2.2 Session 操作测试

| 步骤 | 操作 | 预期 |
|------|------|------|
| 2.2a | Unlock: `POST /session/unlock` `{ email, code }` | `{ token: "mpc_a1b2...", expiresAt, ttl: 1800 }` |
| 2.2b | Status: `GET /session/status?token=mpc_a1b2...` | `{ active: true, remainingSeconds: ~1800 }` |
| 2.2c | 等待 1min 再查 Status | `remainingSeconds: ~1740` |
| 2.2d | Lock: `POST /session/lock` `{ token }` | `200 locked` → token 销毁 |
| 2.2e | Lock 后查 Status | `401 { message: "Session locked" }` |
| 2.2f | Lock 后 send-transaction | `401 { message: "Session locked" }` |
| 2.2g | Unlock → 不操作 → 30min 后 | `401 { message: "Session expired" }` |

### 负面测试

| # | 场景 | 预期 |
|---|------|------|
| N2.1 | Unlock 错误 code | `400 { message: "Invalid code" }` |
| N2.2 | 用已 lock 的 token | `401 { message: "Session locked" }` |
| N2.3 | 用已过期的 token | `401 { message: "Session expired" }` |
| N2.4 | 未注册邮箱 unlock | `400 { message: "Wallet not found" }` |
| N2.5 | 并发 2 次 unlock 同一 wallet | 新 token 替换旧 token（旧 token 失效） |
| N2.6 | Unlock 后立即 lock → 再 unlock | 需要新验证码 |

### 安全验证

| 场景 | 预期行为 |
|------|------|
| Session token 仅服务端有效 | 客户端不可伪造 token |
| Token 无明文私钥 | 检查 token 格式 `mpc_` + hash，非私钥 |
| 跨 wallet 操作 | Token A 不能操作 Wallet B |

### 验证点
- [ ] Unlock → Status → 操作 → Lock 完整闭环
- [ ] 30min TTL 精准
- [ ] Lock 后所有操作被拒绝
- [ ] 重新 Unlock 需新验证码
- [ ] Token 不可跨 wallet 使用

---

## 场景 3: 签名体系 (EIP-191 + EIP-712)

### 3.1 EIP-191 签名 (personal_sign)

| 步骤 | 操作 | 预期 |
|------|------|------|
| 3.1a | Unlock → `POST /sign-message` `{ token, message: "Hello InfraX" }` | `{ signature: "0x..." }` |
| 3.1b | 验证签名 (ecrecover) | 恢复地址 = MPC 地址 |
| 3.1c | 签名不同消息 | 每次签名不同 (nonce 递增) |
| 3.1d | 超长消息 (10KB) | 可正常签名 |
| 3.1e | 空消息 | `400 { message: "Message is required" }` |

### 3.2 EIP-712 签名 (signTypedData)

| 步骤 | 操作 | 预期 |
|------|------|------|
| 3.2a | `POST /sign-typed-data` | `{ signature: "0x..." }` |
| 3.2b | 验证 EIP-712 签名 | 恢复地址正确 |
| 3.2c | 验证 domain separator | 链 ID / 合约地址正确 |
| 3.2d | 缺少 `domain` | `400 { message: "domain required" }` |
| 3.2e | 缺少 `types` | `400 { message: "types required" }` |

### 验证点
- [ ] EIP-191 & EIP-712 签名均可 ecrecover 到 MPC 地址
- [ ] 签名不可伪造
- [ ] 无 session token 时签名被拒绝

---

## 场景 4: 转账 (ETH + ERC20)

### 4.1 ETH 转账 (基础)

| 步骤 | 操作 | 预期 |
|------|------|------|
| 4.1a | 发送 0.01 ETH | `POST /send-transaction` `{ token, to, amount: "0.01", chain: "sepolia" }` | `{ txHash, gasUsed }` |
| 4.1b | 发送 0 ETH | `400 { message: "Amount must be > 0" }` |
| 4.1c | 发送到无效地址 | `400 { message: "Invalid to address" }` |
| 4.1d | 发送到自身地址 | `{ txHash: "0x..." }` (允许) |

### 4.2 转账限额 (核心安全机制)

| 步骤 | 操作 | 预期 |
|------|------|------|
| 4.2a | 查询限额 `GET /api/v2/mpc/limit?address=...` | `{ dailyLimit: "0.1 ETH", used: "0", remaining: "0.1 ETH" }` |
| 4.2b | 发送 0.05 ETH | ✅ 成功, `used` → `0.05` |
| 4.2c | 再次发送 0.05 ETH | ✅ 成功, `used` → `0.1`, `remaining` → `0` |
| 4.2d | 第三次发送 0.01 ETH | `400 { message: "Exceeds daily limit" }` |
| 4.2e | 同时发送 0.15 ETH (超过单笔+日限额) | `400 { message: "Exceeds daily limit" }` |
| 4.2f | 发送 0.11 ETH (超过单笔 0.1 ETH 限额) | `400 { message: "Exceeds per-transaction limit of 0.1 ETH" }` |
| 4.2g | 次日 (UTC+0 重置) → 发送 0.01 ETH | ✅ 成功, `used` → `0.01` (重置) |

### 4.3 ERC20 转账

| 步骤 | 操作 | 预期 |
|------|------|------|
| 4.3a | 发送 100 USDT `{ token, to, amount: "100", tokenAddress: "0xUSDT...", chain: "sepolia" }` | `{ txHash }` |
| 4.3b | 发送超过余额的 USDT | `400 { message: "Insufficient balance" }` |
| 4.3c | 未批准的 ERC20 | `400 { message: "Insufficient allowance" }` |
| 4.3d | 余额查询 (含 ERC20) | `POST /balance` → `{ native, tokens: [{ symbol, balance }] }` |

### 4.4 Gas 处理

| 步骤 | 操作 | 预期 |
|------|------|------|
| 4.4a | 估算 Gas `POST /gas-estimate` | `{ gasLimit, gasPrice, totalCost }` |
| 4.4b | 余额 < totalCost 时发送 | `400 { message: "Insufficient balance for gas" }` |
| 4.4c | EIP-1559 支持 | `maxFeePerGas` + `maxPriorityFeePerGas` 可选 |

### 验证点
- [ ] 转账成功返回 txHash，可查询链上确认
- [ ] 单笔 0.1 ETH 限额
- [ ] 每日 0.1 ETH 限额 + 次日重置
- [ ] ERC20 转账的 approve + transfer 是否正确
- [ ] Gas 估算结果合理

---

## 场景 5: 合约交互

### 5.1 合约只读 (contract-read, 无需 token)

| 步骤 | 操作 | 预期 |
|------|------|------|
| 5.1a | `balanceOf` 查询 | `POST /contract-read` `{ contractAddress, abi: [balanceOf], method: "balanceOf", args: [address] }` | `{ result: "1000000000000" }` |
| 5.1b | `totalSupply` | 返回正确供应量 |
| 5.1c | 无效合约地址 | `400 { message: "Invalid contract address" }` |
| 5.1d | 无效 ABI | `400 { message: "Invalid ABI" }` |
| 5.1e | 不存在的方法 | `400 { message: "Method not found in ABI" }` |
| 5.1f | 无需 token 即可调用 | ✅（开放查询） |

### 5.2 合约写入 (contract-write, 需 token)

| 步骤 | 操作 | 预期 |
|------|------|------|
| 5.2a | `approve(spender, amount)` | `POST /contract-write` `{ token, contractAddress, abi: [approve], method: "approve", args: [spender, amount] }` | `{ txHash, simulated: true, result }` |
| 5.2b | 确认 simulate 先于 broadcast | Response 含 `simulated: true` 字段 |
| 5.2c | simulate 失败 (如不足 allowance) | `400 { message: "Simulation failed", reason: "..." }` → 不广播 |
| 5.2d | `transferFrom` (需先 approve) | ✅ 成功 |
| 5.2e | 未注册 MPC | `400 { message: "MPC not registered" }` |

### 5.3 合约写入安全机制

```
contract-write 流程:
  1. 解析 ABI + args → encode 函数调用
  2. staticCall 模拟 (eth_call) → 检查返回值 + revert reason
  3. 模拟通过 → MPC 签名 (无 single private key)
  4. 广播 raw tx → 返回 txHash
  5. 如果模拟失败 → 返回 400 + reason, 不签名/不广播
```

### 验证点
- [ ] contract-read 无需 token
- [ ] contract-write 需要有效 session token
- [ ] 模拟失败时不广播 (不浪费 Gas)
- [ ] approve → transferFrom 流程正常
- [ ] 复杂合约（如 Uniswap Router）可正常交互

---

## 场景 6: 余额查询

| 步骤 | 操作 | 预期 |
|------|------|------|
| 6.1a | `POST /balance` `{ token, chain: "sepolia" }` | `{ native: { balance, symbol, usdValue }, tokens: [...] }` |
| 6.1b | 指定 tokenAddress | 只返回该 token 余额 |
| 6.1c | 不同链查询 | sepolia / ethereum / bsc / base → 各自返回 |
| 6.1d | 无可选 token | `{ native: "1.5 ETH", tokens: [] }` |
| 6.1e | 新注册钱包 | `{ native: "0 ETH", tokens: [] }` |

---

## 场景 7: 并发 & 竞态测试

| # | 场景 | 操作 | 预期 |
|---|------|------|------|
| 7.1 | 并发 unlock (2 次) | 同一 email 同时 unlock | 最新 token 生效, 旧 token 失效 |
| 7.2 | 并发 send-transaction (2 次) | 同一 token 同时发 | 第一笔成功, 第二笔 `429` 或成功 (如限额充足) |
| 7.3 | Lock 时 send-transaction 在处理 | Lock 中断进行中的交易 | Lock 后 pending tx 应被取消或标记 stale |
| 7.4 | Unlock → 操作 → 30min 内 → 延长 | 操作中自动延长？ | 当前不自动延长，过期后需重新 unlock |

---

## 场景 8: 完整用户日场景

```
早晨:
  1. 解锁 MPC 钱包 (unlock email+code)
  2. 查看余额: 1.3 ETH + 500 USDT

工作中:
  3. 签名消息: "Approve login" (EIP-191)
  4. 调用合约: approve 100 USDT 给 Uniswap Router
  5. 调用合约: swapExactTokensForETH (100 USDT → ~0.05 ETH)
  6. 给小号转 0.01 ETH

晚上:
  7. 查看交易历史: 4 笔交易已确认
  8. 查看限额剩余: 0.09/0.1 ETH (用了 0.01)
  9. 锁定钱包 (lock)
  10. 确认已锁定 (status → locked)
```

### 验证点
- [ ] 全天操作无异常
- [ ] 每笔交易可上链验证
- [ ] 限额跟踪正确 (0.01 记账正确)
- [ ] 历史记录完整

---

## 场景 9: 安全 & 攻击面测试

| # | 场景 | 操作 | 预期 |
|---|------|------|------|
| 9.1 | 伪造 token | `{ token: "mpc_fake_token_12345" }` | `401 { message: "Invalid session token" }` |
| 9.2 | 未解锁直接 send-transaction | 无 token header | `401 { message: "Missing session token" }` |
| 9.3 | 用 Wallet A 的 token 操作 Wallet B | 跨 wallet 操作 | `403 { message: "Token does not match wallet" }` |
| 9.4 | 重放攻击 (同一 tx 发两次) | 相同 nonce 两次 send-transaction | 第二笔 `400` (nonce 已用) |
| 9.5 | send-transaction 超限额 | 单笔 1 ETH | `400 { message: "Exceeds per-transaction limit" }` |
| 9.6 | send-transaction 累计超日限额 | 分多次累计 > 0.1 ETH/天 | `400 { message: "Exceeds daily limit" }` |
| 9.7 | contract-write 无 token | `{ contractAddress, abi, method, args }` 无 token | `401` |
| 9.8 | contract-write 模拟失败 | 调用 revert 的方法 | `400 { message: "Simulation failed", reason: "..." }` |
| 9.9 | contract-write 无 ABI | `{ token, contractAddress, method }` 无 abi | `400 { message: "ABI required" }` |
| 9.10 | 高频解锁 (暴力猜码) | 1min 内 10 次解锁 | 可能触发 rate limit `429` |

### 验证点
- [ ] 所有攻击向量被正确阻断
- [ ] 伪造 token 无法使用
- [ ] 跨 wallet token 不可用
- [ ] 重放攻击被阻止
- [ ] 限额机制坚不可破

---

## 测试通过标准

| 类别 | 标准 |
|------|------|
| 注册 | email → code → register → recover 全链路 |
| Session | Unlock 30min TTL / Lock / Status 精确 |
| 签名 | EIP-191 + EIP-712 均可 ecrecover 到正确地址 |
| 转账 | ETH + ERC20 限额/余额/并发正确 |
| 合约 | 只读 + 写入 (simulate → sign → broadcast) 闭环 |
| 限额 | 单笔 0.1 ETH + 日 0.1 ETH + 次日重置 |
| 安全 | 10 种攻击向量全部阻断 |
| 并发 | Unlock/Send/Lock 竞态处理正确 |
| 余额 | 多链多 token 查询准确 |

---

> **下一文档**: P6 — WAAS + Vault + DC + Payment + Collector 深度测试
