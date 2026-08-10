# DC 链上数据中心 使用指南（:9102）

> 最后更新：2026-08-11 | 生产状态：🟢 已验证可用（2026-08-11 生产实测）

## 1. 服务定位

**DC（Data Center）链上数据中心**是 InfraX 的链上事件查询与数据订阅服务（`projects/dc/index.ts`，独立 PostgreSQL `pocketx_dc` + 只读 `pocketx_collector` 事件库）。

- **数据面（B 端查询）**：覆盖 5 条链——`sepolia` / `ethereum` / `bsc` / `base` / `oxa`——的链上事件查询、事件统计、扫描检查点、Token 目录与原始 receipt 导出。数据来源为 collector 区块扫描器落库（`events` 表 1 亿+ 行，150GB+）。
- **订阅面（套餐计费，MQ-16 T-1）**：按钱包地址订阅 DC 数据套餐，免费套餐直通激活并签发 `dc_api_key`，付费套餐经支付引擎（chain / fiat / x402 rail）确认后激活；月度配额超限返回 **429**。
- **生产实测（2026-08-11）**：`GET /api/v2/data/stats` 200——bsc 1.14 亿事件 / eth 1.02 亿 / base 8 千万；`GET /api/v2/data/events?chain=sepolia&limit=1` 200（真实事件）。

## 2. 鉴权方式

| 面 | 端点 | 鉴权 |
|---|---|---|
| 数据面 | `/api/v2/data/events`、`/stats`、`/health`、`/checkpoints`、`/tokens`、`/raw-receipt` | **`x-dc-api-key` header**（`tenants` 表签发，前缀 `infrax_dc_`，订阅激活时生成） |
| 订阅面 | `/api/v2/data/plans`、`/chains` | **公开**（无鉴权） |
| 订阅面 | `/api/v2/data/subscribe`、`/payment-check`、`/verify`、`/usage`、`/key` | **`x-wallet-address` header**（钱包地址，小写） |
| 回调 | `/api/v2/data/payment-callback` | **HMAC-SHA256**（`x-payments-signature`，服务端 `PAYMENTS_WEBHOOK_SECRET`） |

- `x-dc-api-key` 缺失 → 401 `code:1003`；无效 → 401 `code:1004`。
- 配额按自然月结算（`features.apiCallsPerMonth`），当月用满 → **429** `code:4290`，响应含 `used/quota` 与升级提示。
- 套餐：`data_free`（10000 次/月）、`data_pro`（$29/月，10 万次）、`data_enterprise`（$99/月，100 万次）。

## 3. 端点清单

### 3.1 订阅面（`/api/v2/data`）

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/v2/data/plans` | 公开 | 数据套餐目录（免费/Pro/Enterprise） |
| GET | `/api/v2/data/chains` | 公开 | 支持链列表（sepolia/ethereum/bsc/base/oxa） |
| POST | `/api/v2/data/subscribe` | x-wallet-address | 订阅套餐（body：`planId` + `rail`；免费直通返回 `dcApiKey`，付费返回 `pending` + payment 意图） |
| POST | `/api/v2/data/payment-check` | x-wallet-address | 轮询支付状态（chain rail 链上确认） |
| POST | `/api/v2/data/verify` | x-wallet-address | x402 rail 支付确认（body：`txHash`，payer 需匹配当前钱包） |
| GET | `/api/v2/data/usage` | x-wallet-address | 订阅用量（plan / dcApiKey / monthlyQuota / currentUsage / 日聚合） |
| GET | `/api/v2/data/key` | x-wallet-address | 查询当前租户 `dcApiKey`（含脱敏值） |
| POST | `/api/v2/data/payment-callback` | HMAC 验签 | 支付引擎出站回调（webhook 型 / credit 型，激活 pending 订阅） |

### 3.2 数据面（`/api/v2/data`，均需 `x-dc-api-key`）

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/v2/data/events` | x-dc-api-key | 事件查询（`chain`/`address`/`contract`/`event_type`/`from_block`/`to_block`/`page_size`，翻页用 `next_page_token`，返回含 `amount_raw`/`topic_hash`/`event_data` 原始字段） |
| GET | `/api/v2/data/stats` | x-dc-api-key | 各链事件统计（`event_count`/`latestBlock`/`totalRows`，O(1) 读取 checkpoint） |
| GET | `/api/v2/data/health` | x-dc-api-key | 数据面健康 + 全链扫描检查点 |
| GET | `/api/v2/data/checkpoints` | x-dc-api-key | 区块扫描检查点明细（chain/collector_name/last_block/status） |
| GET | `/api/v2/data/tokens` | x-dc-api-key | Token 目录（`symbol` ILIKE / `chain` 过滤，`limit` ≤500） |
| GET | `/api/v2/data/raw-receipt` | x-dc-api-key | 按 `tx_hash` 实时拉取完整原始 receipt logs（`chain` + `tx_hash` 必填） |

> 注意：`events` 表超大，禁止对事件表做全表 COUNT/GROUP BY（曾引发生产事故 B-10-3）；统计统一走 `/stats`（checkpoint O(1)）。

## 4. 样例代码

### 4.1 curl

```bash
# ① 套餐目录（公开，无需 key）
curl -s http://127.0.0.1:9102/api/v2/data/plans

# ② 支持链列表（公开）
curl -s http://127.0.0.1:9102/api/v2/data/chains

# ③ 数据面：链上事件统计（需 x-dc-api-key，生产实测 200）
curl -s http://127.0.0.1:9102/api/v2/data/stats \
  -H "x-dc-api-key: <DC_API_KEY>"

# ④ 数据面：查询 sepolia 最新 1 条事件（生产实测 200）
curl -s "http://127.0.0.1:9102/api/v2/data/events?chain=sepolia&limit=1" \
  -H "x-dc-api-key: <DC_API_KEY>"

# ⑤ 订阅面：免费套餐直通订阅（需 x-wallet-address）
curl -s -X POST http://127.0.0.1:9102/api/v2/data/subscribe \
  -H "Content-Type: application/json" \
  -H "x-wallet-address: 0x2bA20a76af1297D4Ef9BD242866F690aceaAb9f1" \
  -d '{"planId":"data_free","rail":"chain"}'
# 免费套餐响应：{code:0, data:{dcApiKey:"infrax_dc_...", dcSubStatus:"active", plan:{id:"data_free",price:0}}}

# ⑥ 订阅用量（需 x-wallet-address）
curl -s http://127.0.0.1:9102/api/v2/data/usage \
  -H "x-wallet-address: 0x2bA20a76af1297D4Ef9BD242866F690aceaAb9f1"
```

### 4.2 JS SDK

`infra.dc.*`（v0.6.0）：`events` / `stats` / `checkpoints` / `plans` / `tokens` / `chains` + 订阅面 `subscribe` / `paymentCheck` / `verify` / `usage`。数据面 key 经 `dcApiKey` 配置自动带 `x-dc-api-key` 头。

```ts
import { InfraX } from '@0xinfrax/infrax-dk';

const infrax = new InfraX({
  baseUrl: 'http://127.0.0.1:9102',   // 或经 web 代理 http://<host>:9111
  dcApiKey: process.env.DC_API_KEY,   // ← x-dc-api-key（数据面必需）
});

// 公开：套餐目录 / 支持链
const plans = await infrax.dc.plans();
const chains = await infrax.dc.chains();

// 数据面：统计 + 事件（生产实测 200）
const stats = await infrax.dc.stats();                       // chains[] + totalRows
const events = await infrax.dc.events({ chain: 'sepolia', limit: 1 });

// 订阅面：免费套餐直通激活（x-wallet-address 鉴权）
const walletAddress = '0x2bA20a76af1297D4Ef9BD242866F690aceaAb9f1';
const sub = await infrax.dc.subscribe({ planId: 'data_free', rail: 'chain' }, walletAddress);
if (sub.data.dcSubStatus === 'pending') {
  // 付费套餐：钱包按 sub.data.payment.payTo 支付后提交 txHash 确认
  const ok = await infrax.dc.verify(txHash, walletAddress);
}
const usage = await infrax.dc.usage(walletAddress);  // plan / dcApiKey / monthlyQuota / currentUsage
```

### 4.3 常见错误码

| HTTP | code | 含义 |
|---|---|---|
| 400 | 1001 | 参数缺失/非法（缺 planId、缺 x-wallet-address、chain+tx_hash 格式错误、未知 rail） |
| 400 | 1002 | rail 未启用（如 x402 未在支付引擎开启） |
| 401 | 1003 | 缺 `x-dc-api-key` / 回调签名无效 |
| 401 | 1004 | `x-dc-api-key` 无效或租户非 active |
| 404 | 2002 | 未找到该钱包对应的租户（先 subscribe） |
| 409 | 1001 | verify 时 tx payer 与当前钱包不匹配 |
| 429 | 4290 | 月度配额已用尽（`used/quota`），需升级套餐 |
| 502/503 | 1003 | 支付引擎不可达 / 未配置 PAYMENTS_URL |
