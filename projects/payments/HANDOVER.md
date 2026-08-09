# 通用支付引擎交接文档 — @0xinfrax/payments

> **交接方**：AgentX（sftgroup）
> **接收方**：InfraX 通用平台团队
> **交接状态**：✅ 已完成（2026-08-08）——源码已迁入 **sftgroup/infraX** 仓库 `projects/payments/`
> **原包名**：`@agentxv2/payments`（AgentX 历史版本至 0.2.2，已 npm deprecate，提示迁移到新包）
> **现包名**：`@0xinfrax/payments`（v0.1.0，由 InfraX 账号发布与维护）
> **仓库**：https://github.com/sftgroup/infraX · 目录 `projects/payments/`

---

## 1. 一句话定位

**零业务耦合的通用支付引擎**。模块只负责「钱」：支付方式（method）、资产、金额、链上凭证验证与幂等入账；**业务上下文（agentId、订单号、套餐 ID 等）一律经 `metadata` 透传，模块不解释、不校验、不消费**。持久化走注入的 `PaymentStore` 接缝，宿主业务只通过 `onWebhookEvent` / `onCredit` 回调接入。

> **范围说明（2026-08-10）**：模块只保留**通用通道能力**（chain / fiat / x402 / MPP / 稳定币）。a2a-pay、period 授权制等**业务场景定义**已从模块剥离（见 §2），相应 client / router / store / 迁移已删除。

## 2. 功能矩阵

| 能力 | 说明 | 验证 |
| --- | --- | --- |
| **chain** | 链上订阅（SubscriptionManager escrow），只读：`getPlan` / `hasActiveSubscription` / `platformFeeBps` | 单测 + harness F1-3 |
| **fiat (Stripe)** | Checkout Session 创建（支持按链上套餐价自动定价、计费周期 `period`）、webhook 验签、事件归一化、intent 生命周期 | 单测 + harness F1-3 |
| **x402 v1** | 原生代币周期支付：`verifyAndCredit`（幂等验 tx）、余额、扣减、订阅访问 | harness F1-3 |
| **x402 v2** | `PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE` 三个 base64 header；scheme `exact` / `upto`；EIP-712 Payment 分片方案（domain 含 chainId + verifyingContract） | 单测 + harness F4 |
| **MPP 支付通道 (P2)** | 三阶段 open → (voucher)\* → close + topUp；EIP-712 `Voucher(channelId, cumulativeAmount)` 签名复用幂等（`mode: 'reuse'`）；auto-settle 阈值触发批量扣减；`channelId = keccak256(encodePacked(payer, payee, asset, salt, chainId))` | 单测 + harness F5 |
| **稳定币 (P3)** | EIP-3009 `transferWithAuthorization` + Permit2 `permitTransferFrom` 双机制；`Transfer(from→payTo, value≥price)` 事件作为入账凭证；6 位精度原子单位；`x402.verifyAndCredit` 原生验证失败自动回退 stablecoin | 单测 + harness F6 |

> 计费周期（`PaymentPeriod`：`day/week/month/year`）是**通用能力**，保留在 checkout、stripe recurring、on-chain `plan.period` 中；它不是授权场景。

## 3. 架构与设计原则

```
业务层（AgentX SDK / 前端）          ← 本模块不感知
   │   metadata / clientReference 透传
   ▼
PaymentsService（本模块）
   ├── adapters：chain / stripe / x402 / mpp / stablecoin
   ├── protocol：x402-v2 / mpp-voucher / stablecoin（EIP-712 构造 + 验签）
   ├── store 接缝：PaymentStore + MPPSessionStore
   │     ├── PgPaymentStore / PgMPPSessionStore（通用实现，可选）
   │     └── 宿主自定义 store（AgentX 用 AgentxPaymentStore 覆盖业务表）
   └── 回调接缝：onWebhookEvent / onCredit（宿主在这里落业务状态）
```

**不可打破的设计约束**：

1. **零 AgentX 依赖**：`dependencies` 仅 `pg` + `viem`；`express` 是 optional peer（仅 `@0xinfrax/payments/router` 需要）。`src` 中不允许出现任何 AgentX 业务 token（`fiat_subscriptions`、`x402_*`、`agentId` 等），有自动化断言（见 §8 解耦验证）。
2. **业务参数不落业务语义**：`metadata` 原样存 `payment_intents.metadata`（JSONB）；`clientReference` 由调用方构造、模块原样回显。
3. **持久化可插拔**：所有读写在 store 接缝；通用 Pg 实现是可选的便利实现。
4. **访问策略归宿主**：`resolveAccess` 语义由注入 store 决定（通用实现只查 `payment_access`；AgentX 是「链上 OR fiat/x402」）。模块不耦合。

## 4. 代码结构

```
projects/payments/
├── package.json            # @0xinfrax/payments v0.1.0, deps: pg + viem
├── tsconfig.json
├── README.md               # 使用文档（独立库 + 嵌入式两种形态）
├── DEPLOY.md               # 部署手册
├── HANDOVER.md             # 本文档
├── db/migrations/          # 001-004（模块自有 payment_* 表）
├── src/
│   ├── index.ts            # 公共入口
│   ├── types.ts            # 通用类型（metadata 透传约定）
│   ├── errors.ts           # PaymentError{code,status} + isPaymentError
│   ├── service.ts          # PaymentsService（引擎 + 回调接缝 + intent 生命周期）
│   ├── store.ts            # PaymentStore 接口 + Pg 两实现 + SqlExecutor 解耦
│   ├── client.ts           # X402Client / PaymentsClient / MPPClient
│   ├── router.ts           # createPaymentsRouter（express optional peer）
│   ├── protocol/
│   │   ├── x402-v2.ts      # PaymentRequired / PaymentPayload / PaymentResponse（EIP-712 分片）
│   │   ├── mpp-voucher.ts  # MPP voucher（EIP-712，channelId 确定性公式）
│   │   └── stablecoin.ts   # EIP-3009 + Permit2 验签 helper
│   └── adapters/
│       ├── chain.ts        # 链上只读
│       ├── stripe.ts       # Stripe 协议层（apiBase 可指向 mock）
│       ├── x402.ts         # 原生验证入账 + stablecoin fallback
│       ├── mpp.ts          # 通道 open/voucher/topUp/settle/close/session
│       └── stablecoin.ts   # EIP-3009 Transfer 事件入账验证
└── tests/                  # 10 个文件 89 断言
```

## 5. 存储接缝

### 5.1 PaymentStore（核心）

```ts
interface PaymentStore {
  balanceOf(address: string, asset?: string): Promise<bigint>
  credit(credit: PaymentCredit): Promise<void>            // 幂等入账（reference 为幂等键）
  isCreditRecorded(reference: string): Promise<boolean>   // 幂等探针
  deduct(address: string, amount: bigint, asset?: string): Promise<boolean>
  resolveAccess(subscriber, resource, opts?): Promise<{ active: boolean }>
  recordIntent?(intent): Promise<void>                    // 可选
  updateIntentStatus?(paymentId, status): Promise<void>   // 可选
}
```

### 5.2 MPPSessionStore（P2 可选注入）

- `MPPSessionStore`：`getSession / createSession / applyVoucher / recordVoucher / applySettle / topUp / closeSession`（open/voucher/settle/close 落库）

### 5.3 迁移（随包发布在 `db/migrations/`，幂等）

| 迁移 | 表 |
| --- | --- |
| 001 | `payment_intents` |
| 002 | `payment_credits` / `payment_balances` / `payment_access` |
| 003 | `payment_sessions` / `payment_vouchers`（MPP，含 auto-settle 策略列） |
| 004 | `payment_events`（归一化 webhook 回放） |

> 宿主若自带业务表，可实现自定义 store 注入，此时无需执行模块迁移（AgentX 即此形态）。

## 6. 协议实现要点

### 6.1 x402 v2
- 挑战：`PAYMENT-REQUIRED: <base64(PaymentRequired)>`，含 `accepts[]`（每个含 `scheme`/`amount`/`asset`/`network`(CAIP-2)/`payTo`）与 `resource`
- 证明：`PAYMENT-SIGNATURE: <base64(PaymentPayload)>`，EIP-712 类型 `Payment{accepted,payload}`，domain `{name:'x402',version:'2',chainId,verifyingContract}`
- 回执：`PAYMENT-RESPONSE: <base64(PaymentResponse)>`（`status`/`settledAmount`/`payer`）
- 服务端验证链路：recoverTypedDataAddress 验签 → 验 tx 真实存在且金额匹配 → 幂等入账

### 6.2 MPP
- `channelId` 确定性公式（不查库可重算）
- voucher 幂等：`cum === current_cum && sig === last_signature` → `mode:'reuse'`
- settle：`consumed = cum − spent`；autoSettle 阈值触发；close 冻结会话（退款 = 余额剩余部分，宿主自行决定提现）

### 6.3 Stablecoin
- EIP-3009 domain：`{name: <token 名>, version:'2', chainId, verifyingContract: <token>}` —— **name 必须与链上 token 构造参数完全一致**，否则 ecrecover 失败（见 §10 坑）
- 双机制验签 helper：`recoverEIP3009Signer` / `recoverPermit2Signer`；链上 `Transfer` 事件才是入账依据，验签是纵深防御

## 7. 宿主集成（AgentX 参考实现）

AgentX 以「嵌入式服务」形态集成（`gateway/src/services/payments.ts` + `payments-bridge.ts`），要点：

- `AgentxPaymentStore` 实现 `PaymentStore`，覆盖 AgentX 自有表（`fiat_subscriptions` / `x402_*`），**不执行模块迁移**
- `PaymentsBridge` 消费模块 webhook 事件 → 落业务订阅表
- 统一端点 `/api/v1/payments/*`（含 `/mpp/*`）由宿主路由暴露
- 部署：`payments build`（tsc）→ 宿主 `npm install`（registry 安装）→ 宿主 build → 重启

> AgentX 侧保留定制支付 SDK（`@agentxv2/sdk` 的 `SubscriptionPayments` 与协议客户端 re-export），迁移后改为依赖 `@0xinfrax/payments`。

## 8. 验证体系

| 层 | 内容 | 状态 |
| --- | --- | --- |
| 单测 | `npm test`：10 文件 89 断言（协议/适配器/service/router/错误码） | 全绿 |
| 嵌入式 harness | `scripts/local-payments/run.sh`：postgres+anvil+gateway，`FLOWS="f1 f4 f5 f6"`（F1-3 三轨订阅 / F4 x402 v2 / F5 MPP / F6 稳定币） | 全绿（生产机验证） |
| 解耦验证 | `scripts/local-payments/run-decouple.sh`：独立库形态，19 断言（加载路径/依赖仅 pg+viem/无 AgentX token/DB 仅 payment_* 表） | 全绿 |

## 9. 客户端与 Router

- HTTP 客户端（指向任意部署点）：`X402Client`（quote/pay/replay/verify/balance）、`PaymentsClient`（create/verify/access/info）、`MPPClient`（open/voucher/topUp/settle/close/session）
- `createPaymentsRouter(payments)`：现成 Express router（`/info` `/price` `/checkout` `/verify` `/webhook` `/balance` `/access` `/mpp/*`）；`express` 为 optional peer，不 import router 则无此依赖

## 10. 已知注意点（踩坑记录）

1. **viem `readContract` 读合约 struct 返回**：ABI 必须声明为单个 `tuple` + `components`，若写成扁平 outputs 会错位解码（`Number "1e18" is not in safe integer range`）。
2. **StripeAdapter.parseEvent 归一化**：必须把 Stripe 的 `data.object` 归一化成模块 `WebhookEvent {type, object}`，否则宿主 bridge 读 `undefined.client_reference_id`。
3. **`file:` 依赖是拷贝安装**（npm），非 symlink：改模块后宿主必须 `rm -rf node_modules/@0xinfrax/payments && npm install`，否则 typecheck 用旧 API。
4. **EIP-3009 的 token domain name 一致性**：签名侧 name 与链上合约构造参数必须逐字节一致（示例中 `MockUSD Coin` 的 `Mock USD Coin` 带空格）。
5. **金额精度**：稳定币用 6 位精度原子单位（1 mUSDC = 1e6）；原生代币 18 位。模块内一律十进制字符串，禁止浮点。
6. **anvil harness**：`--block-time` 会导致刚发 tx 的 receipt 不可用（verifyAndCredit 报 invalid）；foundry 镜像无 curl/wget，healthcheck 用 `/dev/tcp`；迁移非幂等需先 DROP/CREATE DATABASE。
7. **宿主 ledger 混资产**（AgentX 侧行为，非模块缺陷）：`AgentxPaymentStore.credit` 把不同资产信用累加进单行原生余额。模块自身按 asset 记账。
8. **gateway 对 `.env` 的 `source`**：带空格的字符串值必须加引号（`STABLECOIN_DOMAIN_NAME="Mock USD Coin"`）。
9. **forge script 部署**：`usdc.mint(msg.sender, …)` 在 forge script 里 mint 给的是**脚本合约地址**而非广播者 EOA，须用 `vm.addr(deployerPrivateKey)`。
10. **场景剥离（2026-08-10）**：a2a / period 授权 rail 已从模块删除（含 `payment_authorizations` 表与 005 迁移）。已在生产库执行过 005 的部署，表数据不受影响（模块不再读写）；新部署不再执行该迁移。

## 11. 发版与维护指南

### 发版流程

```bash
# 1. bump version（package.json，含 README/DEPLOY.md 中的版本引用）
# 2. 本地最小验证（允许：build + typecheck + 单测）
npm run build && npm run typecheck && npm test
# 3. 发布（npm 账号：sftgroup，须具备 @0xinfrax scope 发布权限）
npm publish --access public
# 4. 验证
npm view @0xinfrax/payments dist-tags   # latest 指向新版本
```

> CDN packument 可能短暂 404，用 `?write=true` 或版本级 endpoint 验证。

### 添加新 rail 的步骤

1. `src/protocol/` 加协议（EIP-712 types / header 格式 / 签名恢复）
2. `src/adapters/` 加适配器（验证 + 入账逻辑），并在 `x402.verifyAndCredit` 中按需接 fallback
3. `src/service.ts` 暴露服务层方法 + `PaymentsServiceOptions` 加可选 store
4. `src/client.ts` 加 HTTP 客户端；`src/index.ts` re-export
5. `db/migrations/` 加迁移（幂等，`IF NOT EXISTS`）
6. `tests/` 补单测；`scripts/local-payments/` 补 harness flow
7. **约束检查**：`grep agentId src/` 仅允许出现在 metadata 类型/链上合约字段/包名注释

### 向后兼容承诺

- `PaymentsService` 既有方法签名不变；新能力以「可选 store 注入 + 新增方法」方式添加
- `PaymentStore` 新接口成员一律**可选**（`?`），宿主自定义 store 可滞后实现
- intent 生命周期扩展走 `updateIntentStatus`（宿主未实现则 no-op）

## 12. 与 AgentX SDK 的依赖关系（迁移后）

- AgentX 侧保留定制支付 SDK：`@agentxv2/sdk`（`SubscriptionPayments` 业务封装 + `MPPClient` / `X402Client` / `PaymentsClient` 协议客户端 re-export）
- **依赖方向**：AgentX 定制层 → `@0xinfrax/payments`（registry）→（无反向）；`@agentxv2/payments` 旧包已 deprecate
- 通用层零业务依赖；双方版本通过 semver `^` 范围对接
- **注意**：模块 0.1.2+ 不再导出 `A2AClient` / `PeriodClient` 与 a2a/period 端点；AgentX 定制层若引用这些场景能力，需在业务侧自行实现或移除（见 AgentX 侧通知）
