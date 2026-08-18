# InfraX 数据服务需求文档

> 提交方：Arbitrage 跨交易所套利平台（产品：AI Agent 跨 CEX 价差套利 + 量化终端）
> 版本：v1.0 ｜ 日期：2026-08-19
> 对接对象：InfraX 数据服务（data-service）
> 对接方式：HTTP REST，`X-Service-Key` 鉴权，服务端为 NestJS（TypeScript）

---

## 1. 背景与用途

平台定位为**跨中心化交易所（CEX）价差套利 + AI Agent 自动决策**的量化投资终端，前端为深色量化风格，面向海外用户。当前行情已通过 CCXT 直连 10 所 20 对（真实基线价），需要 InfraX 补齐**宏观情绪因子、ML 因子、财经日历、市场快照**等量化与 AI 决策所需的加工数据。

数据将用于：

| 展示板块 | 用途 |
|---|---|
| Market 页 · AI Market Radar | 综合评分 + 4 维度（Momentum / News Sentiment / Social Sentiment / Structure）+ 解读文本 |
| Market 页 · 宏观仪表盘 | Fear & Greed 大表盘 + VIX/DXY/US10Y 等迷你表盘 |
| Market 页 · AI 信号行 | 树模型方向、上涨概率、FinBERT 情绪、RSI |
| Market 页 · Sentiment Consensus | 新闻情绪打分 + 涨跌共识 |
| Market 页 · Macro Pulse | 经济事件日历（影响级别 + F/P 值） |
| Market 页 · 全球资产概览 | 指数、TVL、主流币价格 |
| Trading Logic 页 | LSTM / Tree-Model 信号模型的数据支撑（roadmap） |

**缺失兜底策略**：任何端点不可用、超时、字段缺失 → 服务端自动降级返回**确定性假数据**（页面统一标注 *illustrative*），保证页面永不白屏、不报错。交易机会仍基于 CCXT 真实基线价的模拟成交，无需 InfraX 提供。

---

## 2. 数据需求清单

### 2.1 宏观情绪因子（category=external）— 高优先级

- 端点：`GET /factors/current?symbols=BTC&category=external`
- 用途：宏观仪表盘、AI Market Radar 的情绪/结构维度、解读文本
- 频率：5 分钟级即可
- 期望字段（symbol 维度，按 BTC 提供全局宏观因子即可）：

| 字段 | 含义 | 取值范围/单位 |
|---|---|---|
| `fear_greed` | 恐慌贪婪指数 | 0~100 |
| `sentiment_score` | 综合情绪得分 | -1 ~ +1 |
| `vix` | 波动率指数 | 数值 |
| `vxn` | CBOE 纳指波动率 | 数值 |
| `gvz` | 黄金波动率 | 数值 |
| `dxy` | 美元指数 | 数值 |
| `us10y` | 美国 10 年期国债收益率 | 百分数 |
| `put_call` | 期权看跌看涨比（含 `interpretation` 解读文本） | 数值 + 文本 |

### 2.2 ML 因子（category=ml）— 高优先级

- 端点：`GET /factors/current?symbols=BTC,ETH,SOL&category=ml`
- 用途：AI 信号行（方向徽章 + 上涨概率条 + FinBERT + RSI）、量化终端核心展示
- 频率：1~5 分钟
- 期望字段：

| 字段 | 含义 | 取值范围/单位 |
|---|---|---|
| `tree_direction` | 树模型方向信号 | 1=up / 0=flat / -1=down |
| `tree_prob_up` | 树模型上涨概率 | 0~1 |
| `finbert_sentiment` | FinBERT 新闻情绪 | -1 ~ +1 |
| `rsi_14` | RSI(14) 技术指标 | 0~100 |
| （可扩展）`ema_fast` / `ema_slow` / `atr` | 均线/波动指标 | 数值 |

### 2.3 新闻情绪因子（category=news）— 高优先级

- 端点：`GET /factors/current?symbols=BTC,ETH,SOL&category=news`
- 用途：Sentiment Consensus 新闻流情绪打分、雷达 News Sentiment 维度
- 期望字段：新闻情绪分数（-1~1）、情绪标签（positive/neutral/negative）、标题级情绪（如可用）

### 2.4 财经日历快照（snapshots，type=calendar）— 高优先级

- 端点：`GET /snapshots?type=calendar`
- 用途：Macro Pulse 板块（替换当前 mock 日历）
- 频率：每日更新 + 当日事件实时
- 期望字段（事件列表）：

| 字段 | 含义 |
|---|---|
| `timestamp` / `date` | 事件时间（ISO 或 Unix 毫秒） |
| `event` / `name` | 事件名称（如 FOMC Rate Decision） |
| `country` | 国家/地区 |
| `impact` | high / medium / low |
| `forecast` | 预期值 |
| `previous` | 前值 |
| `description` | 事件说明（可选） |

### 2.5 其他快照（snapshots）— 中优先级

- `GET /snapshots?type=indices` — 全球主要指数（标普/纳指/道指/恒生等），用于"全球资产概览"
- `GET /snapshots?type=crypto_prices` — 主流加密货币价格清单（补充 CCXT 未覆盖币种）
- `GET /snapshots?type=tvl` — 各链 TVL（`chains: [{chain, tvl}]`）
- `GET /snapshots?type=earnings` — 美股财报事件（ticker/period/actual/estimate/surprise，低优先级）
- `GET /snapshots?type=heatmap` — 分类热力图（topcap/layer1/defi → `[{symbol, name, change_24h}]`，可选）

### 2.6 K线历史（bars）— 可选

- 端点：`GET /bars?symbol=BTC/USDT&timeframe=1D&limit=500`
- 用途：历史趋势 sparkline、净值曲线背景、回测展示
- 期望字段：`{bars: [{ts(毫秒), open, high, low, close, volume}]}`

---

## 3. 期望响应样例

```json
// GET /factors/current?symbols=BTC,ETH,SOL&category=external
{
  "BTC": { "fear_greed": 62, "sentiment_score": 0.18, "vix": 14.2, "dxy": 104.3, "us10y": 4.12, "vxn": 18.6, "gvz": 14.1, "put_call": { "value": 0.93, "interpretation": "Market calm" } }
}

// GET /factors/current?symbols=BTC,ETH,SOL&category=ml
{
  "BTC": { "tree_direction": 1, "tree_prob_up": 0.72, "finbert_sentiment": 0.31, "rsi_14": 58.4 },
  "ETH": { "tree_direction": 0, "tree_prob_up": 0.51, "finbert_sentiment": 0.05, "rsi_14": 52.1 },
  "SOL": { "tree_direction": -1, "tree_prob_up": 0.38, "finbert_sentiment": -0.22, "rsi_14": 44.7 }
}

// GET /snapshots?type=calendar
{ "calendar": [
  { "timestamp": 1755552000000, "event": "US Non-Farm Payrolls", "country": "United States",
    "impact": "high", "forecast": "180K", "previous": "206K", "description": "" }
] }
```

> 字段名以 InfraX 实际契约为准，我方按真实字段做归一化适配；未覆盖的字段按 2.7 降级。

---

## 4. Symbol 清单

- **因子必需（3）**：`BTC/USDT`、`ETH/USDT`、`SOL/USDT`
- **可扩展（17）**：`BNB/XRP/ADA/DOGE/AVAX/DOT/LINK/LTC/TRX/TON/SHIB/NEAR/APT/ARB/OP/FIL/ATOM`（共 20 对，与 CCXT 行情对一致）

---

## 5. 鉴权与调用约定

- Base URL：待 InfraX 提供
- 鉴权 Header：`X-Service-Key: <api_key>`
- 超时：单次请求 ≤ 5s；429 限流时按指数退避重试 ≤ 2 次
- **Fail-silent 原则**：任何失败（网络/非 2xx/字段缺失）→ 返回确定性假数据并标记 `simulated: true`，页面展示 *illustrative* 徽章，不影响其他板块
- 安全：服务端存储 key 于环境变量（`INFRAX_DATA_URL` / `INFRAX_DATA_API_KEY`），仅后端调用，不暴露前端

---

## 6. 交付与验收

1. InfraX 侧确认：Base URL、鉴权方式、各端点字段名与更新频率
2. 我方联调顺序（按优先级）：
   - ① `factors/current`（external + ml）跑通宏观仪表盘与 AI 信号行
   - ② `snapshots?type=calendar` 替换 mock 日历
   - ③ `snapshots`（indices/tvl/crypto_prices/earnings/heatmap）全球资产概览
   - ④ `bars` 历史趋势
3. 验收标准：真实数据可用时页面展示真实值；任何数据不可用时自动降级假数据且页面正常

## 7. 待 InfraX 确认的开放问题

1. InfraX 是否提供**新闻标题流**（非情绪因子，而是标题/摘要列表）？当前新闻标题由我方 mock，若有真实标题源可对接
2. `factors/current` 的 ML 因子是否有更多（如多周期动量、波动率因子）？
3. `bars` 对 crypto 是否可用、支持哪些 timeframe？
