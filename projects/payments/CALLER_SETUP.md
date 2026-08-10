# 调用方自配收款接入模板（@0xinfrax/payments）

> 本模板回答一个问题：**调用方如何集成通用支付引擎，并把收款配置成自己的**。
> 与「平台统一收款」的托管模式不同，本模块的收款归属调用方——每个部署实例一套收款配置（chain 合约 / Stripe 账号 / x402 钱包 / MPP payee）。
>
> 依赖安装 / 数据库 / 合约部署 / 本地验证的通用步骤见 [`DEPLOY.md`](./DEPLOY.md) 与 [`README.md`](./README.md)，本文只讲**收款怎么配、配完怎么验**。

---

## 0. 一句话模型

- **收款 = 实例级配置**：`chains` / `stripe` / `x402` / `mpp` 四组**外部收款**配置 + `invite` / `transfer` 两个**账本内结算**能力，在你创建 `PaymentsService`（嵌入式）或启动 `infrax-payments` 服务（独立服务）时一次性注入，之后所有请求共用这一套。
- **模块校验收款真实性**：入账前必须通过链上校验（`tx.to == payTo` / `Transfer to == payTo` / Stripe 签名），收款地址被篡改不会入账。
- **账本内结算不走外部收款**：`invite`（收费邀请）与 `transfer`（账本内划转）只发生在 `payment_balances` 账本内，无新增外部收款配置；但需要宿主 `SqlExecutor` 实现可选 `transaction` runner（transfer 的 debit+credit 必须原子）。
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
| **invite** | 账本内结算（payee 的 `payment_balances`） | store seam + `INVITE_ENABLED` | `invites`（`InviteStore`） | `INVITE_ENABLED=true`（需 `PgInviteStore`） | 实例级 |
| **transfer** | 账本内划转（from→to 的 `payment_balances`） | store seam + `TRANSFER_ENABLED` | `transfers`（`TransferStore`） | `TRANSFER_ENABLED=true`（需 `PgTransferStore` + `transaction` runner） | 实例级 |
| **batch** | 一次建 N 个 a2a 收款意图，逐项链上验 tx 入账到各自收款钱包 | **依赖收款③ x402 + 收款① chain**（settle 复用 `a2aSettle` 验 tx）+ `BATCH_ENABLED` | `batch`（`BatchStore`）+ 上述 x402/chains | `BATCH_ENABLED=true`（需 `PgBatchStore` + x402/chain 配置齐全） | 实例级 |

> 收款隔离规则：**一个实例 = 一套收款**。需要多租户收款隔离时，请每租户部署一个独立实例；不要试图在同一个实例里轮换收款。

---

## 2. 形态 A：嵌入式（库）接入模板

调用方在自己的服务里依赖 `@0xinfrax/payments`，代码里配置收款。完整可复制示例：

```bash
# 1. 安装（公开 npm registry 已发布；其余来源见 README §依赖配置）
npm install @0xinfrax/payments
# 2. 在你自己项目的数据库执行模块迁移（8 个，全 payment_* 前缀）
for f in node_modules/@0xinfrax/payments/db/migrations/*.sql; do psql "$DATABASE_URL" -f "$f"; done
```

```ts
// src/payments.ts —— 收款配置集中在这里
import { Pool } from 'pg'
import { PaymentsService, PgPaymentStore, PgInviteStore, PgTransferStore } from '@0xinfrax/payments'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
// transfer 需要事务 runner（debit+credit 原子）；不带则 confirm 直接拒绝
const sql = {
  query: (text: string, values?: unknown[]) => pool.query(text, values),
  transaction: async <T>(fn: (tx: { query: typeof pool.query }) => Promise<T>) => {
    const client = await pool.connect()
    try { await client.query('BEGIN'); const r = await fn({ query: (t, v) => client.query(t, v) }); await client.query('COMMIT'); return r }
    catch (e) { await client.query('ROLLBACK'); throw e }
    finally { client.release() }
  },
}

export const payments = new PaymentsService({
  // 持久化接缝：通用 Postgres store（模块自有 payment_* 表）
  store: new PgPaymentStore(sql),

  // ── 账本内结算能力（可选，注入才启用；未启用端点 503）────────────────
  invites: new PgInviteStore(sql),      // invite 收费邀请（INVITE_ENABLED）
  transfers: new PgTransferStore(sql),  // transfer 账本内划转（TRANSFER_ENABLED）

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

调用方以微服务形态运行官方入口 `server.ts`（tsx 直跑），**收款全走环境变量**。部署步骤见 [`DEPLOY.md`](./DEPLOY.md) 与 [`deploy/systemd/infrax-payments.service`](../../deploy/systemd/infrax-payments.service)；**env 模板见 [`env.b-instance.example`](./env.b-instance.example)**（复制为 `.env`，填好必填项即可启动），这里给收款相关的完整 env 清单：

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

# ── 账本内结算能力（可选；未启用端点 503） ───────────────
INVITE_ENABLED=true    # invite 收费邀请（agent 自动向 payer 发账单）
TRANSFER_ENABLED=true  # transfer 账本内原子划转（需内置 transaction runner）
BATCH_ENABLED=true     # batch 一次性建 N 个 a2a 收款意图；⚠️ 依赖收款③ x402（settle 复用 a2aSettle 链上验 tx）+ 收款① chain，缺任一则 capabilities 显示 batch disabled（503）

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
| 6 | **invite 账本内结算** | `POST /payments/invites {payer,payee,valueWei}` → `POST /payments/invites/:id/pay` | 成功：`settled:true`，payer 余额减、payee 余额增 |
| 7 | **transfer 原子划转** | `POST /payments/transfers {from,to,valueWei}` → `POST /payments/transfers/:id/confirm` | 成功 `executed:true`；余额不足 422 且整笔不动 |

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

---

## 6. Agent 专属能力调用（invite / transfer / batch）

> MQ-16 T-5：**invite（自动收费邀请）、transfer（账本内转账）、batch（批量收款）** 三个 agent 场景能力对**外部调用方**开放。账本内结算（invite 余额支付 / transfer 划转）只发生在引擎 `payment_balances` 账本内，**不需要调用方自建收款配置**；batch（批量收款）需要引擎启用 x402（payer 链上向平台钱包转账后逐项验 tx 入账）。

### 6.1 前置：鉴权与能力探测

- **鉴权契约**（统一三选一，与平台一致）：`Authorization: Bearer <px_key>` / `X-API-Key: <px_key>` / `X-Service-Key: <px_key>`
- **外部 key**：向平台申请 data 服务签发的 **px_ key（scope=payment）**——`POST /admin/api-keys`（admin 鉴权）→ `{label, scope:"payment"}` 返回 `px_…`；校验由引擎在 `POST {DATA_URL}/api-keys/verify` 实时完成（scope=payment 须与 data 侧 `PREFIX_BY_SCOPE` 一致，见 `projects/data/app/api_keys.py`）
- **能力探测**：`GET /payments/capabilities` 返回各能力 `enabled` / `endpoints`；invite / transfer / batch 任一未启用时对应端点一律 **503**（显式 "Capability not enabled"，非 404）
- **幂等约定**：transfer 以 `reference` 幂等（同 reference 重复创建返回同一笔）；invite 结算以 `inviteId` 幂等（重复 pay 不双扣）；batch item 以 `paymentId` 幂等（重复 settle 不重复入账）

### 6.2 自动收费邀请（invite）——agent 向 payer 发账单

收集方（payee = agent）创建收费邀请，payer 从**账本余额**支付或**链上**结算：

```bash
BASE=http://127.0.0.1:9132/payments
PX=你的_px_外部key

# 1. payee(agent) 创建邀请：向 payer 收取 0.05 ETH
curl -s -X POST -H "X-API-Key: $PX" -H 'Content-Type: application/json' \
  -d '{"payer":"0x…payer","payee":"0x…agent","valueWei":"50000000000000000","memo":"agent 月度服务费","dueAt":"2026-09-01T00:00:00Z"}' \
  $BASE/invites
# → { "inviteId":"inv_…", "paymentId":"a2a_…", "amountWei":"…", "payee":"0x…", "dueAt":"…" }

# 2. payer 从账本余额支付（payer 余额不足 → 400/422，整笔不动）
curl -s -X POST -H "X-API-Key: $PX" $BASE/invites/inv_…/pay
# → { "inviteId":"inv_…", "settled":true, "transferId":"…" }

# 3. 查询：按地址 + 角色（payer|payee）列出邀请；默认仅返回未结算（created/sent），
#    查已结算需显式 status=settled
curl -s -H "X-API-Key: $PX" "$BASE/invites?address=0x…payer&role=payer&status=settled"
```

状态机：`created → sent → settled | expired（读时惰性过期）| cancelled`。链上结算路径：payer 链上向 payee 转账后 `POST /invites/:inviteId/settle {txHash}`（引擎校验 `tx.to == payee`，需 x402；仅余额支付路径不依赖 x402）。

### 6.3 账本内转账（transfer）——agent 账本余额划转

两阶段：创建（记录意图）→ confirm（单事务原子 debit+credit，余额不足整笔回滚 422）：

```bash
# 1. 创建：agent 账本余额 → 目标地址（reference 幂等键）
curl -s -X POST -H "X-API-Key: $PX" -H 'Content-Type: application/json' \
  -d '{"from":"0x…agent","to":"0x…user","valueWei":"1000000000000000","reference":"tx-001"}' \
  $BASE/transfers
# → { "transferId":"…", "status":"created" }

# 2. confirm：原子执行 debit+credit（重复 confirm 幂等不双扣）
curl -s -X POST -H "X-API-Key: $PX" $BASE/transfers/<transferId>/confirm
# → { "transferId":"…", "executed":true, "status":"executed" }
# 余额不足 → 422 { "executed":false, "status":"failed", "error":"insufficient balance" }

# 3. 查询流水
curl -s -H "X-API-Key: $PX" "$BASE/transfers?address=0x…agent&role=from"
```

### 6.4 批量收款（batch）——一次向 N 个 payee 建收款意图

payer 一次性对 N 个收款方创建 a2a 意图；每个 item 由 payer **链上向平台钱包转账**后逐项 settle（需引擎启用 x402）：

```bash
# 1. 创建：payer 一次向 3 个 payee 收款
curl -s -X POST -H "X-API-Key: $PX" -H 'Content-Type: application/json' \
  -d '{"subscriber":"0x…payer","items":[{"payee":"0x…a","amountWei":"1000000000000000"},{"payee":"0x…b","amountWei":"2000000000000000"},{"payee":"0x…c","amountWei":"3000000000000000"}]}' \
  $BASE/batch
# → { "method":"batch", "batchId":"batch_…", "items":[{paymentId,payee,amountWei},…] }

# 2. 逐项 settle：payer 向平台钱包（GET /payments/info → payTo）转账后验 tx 入账到各自 payee
curl -s -X POST -H "X-API-Key: $PX" -H 'Content-Type: application/json' \
  -d '{"batchId":"batch_…","itemId":"a2a_…","txHash":"0x…"}' $BASE/batch/settle
# → { "settled":true, "batchId":"…", "itemId":"…", "creditedWei":"…" }

# 3. 全部完成批次自动 completed；未支付可取消
curl -s -H "X-API-Key: $PX" "$BASE/batch?batchId=batch_…"
curl -s -X POST -H "X-API-Key: $PX" -H 'Content-Type: application/json' -d '{"batchId":"batch_…"}' $BASE/batch/cancel
```

### 6.5 错误码速查

| 状态 | 含义 | 典型场景 |
| --- | --- | --- |
| 400 | 缺参 / 参数非法 | 缺 `payer/payee/valueWei`；items 空数组 |
| 401 | 未授权 | 无 key / 非 px_ key / scope 不匹配 |
| 422 | 账本或链上校验失败 | transfer 余额不足；invite/batch settle 的 tx 非有效支付 |
| 503 | 能力未启用 / 依赖未配置 | invite/transfer/batch 开关未开；batch 但 x402 未启用 |

