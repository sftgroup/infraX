# 调用方自配收款接入模板（@0xinfrax/payments）

> 本模板回答一个问题：**调用方如何集成通用支付引擎，并把收款配置成自己的**。
> 与「平台统一收款」的托管模式不同，本模块的收款归属调用方——每个部署实例一套收款配置（chain 合约 / Stripe 账号 / x402 钱包 / MPP payee）。
>
> 依赖安装 / 数据库 / 合约部署 / 本地验证的通用步骤见 [`DEPLOY.md`](./DEPLOY.md) 与 [`README.md`](./README.md)，本文只讲**收款怎么配、配完怎么验**。

---

## 0. 一句话模型

- **收款 = 实例级配置**：`chains` / `stripe` / `x402` / `mpp` 四组配置在你创建 `PaymentsService`（嵌入式）或启动 `infrax-payments` 服务（独立服务）时一次性注入，之后所有请求共用这一套收款。
- **模块校验收款真实性**：入账前必须通过链上校验（`tx.to == payTo` / `Transfer to == payTo` / Stripe 签名），收款地址被篡改不会入账。
- 需要多租户收款隔离时，请**每租户部署一个独立实例**；模块不提供实例内的按请求收款切换（那是业务场景，不属于通用通道能力）。

---

## 1. 收款配置全景

| 轨 | 钱最终进谁的口袋 | 收款配置项 | 嵌入式（库）Options | 独立服务 env | 覆盖粒度 |
| --- | --- | --- | --- | --- | --- |
| **chain** | 链上 `SubscriptionManager` escrow（**你自己部署/指定的合约**） | 合约地址 | `chains.<slot>.subscriptionManager` | `CHAIN_<NAME>_SUBSCRIPTION_MANAGER` | 实例级 |
| **fiat** | **你自己的 Stripe 账户** | `secretKey` + `webhookSecret` | `stripe.secretKey` / `stripe.webhookSecret` | `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | 实例级 |
| **x402** | **你指定的收款钱包** | `payTo` + `priceWei` + `chain` | `x402.payTo` / `x402.priceWei` / `x402.chain` | `X402_PAY_TO` / `X402_PRICE_WEI` / `X402_CHAIN` | 实例级 |
| **stablecoin** | 同一收款钱包（复用 `x402.payTo`） | 复用 `payTo` + `asset` / `decimals` / `priceWei` | `x402.stablecoin.*` | 独立服务暂未暴露（嵌入式可配） | 实例级 |
| **MPP** | **你指定的 payee 收款地址** | `payee` + `domain` + `chain` | `mpp.payee` / `mpp.domain` / `mpp.chain` | `MPP_PAYEE` / `MPP_DOMAIN` / `MPP_CHAIN` | 实例级 |

> 收款隔离规则：**一个实例 = 一套收款**。需要多租户收款隔离时，请每租户部署一个独立实例；不要试图在同一个实例里轮换收款。

---

## 2. 形态 A：嵌入式（库）接入模板

调用方在自己的服务里依赖 `@0xinfrax/payments`，代码里配置收款。完整可复制示例：

```bash
# 1. 安装（公开 npm registry 已发布；其余来源见 README §依赖配置）
npm install @0xinfrax/payments
# 2. 在你自己项目的数据库执行模块迁移（4 个，全 payment_* 前缀）
for f in node_modules/@0xinfrax/payments/db/migrations/*.sql; do psql "$DATABASE_URL" -f "$f"; done
```

```ts
// src/payments.ts —— 收款配置集中在这里
import { Pool } from 'pg'
import { PaymentsService, PgPaymentStore } from '@0xinfrax/payments'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })

export const payments = new PaymentsService({
  // 持久化接缝：通用 Postgres store（模块自有 payment_* 表）
  store: new PgPaymentStore(pool),

  // ── 收款配置 ──────────────────────────────────────────────────────────
  // ① chain 轨：收款 = 你自己部署/指定的 SubscriptionManager（escrow）
  //    链上套餐定价（getPlan）与订阅状态都读这个合约
  chains: {
    oxachain: {
      rpcUrl: process.env.OXA_RPC_URL!,                 // 或经 chain-rpc 网关
      chainId: 19505,
      subscriptionManager: process.env.OXA_SUBSCRIPTION_MANAGER!, // ← 你的合约
    },
    sepolia: {
      rpcUrl: process.env.SEPOLIA_RPC_URL!,
      chainId: 11155111,
      subscriptionManager: process.env.SEPOLIA_SUBSCRIPTION_MANAGER!, // ← 你的合约
    },
  },

  // ② fiat 轨：收款 = 你自己的 Stripe 账号（Checkout 资金进你的 Stripe 账户）
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY!,          // ← 你的 sk_*
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,  // ← 你的 whsec_*
    tokenUsdPrice: Number(process.env.FIAT_TOKEN_USD_PRICE ?? 1), // 套餐自动定价用
  },

  // ③ x402 轨：收款 = 你指定的收款钱包（原生代币打到这个地址）
  x402: {
    enabled: true,
    payTo: process.env.X402_PAY_TO!,                    // ← 你的收款钱包
    priceWei: process.env.X402_PRICE_WEI!,              // ← 单次价格（wei）
    chain: 'oxachain',
    // 稳定币轨：同一收款钱包，EIP-3009 / Permit2 的 Transfer to == payTo 校验
    stablecoin: {
      enabled: true,
      asset: process.env.STABLECOIN_ASSET!,             // ← USDC 合约地址
      decimals: 6,
      priceWei: process.env.STABLECOIN_PRICE_WEI!,      // ← 稳定币单价
    },
  },

  // ④ MPP 轨：收款 = 你指定的 payee（通道押金打到这个地址）
  mpp: {
    enabled: true,
    domain: process.env.MPP_DOMAIN!,                    // EIP-712 domain（voucher 验签）
    payee: process.env.MPP_PAYEE!,                      // ← 你的收款地址
    chain: 'oxachain',
  },

  // ── 你的业务只写在这里 ────────────────────────────────────────────────
  onWebhookEvent: async (event) => {
    // event.type: 'checkout.session.completed' | 'invoice.paid' | ...
    // event.object.client_reference_id 是你构造的引用（见 README §业务上下文透传）
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
// src/app.ts —— 挂载现成 router（express 是 optional peer）
import express from 'express'
import { createPaymentsRouter } from '@0xinfrax/payments/router'
import { payments } from './payments'

const app = express()
// 重要：webhook 需要原始 body 用于签名校验
app.use(express.json({ verify: (req, _res, buf) => { (req as any).rawBody = buf } }))
// 挂载通用支付路由（前缀自定）：/info /price /checkout /verify /webhook
// /balance /access + MPP×6（open/voucher/topup/settle/close/session）
app.use('/payments', createPaymentsRouter(payments))
app.listen(3000)
```

---

## 3. 形态 B：独立服务（infrax-payments）接入模板

调用方以微服务形态运行官方入口 `server.ts`（tsx 直跑），**收款全走环境变量**。部署步骤见 [`DEPLOY.md`](./DEPLOY.md) 与 [`deploy/systemd/infrax-payments.service`](../../deploy/systemd/infrax-payments.service)，这里给收款相关的完整 env 清单：

```ini
# ── 基础 ────────────────────────────────────────────────
PORT=9132
DATABASE_URL=postgresql://user:pass@host:5432/pocketx_payments   # 调用方自己的库
PAYMENTS_API_KEY=<随机 hex>                                       # 服务间调用 key

# ── 收款① chain 轨：你自己的 SubscriptionManager ────────
CHAIN_OXACHAIN_RPC_URL=http://127.0.0.1:9130/v1/rpc/oxa           # 或直连 RPC
CHAIN_OXACHAIN_CHAIN_ID=19505
CHAIN_OXACHAIN_SUBSCRIPTION_MANAGER=0x…你的合约                    # ← 收款合约
# 经 chain-rpc 网关时自动带 X-Service-Key（读 key）+ raw JSON-RPC
CHAIN_RPC_READ_KEY=…

# ── 收款② fiat 轨：你自己的 Stripe 账号 ─────────────────
STRIPE_SECRET_KEY=sk_live_…                                       # ← 你的
STRIPE_WEBHOOK_SECRET=whsec_…                                     # ← 你的

# ── 收款③ x402 轨：你的收款钱包 ─────────────────────────
X402_ENABLED=true
X402_PAY_TO=0x…你的收款钱包                                       # ← 你的
X402_PRICE_WEI=1000000000000000
X402_CHAIN=oxachain

# ── 收款④ MPP 轨：你的 payee ────────────────────────────
MPP_ENABLED=true
MPP_DOMAIN=…                                                     # EIP-712 domain
MPP_PAYEE=0x…你的收款地址                                         # ← 你的
MPP_CHAIN=oxachain

# ── 可选：事件出站转发（业务方回调端点） ────────────────
WEBHOOK_FORWARD_URL=https://your-service.example.com/payments/events
WEBHOOK_FORWARD_SECRET=…   # HMAC 签名（X-Payments-Signature）
```

> 独立服务是**一套收款一个实例**。需要多个收款主体时，复制这份 unit 成多个实例（不同端口 / 不同 env）。

---

## 4. 收款自检清单（接入后必测）

配置完收款后，逐项验证「钱确实会进你的口袋」：

| # | 验证点 | 命令 | 期望 |
| --- | --- | --- | --- |
| 1 | **x402 收款地址生效** | `GET /payments/info` | `payTo` / `mpp.payee` 是**你自己**的地址 |
| 2 | **chain 收款合约生效** | `GET /payments/price?chain=oxachain&planId=1` | 读到**你自己合约**里的套餐价（非空 / 非 500） |
| 3 | **入账校验收款方** | `POST /payments/verify {txHash}` | `tx.to == 你的 payTo` 才 `verified:true`；转给别人返回 422 |
| 4 | **fiat 收款账号生效** | `POST /payments/checkout {amountCents:1000}` | 返回 `sessionUrl`（stripe.com，商户=你的账号） |
| 5 | **webhook 验签** | 用**你自己的** `whsec_*` 签名 POST `/payments/webhook` | `200 received`；错误签名 400 |

curl 冒烟示例：

```bash
BASE=http://127.0.0.1:9132/payments
KEY=你的 PAYMENTS_API_KEY

# 1. 收款地址回显
curl -s -H "X-API-Key: $KEY" $BASE/info
# → { "enabled":true, "payTo":"0x…你的", "chain":"oxachain", "mpp":{...} }

# 2. 读自己的合约套餐
curl -s -H "X-API-Key: $KEY" "$BASE/price?chain=oxachain&planId=1"
# → { "planId":1, "price":"…", "period":"month", "active":true, ... }

# 3. 转给非收款地址 → 拒绝
curl -s -X POST -H "X-API-Key: $KEY" -H 'Content-Type: application/json' \
  -d '{"txHash":"0x…转账到别人的tx"}' $BASE/verify
# → 422 { "error":"Transaction is not a valid payment to the platform wallet" }
```

---

## 5. 常见问题

**Q：一个实例能同时给多个收款方收款吗？** 不能。收款是实例级配置；多收款主体请多实例（每租户一套 env / 一份 Options）。

**Q：收款地址会被别人改吗？** 不能。`payTo` / `payee` / `subscriptionManager` 是部署期注入的；且入账前模块链上校验 `tx.to == payTo` / `Transfer to == payTo`（大小写不敏感），伪造收款方不会入账。

**Q：Stripe 收款为什么进我账户？** fiat 轨直接用**你的** `secretKey` 调 Stripe API 创建 Checkout Session，资金按 Stripe 规则进该账号绑定的收款账户；`webhookSecret` 保证只有 Stripe（用你的签名）能触发入账回调。

**Q：chain 轨的收款合约要自己部署吗？** 是。`subscriptionManager` 指向你自己部署的 `SubscriptionManager`（部署方法见 `DEPLOY.md` §4）；也可使用他人已部署的合约地址（向对方索取，须信任其管理方）。

**Q：独立服务目前暴露了 stablecoin 收款配置吗？** 未暴露（`server.ts` env 只有 x402 基础项）；嵌入式形态可完整配置 `x402.stablecoin.*`。

**Q：如何校验收款配置没串？** 跑一遍 §4 自检清单，重点看 `/info` 的 `payTo`/`payee` 与 `/price` 读到的套餐是否来自你的合约。
