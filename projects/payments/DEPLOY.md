# @0xinfrax/payments — 独立项目集成部署指南

本文档说明如何把通用支付模块 `@0xinfrax/payments` 集成到一个**全新的、与 AgentX 无关的项目**中，让该项目获得三种支付能力：

- **chain**：链上订阅（用户钱包直接调用链上 `SubscriptionManager.subscribe`，服务端读取链上状态做访问控制）
- **fiat**：Stripe 信用卡订阅（Checkout Session + 签名校验的 Webhook，无需自己对接 Stripe 协议）
- **x402**：原生代币按量/周期支付（用户向平台钱包转账，服务端验 tx、幂等入账、扣费访问）

核心特点：**模块不感知你的业务**。你的业务上下文（订单号、用户 ID、套餐 ID…）通过 `metadata` 透传，持久化走可注入的 `PaymentStore`，业务动作（发货、授权、通知）只写在回调里。

> 模块自身的 API 参考见同目录 `README.md`。本文只讲"如何接到你的项目里"。

---

## 1. 前置条件

| 项 | 要求 |
| --- | --- |
| Node.js | ≥ 18.18（模块使用原生 `fetch` / `crypto.randomUUID`） |
| 数据库 | PostgreSQL 14+ |
| 链上合约 | 一条链上已部署的 `SubscriptionManager`（见 §4；本地可用 anvil） |
| Stripe | 正式：Stripe 账号（`sk_test_*` / `whsec_*`）；本地：mock Stripe（见 §7） |
| 包管理器 | npm ≥ 9 |

模块运行时依赖仅 `pg` + `viem`（均为传递依赖，自动安装）；`express` 是 optional peer（仅当使用现成 router 时需要）。

---

## 2. 安装依赖

### 2.1 package.json

```jsonc
{
  "dependencies": {
    "@0xinfrax/payments": "file:../payments"   // 按你的来源替换，见下表
    // pg / viem 由模块传递安装，无需显式声明
  },
  "devDependencies": {
    "@types/pg": "^8.11.10"
  }
}
```

### 2.2 三种安装来源

| 场景 | 写法 |
| --- | --- |
| Monorepo / 本地开发 | `"@0xinfrax/payments": "file:../payments"` |
| Git 仓库（打 tag 固定版本） | `"@0xinfrax/payments": "git+https://github.com/<org>/payments.git#v0.2.0"` |
| 私有 npm registry | `"@0xinfrax/payments": "^0.2.0"`（配合 `.npmrc`） |

```bash
npm install
```

> **file: 依赖注意**：npm 对 `file:` 本地路径是**拷贝安装**（非软链）。模块升级后需删除重装刷新：
> `rm -rf node_modules/@0xinfrax/payments && npm install`

---

## 3. 数据库初始化

模块自带 3 个迁移文件（随包发布在 `db/migrations/`），在**你项目自己的数据库**中执行：

```bash
export DATABASE_URL='postgresql://user:pass@host:5432/your_db'

for f in node_modules/@0xinfrax/payments/db/migrations/*.sql; do
  psql "$DATABASE_URL" -f "$f"
done
```

创建的表（全部 `payment_*` 前缀，不会与你的业务表冲突）：

| 迁移 | 表 | 用途 |
| --- | --- | --- |
| `001_payment_intents.sql` | `payment_intents` | 统一支付意图审计（全轨） |
| `002_payment_credits.sql` | `payment_credits` / `payment_balances` / `payment_access` | 入账台账、余额、通用访问登记 |
| `003_payment_sessions.sql` | `payment_sessions` / `payment_vouchers` | 支付会话 / 凭证（MPP 预留） |

验证：

```sql
SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'payment_%';
-- 应列出 6 张表
```

> 如果你已经有自己的余额/订阅表，可以不执行迁移，改为实现 `PaymentStore` 接口注入（§6.3）。此时 `recordIntent` 为可选方法，跳过即可。

---

## 4. 链上合约（可选）

`chain` 轨和 `x402` 轨需要链上有 `SubscriptionManager`。若目标链上已存在合约（如 AgentX 已部署的实例），跳过本步，只把地址填入配置。

全新部署（以本地 anvil 为例，`forge` 来自 Foundry）：

```bash
# 1. 起本地链（可选，正式网忽略）
anvil --port 8545 --chain-id 11155111

# 2. 部署 IdentityRegistry + SubscriptionManager + plan#1（2.5% 平台费率）
forge script script/DeployLocal.s.sol \
  --rpc-url http://127.0.0.1:8545 \
  --private-key 0xac09…f2ff80 \
  --broadcast --legacy
# 输出中的 SubscriptionManager: 0x… 就是配置要用的地址
```

（合约源码与脚本在 AgentX 的 `contracts/` 目录；你的项目只需要链上地址，不需要合约代码。）

> 若想复用 AgentX 生产链上已部署的 SubscriptionManager，请向项目方索取地址，并在 `chains.<slot>.subscriptionManager` 配置中填入。链上套餐定价会被 fiat 自动定价读取（§8.2）。

---

## 5. 最小集成（Express 示例）

一个完整的可运行示例（TypeScript）：

```ts
// src/payments.ts
import { Pool } from 'pg'
import { PaymentsService, PgPaymentStore } from '@0xinfrax/payments'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

export const payments = new PaymentsService({
  // 持久化接缝：通用 Postgres store（模块自有 payment_* 表）
  store: new PgPaymentStore(pool),

  // 链上槽位：key 是链标识（sepolia / oxachain / 任意自定义名）
  chains: {
    sepolia: {
      rpcUrl: process.env.RPC_URL!,
      chainId: 11155111,
      subscriptionManager: process.env.SUBSCRIPTION_MANAGER!,
    },
  },

  // fiat 轨：不配则 checkout/webhook 返回 503
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY!,
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
    apiBase: process.env.STRIPE_API_BASE,   // 可选；本地 mock 用 http://127.0.0.1:8777/v1
    tokenUsdPrice: Number(process.env.FIAT_TOKEN_USD_PRICE ?? 1), // 自动定价用
  },

  // x402 轨：不配则 verify 返回 503
  x402: {
    enabled: true,
    payTo: process.env.X402_PAY_TO!,          // 平台收款钱包
    priceWei: process.env.X402_PRICE_WEI!,    // 单次价格（最低门槛）
    chain: 'sepolia',
  },

  // ── 你的业务只写在这里 ────────────────────────────────────────────
  onWebhookEvent: async (event) => {
    // event.type: 'checkout.session.completed' | 'invoice.paid' | ...
    // event.object: Stripe 事件对象（client_reference_id 是你构造的引用）
    if (event.type === 'checkout.session.completed') {
      const [userId, planId] = String(event.object.client_reference_id ?? '').split('|')
      await grantSubscription(userId, planId)   // 你的业务：开订阅/发货
    }
  },
  onCredit: async (credit) => {
    // 链上付款验证成功且入账后触发（幂等）
    await notifyTopUp(credit.payer, credit.amountWei) // 你的业务：通知/充值
  },
})
```

```ts
// src/app.ts
import express from 'express'
import { createPaymentsRouter } from '@0xinfrax/payments/router'
import { payments } from './payments'

const app = express()

// 重要：webhook 需要原始 body 用于签名校验
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf } }))

// 挂载通用支付路由（前缀自定）
app.use('/payments', createPaymentsRouter(payments))

// …你的其它业务路由…

app.listen(3000)
```

启动后即获得以下端点：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/payments/info` | x402 协议发现（price/payTo/network） |
| GET | `/payments/price?chain=&planId=` | 链上套餐定价 |
| POST | `/payments/checkout` | 发起 fiat Checkout（见 §8.2） |
| POST | `/payments/verify` | 验证链上付款并入账（x402） |
| POST | `/payments/webhook` | Stripe Webhook（签名在模块内校验） |
| GET | `/payments/balance?address=` | 模块账本余额 |
| POST | `/payments/access` | 统一访问检查 |

---

## 6. 三种集成方式对比

| 方式 | 说明 | 适用 |
| --- | --- | --- |
| **6.1 现成 router** | 挂载 `createPaymentsRouter` 即用（§5） | 大多数项目，最快 |
| **6.2 自写路由** | 只调用 `paymentsService` 方法，端点/鉴权自己控制 | 需要自定义鉴权、限流、返回结构 |
| **6.3 自定义 store** | 实现 `PaymentStore`，用自己的表 | 已有余额/订阅体系的存量项目 |

### 6.2 自写路由（片段）

```ts
import { PaymentsService, PaymentError, isPaymentError } from '@0xinfrax/payments'

app.post('/api/pay/verify', async (req, res) => {
  try {
    const verified = await payments.verifyPayment(req.body.txHash, req.body.chain)
    if (!verified) return res.status(422).json({ error: 'Not a valid payment' })
    res.json(verified)
  } catch (err) {
    if (isPaymentError(err)) {
      // code 可机器判读：NOT_CONFIGURED(503) / INVALID_SIGNATURE(400) / PROVIDER_ERROR(502) …
      return res.status(err.status).json({ error: err.message, code: err.code })
    }
    throw err
  }
})
```

### 6.3 自定义 store

```ts
import type { PaymentStore, PaymentCredit } from '@0xinfrax/payments'

class MyStore implements PaymentStore {
  async balanceOf(address: string, asset?: string): Promise<bigint> { /* 读你的余额表 */ }
  async credit(credit: PaymentCredit): Promise<void> { /* 幂等入账（按 reference 去重） */ }
  async isCreditRecorded(reference: string): Promise<boolean> { /* 幂等探针 */ }
  async deduct(address: string, amount: bigint, asset?: string): Promise<boolean> { /* 原子扣减 */ }
  async resolveAccess(subscriber: string, resource: unknown, opts?: { chain?: string }): Promise<boolean> {
    // 你的统一访问策略：例如「链上订阅 OR 本地订阅」都算有权限
  }
}
```

---

## 7. 配置参考

### 7.1 环境变量表

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | ✅ | Postgres 连接串（§3 迁移过的库） |
| `RPC_URL` | 按轨 | 链 RPC（chain / x402 轨需要） |
| `SUBSCRIPTION_MANAGER` | 按轨 | 链上合约地址 |
| `STRIPE_SECRET_KEY` | fiat 轨 | `sk_test_*` / `sk_live_*` |
| `STRIPE_WEBHOOK_SECRET` | fiat 轨 | Webhook 签名密钥 `whsec_*` |
| `STRIPE_API_BASE` | 可选 | 默认 `https://api.stripe.com/v1`；本地 mock 用 `http://127.0.0.1:8777/v1` |
| `FIAT_TOKEN_USD_PRICE` | 可选 | 默认 `1`：native 单价，用于套餐自动定价 |
| `X402_PAY_TO` | x402 轨 | 平台收款钱包地址 |
| `X402_PRICE_WEI` | x402 轨 | 单次请求价格（wei） |
| `X402_CHAIN` | 可选 | x402 默认链槽位，默认 `sepolia` |

### 7.2 fiat 自动定价规则

Checkout 请求不带 `amountCents` 而带 `planId` 时，模块按链上套餐价自动换算：

```
cents = round(planPriceWei / 1e18 × FIAT_TOKEN_USD_PRICE × 100)
```

例如套餐 1 native、`FIAT_TOKEN_USD_PRICE=1` → 100¢。任何时刻显式传 `amountCents` 都优先。金额下限 50¢（Stripe 最低）。

---

## 8. 业务接入约定

### 8.1 `clientReference`（fiat 轨的透明引用）

由**你构造**，模块只原样转发给 Stripe，并在 Webhook 事件对象里原样回显：

```ts
const ref = `${userId}|${planId}`  // 自定义格式，用管道符分隔
const checkout = await payments.createPayment({
  method: 'fiat',
  subscriber: walletAddress,
  amountCents: 1990,                 // 或 pricing: { planId } 自动定价
  clientReference: ref,
  metadata: { orderId, userId },     // 业务上下文，原样落 payment_intents.metadata
})
// checkout.paymentId 是模块生成的意图 ID（审计用）
```

Webhook 侧解析：

```ts
onWebhookEvent: async (event) => {
  if (event.type === 'checkout.session.completed') {
    const [userId, planId] = String(event.object.client_reference_id).split('|')
    // → 开订阅
  }
}
```

### 8.1b 意图生命周期（payment_intents）

每次 `createPayment` 都会落一条审计记录（`paymentId`）。生命周期流转规则：

- **x402 轨**：`verifyPayment` 成功时模块**自动**把对应 intent 置为 `paid`
- **fiat 轨**：模块不知道哪个 webhook 对应哪笔 intent（不解释你的 `clientReference`），由你在回调里驱动：

```ts
const checkout = await payments.createPayment({ method: 'fiat', /* … */ })
// checkout.paymentId → 存到你的订单表

onWebhookEvent: async (event) => {
  if (event.type === 'checkout.session.completed') {
    await payments.updateIntentStatus(order.paymentId, 'paid')    // 成功
  }
  if (event.type === 'checkout.session.expired') {
    await payments.updateIntentStatus(order.paymentId, 'failed')  // 超时/失败
  }
}
```

合法转换：`created → paid | failed | closed`、`paid → closed`。非法状态值会抛 `PaymentError(INVALID_INPUT)`；未实现 `updateIntentStatus` 的自定义 store 自动跳过（no-op）。

### 8.2 三轨的业务闭环

| 轨 | 用户侧动作 | 服务端动作 | 访问判定 |
| --- | --- | --- | --- |
| chain | 钱包调用 `subscribe(planId)`（付套餐价） | 读链上 `hasActiveSubscription` | 链上状态 |
| fiat | 跳转 Stripe Checkout 页付款 | Webhook 验签 → `onWebhookEvent` 开订阅 | 你的 store |
| x402 | 向 `payTo` 转 native（`/verify` 校验） | 验 tx → 幂等入账 → `onCredit` | 你的 store |

---

## 9. 本地端到端验证

无需 Stripe 账号、无需真实链，可全流程本地验证。

### 9.1 模块自带测试

```bash
cd node_modules/@0xinfrax/payments && npm test
# 30/30 全绿（Stripe 签名、错误码、自动定价、幂等、router 端点）
```

### 9.2 三轨 E2E（复刻 AgentX 的解耦验证环境）

```bash
# 依赖：docker（postgres + anvil）+ foundry + mock Stripe
# 步骤：起 infra → 部署合约 → 建库迁移 → 起 mock Stripe → 起你的服务
# 然后对 /payments 端点发冒烟请求（见下）
```

### 9.3 curl 冒烟清单

```bash
BASE=http://127.0.0.1:3000/payments

# x402 发现
curl -s $BASE/info

# 链上套餐定价（需要链已部署 plan#1）
curl -s "$BASE/price?chain=sepolia&planId=1"

# 创建 fiat Checkout（显式金额）
curl -s -X POST $BASE/checkout -H 'Content-Type: application/json' \
  -d '{"subscriber":"0xf39F…","amountCents":1990,"clientReference":"u1|1","metadata":{"orderId":"o1"}}'
# → { "method":"fiat", "paymentId":"pi_…", "sessionUrl":"https://checkout.stripe.com/…", "sessionId":"cs_…" }

# 访问检查
curl -s -X POST $BASE/access -H 'Content-Type: application/json' \
  -d '{"subscriber":"0xf39F…","resource":{"agentId":1}}'
# → { "active": false } （未授权；fiat 付款成功后为 true）
```

---

## 10. 生产注意事项

1. **Webhook 必须公网可达**：Stripe 会把事件 POST 到你的 `/payments/webhook`；正式环境配好 HTTPS 与签名密钥 `whsec_live_*`。
2. **密钥保管**：`STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / `X402_PAY_TO` 对应私钥都放入 secret 管理（KMS / 环境变量 / CI secret），**切勿入库或进前端**。
3. **`X402_PAY_TO` 私钥**：平台收款钱包私钥只用于服务端离线操作（如自动结算），建议冷热分离。
4. **幂等由模块保证**：同一笔 tx（x402）重复 verify 不会重复入账；你的 `onCredit` / `onWebhookEvent` 也应按引用幂等（模块只保证一次回调，不保证你的回调自身不重入——请在业务侧用 `client_reference_id` / `credit.reference` 做去重）。
5. **rawBody**：忘记 `express.json({ verify })` 会导致 webhook 全部 400（模块会提示 missing rawBody）。
6. **多副本部署**：余额扣减与入账都走数据库原子操作（`UPDATE … WHERE balance >= $amount` / `ON CONFLICT`），多实例安全。
7. **错误处理**：所有业务异常统一 `PaymentError{code,status}`，路由侧按 `err.status` 返回即可，不要字符串匹配。
8. **file: 依赖刷新**：开发期用 `file:` 时，模块更新后必须 `rm -rf node_modules/@0xinfrax/payments && npm install`（拷贝安装不自动刷新）。

---

## 11. FAQ

**Q: 我不想用自己的数据库，能直接跑吗？** 不能。模块所有持久化需要数据库；但如果你已有余额/订阅体系，可用自定义 `PaymentStore`（§6.3）绕过模块的表。

**Q: 三种轨必须全部启用吗？** 不必。只配 `chains` 就能用 chain 轨；不传 `stripe` 则 fiat 端点返回 503，不传 `x402` 则 verify 返回 503。

**Q: 套餐价格在哪维护？** 链上 `SubscriptionManager` 是唯一权威（chain 轨直接读它，fiat 自动定价也读它）。价格变更改合约参数即可。

**Q: 支付成功后如何同步用户状态？** 在 `onWebhookEvent`（fiat）和 `onCredit`（x402）回调里做你的业务动作；chain 轨不需要同步——访问时直接查链上。

**Q: 模块会改动我的业务表吗？** 不会。模块只写 `payment_*` 表；`recordIntent` / `resolveAccess` 等都可注入或跳过。
