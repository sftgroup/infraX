# @0xinfrax/payments

零业务耦合的通用支付引擎（chain / Stripe / x402 / MPP 支付通道 / 稳定币 / a2a / period 订阅周期 / batch 批量收款 / invite 自动收费邀请 / transfer 账本内转账）。

> **维护**：由 **InfraX**（GitHub [sftgroup/infraX](https://github.com/sftgroup/infraX)）团队维护；源码位于仓库 [`projects/payments/`](https://github.com/sftgroup/infraX/tree/main/projects/payments) 目录，npm 包 `@0xinfrax/payments` 由 InfraX 账号发布与维护。集成方可作为独立库使用，但问题的修复与演进统一由 InfraX 负责。

> **集成到独立项目**：完整部署步骤（安装 / 数据库 / 合约 / 代码接入 / 验证 / 生产注意）见 [`DEPLOY.md`](./DEPLOY.md)。
>
> **调用方自配收款**：想配置「自己的收款」（自部署 SubscriptionManager / 自己 Stripe 账号 / 自配 x402 钱包 / MPP payee），见 [`CALLER_SETUP.md`](./CALLER_SETUP.md)。

- **嵌入式服务**：作为宿主 Gateway 的内部引擎（AgentX 即此形态的参考实现，见 `gateway/src/services/payments.ts`）
- **独立库**：可被任意项目依赖，以「调用方自持 store」的形态独立运行
- **独立服务（微服务形态）**：仓库内置部署入口 [`server.ts`](server.ts)（tsx 直跑）——Express + 统一鉴权（auth-express，Bearer/X-API-Key/X-Service-Key）+ `PgPaymentStore`（`pocketx_payments` 独立库，启动自动跑 4 迁移）+ `/health` + `createPaymentsRouter`（挂 `/payments`）；链上读可配 `CHAIN_RPC_READ_KEY` 走 chain-rpc 网关（DC-10）；`WEBHOOK_FORWARD_URL` 时事件出站转发（`createWebhookForwarder`）。systemd 模板见 `deploy/systemd/infrax-payments.service`（:9132）

核心设计：**模块只懂钱**（方法 / 资产 / 金额 / 凭证）。业务上下文（如 `agentId`、订单号）一律经 `metadata` 透传；持久化走注入的 `PaymentStore` 接缝；宿主业务（订阅注册、发货）只通过 `onWebhookEvent` / `onCredit` 回调接入。模块不解释、不校验、不消费任何业务参数。

依赖仅有 `pg`（账本/凭证）与 `viem`（链上读写）。

---

## 目录

- [依赖配置（迁移到其他项目）](#依赖配置迁移到其他项目)
- [数据库迁移](#数据库迁移)
- [快速开始（独立库形态）](#快速开始独立库形态)
- [调用方自配收款模板](#依赖配置迁移到其他项目)（[`CALLER_SETUP.md`](./CALLER_SETUP.md)）
- [嵌入式形态（宿主自带 store / 回调）](#嵌入式形态宿主自带-store--回调)
- [业务上下文透传规则](#业务上下文透传规则)
- [API 参考](#api-参考)
- [本地验证](#本地验证)
- [目录结构](#目录结构)

---

## 依赖配置（迁移到其他项目）

### 1. package.json

```jsonc
{
  "dependencies": {
    "@0xinfrax/payments": "^0.1.0" // 公开 npm registry 安装（推荐）；或 file:/git/私有 registry，见下
    // pg / viem 是模块的传递依赖，npm install 会自动安装，宿主无需显式声明
  }
}
```

> 若宿主自身也要用 `viem` 发交易（链上 / x402 付款），可另行声明自己版本的 `viem`——模块会从自身 `node_modules` 解析，互不冲突。

### 2. 四种安装来源

| 场景 | package.json 写法 |
| --- | --- |
| **公开 npm registry（推荐，已发布）** | `"@0xinfrax/payments": "^0.1.0"`（`npm view @0xinfrax/payments version` → 当前 latest） |
| Monorepo / 本地开发 | `"@0xinfrax/payments": "file:../payments"` |
| Git 仓库（打 tag 固定版本） | `"@0xinfrax/payments": "git+https://github.com/<org>/payments.git#v0.2.0"` |
| 私有 npm registry | `"@0xinfrax/payments": "^0.2.0"`（配合 `.npmrc` 指向 registry） |

### 3. 使用前构建

发布物是 `tsc` 产物（`dist/`）。`file:` 引用前需确保已构建：

```bash
cd payments && npm install && npm run build
```

---

## 数据库迁移

模块拥有自己的 `payment_*` 表（8 个迁移文件，随包发布在 `db/migrations/`）：

| 迁移 | 表 | 用途 |
| --- | --- | --- |
| `001_payment_intents.sql` | `payment_intents` | 统一支付意图（chain / fiat / x402 / mpp / a2a） |
| `002_payment_credits.sql` | `payment_credits` / `payment_balances` / `payment_access` | 入账台账、余额、通用访问登记表 |
| `003_payment_sessions.sql` | `payment_sessions` / `payment_vouchers` | MPP 通道会话 / 凭证 |
| `004_payment_events.sql` | `payment_events` | 归一化 webhook 事件回放 |
| `005_payment_authorizations.sql` | `payment_authorizations`（+ `payment_intents.payee`） | period 授权（订阅周期计费） |
| `006_payment_batches.sql` | `payment_batches` | batch 批量收款（一次 N 个 a2a 意图） |
| `007_payment_invites.sql` | `payment_invites` | invite 收费邀请（payer/payee/amount/due_at/memo + 状态机） |
| `008_payment_transfers.sql` | `payment_transfers` | transfer 账本内原子划转（reference 幂等键） |

在**新项目自己的数据库**中执行（不要复用其他项目的表）：

```bash
for f in node_modules/@0xinfrax/payments/db/migrations/*.sql; do
  psql "$DATABASE_URL" -f "$f"
done
```

通用形态使用 `PgPaymentStore`（读这些表）。如果宿主已有自己的订阅/余额表，可自定义实现 `PaymentStore` 注入（见[嵌入式形态](#嵌入式形态宿主自带-store--回调)），此时可不执行模块迁移。

---

## 快速开始（独立库形态）

```ts
import { Pool } from 'pg'
import { PaymentsService, PgPaymentStore } from '@0xinfrax/payments'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

const payments = new PaymentsService({
  store: new PgPaymentStore(pool),

  // 链上：每个 slot 一条（可读链上套餐价 / 订阅状态）
  chains: {
    sepolia: {
      rpcUrl: process.env.RPC_URL,
      chainId: 11155111,
      subscriptionManager: process.env.SUBSCRIPTION_MANAGER, // 部署好的 SubscriptionManager
    },
  },

  // 法币：不配则 fiat 轨返回「未配置」（503）
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET,
    apiBase: process.env.STRIPE_API_BASE,   // 可选，默认 https://api.stripe.com/v1；本地 mock 用 http://127.0.0.1:8777/v1
    tokenUsdPrice: 1,                        // 可选，默认 1：native 单价 → 用于套餐自动定价
  },

  // x402：不配则 verify 返回「未配置」
  x402: {
    enabled: true,
    payTo: process.env.X402_PAY_TO,          // 平台收款钱包
    priceWei: process.env.X402_PRICE_WEI,    // 单次价格
    chain: 'sepolia',
  },

  // ── 宿主业务只写在这里 ──────────────────────────────────────────────
  // webhook 事件（Stripe）→ 你的业务：开订阅、发凭证、写订单
  onWebhookEvent: async (event) => {
    if (event.type === 'checkout.session.completed') {
      const [subscriber, resourceId] = String(event.object.client_reference_id ?? '').split('|')
      await grantAccess(subscriber, resourceId) // 例如写 payment_access 或你自己的表
    }
  },
  // 链上付款验证成功入账后（x402 轨）→ 你的业务
  onCredit: async (credit) => {
    await notifyUser(credit.payer, credit.amountWei)
  },
})
```

### 通道的典型用法

```ts
// ① 链上：用户先在链上调用 SubscriptionManager.subscribe(planId)，然后：
const active = await payments.chain.hasActiveSubscription('sepolia', subscriber, agentId)
const plan = await payments.chain.getPlan('sepolia', planId) // 定价、套餐详情（含计费周期）
const feeBps = await payments.chain.platformFeeBps('sepolia')

// ② 法币：创建 Stripe Checkout Session（可自动定价，period 为计费周期）
const checkout = await payments.createPayment({
  method: 'fiat',
  subscriber,
  period: 'month',
  pricing: { planId },                    // 省略 amountCents → 按链上套餐价换算
  metadata: { agentId, planId },          // 业务参数原样透传
  clientReference: `${subscriber}|${agentId}|${planId}`, // 由你构造，webhook 原样回显
})
// → { method:'fiat', sessionUrl, sessionId, clientReference, redirect:true }

// ③ x402：用户向 payTo 转账后验证入账（幂等）
const verified = await payments.verifyPayment(txHash, 'sepolia')
// → { reference, payer, creditedWei, asset, chain } 或 null（非有效支付）
const balance = await payments.balanceOf(subscriber) // 模块账本余额
```

### Webhook 路由（需要 rawBody）

```ts
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf } }))

app.post('/webhooks/stripe', async (req, res) => {
  try {
    await payments.handleWebhook(req.rawBody.toString(), req.headers['stripe-signature'])
    res.json({ received: true })
  } catch (err) {
    res.status(400).json({ error: err.message }) // 签名无效 → 'Invalid signature'
  }
})
```

### 访问检查

```ts
// 通用 store 只查 payment_access 登记表；「链上 OR 链下」的统一策略由你的 store 实现决定
const access = await payments.resolveAccess(subscriber, { agentId }, { chain: 'sepolia' })
```

### 可选：现成 Express router（版本 A 推荐）

`@0xinfrax/payments/router` 提供了覆盖全部端点（`/info` `/price` `/checkout` `/verify` `/webhook` `/balance` `/access` `/capabilities` `/mpp/*` `/a2a/*` `/period/*` `/batch/*` `/invites/*` `/transfers/*`）的现成 router，挂载即用：

```ts
import { createPaymentsRouter } from '@0xinfrax/payments/router'

app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf } })) // webhook 需要 rawBody
app.use('/payments', createPaymentsRouter(payments))
```

`express` 是 optional peer 依赖：不调用 `createPaymentsRouter` 就不需要它。

### 能力层（可插拔 rail）

每个通道是一个**可插拔能力**（chain / fiat / x402 / mpp / a2a / period / batch / invite / transfer），由构造参数（+ ENV 开关）决定启用与否：

- `GET /capabilities` 返回能力清单（`enabled` / `endpoints` / `config`），调用者先探测再使用：
  ```json
  { "capabilities": { "a2a": { "enabled": true, "endpoints": ["POST /a2a", "POST /a2a/settle"], "config": { "defaultPayee": "0x..." } }, "...": {} } }
  ```
- 未启用能力的端点仍存在但返回 **503**（显式 "not enabled" 而非 404），便于调用方识别配置缺失。
- 新增能力不破坏旧调用：`createPayment(method)` 增加 `a2a`（两阶段意图）与 `batch`（一次向 N 个 payee 收款）；`chargePeriod` / `getAuthorization` 走 period 授权；`createInvite` / `payInviteByBalance` 走 invite（agent 自动发收费邀请）；`createTransfer` / `confirmTransfer` 走 transfer（账本内原子划转）。
- 独立开关：`a2a` 默认随 `x402` 开启（可 `A2A_ENABLED=false` 关闭）；`period` / `batch` / `invite` / `transfer` 需注入对应 store seam 才启用（微服务形态另需 `PERIOD_ENABLED` / `BATCH_ENABLED` / `INVITE_ENABLED` / `TRANSFER_ENABLED=true`）。

---

## 嵌入式形态（宿主自带 store / 回调）

模块的所有持久化都走 `PaymentStore` 接口，宿主可注入自己的表：

```ts
import { PaymentsService } from '@0xinfrax/payments'
import type { PaymentStore, PaymentCredit } from '@0xinfrax/payments'

class MyStore implements PaymentStore {
  balanceOf(address, asset) { /* 读你的余额表 */ }
  credit(credit: PaymentCredit) { /* 幂等入账 */ }
  isCreditRecorded(reference) { /* 幂等探针 */ }
  deduct(address, amount, asset) { /* 扣减，返回是否充足 */ }
  resolveAccess(subscriber, resource, opts) { /* 你的统一访问策略 */ }
}

const payments = new PaymentsService({ store: new MyStore(), chains, stripe, x402, ... })
```

AgentX 自身即此形态的参考实现：

- 组装：`gateway/src/services/payments.ts`（env → 模块配置）
- 自定义 store + 事件桥：`gateway/src/services/payments-bridge.ts`（`AgentxPaymentStore` 覆盖 `fiat_subscriptions` / `x402_*` 表，`PaymentsBridge` 把模块 webhook 事件落到业务订阅表）

---

## 业务上下文透传规则

1. **`metadata`**：业务参数（`agentId` / `planId` / 订单号…）放这里，模块原样落 `payment_intents.metadata`（JSONB），不解释、不校验、不消费。
2. **`clientReference`**（fiat）：由调用方构造的透明引用（如 `subscriber|agentId|planId`），模块转发给 Stripe 并在结果与 webhook 事件中原样回显；解析它属于宿主业务。
3. **访问策略**：`resolveAccess` 的语义由注入的 store 决定（通用 `PgPaymentStore` 只查 `payment_access`；AgentX 的 store 是「链上 OR fiat/x402」）。模块不感知。

---

## API 参考

| 成员 | 说明 |
| --- | --- |
| `PaymentsService.createPayment(input)` | 创建支付意图（fiat checkout / MPP open） |
| `PaymentsService.verifyPayment(txHash, chain?)` | 验证链上付款并幂等入账（原生优先，失败回退 stablecoin EIP-3009） |
| `PaymentsService.handleWebhook(payload, signature)` | 校验 Stripe 签名 → 归一化事件 → 调 `onWebhookEvent` |
| `PaymentsService.resolveAccess(subscriber, resource, opts?)` | 委托 store 的访问检查 |
| `PaymentsService.balanceOf / deduct` | 余额查询 / 原子扣减（委托 store） |
| `PaymentsService.chain` | `ChainAdapter`：`getPlan` / `hasActiveSubscription` / `platformFeeBps` |
| `PaymentsService.stripe` | `StripeAdapter`：`createCheckoutSession` / `verifyWebhookSignature` / `parseEvent` |
| `PaymentsService.x402` | `X402Adapter`：`verifyAndCredit` / `balanceOf` / `deduct` / `paymentRequiredHeaders` |
| `PaymentsService.mpp` | `MPPAdapter`：`open` / `voucher` / `topUp` / `settle` / `close` / `session`（支付通道） |
| `PaymentsService.mppVoucher / mppTopUp / mppSettle / mppClose / mppSession` | MPP 通道操作（服务层薄封装） |
| `PgPaymentStore` | 通用 Postgres store（`payment_*` 表） |
| `PgMPPSessionStore` | MPP 通道 Pg 实现（可选，注入到 Options） |
| `updateIntentStatus(paymentId, status)` | 推进 intent 生命周期（`created→paid/failed/closed`）；x402 由 verifyPayment 自动置 `paid`，fiat 由宿主在回调里驱动 |
| `PaymentError` / `isPaymentError` | 带 `code` + 建议 `status` 的类型化错误（宿主按码映射 HTTP） |
| `createPaymentsRouter` | 现成 Express router（`@0xinfrax/payments/router`） |
| `X402Client` / `PaymentsClient` / `MPPClient` | 面向任意部署点的 HTTP 客户端 |
| `buildVoucherMessage` / `recoverEIP3009Signer` / `recoverPermit2Signer` | EIP-712 协议 helper（MPP voucher / 稳定币双机制） |
| `buildPaymentMessage` / `encodeHeader` / `decodeHeader` | x402 v2 协议 helper（PaymentRequired / PaymentPayload / PaymentResponse） |

类型集中在 `types.ts`：`PaymentMethod`、`CreatePaymentInput / CreatePaymentResult`、`PaymentCredit`、`VerifiedPayment`、`WebhookEvent`、`PlanInfo`、`X402Info`、`MPPSessionRow` 等。

---

## 本地验证

仓库内置两套本地 harness（需 docker，无需 Stripe 账号、无需真实链）：

| 脚本 | 验证对象 | 说明 |
| --- | --- | --- |
| `scripts/local-payments/run.sh` | 嵌入式形态（B） | 起 postgres+anvil → 部署合约（含 MockUSDC）→ 起 gateway → `FLOWS="f1 f4 f5 f6"` 全绿（F1-3 三轨订阅 / F4 x402 v2 / F5 MPP / F6 稳定币 EIP-3009） |
| `scripts/local-payments/run-decouple.sh` | 独立库形态（A） | 只 import 模块自身 + 独立 `agentx_payments` 库，证明零 AgentX 耦合，19 项断言 |
| `npm test` | 单测 | 12 个文件 124 项断言（协议 / 适配器 / service / router / 错误码 / 能力层 / invite+transfer 状态机与原子划转） |

解耦验证断言示例：模块入口必须从自身 `dist/` 解析、依赖仅 `pg,viem`、src/dist 无 `fiat_subscriptions` / `x402_*` / `@agentxv2/sdk` 等业务 token、DB 仅 `payment_*` 表。

---

## 目录结构

```
payments/
├── package.json            # @0xinfrax/payments, deps: pg + viem
├── tsconfig.json
├── db/migrations/          # 001-008（模块自有 payment_* 表）
├── src/
│   ├── index.ts            # 公共入口
│   ├── types.ts            # 通用类型（metadata 透传约定）
│   ├── errors.ts           # PaymentError{code,status}
│   ├── service.ts          # PaymentsService（引擎 + 回调接缝）
│   ├── store.ts            # PaymentStore 接口 + PgPaymentStore + PgMPPSessionStore + PgAuthorizationStore + PgBatchStore + PgInviteStore + PgTransferStore
│   ├── client.ts           # X402Client / PaymentsClient / MPPClient
│   ├── router.ts           # createPaymentsRouter（express 为 optional peer）
│   ├── protocol/
│   │   ├── x402-v2.ts      # PaymentRequired / PaymentPayload / PaymentResponse（EIP-712）
│   │   ├── mpp-voucher.ts  # MPP voucher（EIP-712，channelId 确定性公式）
│   │   └── stablecoin.ts   # EIP-3009 + Permit2 验签 helper
│   └── adapters/
│       ├── chain.ts        # 链上只读（getPlan / hasActiveSubscription）
│       ├── stripe.ts       # Stripe 协议层（可配 apiBase 指向 mock）
│       ├── x402.ts         # 原生代币付款验证 + 入账（stablecoin fallback）
│       ├── mpp.ts          # MPP 通道（open/voucher/topUp/settle/close/session）
│       └── stablecoin.ts   # EIP-3009 Transfer 事件入账验证
```
