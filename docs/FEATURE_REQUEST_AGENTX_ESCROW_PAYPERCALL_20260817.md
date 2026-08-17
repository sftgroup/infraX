# InfraX 通用支付能力需求文档（AgentX 侧提交）

> 提交方：AgentX 平台
> 日期：2026-08-17
> 接收方：InfraX（sftgroup/infraX，`projects/payments` / `projects/session-key` / `projects/mpc` / `projects/mpc-sdk`）
> 性质：通用能力需求（引擎/协议层），宿主业务策略不在此列
>
> 协同模式：InfraX 按本清单发版 → AgentX 通过 `npm` bump 版本消费，不做代码复制。

---

## 0. 背景与总体原则

AgentX 正在落地三项优化：**资金金库化托管**、**A2A 编排待付款闭环**、**Agent 自主付费（MPC 钱包 + Session Key）**。

按"通用能力上收、宿主策略保留"的原则拆分：

| 归属 | 范围 |
|---|---|
| **InfraX（本清单）** | 钱怎么收（escrow 金库）、怎么验（verify/入账）、怎么签（session-key/mpc 代付）、统一访问策略与按次扣费（pay-per-call） |
| **AgentX（自理）** | 谁收（tenant/agent 业务语义）、业务计费策略、任务状态机、前端 UI、DB 迁移、对账任务、编排服务 |

---

## 1. 需求分组总览

| 分组 | 需求号 | 主题 | 优先级 |
|---|---|---|---|
| OE：Escrow 金库收款 | OE-1 ~ OE-4 | 金库收款路径补全与标准化 | P0 |
| PC：统一访问 + 按次扣费 | PC-1 ~ PC-3 | pay-per-call 通用能力 | P0 |
| A2A：余额模式结算 | A2A-1 | a2aSettle 支持余额模式 | P1 |
| SK：Session Key 代付配套 | SK-1 ~ SK-4 | Agent 代付授权模板/测试/文档 | P1 |
| MPC：钱包演进 | MPC-1 | 2-of-3 阈值演进 | P2 |

---

## 2. OE：Escrow 金库收款路径（P0）

### 背景

AgentX 当前 x402 余额的资金链上直转平台 EOA（`X402_PAY_TO`），存在单点私钥托管大额资金的隐患。方案改为**金库合约（Vault）托管资金**。引擎已具备 OE-5 escrow 判定雏形（`X402Adapter.verifyEscrowDepositTx`：`tx.to == escrow.address` + `Deposited(user, amount, token)` 事件 + `amount ≥ price` 入账），需要补全与标准化。

### OE-1 公开 escrow 配置与 ABI

- 现状：`x402.escrow.address` 已在 cfg 中存在，`escrowDepositAbi` 为适配器内部常量。
- 目标：
  - 完整公开 escrow 配置字段（地址、可选 ABI/chain 等，以源码 `cfg` 为准）到 README 与 `GET /capabilities` 能力清单；
  - 导出 `escrowDepositAbi`（`Deposited(user, amount, token)`）供集成方合约对齐。
- 验收：集成方按文档配置 `x402.escrow.address` 后，`verifyAndCredit` 自动走 escrow 判定，无需改引擎代码。

### OE-2 标准 Escrow 合约参考实现

- 现状：**已存在**——`projects/escrow/contracts/InfraXEscrow.sol`（`Deposited(user, amount, token)` + `deposit()/depositERC20()` + `withdraw()/withdrawERC20()` + `balanceOf()`），接口与 OE-5 判定完全对齐；AgentX 可直接部署使用，**无需自写金库合约**。
- 目标（补齐缺口）：
  - 提供 Escrow 部署/集成指引文档：如何部署并与 `x402.escrow.address` 配置对接（含 `GET /capabilities` 暴露 escrow 信息）；
  - 确认/补齐治理能力（角色化提现 owner/multisig、`pause/unpause` 熔断、资金上限），如缺失列为可选项。
- 验收：AgentX 按指引部署 InfraXEscrow 并配置 escrow 后，verify 自动走 escrow 判定；治理能力文档明确。

### OE-3 ERC20 deposit 走 escrow

- 现状：`verifyEscrowDepositTx` 仅接受 native（`token == address(0)`）；ERC20 走 stablecoin rail（`Transfer → payTo`，直转 payee，不经 escrow）。
- 目标：escrow 路径支持 ERC20 deposit（`Deposited(user, amount, token)` 中 `token != 0` 时按 token 校验），或明确 stablecoin 也经 escrow 托管的判定。
- 验收：代币充值资金同样进金库托管，verify 幂等入账。

### OE-4 链上余额锚与 ledger 对账参考实现

- 现状：注释提及 OE-8（ledger 为索引层、链上余额为准），无具体实现。
- 目标：提供"链上 `balanceOf` 汇总 ↔ 链下 ledger 累计"的对账参考（可脚本/示例），含对账差异告警语义。
- 验收：集成方可跑对账任务并输出差异报告。

---

## 3. PC：统一访问策略 + 按次扣费（P0）

### 背景

AgentX 自研了 `canAccessAgentOrPay`（拥有/订阅 → 放行；否则余额足够 → 服务端 deduct 1 单位 + 审计幂等；不足 → 402/待付款）。这是通用支付语义，应上收为引擎能力，宿主只注入策略参数。

### PC-1 `resolveAccess` 默认组合器

- 现状：`resolveAccess(subscriber, resource, opts)` 存在，但"链上 OR 链下订阅 OR 按次扣费"的判定语义由各宿主 store 自实现。
- 目标：提供默认组合器（策略可配）：`chain 订阅 OR offchain 订阅 OR balance ≥ price`；宿主仅注入优先级与各子判定来源。
- 验收：AgentX 用默认组合器即可复现 `canAccessAgentOrPay` 行为，宿主不再各自实现判定树。

### PC-2 按次扣费审计/幂等通用化

- 现状：AgentX 自建 `a2a_pay_log`（payer/agent_id/amount/ref_id 幂等）。
- 目标：payments 提供通用访问扣费日志表/事件（如 `payment_access_log` + `access.deducted` 事件），ref_id 幂等，宿主可订阅审计。
- 验收：按次扣费全程可审计、幂等、可对账，宿主无需自建日志表。

### PC-3 402 响应结构化

- 现状：402 仅协议头；宿主自行拼错误体。
- 目标：402 body 结构化：`{ priceWei, payTo, resource, resumeRef, mode: 'topup'|'subscribe' }`，供前端直接渲染"付款按钮"（充值并继续 / 改为订阅）。
- 验收：前端按响应即可渲染待付款卡片，无需拼接业务文案。

---

## 4. A2A：余额模式结算（P1）

### A2A-1 `a2aSettle` 支持 `mode:'balance'`

- 现状：`a2aSettle({ paymentId, txHash })` 仅支持链上 tx 入账（`verifyAndCredit`）。
- 背景：AgentX 的 A2A 编排是服务端→服务端（worker 内部委派），无法每次要求用户链上付款；需要**从 payer 预存余额直接 deduct** 完成结算，无新链上 tx。
- 目标：`a2aSettle` 增加 `mode: 'tx' | 'balance'`（默认 `'tx'` 兼容现状）；`balance` 模式校验余额后 `deduct` + 置 intent `paid` + 事件与 onCredit 回调，ref 幂等。
- 验收：余额模式结算原子、幂等，宿主可指定扣减金额与 ref。

---

## 5. SK：Session Key 代付配套（P1）

### 背景

AgentX 要让 Agent 自主付费：MPC 钱包持 agent 资金，Session Key（限额/白名单/有效期）在运行时自动代签"充值/付款"交易，无需用户在线。Session Key 引擎需提供面向该场景的配套。

### SK-1 代付授权模板

- 目标：提供"典型代付授权"模板：`contracts=[Escrow/Vault 地址], functions=[deposit]`（或 x402 payTo 转账）的一键 SessionAuth 生成与示例。
- 验收：AgentX 可按模板快速生成"只允许付给金库、限额定次"的会话。

### SK-2 修正文档与实现差异（A-16）

- 现状：`docs/services/session-key.md` 表述"sessionAddress 由服务端生成"，实际 A-16 后已改为**客户端生成 keypair 并提交 publicKey**（`session-service.ts`）。
- 目标：文档与代码对齐。
- 验收：README/服务文档与实现一致。

### SK-3 测试补强

- 现状：仅 1 个单测文件（`execution-service.test.ts`）。
- 目标：补会话创建/撤销、限额耗尽、白名单拒绝、并发锁、过期路径测试。
- 验收：核心路径单测覆盖，`npm test` 全绿。

### SK-4（可选）会话私钥托管加固

- 现状：服务端 AES-256-GCM 加密托管（`ENCRYPTION_KEY` env）。
- 目标：支持 KMS/外部密钥托管适配（可选接缝），文档标注密钥管理最佳实践。
- 验收：集成方可选接入外部密钥管理，密钥不落明文 env。

---

## 6. MPC：钱包演进（P2）

### MPC-1 2-of-3 阈值演进

- 现状：CGGMP24 **2-of-2**（服务端片1 + 恢复片2，诚实安全边界：不防服务端作恶）。
- 背景：Agent 钱包承载资金，AgentX 希望提升为"服务端片 + 用户片 + 独立守护片"的 2-of-3，任一单片泄露不可用、丢失可恢复。
- 目标：`TSS_EVALUATION.md` 中规划的加片3（独立签名机/HSM）落地。
- 验收：2-of-3 签名/恢复路径测试通过，现有 2-of-2 钱包平滑兼容。

---

## 7. 版本与协同约定

- InfraX 各模块按上述需求发版（建议 payments 0.1.4+；session-key 0.2.x+；mpc-sdk 0.3.x+）。
- 发版后 AgentX `npm` bump 对应依赖消费，不做代码复制。
- 需求实现顺序建议：**OE-1/OE-2（P0，AgentX 金库接入的依赖）→ PC-1/PC-3（P0，待付款闭环的依赖）→ A2A-1（P1）→ SK-1~3（P1）→ OE-3/OE-4/MPC-1（P2）**。
