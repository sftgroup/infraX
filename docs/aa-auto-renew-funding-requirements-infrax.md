# 自动续订 · 智能账户资金充值与计费路径需求（AgentX → infraX）

> 提交方：AgentX（生产 43.159.60.46，仓库 Agentx）
> 日期：2026-08-19
> 接收方：InfraX（`projects/escrow` / `projects/aa-relay`）
> 性质：aa-relay A-10 计费 + InfraXEscrow 的**充值路径闭环**增量需求（不覆盖 `PAYMASTER_ONCHAIN_ESCROW_DESIGN.md` 的通用托管设计，与之衔接）
> 状态：✅ **已实施并生产验证**（2026-08-19 实施/上链，2026-08-20 复核：REQ-1/2/3/5 全部交付，REQ-4 为 AgentX 侧自理 fallback；详见 infrax_tasklist §9.20 REQ-1~5 登记与 AA_RELAY_BILLING.md）

---

## 0. 背景

AgentX ERC-4337 自动续订已于 2026-08-19 全链路打通（enable → confirm receiptSuccess → 续订上链 → 指针前移），**唯一剩余的产品闭环缺口：用户如何给"智能账户"充值**。

自动续订的所有链上开销都由**智能账户**（服务端为用户 EOA 部署的 ERC-4337 子账户，用户不持有私钥，服务端仅持 session key 签发续订指令）承担。当前只存在测试脚本可用的手工三步充值，对真实用户不可用。

## 1. 资金模型现状（AgentX 链上实证）

自动续订的每笔 UserOp 涉及 **三类资金，按账户地址独立记账（EOA 与每个子账户互不共用）**：

| 开销 | 支付来源 | 充值动作（当前） | 现状 |
|---|---|---|---|
| 订阅费（0.001 OXA/次） | 子账户 **native 余额**（execute value） | EOA 直接转账 OXA 给子账户 | ✅ 可用（Kernel `receive()` 不会转走，实证：native 到账、EP deposit 不变） |
| UserOp gas | 子账户 **EntryPoint deposit** | EOA 调 `EP.depositTo(子账户)` | ✅ 可用（但 per-account 独立，N 个子账户需 N 次） |
| relay 服务费（A-10，预扣约 0.00246 OXA/次） | 子账户在 **InfraXEscrow 的 `_balances[account]`** | 🔴 **无用户路径** | ❌ 阻断 |

**关键事实（决定缺口）：**
1. `InfraXEscrow.deposit()` 只记 `_balances[msg.sender]` —— 用户 EOA 调 `deposit()`，钱记到 EOA 名下；而 relay 计费的 `subscriber = op.sender`（子账户）→ **EOA 充值永远到不了子账户名下**。
2. `InfraXEscrow.receive()` 兜底接收转账但**不修改任何余额** → "直接向托管合约转账"也不入账。
3. 因此 relay 402 提示"向托管合约 deposit() 充值"对子账户计费场景是**误导文案**。
4. 唯一可用路径是"子账户自己调 `deposit()`"（self-pay UserOp），但需要：EOA 转 native（订阅费）→ EOA `EP.depositTo`（gas）→ 子账户 session key 签 `deposit()`（relay 费）——**三步手工 + 依赖 session 白名单含 `escrow.deposit()`**（当前自动续订 session 白名单没有）。

## 2. 现状能力对照（infraX 侧已有 vs 缺失）

| 能力 | 现状 | 缺口 |
|---|---|---|
| InfraXEscrow `deposit()/depositERC20()/withdraw()/balanceOf()/charge()/refund()` | ✅ 已部署 `0x8bf8ffee…` | **无 `depositFor(user)`**——帮他人入账的能力 |
| relay escrow 双轨计费（charge/refund/退差） | ✅ 生产运行 | 无充值端点；`/v1/ledger-balance` 在 escrow 模式下仍检查 ledger 配置（`aaChargeConfigured()`）→ 可能 503 |
| relay `GET /v1/plans` 价目表 | ✅ | 预扣构成（固定费+预估 gas）与退差语义可读性不足 |
| SK-1 session 代付模板（`escrow-deposit`） | ✅ | 面向"EOA 主钱包给**自己**充值"；未覆盖"给**他人/子账户**入账" |

## 3. 需求清单

### REQ-1（P0）InfraXEscrow 新增 `depositFor(address user)`（核心）

- 接口（与 EP `depositTo` 同语义）：
  ```solidity
  function depositFor(address user) external payable;            // 原生币：EOA 代 user 入账
  function depositForERC20(address token, uint256 amount, address user) external; // ERC20 同理
  ```
- 语义：`_balances[user] += msg.value`，**记账到 user 名下**；`msg.sender`（充值者）仅作来源记录。
- 权限：**不要求 relayer/owner**（用户可自由帮任意地址入账，与 `EP.depositTo` 一致；非出金操作，无资金风险）。
- 事件：`Deposited` 增加 `by`（充值者）字段，或新增 `DepositedFor(user, amount, token, by)`，供 AgentX 索引对账。
- 安全：沿用现有 `deposit()` 的限额/暂停语义（仅影响入账对象为用户）；无提现风险（`withdraw` 仍仅本人）。
- 验收：EOA **单笔 tx** 调 `depositFor(子账户)` → `balanceOf(子账户)` 即时增加；relay 广播 UserOp 预扣成功。

> 选型理由：最简通用（一行记账逻辑），与 EntryPoint `depositTo` 对齐，AgentX 前端/后端一次交易闭环；无需 relay 托管 EOA 私钥。

### REQ-2（P0）relay 计费/资金能力补全

- **2a. 修正 `/v1/ledger-balance`**：escrow 模式下不应要求 ledger 配置（`aaChargeConfigured()` 检查会导致 503），改为 `escrowConfigured() || aaChargeConfigured()` 放行（当前实现：`billing.ts` 的 `aaLedgerBalance` 已按 escrow 分支读链上，但路由前置检查不匹配）。
- **2b. 资金总览端点（或扩展 `ledger-balance` 返回）**：返回子账户三类资金 `{ escrowWei, epDepositWei, nativeWei }`。供 AgentX 续订前资金预检、余额不足提前通知/暂停续订（当前服务端只能读 escrow，EP deposit/native 需自行链上查）。
- **2c. 修正 402 `topupHint`**：escrow 模式下提示"向托管合约 deposit()"对**子账户计费**场景是误导（见 §1.3）。按充值目标区分文案：a) 计费主体是 EOA 自己 → 现有文案；b) 计费主体是智能账户（`op.sender`）→ 指引"EOA 调 `depositFor(account)`（或经 relay 充值端点）"。
- 验收：escrow 模式下 `ledger-balance` 返回链上余额；402 文案在子账户场景正确指向 `depositFor`。

### REQ-3（P1）价目与结算语义文档化（接入方依赖）

- 预扣构成明确：`固定费（AA_USEROP_FEE_WEI 默认 0.0001 OXA）+ 预估 gas（callGasLimit+verificationGasLimit+preVerificationGas）× maxFeePerGas`；
- 收据后退差语义：`refund/extra`（多退少补）、广播失败全额退还；
- 计费往返耗时（AgentX 实测 charge ~12s + bundler 模拟 ~24s+）与 **SLA/超时建议值**（AgentX 网关已用 150s 超时；建议 relay 文档给出推荐客户端超时）；
- 可选：relay 异步提交模式（`POST /v1/userops` 返回 opHash 即 202，收据走 `GET /v1/userops/:hash` 轮询），消除长连接超时耦合。

### REQ-4（P2，AgentX 自理备选，不依赖合约升级）self-pay 充值路径

- AgentX 侧将自动续订 session 白名单**增加 `escrow.deposit()` 条目**（valueLimit=充值上限），使子账户可用 session key 自付充值（EOA 先转 native + `EP.depositTo`）。
- 说明：多步充值、体验差，仅作为 REQ-1 未落地前的 fallback；**若 REQ-1 落地则不再需要**。

### REQ-5（P2，可选）批量充值/对账辅助

- 若 AgentX 后续多子账户场景，请求 relay/合约支持批量 `depositFor`（单 tx 多账户入账）或提供批量估算模板（N 期续订费用 = 订阅价×N + (固定费+预估gas)×N）。

## 4. AgentX 侧自理（不在 infraX 范围）

- **前端充值引导**：开启自动续订时，按 REQ-1 估算一年续订费用，引导用户一次 `depositFor`（REQ-1 落地后）/ 三步合一（fallback）；
- **续订资金预检与告警**：gateway 续订前检查 escrow 余额，不足时提前通知（邮件/站内）+ 暂停续订并标记（`renew_status` 保留，余额补齐后恢复）；
- 计费对账：按 escrow `Charged/Refunded` 事件与本地 `renew_log` 对账。

## 5. 验收标准（本轮）

1. `depositFor(子账户)` 单笔 tx 入账成功，`balanceOf(子账户)` 即时可见；
2. 子账户 escrow 余额充足时，relay 广播 UserOp 不再 402；
3. `ledger-balance` 在 escrow 模式下返回链上余额（不 503）；
4. 402 提示在子账户计费场景正确指引 `depositFor`；
5. 价目文档包含预扣构成、退差语义、SLA 超时建议。

## 6. 与既有 infraX 文档的关系

- **不覆盖** `docs/PAYMASTER_ONCHAIN_ESCROW_DESIGN.md`（通用托管迁移设计，阶段 1/2/3 继续有效）；
- **衔接** `docs/FEATURE_REQUEST_AGENTX_ESCROW_PAYPERCALL_20260817.md` 的 OE-2（金库收款路径）：OE-2 解决"EOA 向金库充值（x402 按次扣费）"，本需求解决"**智能账户（非 EOA）作为计费主体的充值闭环**"，两者是同一 escrow 合约的两个用例；
- **衔接** `docs/services/session-key.md` 的 SK-1：现有模板面向"EOA 主钱包给自己充值"；若采纳 REQ-4，需补充"给子账户入账"的模板示例。
