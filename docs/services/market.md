# Collector-Market 行情与市场分析 使用指南（:9101）

> 最后更新：2026-08-11 | 生产状态：🟢 已验证可用（2026-08-11 生产实测）

## 0. 快速开始（Quick Start）

**1）安装**

```bash
npm install @0xinfrax/infrax-dk
```

**2）获取凭据**

`api_keys` 表签发的 `pkx_` key，数据面 `/api/v2/data/market/*` 与订阅面 `/api/v2/market/*` 均用 `X-API-Key` 携带（1 分钟滑动窗口限流，默认 100 次/分）；`/api/v2/market/plans` 公开。

**3）最小示例**

```ts
import { InfraX } from '@0xinfrax/infrax-dk';

const infrax = new InfraX({
  baseUrl: 'http://127.0.0.1:9101',   // 内网直连；公网经 web 代理 http://43.163.105.172:9111
  apiKey: process.env.MARKET_API_KEY, // ← X-API-Key（pkx_ key）
});

// 数据面：热门代币（chainIndex 必填，生产实测 200）
const hot = await infrax.market.getHotTokens('1', 5);

// 订阅面：套餐目录（公开）
const plans = await infrax.market.plans();
console.log(plans.data);
```

**4）验证**

```bash
curl -s http://127.0.0.1:9101/api/v2/data/market/supported-chains \
  -H "X-API-Key: <MARKET_API_KEY>"   # 生产实测 200
```

> 完整端点清单 / 鉴权细节 / 错误码见下文对应章节。

## 1. 服务定位

**Collector-Market（行情与市场分析）**是 InfraX 的市场数据服务（`projects/collector`，:9101），同时承担链上事件扫描与 OKX ChainOS v6 DEX 行情聚合。

- **行情数据面**（挂 `/api/v2/data/market/*`，`routes/marketRoutes.ts`）：支持链列表、指数价格、代币搜索/K 线/热门代币、Meme 信号、智能资金信号、排行榜、Holder 聚类（BubbleMap）、地址组合分析（Portfolio）等 40+ 端点；另含自管表（`tracked-tokens` 监控列表、`custom-sigs` 自定义事件签名）。
- **订阅面**（挂 `/api/v2/market/*`，`marketSubscriptionRoutes.ts`）：Market 套餐购买（MQ-16 T-2）。免费套餐直接激活；付费套餐经支付引擎（chain / fiat / x402）确认后激活；月度配额超限返回 **503**（对齐需求：配额用尽 → 503）。
- **生产实测（2026-08-11）**：`GET /api/v2/data/market/supported-chains` 200（BTC/ETH 链列表）；`GET /api/v2/market/usage` 200——market_free 月配额 10000、已用 2299（计费真实生效）。

> ⚠️ 行情端点**完整路径为 `/api/v2/data/market/*`**（前缀包含 `/data`），订阅端点为 `/api/v2/market/*`，两者不同、勿混淆。

## 2. 鉴权方式

| 面 | 端点 | 鉴权 |
|---|---|---|
| 行情数据面 | `/api/v2/data/market/*` | **`X-API-Key`**（`api_keys` 表签发的 `pkx_` key；1 分钟滑动窗口限流，默认 `rate_limit=100`；挂 `marketQuotaEnforce` 按量计费） |
| 订阅面 | `/api/v2/market/plans` | **公开** |
| 订阅面 | `/api/v2/market/checkout`、`/payment-check`、`/verify`、`/usage` | **`X-API-Key`**（识别 keyId） |
| 回调 | `/api/v2/market/payment-callback` | **HMAC-SHA256**（`x-payments-signature`，服务端 `PAYMENTS_WEBHOOK_SECRET`） |

- `X-API-Key` 缺失/无效 → 401（`code:-1`）；key 被禁用 → 403；1 分钟限流超限 → 429（`code:-1`）。
- 月度配额（自然月，`market_usage` 计数）用满 → **503**，响应含 `used/quota/plan/upgradeUrl`。
- 套餐：`market_free`（10000 次/月）、`market_pro`（$49/月，10 万次）、`market_enterprise`（$199/月，100 万次）。

## 3. 端点清单

### 3.1 行情数据面（`/api/v2/data/market/*`，均需 `X-API-Key`）

**P1 免费层**

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v2/data/market/supported-chains` | 支持的链列表（生产实测 200） |
| GET | `/api/v2/data/market/balances` | 地址全部 Token 余额（`address` 必填，`chains` 逗号分隔） |
| GET | `/api/v2/data/market/transactions` | 地址交易历史（`address` 必填，`limit` 默认 50） |

**P2 基础层**

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v2/data/market/index-price` | 指数价格（`chainIndex` 必填） |
| GET | `/api/v2/data/market/index-price-history` | 指数历史价格（`chainIndex` 必填，`limit` 默认 100） |
| GET | `/api/v2/data/market/balance-total` | 地址组合总价值（`address` 必填） |
| GET | `/api/v2/data/market/token-balance` | 单 Token 余额（`address`+`chainIndex`+`tokenAddress`） |
| GET | `/api/v2/data/market/transaction-detail` | 单笔交易详情（`chainIndex`+`txHash`） |
| GET | `/api/v2/data/market/token-search` | 代币搜索（`keyword` 必填，`chainIndex`/`limit`） |
| GET | `/api/v2/data/market/token-info` | Token 基础信息（`chainIndex`+`tokenAddress`） |
| GET | `/api/v2/data/market/hot-tokens` | 热门代币（**`chainIndex` 必填**，30+ 过滤参数可选，`limit` 默认 50） |
| GET | `/api/v2/data/market/top-liquidity` | 高流动性池（`chainIndex`+`tokenAddress`） |
| GET | `/api/v2/data/market/candles` | K 线（`chainIndex`+`tokenAddress`，`period` 默认 `15m`，`limit` 默认 100） |
| GET | `/api/v2/data/market/price` | 实时 DEX 价格（`chainIndex`+`tokenAddress`） |
| GET | `/api/v2/data/market/trades` | 近期成交（`chainIndex`+`tokenAddress`，`limit` 默认 50） |

**P3 高级层（Token 分析）**

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v2/data/market/token-advanced` | Token 高级信息 |
| GET | `/api/v2/data/market/token-holders` | 持有者列表（`limit` 默认 50） |
| GET | `/api/v2/data/market/token-top-traders` | 顶级交易者 |
| GET | `/api/v2/data/market/price-info` | 详细价格信息 |
| GET | `/api/v2/data/market/historical-candles` | 历史 K 线（`period` 默认 `1H`） |

**P3 MemePump**

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v2/data/market/mempump/chains` | Meme 支持链 |
| GET | `/api/v2/data/market/mempump/list` | Meme 代币列表（`chainIndex` 必填） |
| GET | `/api/v2/data/market/mempump/details` | Meme 代币详情 |
| GET | `/api/v2/data/market/mempump/devinfo` | 开发者信息 |
| GET | `/api/v2/data/market/mempump/similar` | 相似代币 |
| GET | `/api/v2/data/market/mempump/bundle` | Bundle 检测 |
| GET | `/api/v2/data/market/mempump/apedwallets` | Aped 钱包 |

**P3 信号 / 排行榜**

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v2/data/market/signals` | 智能资金信号（`chainIndex` 必填） |
| GET | `/api/v2/data/market/signal-chains` | 信号支持链 |
| GET | `/api/v2/data/market/leaderboard` | 交易者排行榜（`chainIndex` 必填，`leaderboardType` 默认 `pnl`） |
| GET | `/api/v2/data/market/leaderboard-chains` | 排行榜支持链 |

**P3 Holder 聚类（BubbleMap）**

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v2/data/market/cluster-overview` | 聚类总览 |
| GET | `/api/v2/data/market/cluster-list` | 聚类列表 |
| GET | `/api/v2/data/market/cluster-top-holders` | 聚类顶级持有者 |

**P3 地址组合分析（Portfolio）**

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v2/data/market/portfolio-overview` | 组合总览（`address` 必填） |
| GET | `/api/v2/data/market/portfolio-pnl` | 近期 PnL（`address` 必填） |
| GET | `/api/v2/data/market/portfolio-token-pnl` | 单 Token PnL（`address`+`chainIndex`+`tokenAddress`） |
| GET | `/api/v2/data/market/portfolio-dex-history` | DEX 交易历史（`address` 必填） |

**自管表（SDK/MCP 使用）**

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v2/data/market/tracked-tokens` | 监控列表（`chain`/`enabled` 过滤） |
| POST | `/api/v2/data/market/tracked-tokens` | 添加监控 Token（`chain`+`tokenAddress`） |
| DELETE | `/api/v2/data/market/tracked-tokens` | 移除监控 Token |
| GET | `/api/v2/data/market/custom-sigs` | 自定义事件签名列表 |
| POST | `/api/v2/data/market/custom-sigs` | 注册自定义签名（`chain`+`topicHash`+`eventType`，topicHash 须 0x+64hex） |
| DELETE | `/api/v2/data/market/custom-sigs` | 移除自定义签名 |

### 3.2 订阅面（`/api/v2/market`）

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/v2/market/plans` | 公开 | 套餐目录（free/pro/enterprise） |
| POST | `/api/v2/market/checkout` | X-API-Key | 发起订阅支付（body：`plan_id`+`rail`+可选 `subscriber`；免费直通激活，付费返回 pending + payment 意图） |
| POST | `/api/v2/market/payment-check` | X-API-Key | 轮询支付状态（chain rail 链上确认） |
| POST | `/api/v2/market/verify` | X-API-Key | x402 支付确认（body：`txHash`） |
| GET | `/api/v2/market/usage` | X-API-Key | 用量（planName / monthlyQuota / currentUsage / 日聚合；生产实测 200） |
| POST | `/api/v2/market/payment-callback` | HMAC 验签 | 支付引擎出站回调（`mktsub:` 前缀激活 pending 订阅） |

## 4. 样例代码

### 4.1 curl

```bash
# ① 支持链列表（需 X-API-Key，生产实测 200）
curl -s http://127.0.0.1:9101/api/v2/data/market/supported-chains \
  -H "X-API-Key: <MARKET_API_KEY>"          # api_keys 表签发的 pkx_ key

# ② 热门代币（chainIndex 必填；chainIndex 取值见 supported-chains 返回，如 BTC/ETH 链）
curl -s "http://127.0.0.1:9101/api/v2/data/market/hot-tokens?chainIndex=1&limit=5" \
  -H "X-API-Key: <MARKET_API_KEY>"

# ③ K 线
curl -s "http://127.0.0.1:9101/api/v2/data/market/candles?chainIndex=1&tokenAddress=0x...&period=15m&limit=10" \
  -H "X-API-Key: <MARKET_API_KEY>"

# ④ 订阅用量（需 X-API-Key；生产实测 200：market_free 月配额 10000，已用 2299）
curl -s http://127.0.0.1:9101/api/v2/market/usage \
  -H "X-API-Key: <MARKET_API_KEY>"

# ⑤ 套餐目录（公开，无需 key）
curl -s http://127.0.0.1:9101/api/v2/market/plans

# ⑥ 免费套餐订阅（需 X-API-Key）
curl -s -X POST http://127.0.0.1:9101/api/v2/market/checkout \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <MARKET_API_KEY>" \
  -d '{"plan_id":"market_free","rail":"chain"}'
# 响应：{code:0, data:{keyId, planId:"market_free", marketSubStatus:"active", free:true}}
```

### 4.2 JS SDK

`infra.market.*`（v0.6.0，21 方法）：数据面 `searchToken` / `getTokenInfo` / `getHotTokens` / `getCandles` / `getPrice` / `getBalances` / `getTransactions` / `getMemePumpList` / `getSignalList` / `getLeaderboard` / `getTrackedTokens` / `addTrackedToken` / `removeTrackedToken` / `getEventSigs` / `addEventSig` / `removeEventSig` + 订阅面 `plans` / `checkout` / `paymentCheck` / `verify` / `usage`。key 经 `apiKey` 配置自动带 `X-API-Key` 头。

```ts
import { InfraX } from '@0xinfrax/infrax-dk';

const infrax = new InfraX({
  baseUrl: 'http://127.0.0.1:9101',          // 或经 web 代理 http://<host>:9111
  apiKey: process.env.MARKET_API_KEY,        // ← X-API-Key（api_keys 表签发的 pkx_ key）
});

// 数据面：支持链列表 / 热门代币 / K 线（生产实测 200）
// 注：supported-chains 当前未封装进 SDK，可直连 REST（需 X-API-Key）：
const chains = await fetch('http://127.0.0.1:9101/api/v2/data/market/supported-chains',
  { headers: { 'X-API-Key': process.env.MARKET_API_KEY! } }).then(r => r.json());
const hot = await infrax.market.getHotTokens('1', 5);            // chainIndex 必填
const klines = await infrax.market.getCandles('1', '0x...', '15m', 10);

// 订阅面：套餐目录（公开）
const plans = await infrax.market.plans();

// 订阅：免费套餐直通激活
const sub = await infrax.market.checkout({ plan_id: 'market_free', rail: 'chain' });
if (sub.data.marketSubStatus === 'pending') {
  // 付费套餐：按 sub.data.payment 支付后提交 txHash 确认（x402 rail）
  const ok = await infrax.market.verify(txHash);
}

// 用量（生产实测 200：market_free 10000 配额已用 2299）
const usage = await infrax.market.usage();   // planName / monthlyQuota / currentUsage
```

### 4.3 常见错误码

| HTTP | code | 含义 |
|---|---|---|
| 400 | -1 | 缺少必填参数（如 `chainIndex`、`keyword`、`address`；topicHash 格式非法） |
| 400 | 1001 | 未知套餐 plan_id |
| 400 | 1002 | 套餐无链上映射（PAYMENTS_PLAN_ID_MAP 未配）/ x402 rail 未启用 |
| 401 | -1 | 缺 / 无效 `X-API-Key`；payment-callback HMAC 验签失败 |
| 403 | -1 | API Key 被禁用 |
| 404 | 2002 | 未找到该 key（usage） |
| 429 | -1 | 1 分钟滑动窗口限流超限（默认 100 次/分） |
| 502 | 1003 | 支付引擎不可达 |
| 503 | 503 | 月度配额用尽（`used/quota` + upgradeUrl），需升级套餐 |
