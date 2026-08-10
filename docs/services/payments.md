# Payments 通用支付引擎 使用指南（:9132）

> 最后更新：2026-08-11 | 生产状态：🟢 已验证可用（2026-08-11 生产实测）

## 0. 快速开始（Quick Start）

**1）安装**

```bash
npm install @0xinfrax/infrax-dk
```

**2）获取凭据**

平台 `PAYMENTS_API_KEY`（bridge key），或 data 服务签发的 scope=`payment` 外部 key（`px_` 前缀，经 data `/api-keys/verify` 实时校验）。本服务**仅内网**，外部经 VPN/跳板或业务服务转发访问，无公网代理路径。

**3）最小示例**

> ⚠️ 引擎响应为**裸 JSON**（非 `{code,message,data}` 信封），SDK 用 raw 调用直接返回数据。

```ts
import { InfraX } from '@0xinfrax/infrax-dk';

const infrax = new InfraX({
  paymentsUrl: 'http://127.0.0.1:9132',           // 内网直连（服务仅内网）
  paymentsApiKey: process.env.PAYMENTS_API_KEY,   // 自动带 x-api-key 头
});

// 能力探测（建议先调：确认各 rail 是否启用；裸 JSON）
const caps = await infrax.payment.capabilities();
console.log(caps.capabilities.chain.enabled);

// 链上套餐定价（裸 JSON）
const info = await infrax.payment.price(5, 'oxachain');
console.log(info.price);
```

**4）验证**

```bash
curl -s http://127.0.0.1:9132/payments/capabilities \
  -H "X-API-Key: <PAYMENTS_API_KEY>"   # → 裸 JSON（非信封）
```

> 完整端点清单 / 鉴权细节 / 错误码见下文对应章节。

## 1. 服务定位

通用支付引擎（`@0xinfrax/payments` standalone 实例，systemd `infrax-payments`），统一承载平台的"钱"通道：**chain**（链上 SubscriptionManager escrow 订阅）、**fiat**（Stripe checkout + webhook）、**x402**（单笔链上原生代币支付验证）、**mpp**（状态通道），以及 MQ-16 T-5 新增的 **period**（周期授权扣费）、**invite**（账单邀请）、**transfer**（账本内部转账）、**batch**（一次多 payee 批量收款）能力。业务服务（waas / dc / collector / chain-rpc）只管"权益激活"，钱全部走本引擎；`pocketx_payments` 库。

生产访问：
- 内网直连 `http://127.0.0.1:9132`（端点统一挂 `/payments` 前缀）
- **仅内网**：web 代理（:9111）与 nginx 均未配置 `/payments` 公网路由，外部需经 VPN/跳板或由业务服务代理转发

## 2. 鉴权方式

统一平台鉴权契约（三选一，任一匹配即通过）：

```
Authorization: Bearer <key>
X-API-Key: <key>
X-Service-Key: <key>
```

- key：平台 `PAYMENTS_API_KEY`（bridge key），或 data 服务签发的 **scope=`payment`**（`px_` 前缀）外部 key——外部 key 经 data `POST /api-keys/verify` 实时校验，scope 必须为 `payment`，否则 `px_` key 会回退 mcp scope 导致 401。
- 豁免端点：`/payments/webhook`（引擎内部按 Stripe 签名验签，回调不带平台 key）、`/health`（公开）。
- **响应为裸 JSON**（非 `{code,message,data}` 信封），错误为 `{ error: '<message>' }` + 对应 HTTP 状态码。
- 能力未开启的 rail 端点**仍存在但返回 503**（`Capability not enabled`），用于显式提示而非裸 404——先探测 `GET /payments/capabilities` 再调用。

## 3. 端点清单

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/health` | 公开 | 健康检查 |
| GET | `/payments/info` | key | 通道发现：x402 价格/收款地址/网络 + stablecoin/mpp 状态 |
| GET | `/payments/price?planId=&chain=` | key | 链上套餐定价（SubscriptionManager.getPlan；chain 默认 `oxachain`） |
| GET | `/payments/chain-info/:chain` | key | 链配置（chainId + subscriptionManager + nativeAsset） |
| GET | `/payments/subscription/:chain/:subscriber/:resourceId` | key | 链上订阅状态（hasActiveSubscription → `{active}`） |
| POST | `/payments/checkout` | key | fiat checkout（Stripe），body `{subscriber, amountCents?, planId?, period?, currency?, chain?, metadata?, successUrl?, cancelUrl?}` → `{paymentId, sessionUrl, sessionId}` |
| POST | `/payments/verify` | key | x402 链上支付验证，body `{txHash, chain?}` → `{verified, reference, payer, creditedWei, asset, chain}` |
| POST | `/payments/webhook` | 豁免 | Stripe webhook（`stripe-signature` 验签；需宿主保留 rawBody） |
| GET | `/payments/balance?address=&asset=` | key | 引擎账本余额（`{address, balanceWei}`） |
| POST | `/payments/access` | key | 统一访问检查，body `{subscriber, resource, chain?}` → `{active}` |
| POST | `/payments/a2a` | key | a2a 收款意图（phase 1），body `{subscriber, valueWei, payee?, asset?, chain?}` → `{paymentId, amountWei, payee}` |
| POST | `/payments/a2a/settle` | key | a2a 结算（phase 2），body `{paymentId, txHash, chain?}` |
| POST | `/payments/mpp/open` | key | 开 MPP 通道（`{payer, depositWei, salt, txHash}`） |
| POST | `/payments/mpp/voucher` | key | 提交累计 voucher（`{channelId, cumulativeAmount, signature}`） |
| POST | `/payments/mpp/topup` | key | 通道充值（`{channelId, txHash, additionalWei}`） |
| POST | `/payments/mpp/settle` | key | 批量结算未结算消费（`{channelId}`） |
| POST | `/payments/mpp/close` | key | 关闭通道（先结算尾部）（`{channelId}`） |
| GET | `/payments/mpp/session?channelId=` | key | 通道状态 |
| GET | `/payments/capabilities` | key | **能力探测**（各 rail enabled + 端点清单） |
| POST | `/payments/period/charge` | key | 周期授权扣费（`{authorizationId}`） |
| GET | `/payments/period/authorization?authorizationId=` | key | 周期授权状态 |
| POST | `/payments/batch` | key | 批量收款意图，body `{subscriber, items:[{payee, amountWei, asset?}], chain?}` → `{batchId, items}` |
| POST | `/payments/batch/settle` | key | 结算单个 item（`{batchId, itemId, txHash, chain?}`） |
| GET | `/payments/batch?batchId=` | key | batch 状态 |
| POST | `/payments/batch/cancel` | key | 取消 batch（仅未支付 items） |
| POST | `/payments/invites` | key | 创建账单邀请，body `{payer, payee, valueWei, asset?, chain?, dueAt?, memo?}` → `{inviteId, paymentId, amountWei, payee}` |
| GET | `/payments/invites?address=&role=payer\|payee&status=` | key | 邀请列表 |
| GET | `/payments/invites/:inviteId` | key | 单个邀请详情 |
| POST | `/payments/invites/:inviteId/cancel` | key | 取消未结算邀请 |
| POST | `/payments/invites/:inviteId/settle` | key | 链上结算（提交 payer 的 txHash） |
| POST | `/payments/invites/:inviteId/pay` | key | 账本支付（payer ledger 余额扣款结算） |
| POST | `/payments/transfers` | key | 发起账本转账，body `{from, to, valueWei, asset?, reference?}` → `{transferId, status}` |
| POST | `/payments/transfers/:transferId/confirm` | key | **确认并执行**转账（原子入账） |
| GET | `/payments/transfers?address=&role=from\|to` | key | 转账列表 |
| GET | `/payments/transfers/:transferId` | key | 单个转账详情 |
| POST | `/payments/transfers/:transferId/cancel` | key | 取消未执行转账 |

> 生产能力现状（`GET /payments/capabilities` 实测）：chain 开、x402 开（a2a 随之开）、fiat/mpp/period/batch/invite/transfer 按部署 env 开关（生产实测 fiat/mpp 为 `enabled:false`）。未开能力端点返回 **503**。

## 4. 样例代码

### 4.1 curl（内网直连；该服务仅内网，无公网代理路径）

```bash
# ── 能力探测（建议先调：确认哪些 rail 已开）──
curl -s http://127.0.0.1:9132/payments/capabilities \
  -H "X-API-Key: <PAYMENTS_API_KEY>"

# ── 通道发现（x402 价格/收款地址/网络）──
curl -s http://127.0.0.1:9132/payments/info \
  -H "X-API-Key: <PAYMENTS_API_KEY>"
# → {"enabled":true,"priceWei":"1000000000000000","payTo":"0x52Ec58173042E8d0C9be0BdA81e95a8CbB5B8e06",
#    "network":"eip155:19505","chain":"oxachain","rails":{"x402":true,"stablecoin":false},
#    "stablecoin":{"enabled":false},"mpp":{"enabled":false}}

# ── 账本转账：创建 → 确认执行（原子入账）──
curl -s -X POST http://127.0.0.1:9132/payments/transfers \
  -H "X-API-Key: <PAYMENTS_API_KEY>" -H 'Content-Type: application/json' \
  -d '{"from":"0x1111111111111111111111111111111111111111","to":"0x2222222222222222222222222222222222222222","valueWei":"1000000000000000","asset":"native"}'
# → {"transferId":"<TRANSFER_ID>","status":"created"}

curl -s -X POST http://127.0.0.1:9132/payments/transfers/<TRANSFER_ID>/confirm \
  -H "X-API-Key: <PAYMENTS_API_KEY>"
# → {"transferId":"<TRANSFER_ID>","executed":true,"status":"executed"}

# ── 批量收款：创建意图（batch 能力开时）──
curl -s -X POST http://127.0.0.1:9132/payments/batch \
  -H "X-API-Key: <PAYMENTS_API_KEY>" -H 'Content-Type: application/json' \
  -d '{"subscriber":"0x1111111111111111111111111111111111111111","items":[{"payee":"0x2222222222222222222222222222222222222222","amountWei":"1000000000000000"},{"payee":"0x3333333333333333333333333333333333333333","amountWei":"2000000000000000"}]}'
# → {"method":"batch","batchId":"<BATCH_ID>","items":[...]}
```

### 4.2 JS SDK（@0xinfrax/infrax-dk v0.6.0）

```ts
import { InfraX } from '@0xinfrax/infrax-dk';

const infrax = new InfraX({
  // 引擎独立入口（paymentsUrl 缺省回退 baseUrl）
  paymentsUrl: 'http://127.0.0.1:9132',   // 内网直连（服务仅内网）
  paymentsApiKey: process.env.PAYMENTS_API_KEY, // 缺省回退 apiKey；自动带 x-api-key 头
});

// ── 能力探测 + 通道发现 ──
const caps = await infrax.payment.capabilities();   // GET /payments/capabilities（裸 JSON）
const info = await infrax.payment.price(5, 'oxachain'); // GET /payments/price?planId=5&chain=oxachain
console.log(caps.capabilities.chain.enabled, info.price);

// ── fiat checkout ──
const co = await infrax.payment.checkout({
  subscriber: '0x1111111111111111111111111111111111111111',
  planId: 5,
  period: 'month',
});
console.log(co.sessionUrl); // Stripe 跳转链接

// ── a2a 收款意图 + 链上结算 ──
const a2a = await infrax.payment.a2a({ subscriber: '0xA...', valueWei: '1000000000000000' });
await infrax.payment.a2aSettle({ paymentId: a2a.paymentId, txHash: '0x...' });

// ── 账本内部转账：创建 + 确认（原子入账）──
const tr = await infrax.payment.transferCreate({
  from: '0x1111111111111111111111111111111111111111',
  to: '0x2222222222222222222222222222222222222222',
  valueWei: '1000000000000000',
  asset: 'native',
});
await infrax.payment.transferConfirm(tr.transferId);

// ── 批量收款：一次多 payee ──
const batch = await infrax.payment.batchCreate({
  subscriber: '0x1111111111111111111111111111111111111111',
  items: [
    { payee: '0x2222222222222222222222222222222222222222', amountWei: '1000000000000000' },
    { payee: '0x3333333333333333333333333333333333333333', amountWei: '2000000000000000' },
  ],
});
const batchState = await infrax.payment.batchGet(batch.batchId);
console.log(batchState.status, batchState.items);
```

### 4.3 常见错误码

| HTTP | 场景 |
|---|---|
| 400 | 缺少必填字段（如 `planId is required` / `txHash is required`） |
| 401 | 未带 key / key 无效（scope 不匹配时 `px_` key 会 401） |
| 404 | 资源不存在（invite/transfer/batch 未找到） |
| 422 | 提交的 tx 不是打到平台收款地址的有效支付（verify/a2a-settle/batch-settle/invite-settle/transfer-confirm 校验失败） |
| 503 | 该 rail 能力未启用（`Capability not enabled for this deployment`）——先查 `/payments/capabilities` |
| 5xx | 引擎内部错误（上游链 RPC 失败等，响应 `{error}`） |
