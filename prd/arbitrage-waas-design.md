# Arbitrage 平台 WAAS（Wallet-as-a-Service）设计参考

> 提交方：Arbitrage 跨交易所套利平台（产品：AI Agent 跨 CEX 价差套利 + 量化终端）
> 版本：v1.0 ｜ 日期：2026-08-19
> 对接对象：InfraX 团队（供参考与优化）
> 技术栈：NestJS 11 + Prisma 7 + PGlite，ethers v6，BSC 主网 RPC（dry-run 可切换）

---

## 1. 概述

平台将链上资金流抽象为一个 **WAAS（钱包即服务）** 子系统，职责边界如下：

| 模块 | 职责 |
|---|---|
| 充值 | 每用户 HD 派生独立充值地址（m/44'/60'/0'/0/{index}），区块扫描 + 确认数 + 幂等入账 |
| 冷热分离 | 热钱包（广播/归集支付方）+ 冷地址（资金沉淀，人工转入） |
| 归集 | 定时把用户充值地址上的 USDT/USDC/BNB 余额归集到冷地址，链上审计 |
| 提现 | 状态机（review/processing/broadcast/failed）+ 人工审核 + 广播队列 + 手续费 |
| 资金账户 | 三层隔离：main（充提）/ portfolio（持仓锁定）/ reward（收益与奖励） |
| 平台币 | 内部记账币种 ARB（面值 1:1），收益按 80% USDT + 20% ARB 拆分入 reward 层 |

设计原则：
- **所有链上资金参数均通过管理后台 SystemConfig 可配**，热钱包私钥、冷地址、归集阈值、gas 策略、提现限额等无需发版即可调整；
- **dry-run 开关**：`BSC_DRY_RUN=true` 时所有广播/归集/赞助仅模拟并写审计表，用于联调与演示；
- **审计完备**：Sweep / SweepBatch / GasSponsor 三张链上操作审计表 + 财务流水（Transaction）双写。

---

## 2. 架构与职责

```
                    ┌─────────────────────────────────────────────┐
                    │                管理后台 Admin                 │
                    │  SystemConfig 配置 / 套餐 / 提币审核 / 钱包监控 │
                    └───────────────┬─────────────────────────────┘
                                    │ 读配置
   ┌────────────────────────────────▼────────────────────────────────┐
   │                        WAAS 核心层（BSC 模块）                    │
   │  BscListener   区块扫描（ERC20 15s / BNB 60s）→ 充值幂等入账       │
   │  BscBroadcaster 提现队列（30s）→ 热钱包签名广播                   │
   │  BscSweeper    归集调度（sweep_interval_sec，递归 setTimeout）    │
   │  BscService    HD 派生 / 热钱包 / 余额查询 / sweepAll / gas 赞助   │
   └────────────────────────────────┬────────────────────────────────┘
                                    │ ethers v6 JsonRpcProvider
                          ┌─────────▼─────────┐
                          │  BSC RPC（bsc_rpc_url）│
                          └───────────────────┘

   链上账户：
   - 热钱包：SystemConfig.hot_wallet_private_key（未配置回退 HD path 0）
   - 冷地址：SystemConfig.cold_address（归集目标，人工多签/HSM）
   - 用户充值地址：HD 派生 m/44'/60'/0'/0/{index}（BSC_MNEMONIC）
```

**资金路径**：
1. 用户向自己充值地址打 USDT/USDC/BNB → 区块扫描确认 → 入 main 层；
2. 用户购买套餐 → USDT 从 main → portfolio（本金锁定，B 类设 maturedAt）；
3. 每日 00:30 UTC 结算 → A/B 类利息按 static_ratio_usdt（默认 0.8）拆 USDT+ARB 入 reward 层；
4. 用户提现 → 从 main 或 reward 扣减 → 状态机（< 阈值自动广播 / ≥ 阈值人工审核）；
5. 自动归集 → 用户充值地址余额 → 冷地址（dust 阈值跳过、gas 赞助兜底、热钱包 gas 告警熔断）。

---

## 3. 用户可配置参数（SystemConfig 全量白名单）

以下键全部在管理后台 Config 页可改（`PUT /api/v1/admin/config`，白名单校验，非白名单返回 BAD_CONFIG_KEY）。私钥类字段回显时脱敏（maskSecret）。

### 3.1 钱包与链

| Key | 含义 | 默认值 | 安全建议 |
|---|---|---|---|
| `hot_wallet_private_key` | 热钱包私钥（十六进制 0x…） | 空（回退 HD path 0） | **生产必须加密存储**（KMS/HSM/Vault），后台仅接受密文或由运维注入；切勿明文落库 |
| `cold_address` | 归集冷地址（0x…） | 空 | 应使用多签/HSM 托管冷钱包；地址变更需二次确认 |
| `arb_contract_address` | 平台币 ARB 的 BEP20 合约地址 | 空 | 上主网前校验合约审计报告 |
| `bsc_rpc_url` | BSC RPC 节点地址 | bsc.publicnode.com | 生产建议自建/付费 RPC + 多节点容灾 |

### 3.2 自动归集（sweep）

| Key | 含义 | 默认值 | 说明 |
|---|---|---|---|
| `sweep_enabled` | 归集总开关 | `false` | `true`/`false`；手动触发（POST /admin/sweeps/run）不受此开关限制 |
| `sweep_interval_sec` | 自动归集周期（秒） | `60` | 最小 5s；递归 setTimeout，改配置即时生效 |
| `sweep_min_usd` | dust 阈值（USD） | `1` | 低于阈值跳过（gas 成本 > 归集价值） |
| `gas_reserve_bnb` | 每地址保留 BNB gas | `0.001` | 归集后保留，保证地址仍可支付未来转账 |
| `gas_alert_bnb` | 热钱包 BNB 告警阈值 | `0.05` | 热钱包余额低于该值 → 整轮归集熔断跳过并告警 |
| `gas_sponsor_enabled` | 无 gas 地址代付开关 | `true` | 热钱包代付 BNB（×1.5 buffer），写 GasSponsor 审计 |

### 3.3 提现规则

| Key | 含义 | 默认值 | 说明 |
|---|---|---|---|
| `withdraw_single_limit` | 单笔提现限额（USDT） | `10000` | 超限直接拒绝（SINGLE_LIMIT） |
| `withdraw_daily_limit` | 单日累计限额（USDT） | `50000` | 排除 failed/canceled |
| `withdraw_review_threshold` | 人工审核阈值（USDT） | `10000` | ≥ 阈值进入 review 队列待审核 |
| `withdraw_currencies` | 可提现币种 | `USDT,USDC,BNB` | 逗号分隔；平台币 ARB 恒不可提现 |
| `withdraw_fee_rate` | 提现手续费率 | `0.05` | 在请求金额上按比例扣，fee 入账、实发 amount − fee |

### 3.4 收益与资金账户

| Key | 含义 | 默认值 | 说明 |
|---|---|---|---|
| `static_ratio_usdt` | 静态收益（A/B 类日息）USDT 占比 | `0.8` | 0~1，余下 20% 为平台币 ARB（面值 1:1） |
| `dynamic_ratio_usdt` | 动态收益（推广奖励）USDT 占比 | `1.0` | 推广奖励维持纯 USDT |
| `platform_token_symbol` | 平台币展示名 | `ARB` | 仅展示用途 |

### 3.5 购买支付（管理后台统一配置，用户无自由选择）

| Key | 含义 | 默认值 | 说明 |
|---|---|---|---|
| `purchase_methods` | 支付方式 | `both` | `usdt_only` / `arb_usdt`（固定比例） / `both`（可选） |
| `purchase_arb_ratio` | ARB+USDT 固定比例（ARB 占比） | `0.5` | 0~1；`both` 模式下用户只能选 0 或该配置值 |
| `platform_url` | 主平台地址（邀请链接用） | 空 | promo 面板跨应用跳转 |

---

## 4. 核心流程

### 4.1 充值监听与幂等入账

- 每用户唯一 HD 充值地址（`getDepositAddress`，index 单调递增，落 DepositAddress 表）；
- 区块扫描：`scanErc20`（USDT/USDC 合约 Transfer 事件，15s）/ `scanBnb`（60s）；
- 确认数 ≥ BSC_CONFIRMATIONS → `creditDeposit` 幂等入账（Deposit.txHash unique）；
- 低于最小充值额（BSC_MIN_DEPOSIT_USD）→ 标记 failed 不入账；
- 入账：main 层 + 金额 + 财务流水（type=deposit）。

### 4.2 提现状态机

```
createWithdrawal（2FA 校验 → 币种白名单 → 单笔/单日限额 → 手续费）
   │
   ├─ amount <  review_threshold ──→ status=processing ──→ 广播队列（BscBroadcaster）
   └─ amount ≥  review_threshold ──→ status=review ──→ 管理后台人工审核（/admin/withdrawals/:id/review）
                                                          └─ 通过 → processing → 广播
广播失败重试：reviewReason 计次，>3 次 → failed（资金自动回退/人工处理）
```

- 广播器只处理 `processing`；`BSC_DRY_RUN=true` 时模拟广播（随机 txHash）；
- 广播成功 → status=broadcast + txHash → 财务流水标记完成。

### 4.3 自动归集 sweepAll（含 gas 赞助）

单轮流程（`SweepBatch` 聚合审计）：

1. **前置校验**：`sweep_enabled`（手动 force 可跳过）→ `cold_address` 已配 → **热钱包 gas 熔断**（< gas_alert_bnb 整轮跳过）；
2. 建 `SweepBatch`，遍历全部用户充值地址：
   - **USDT/USDC**：余额 > dust 阈值（sweep_min_usd）才处理；地址 BNB 不足支付 gas 时，若 `gas_sponsor_enabled` 则热钱包代付（×1.5 buffer，写 GasSponsor）；
   - **BNB**：保留 gas_reserve_bnb，其余归集；
   - 每笔成功/失败写 `Sweep` 审计（from/to/currency/amount/txHash/error）；
3. 更新 batch 聚合计数（total/succeeded/failed/skipped/sponsored）。

**gas 成本动态估算**：`estimateSweepGasCost` = getFeeData().gasPrice × 100k gas limit（真实转账约 60k，留 buffer）。

### 4.4 收益拆分（80/20）

- 每日 00:30 UTC 结算：A/B 类 active 订单按 `principal × apy / 36500 × 天数` 计息（interestDate 幂等）；
- 拆分为 `usdtPart = interest × static_ratio_usdt` + `arbPart = interest − usdtPart`，双写入 reward 层 + 财务流水；
- **本金提取不受 20:80 限制**：赎回本金 100% 走 portfolio → main（USDT），不做任何拆分；
- 灵活套餐（A）：随时提取收益（reward 层）+ 本金（redeem）；
- 定期套餐（B）：到期前仅可提取收益（reward 层），本金锁定至 maturedAt，到期后 claim 提取本金。

---

## 5. 安全与风控建议（InfraX 参考）

1. **私钥分级**：热钱包私钥加密存储（KMS/HSM/Vault），后台表单只收密文；冷地址多签 + 人工转移。
2. **限额风控**：单笔/单日限额 + 人工审核阈值 + 2FA 强校验（提现/购买）+ 支付密码二次确认。
3. **熔断与告警**：热钱包 gas 告警熔断（防广播/赞助全军覆没）；低余额邮件/IM 告警。
4. **幂等与审计**：所有链上操作（充值/归集/赞助/广播）有审计表 + 唯一键幂等，可对账。
5. **dry-run 隔离**：联调环境 BSC_DRY_RUN=true，模拟广播不触网，零成本验证状态机。
6. **配置白名单**：可改键白名单校验，私钥回显脱敏，变更留痕（updatedAt）。

## 6. 给 InfraX 的优化建议

- 热钱包 BNB 赞助可用 Flashbot/批量交易优化 gas 成本；
- sweep 明细目前通过时间窗关联批次（Sweep 无 batchId 外键），建议加 batchId 外键精确归属；
- 生产建议升级 BullMQ 定时任务替代进程内 interval，支持多实例水平扩展；
- 可增加冷热钱包动态额度（热钱包只保留当日预估流水所需资金，超出自动归集冷钱包）。
