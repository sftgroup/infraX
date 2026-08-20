# aa-relay 计费与资金语义（A-10 / OE-6 / REQ-1~3）

> 适用：aa-relay（:9131，`@0xinfrax/aa-sdk` 调用方）的 UserOp 中继计费。
> 依据：AgentX 需求 `docs/aa-auto-renew-funding-requirements-infrax.md`（REQ-1~3，2026-08-19 实施）；
> 通用托管设计见 `docs/PAYMASTER_ONCHAIN_ESCROW_DESIGN.md`。

## 1. 计费模式

| 模式 | 开关 | 资金权威源 | 说明 |
|---|---|---|---|
| escrow 链上托管 | `ESCROW_MODE=true` | 链上 `InfraXEscrow` `balanceOf` | 广播前 `charge`（storage 记账）、收据后 `refund/extra` 退差；**生产默认** |
| session 订阅 ledger | `AA_PAYMENTS_URL/API_KEY/PLATFORM_ADDRESS` | payments ledger | 预扣/退差同语义，资金在平台 ledger |
| 未配置 | 两者皆无 | — | 免费放行（开发环境向后兼容） |

> 两类均未配置才免费；`/v1/ledger-balance` 在 **escrow 模式也放行**（读链上余额，REQ-2a）。

## 2. 预扣构成（广播前 charge）

```
预扣额 = 固定费（AA_USEROP_FEE_WEI，默认 0.0001 OXA）
       + 预估 gas（callGasLimit + verificationGasLimit + preVerificationGas）× maxFeePerGas
```

- 生产实测预扣约 **0.00246 OXA/次**（enable 场景，固定费 + 预估 gas）。
- 链上 `charge` 受 perTx/perDay 限额约束（默认 1/10 OXA，owner 可配）。

## 3. 结算退差（收据后）

| 情形 | 动作 | 语义 |
|---|---|---|
| 实际 < 预扣 | `refund(差额)` | 多退（余额回补 + 当日累计回退） |
| 实际 > 预扣 | `charge(差额)` | 少补（追扣，余额/限额不足 → 402） |
| 广播失败 | `refund(全额)` | 全额退还预扣 |

实际扣费 = 固定费 + `actualGasCost`（收据），即 **UserOp 次数费 + paymaster gas 代付按实际结算**。

> **同步 vs 异步结算差异（对账关键，2026-08-21 P1 优化后）**：
> - **同步（`wait=true`，默认）**：阻塞至收据 → 按 `固定费 + actualGasCost` 多退少补（refund/extra）。
> - **异步（`wait=false`）**：广播成功立即返回 **202 + opHash**，**后台轮询收据后同样按 `固定费 + actualGasCost` 结算退差**（与同步一致）；仅广播失败全额退款，收据超时（120s）保留预扣仅告警。对账以 `Charged` + `Refunded`（`ref` 带 `:refund`/`:extra`）为准。
>
> 对账事件（`InfraXEscrow`）：`Charged(user, amount, ref)` / `Refunded(user, amount, ref)`；退差/追扣 ref 带后缀 `:refund` / `:extra`，退款 ref = `{chargeRef}:refund`。

## 4. 资金总览（REQ-2b）

`POST /v1/ledger-balance`（body `{account}`，escrow 模式）返回：

```json
{ "address": "0x…", "balanceWei": "…", "balance": "0.05",
  "funds": { "escrowWei": "50000000000000000",      // relay 计费预扣来源
             "epDepositWei": "…",                    // EntryPoint deposit（UserOp gas 来源）
             "nativeWei": "…" } }                    // 账户原生余额（execute value 来源）
```

> EP/native 读取失败仅告警不阻断（funds 对应字段为 null）。EP 地址取 `ESCROW_ENTRYPOINT` 或 `AA_OXACHAIN_ENTRYPOINT_V07`。

## 5. 智能账户充值路径（REQ-1，AgentX 场景）

计费主体是智能账户（`op.sender`，用户不持私钥）时，三类资金独立、互不共用：

| 开销 | 来源 | 充值动作 |
|---|---|---|
| 订阅费（execute value） | 子账户 native | 主钱包 EOA 直接转 OXA 给子账户 |
| UserOp gas | 子账户 **EntryPoint deposit** | EOA 调 `EP.depositTo(子账户)` |
| relay 服务费（预扣） | 子账户 **InfraXEscrow `_balances[account]`** | **主钱包 EOA 单笔 tx 调 `depositFor(子账户)` 代充值**（REQ-1） |

- `depositFor(user)` / `depositForERC20(token, amount, user)`：`_balances[user] += msg.value`，记账到 **user** 名下（与 `EP.depositTo` 同语义，无权限要求、非出金操作）。
- 事件 `DepositedFor(user, amount, token, by)` 供对账索引。
- 兜底：账户自身用 session key 调 `deposit()` 自付（需会话白名单含 `escrow.deposit()`，REQ-4 fallback）。
- ⚠️ `deposit()` 只记 `msg.sender`：用户 EOA 调 `deposit()` 到不了子账户名下；402 提示已按计费主体区分文案（REQ-2c）。

## 5.5 批量充值与费用估算（REQ-5）

多子账户/多期续订场景：

**N 期续订总费用估算**（可预计算充值额）：

```
N 期费用 = N × 单期费用
单期费用 = 订阅价（execute value） + relay 服务费（固定费 0.0001 OXA + 预估 gas）
```

- 生产实测（enable 场景）单期 relay 服务费 ≈ **0.00246 OXA**（固定费 + 预估 gas，预扣值；结算按实际退差）。
- 例：订阅价 0.05 OXA/期 × 12 期 + relay 服务费 0.00246×12 → 一次性充值 ≈ 0.6295 OXA。

**批量入账**（2026-08-19 上线，`InfraXEscrow` UUPS 升级后）：

```solidity
function depositForBatch(address[] users, uint256[] amounts) external payable;   // msg.value 须等于各额之和
function depositForERC20Batch(address token, address[] users, uint256[] amounts) external;
```

- 单 tx 多账户入账（gas 远低于 N 笔 depositFor），逐账户各发 `DepositedFor` 事件供对账聚合。
- 生产实测：`depositForBatch([0x02a6…A3, 0x257a…B4], [0.001, 0.002], {value: 0.003})` → 两账户精确入账，tx `0x0bd95a6c…` ✅
- 充值后由账户相关方确认 `balanceOf` 即生效（relay 计费主体 = `op.sender` 直接命中）。

## 6. 耗时与 SLA 建议（REQ-3）

AgentX 生产实测（2026-08-18/19）：

| 阶段 | 耗时 |
|---|---|
| escrow `charge` 上链确认 | ~12s |
| bundler 模拟 + 广播 + 收据 | ~24s+ |
| **端到端（charge→settle）** | ~40-60s |

**客户端超时建议 ≥ 150s**（AgentX 网关已采用 150s）；如长连接不可接受，用异步模式：

- 同步：`POST /v1/userops`（默认）阻塞至收据，收据后按 actualGasCost 多退少补。
- 异步：`POST /v1/userops` body 传 `wait:false` → **立即返回 202 Accepted + opHash** → `GET /v1/userops/:hash` 轮询收据，消除长连接超时耦合；**收据后在后台自动结算退差**（与同步口径一致，见 §3）。

## 7. 端点速查

| 端点 | 鉴权 | 说明 |
|---|---|---|
| `GET /v1/plans` | `AA_RELAY_API_KEY`（实测需 key，2026-08-19） | 价目/模式/充值指引（`aaPlansInfo`） |
| `POST /v1/ledger-balance` | `AA_RELAY_API_KEY` | 余额 + 资金总览（REQ-2b） |
| `POST /v1/userops` | `AA_RELAY_API_KEY` | UserOp 广播（同步/异步） |
| `GET /v1/userops/:hash` | `AA_RELAY_API_KEY` | 收据/状态轮询 |
