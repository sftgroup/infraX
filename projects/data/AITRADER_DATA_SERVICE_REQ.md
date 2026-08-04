# B 端 data-service 需求文档（完整版 · AItrader 侧提交）

> 提交方：AItrader 项目 ｜ 日期：2026-08-04
> 背景：AItrader 微服务化后，data-service 已并入 B 端项目统一维护（生产 `http://43.159.60.46:8765`）。AItrader 单体 + 3 个本地微服务（backtest/trading/analysis）将**全部收敛为通过 HTTP 调用 B 端 data-service**，删除本地数据层。
> 本文档为**完整需求**：已实现能力（DS-1~DS-6，作为契约确认）+ 待补缺口（DS-7~DS-12）。状态标记：✅ 已实现 ｜ 🔲 待补 ｜ ⚠️ 部分实现/待确认。

---

## 1. 需求总览

| 编号 | 需求 | 状态 | 优先级 |
|---|---|---|---|
| DS-1 | K 线数据 `/bars`（OHLCV+指标+因子） | ✅ 已实现（数据覆盖不足，见 DS-8） | P0 |
| DS-2 | 因子目录/最新/历史 `/factors/*` | ✅ 已实现 | P0 |
| DS-3 | 复杂快照 `/snapshots` | ⚠️ 部分（缺 3 类，见 DS-10） | P0 |
| DS-4 | 符号解析 `/api/v1/symbol/resolve` | ⚠️ 已实现，多市场覆盖待确认（DS-11） | P1 |
| DS-5 | 券商市场策略 `/api/v1/policy/broker-market` | ✅ 已实现 | P1 |
| DS-6 | 统计/健康 `/stats` `/health` | ✅ 已实现 | — |
| DS-7 | 实时报价 `/ticker` | ✅ 已实现（1375a38，2026-08-05 已部署） | **P0** |
| DS-8 | `/bars` 数据覆盖保证 + spot/swap 区分 | ⚠️ 接口已补 `market_type`（spot/swap，方案 A），swap 数据采集待补 | **P0** |
| DS-9 | 符号搜索 `/symbols/search` | 🔲 待补 | **P0** |
| DS-10 | `/snapshots` 类型补齐（commodities/forex_pairs/market_overview） | 🔲 待补 | P1 |
| DS-11 | `/symbol/resolve` 多市场覆盖确认 | 🔲 待 B 端确认 | P1 |
| DS-12 | 入站鉴权 `X-Service-Key` | 🔲 待补（与 AItrader 侧联动） | P1 |

---

## 2. 已实现能力确认（DS-1 ~ DS-6）

### DS-1 K 线数据 `GET /bars` ✅

**契约（已核实代码，与 B 端一致）**：

```
GET /bars
  query: symbol     必填，如 BTC/USDT
         timeframe  可选，默认 1m；支持 1m/5m/15m/1h/4h/1D
         start      可选，unix 毫秒（闭区间 >=）
         end        可选，unix 毫秒（闭区间 <=）
         limit      可选，默认 500，上限 5000
响应 200:
{
  "symbol": "BTC/USDT",
  "timeframe": "4h",
  "count": 522,
  "bars": [
    {
      "ts": 1746748800000,          // unix 毫秒
      "open": 64000.5, "high": 64500, "low": 63800, "close": 64120.8, "volume": 1234.5,
      "rsi_14": 52.3, "macd": 12.4, "macd_signal": 10.1, "macd_hist": 2.3,
      "bb_upper": 65000, "bb_middle": 64000, "bb_lower": 63000, "atr_14": 312.4,
      "ma_5": 63900, "ma_10": 63800, "ma_20": 63600
    }
  ]
}
```

**要点**：时间为毫秒；`start`/`end` 闭区间；bars 升序；指标字段可缺省（None 不返回）；外部因子按最近时间戳 join。

**现状缺口**：数据覆盖不足（仅实测 BTC/USDT 4h 有数据）→ 详见 DS-8。**当前不可用，P0 阻塞。**

### DS-2 因子 `GET /factors/catalog` `GET /factors/current` `GET /factors/history` ✅

**契约**：

```
GET /factors/catalog            → { "factors": [ ... ] }            # 全部可用因子目录
GET /factors/current
  query: symbols   可选，逗号分隔，默认 BTC
         category  可选：external/sentiment/news/opportunities/heatmap/calendar/snapshot
  → { "ts": <ms>, "factors": { ... } }
GET /factors/history
  query: symbol, timeframe, ids(逗号分隔), start, end(ms), limit(≤5000)
  → 逐 bar 因子序列，ts 毫秒，与 /bars 对齐
```

**category 覆盖**：external（fear_greed/vix/dxy/us10y）、sentiment（yield_curve/put_call_ratio/adanos_sentiment/sentiment_score）、news、opportunities、heatmap、calendar、snapshot（crypto_prices/indices/on-chain/defi/volatility/macro/earnings）。

**消费方**：trading-service（因子注入策略执行）、analysis-service（AI 分析上下文）、backtest-service（`/factors/current`）。✅ 已接入可用。

### DS-3 复杂快照 `GET /snapshots` ⚠️

**契约**：

```
GET /snapshots?type=<type>
  type ∈ heatmap | calendar | news | crypto_prices | indices | tvl |
         volatility | us_indicators | earnings | yield_curve |
         put_call_ratio | adanos_sentiment | opportunities
  → { "ts": <ms>, "snapshots": { ... } }
```

**状态**：上述 type 已实现。**缺失**：commodities（商品）、forex_pairs（外汇对）、market_overview（多市场概览）→ DS-10。

### DS-4 符号解析 `GET /api/v1/symbol/resolve` ⚠️

```
GET /api/v1/symbol/resolve?symbol=BTC   → { "query": "BTC", "resolved": "BTCUSDT" }
```

**状态**：单符号→标准符号解析已实现。**待确认**：是否覆盖 crypto/美股/外汇/期货/A股/港股（DS-11）。

### DS-5 券商市场策略 `GET /api/v1/policy/broker-market` ✅

```
GET /api/v1/policy/broker-market
  → { "crypto": { "exchanges": ["Binance","OKX","Bybit","Gate","Kucoin","Kraken","HTX","Bitget","Deepcoin","Coinbase"], "default": "Binance" } }
```

### DS-6 统计/健康 `GET /stats` `GET /health` ✅

```
GET /health → { "status": "ok", "service": "data-service", "version": "1.0.0" }
GET /stats  → { "kline_rows", "snapshot_rows", "symbols", "time_start", "time_end" }
```

---

## 3. 待补需求（DS-7 ~ DS-12）

### DS-7 实时报价 `GET /ticker` 🔲 P0

**必要性**：AItrader 单体删除本地 ccxt/yfinance 后，以下功能必须由 B 端承接实时价：
- 持仓实时价格展示（`strategy/live_trading.py`）
- 持仓价格/盈亏告警（`portfolio/alerts.py` 定时轮询 `KlineService.get_realtime_price`）
- 快交易价格快照、全局行情页、自选行情

**契约建议**：

```
GET /ticker
  query: symbol       必填，如 BTC/USDT
         market_type  可选，spot | swap（默认 spot）
         exchange_id  可选，如 binance（默认 B 端策略决定）
         market       可选，crypto | usstock | forex | futures | cnstock | hkstock
响应 200:
{
  "symbol": "BTC/USDT",
  "price": 64000.5,
  "change": -120.3,
  "changePercent": -0.19,
  "high": 64500.0,
  "low": 63800.0,
  "open": 64120.8,
  "previousClose": 64120.8,
  "ts": 1746748800000
}
```

**要点**：字段对齐 AItrader 消费方 `KlineService.get_realtime_price` 返回结构，避免二次映射；`market` 需覆盖 crypto/美股/外汇/期货/A股/港股；建议 B 端做 5-30s 缓存；非 200 返回 `{ "detail": "<原因>" }`。

### DS-8 `/bars` 数据覆盖保证 + spot/swap 区分 🔲 P0

**现状事实（2026-08-04 实测）**：
- `BTC/USDT` + `1m`/`1D` 返回空；仅 `4h` 有数据（522 根，2026-05-09 → 08-04）。
- 采集配置：crypto 默认 3 标的（BTC/ETH/SOL）× 默认 1m（生产环境实际启用了 4h）；多市场（美股/外汇/期货 via yfinance，A股/港股 via akshare）仅采集日线/1h/4h，且依赖 `data_config.json`。

**要求**：

| 市场 | 标的 | timeframe | 最低历史深度 |
|---|---|---|---|
| Crypto spot | BTC/ETH/SOL（可扩展） | 1m/5m/15m/30m/1h/4h/1D | 1m≥30 天；5m/15m/30m≥180 天；1h/4h≥1 年；1D≥3 年 |
| Crypto swap 永续 | BTC/USDT:USDT 等主流 | 同上 | 同上 |
| 美股 | 主流标的（SPY/QQQ/AAPL 等） | 1m/5m/15m/1h/4h/1D | 1D≥3 年，分钟级≥30 天 |
| 外汇 | 主流货币对 | 15m/1h/4h/1D | 1D≥1 年 |
| 期货 | 主流商品期货 | 1h/4h/1D | 1D≥1 年 |
| A股/港股 | 活跃标的 | 15m/1h/4h/1D | 1D≥1 年 |

**要点**：
- 深度标准对齐 AItrader 回测区间上限（1m 30 天、5m 180 天、15m/30m 365 天、其余 1095 天），保证用户可选区间不越界。
- **spot/swap 区分**（二选一，推荐前者）：
  - 方案 A：`/bars` 增加可选参数 `market_type`（spot/swap），B 端将 `BTC/USDT` 映射到对应合约数据；
  - 方案 B：`symbol` 直接接受 ccxt 风格 `BTC/USDT:USDT`。
  消费方：AItrader 快交易与策略执行涉及 USDT 永续（`market_type=swap`），当前无法区分。
- 数据连续性：不允许静默丢 bar；缺失可在 `/stats` 或响应中可观测。

### DS-9 符号搜索 `GET /symbols/search` 🔲 P0

**必要性**：单体 `market.py` 符号搜索（前端"添加自选/搜索交易对"）当前用本地 ccxt `load_markets()` 全量加载后模糊匹配 USDT 交易对。现有 `/symbol/resolve` 是"已知符号解析"，**不支持关键字模糊搜索返回候选列表**。

**契约建议**：

```
GET /symbols/search
  query: keyword  必填，模糊关键字（如 "btc"、"eth/"）
         market   可选，crypto | usstock | forex | futures（默认 crypto）
         limit    可选，默认 20，上限 100
响应 200:
{
  "keyword": "btc",
  "symbols": [
    { "symbol": "BTC/USDT", "market": "crypto", "market_type": "spot", "exchange": "binance", "active": true },
    { "symbol": "BTC/USDT:USDT", "market": "crypto", "market_type": "swap", "exchange": "binance", "active": true }
  ]
}
```

**要点**：只返回 `active=true` 且 quote=USDT（crypto）；支持 spot/swap 双市场返回；B 端结果缓存（对标单体 4 小时缓存，避免打爆上游）。

### DS-10 `/snapshots` 类型补齐 🔲 P1

| 缺失 type | 单体原数据 | 消费方 |
|---|---|---|
| `commodities` | 商品行情（黄金/原油等，yfinance） | 全局市场页"商品"板块 |
| `forex_pairs` | 外汇对行情（yfinance） | 全局市场页"外汇"板块 |
| `market_overview` | 多市场概览聚合（涨跌分布） | 全局市场页顶部概览 |

**要求**：返回结构与现有 `{ts, snapshots}` 信封一致；刷新节奏对标单体缓存 TTL（商品/外汇 30 分钟、概览 15 分钟）。

### DS-11 `/symbol/resolve` 多市场覆盖确认 🔲 P1

单体 `symbol_name.py` 当前用 yfinance/finnhub/腾讯/MOEX 解析跨市场符号（crypto/美股/外汇/期货/A股/港股），删除本地后需全部由 B 端承接。**请 B 端确认 `resolve` 的覆盖范围**；若仅 crypto，AItrader 侧将保留非 crypto 解析的本地降级。

### DS-12 入站鉴权 `X-Service-Key` 🔲 P1

**必要性**：当前 data-service 公网无鉴权。AItrader 侧即将为服务间调用引入共享凭据：调用方携带 `X-Service-Key: <SERVICE_API_KEY>`，AItrader 与 B 端共享同一 key 配置。

**要求**：data-service 全部端点（`/health` 豁免）校验 `X-Service-Key`，缺失/不匹配返回 401 `{ "detail": "unauthorized" }`。

---

## 4. B 端已知采集配置（供 B 端核对）

- crypto：`KL_SYMBOLS` 默认 `BTC/USDT,ETH/USDT,SOL/USDT`；`KL_TIMEFRAMES` 默认 `1m`；`KL_EXCHANGE` 默认 binance；采集间隔 `KL_INTERVAL_SEC` 默认 300s。
- 多市场：`data_config.json` → `multi_kline`：`us_stocks`/`forex`/`futures`（yfinance，仅 1d/1h/4h）、`cn_stocks`/`hk_stocks`（akshare，仅 1d）。
- 快照/因子收集器（startup 自动启动）：ExternalFactor / Calendar / Snapshot / Heatmap / News / Sentiment / Adanos / Opportunity。

---

## 5. 消费方清单（影响面）

| 消费方 | 使用端点 | 说明 |
|---|---|---|
| backtest-service（8002） | `/bars`、`/factors/current` | 回测数据源（已接入，秒↔毫秒换算） |
| trading-service（8004） | `/bars`、`/factors/current` | 策略执行 + 因子（已接入） |
| analysis-service（8003） | `/bars`、`/factors/current`、`/factors/catalog` | AI 分析上下文（已接入） |
| AItrader 单体（3602） | `/ticker`(新)、`/bars`、`/symbols/search`(新)、`/snapshots`、`/symbol/resolve` | 待切换（DS-7/8/9/10/11 落地后） |
| knowledge-injector / lightrag-service | LightRAG 注入/查询 | 独立链路，不受本需求影响 |

---

## 6. 优先级与依赖

```
DS-7 /ticker        → 单体行情切换前置（无 ticker 则持仓现价/告警不可用）
DS-8 /bars 覆盖     → 3 个微服务已依赖；当前仅 4h 数据 = 功能不可用，最高优先
DS-9 /symbols/search→ 单体符号搜索前置
DS-10 /snapshots 补齐→ 仪表盘板块，可与 DS-7/8/9 并行
DS-11 resolve 覆盖  → 需 B 端确认（决策点）
DS-12 鉴权          → 与 AItrader 侧 WS-A 鉴权加固联动，建议同批上线
```

---

## 7. 验收标准（B 端上线后 AItrader 侧验证）

1. `/ticker`：BTC/USDT（spot+swap）、任一美股、任一外汇标的返回非 0 `price`，字段齐全。
2. `/bars`：BTC/USDT `1m` 最近 30 天连续无缺口；`1D` 最近 3 年；ETH/SOL 同；任一美股 `1D` ≥ 1 年；`BTC/USDT:USDT`（或 `market_type=swap`）可查。
3. `/symbols/search?keyword=btc` 返回 ≥ 10 个 USDT 交易对（含 spot 与 swap），全部 `active=true`。
4. `/snapshots?type=commodities|forex_pairs|market_overview` 均返回非空数据。
5. 全部端点（除 `/health`）带 `X-Service-Key`：无 key → 401，有 key → 200。
6. AItrader 单体删除本地 `data_sources/`、`data_providers/` 后，kline/持仓现价/告警/符号搜索/仪表盘全流程可用。
