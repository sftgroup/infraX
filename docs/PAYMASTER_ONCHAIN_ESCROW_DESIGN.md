# 平台钱包 EOA → 托管合约 + 计费链上化（架构设计）

- 状态：**草案（P1 演进方向）**
- 日期：2026-08-16
- 范围：aa-relay 计费层（A-10 / x402）+ 平台资金托管
- 关联：`projects/aa-relay/src/billing.ts`、payments 引擎（ledger）、`infrax-aa-paymaster`（VerifyingPaymaster）

---

## 1. 背景与现状

### 1.1 当前计费链路（ledger 方案，生产运行中）

```
用户(sender) ── 广播 /v1/userops ──▶ aa-relay
                                       │  A-10 计费
                                       ▼
                              ledger（payments 引擎 DB）
                              payment_balances / payment_credits
                              chargeUserOp(): 预扣 → 广播
                              settleUserOp(): 收据后按 actualGasCost 退差（多退少补）
```

- **入账路径**：① DB 直插（联调/运维）② x402 verify（用户向平台钱包转账 → 引擎入账）
- **键维度**：`subscriber = userOp.sender`（智能账户地址）
- **已实测**：PocketX 联调 tx `0x8f1666db…be0862`（alto 直连）EP 存款扣减 `312,612,002,188,284 wei = actualGasCost`；relay 广播经 A-10 计费 402 拦截后，ledger 预存 1 OXA 放行

### 1.2 现状问题（本设计的动因）

| # | 问题 | 证据 |
|---|---|---|
| P1 | **平台钱包为 EOA**，托管资金单点风险 | `0x5682e2d55770e46ad24b92e51d6d0a3b629fa0b3`：`eth_getCode=0x`（无合约），余额 10 OXA；私钥泄露 = 资金全失 |
| P2 | **计费依赖中心化 DB ledger**，资金托管与记账均不可链上验证 | ledger 仅 DB 直插/x402 入账，外部客户无法验证资金安全 |
| P3 | **原子预扣 / 结算 / 平台可动用性目前仅靠 DB 事务** | 无链上锚点；退款/对账依赖 DB 完整性 |

> 注：链上 gas 结算（EP deposit）**已存在**（VerifyingPaymaster + EntryPoint deposit 扣减），本设计解决的是**服务费计费层**与**平台资金托管层**，两者独立。

---

## 2. 设计目标与原则

1. **资金安全**：平台托管资金从 EOA 迁入**智能合约托管**，消除私钥单点；用户存管资金合约可验证。**治理不依赖外部多签**——全部由合约机制承担（owner 密钥 HSM/轮换 + pause 冻结计费 + 限额兜底 + 升级需先暂停）。
2. **计费链上化**：原子预扣、扣款、退款在**链上合约记账**（storage 操作），不依赖 DB 事务保证资金语义。
3. **零信任边界**：任何"资金状态"均可在链上校验；ledger 降级为索引/对账层。
4. **向后兼容**：迁移期间 ledger 与合约双轨（feature flag），现有 PocketX 调用不改协议。
5. **成本可控**：扣款走**记账而非转账**（合约内 storage 加减），单次扣款 gas 远低于转账；支持批量结算。

---

## 3. 目标架构

```
用户(sender, Kernel 智能账户)
   │ ① deposit/锁定（存管到 Escrow）
   ▼
┌─────────────────────────┐
│  InfraX Escrow（托管记账合约） │   ← 合约内 owner 治理（密钥 HSM/轮换，无多签）
│  balances[user]           │   charge/refund：storage 原子记账
│  allowances[spender]      │   withdraw：仅本人（账户/EOA 签名）
└─────────────────────────┘
        │ ② charge（relay 授权扣款，链上原子）
        ▼
   aa-relay（广播前 charge → 广播 → 收据后 refund 退差）
        │
        ▼
   VerifyingPaymaster（gas 代付，EP deposit 链上结算，现有链路不变）
```

- **托管**：用户原生资产/稳定币存入 Escrow（或授权代扣额度），余额链上可查。
- **计费**：relay 广播前调 `Escrow.charge(user, amount, ref)`（链上原子扣减）；收据后 `refund` 退差。
- **结算**：charge/refund 均为 storage 记账（无真实转账），gas 成本≈一次 SSTORE。
- **提现**：用户 `withdraw(amount)`（余额解锁转出）；平台侧仅治理参数，不经手用户资金。

---

## 4. 合约设计要点

### 4.1 核心接口（Solidity 草案）

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IInfraXEscrow {
    // ---- 用户侧 ----
    function deposit() external payable;                       // 存管（原生资产）
    function depositERC20(address token, uint256 amount) external; // 存管 ERC20
    function withdraw(uint256 amount) external;                // 提现（仅本人）
    function balanceOf(address user) external view returns (uint256);

    // ---- 计费侧（仅授权 relayer） ----
    function charge(address user, uint256 amount, string calldata ref) external returns (uint256 newBal);
    function refund(address user, uint256 amount, string calldata ref) external returns (uint256 newBal);

    // ---- 治理侧（仅 owner，智能合约直接治理） ----
    function setRelayer(address relayer, bool enabled) external;
    function setChargeLimit(address user, uint256 perTx, uint256 perDay) external; // 限额
    function pause() external; function unpause() external;
}
```

### 4.2 数据结构

- `balances[user]`：用户托管余额（wei），存管/扣款/退款/提现均作用于该映射（**记账式**，非余额转账）。
- `dailyCharged[user][day]`：单日累计扣款（配合限额，防 relayer 私钥滥用）。
- `allowances[relayer]`：授权扣款地址集合。
- `ref`（string）：扣款引用（`aa:userop:<uuid>`），写入 event 供对账。

### 4.3 权限模型

| 角色 | 权限 | 说明 |
|---|---|---|
| 用户 | deposit / withdraw / balanceOf | withdraw 仅限本人；ERC-7579 账户场景由 owner 经 execute 调 |
| Relayer（aa-relay 签名服务） | charge / refund | 受 `perTx/perDay` 限额约束；密钥走 HSM/轮换 |
| Owner（平台管理地址，密钥 HSM/轮换） | setRelayer / setChargeLimit / pause / 升级 | 治理不影响用户资金；升级需先 pause |

### 4.4 安全要点

1. **重入防护**：charge/refund 无外部转账（纯 storage），天然低危；提现走 CEI（Checks-Effects-Interactions）+ `ReentrancyGuard`。
2. **限额**：单笔/单日扣款上限（默认 perTx ≤ 1 OXA、perDay ≤ 10 OXA 可配），防 relay 密钥失陷。
3. **升级**：UUPS 代理（proxy + implementation），owner 发起（需先 pause，暂停时冻结计费）。
4. **暂停开关**：`pause()` 冻结 charge/refund，存管/提现不受阻（用户资产随时可取）。
5. **资金隔离**：Escrow 托管资金与运营资金分账户；paymaster EP deposit 由平台 owner 独立注资。
6. **审计**：上线前第三方审计（重入、权限、限额、升级安全）。

### 4.5 成本评估

| 操作 | 链上开销（估算） | 说明 |
|---|---|---|
| charge（SSTORE） | ~21k–50k gas | 记账式扣款，远低于真实转账（21k+） |
| refund（SSTORE） | ~21k–50k gas | 同上 |
| 批量结算（多 userOp 合并） | 分摊 | relay 可攒批一次性结算，摊薄成本 |

---

## 5. 迁移步骤（分阶段，每阶段可独立验收/回滚）

### 阶段 0：现状（不动）

- ledger 单轨计费；平台 EOA 直收 x402；paymaster EP deposit 链上结算已运行。
- 目标：**不破坏现有 PocketX 联调**（ledger 已预存 1 OXA，可继续跑）。

### 阶段 1：托管合约落地 + 资金迁入（解决 P1 单点风险）

1. 部署 `InfraXEscrow`（oxachain 19505），**owner = 平台管理地址**（密钥 HSM/轮换，不引入外部多签；治理全部由合约机制承担：pause 冻结计费 + 限额兜底 + 升级需先暂停）。
2. 平台 EOA `0x5682e2…fa0b3` 资金迁移：EOA → **直接注资 Escrow/paymaster**（无多签环节）；**EOA 提现清零、私钥作废**。
3. x402 充值目标切换：`AA_PLATFORM_ADDRESS` 指向 Escrow（`deposit()` 兼作入账：verify 解析 Escrow 入账事件）。
4. **验收**：用户向 Escrow 存款后 `balanceOf` 链上可见；EOA 余额为 0；充值/提现端到端通过。

### 阶段 2：计费链上化双轨（解决 P2/P3）

1. aa-relay `billing.ts` 增加 `escrowMode`（feature flag）：`chargeUserOp`/`settleUserOp` 在 ledger 与 Escrow 之间按开关选择（同一调用面）。
2. relay 集成 Escrow `charge/refund`（附带限额参数）；保留 ledger 路径为 fallback。
3. **验收**：并发 100 个 userOp 无超扣（合约原子性）；收据后退差与 ledger 结果一致（对账差异 = 0）。

### 阶段 3：ledger 转索引/对账层

1. 新用户默认走 Escrow；ledger 仅记录事件索引 + 日终对账（`ledger sum == escrow 链上扣减`）。
2. 存量 ledger 余额（如联调 1 OXA）结算/清零。
3. **验收**：对账作业持续 7 天零差异；暂停/升级演练通过。

---

## 6. 权衡与决策记录

| 维度 | ledger（现状） | Escrow 合约（本设计） |
|---|---|---|
| 资金可验证性 | ❌ 仅 DB | ✅ 链上可查 |
| 平台单点风险 | EOA 私钥 | ✅ 合约托管（余额链上可查，治理由合约机制承担） |
| 扣款成本 | 零 | ~21k–50k gas/次（可批量摊薄） |
| 并发防超扣 | DB 事务 | ✅ 链上原子 |
| 结算灵活性（退款/多资产） | 高 | 中（需合约内实现） |
| 开发/审计成本 | 已投产 | 需合约开发 + 审计 |

**结论**：当前（联调/小规模 B 端）ledger 仍是最优解；**P1 面向公开市场前**落地 Escrow 迁移，重点优先做**阶段 1（EOA → 托管合约）**以消除资金单点风险，阶段 2/3 视规模按需推进。治理不依赖外部多签，由智能合约直接承担。

---

## 7. 待办（Backlog）

- [ ] 阶段 1：Escrow 合约代码 + 测试（Hardhat/Foundry）+ 安全要点逐项实现
- [ ] 阶段 1：Escrow 部署（owner=平台管理地址，密钥 HSM/轮换）与 EOA 资金迁移
- [ ] 阶段 2：aa-relay `escrowMode` 双轨计费实现 + 并发/对账测试
- [ ] 阶段 3：对账作业（ledger ↔ 链上）与存量结算
- [ ] 第三方安全审计（阶段 1 上线前）
