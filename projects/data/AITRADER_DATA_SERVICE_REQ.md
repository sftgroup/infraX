# B 端 data-service 需求文档（完整版 · AItrader 侧提交）

> 提交方：AItrader 项目 ｜ 日期：2026-08-04
> 背景：AItrader 微服务化后，data-service 已并入 B 端项目统一维护（生产 `http://43.159.60.46:8765`）。AItrader 单体 + 3 个本地微服务（backtest/trading/analysis）将**全部收敛为通过 HTTP 调用 B 端 data-service**，删除本地数据层。
> 本文档为**完整需求**：已实现能力（DS-1~DS-6，作为契约确认）+ 待补缺口（DS-7~DS-14）。状态标记：✅ 已实现 ｜ 🔲 待补 ｜ ⚠️ 部分实现/待确认。

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
| DS-8 | `/bars` 数据覆盖保证 + spot/swap 区分 | ✅ 已实现（da2cd34，2026-08-05 已部署） | **P0** |
| DS-9 | 符号搜索 `/symbols/search` | 🔲 待补 | **P0** |
| DS-10 | `/snapshots` 类型补齐（commodities/forex_pairs/market_overview） | 🔲 待补 | P1 |
| DS-11 | `/symbol/resolve` 多市场覆盖确认 | 🔲 待 B 端确认 | P1 |
| DS-12 | 入站鉴权 `X-Service-Key` | 🔲 待补（与 AItrader 侧联动） | P1 |
| DS-13 | ML 因子并入标准因子面（catalog/current/history） | 🔲 待补 | P1 |
| DS-14 | 官方 Python SDK（封装全部端点） | 🔲 待补（建议与 DS-12 同批） | P1 |

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

## 3. 待补需求（DS-7 ~ DS-14）

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

### DS-13 ML 因子并入标准因子面 🔲 P1

**背景事实（2026-08-06 代码核实）**：
- B 端已有独立 **ml-service** 推理并落库：LightGBM 方向预测（`/ml/tree_predictions` → `raw_snapshots` 的 `tree_predictions`）、FinBERT 新闻情绪（`/ml/sentiment`）、bolt/moirai/timesfm 时序预测（`ml_predictions` 明细表，`/ml/predictions` 可查）、跨模型共识（`/ml/consensus`）。
- **但当前 `/factors/catalog`（内置 18 因子：技术 11 + 宏观 3 + 情绪 2 + onchain 2）、`/factors/current`、`/factors/history` 均不包含任何 ML 因子**——它们只走独立 `/ml/*` 端点，`_SIMPLE_FACTOR_IDS` / `_NON_TECH_FACTORS` 均不含。
- AItrader 侧（单体 + backtest/trading/analysis 微服务）**当前无任何代码消费 `/ml/*`**，即 LightGBM/FinBERT/bolt/moirai/timesfm 预测因子目前**无法用于回测、AI 分析、实盘交易**。

**必要性**：AItrader 的策略回测、AI 快速分析、实盘信号评估都从统一因子面（`/factors/catalog` + `/factors/current` + `/factors/history`）取因子。ML 因子（随机森林/LightGBM 方向预测、FinBERT 情绪、时序预测、共识）若并入标准面，各消费方**零改动**即可在策略代码里直接引用（如 `bar.tree_prob_up`、`bar.finbert_sentiment`）。

**要求**：

```
GET /factors/catalog  → 追加 ML 类别因子（category="ml"，与 technical/macro/sentiment/onchain 并列）：
  tree_direction      （LightGBM 方向：up/down/flat）
  tree_prob_up        （LightGBM 上涨概率 0~1）
  tree_uncertainty    （预测不确定性，可选）
  finbert_sentiment   （FinBERT 新闻情绪，-1~1）
  bolt_forecast       （bolt 时序预测值，可选）
  moirai_forecast     （moirai 时序预测值，可选）
  timesfm_forecast    （timesfm 时序预测值，可选）
  consensus_score     （跨模型共识，可选）
  （factor id / 语义以 B 端 ml-service 实际产出为准，AItrader 侧按 id 消费）

GET /factors/current
  → ML 因子按 symbol 返回（ml_predictions 按 symbol 存储，与 fear_greed 同型广播）

GET /factors/history
  → ML 因子历史序列并入（与现有宏观/情绪因子一致，按最近时间戳 asof 对齐，无未来函数）
```

**要点**：
- ML 因子按 **symbol** 粒度返回（区别于 vix/dxy 等全局因子）；方向/概率类因子建议统一数值化（`tree_direction` 可用 1/0/-1 或字符串，二选一并写入 catalog `type`）。
- `/factors/history` 的 asof 对齐逻辑沿用现有 `_NON_TECH_FACTORS` 模式（fetched_at ≤ bar ts 最近值），保证回测无未来函数。
- **前置条件确认**：请 B 端确认生产已配置 `ML_SERVICE_URL` 且 ml-service 在产数（未配置时 TreeMl/FinBERT/P2Ml collector 空转，无任何数据）。
- 落地顺序建议：先并 `/factors/catalog` + `/factors/current`（实盘/AI 分析立即可用），再并 `/factors/history`（回测可用）。

---

### DS-14 官方 Python SDK（封装全部端点） 🔲 P1

**必要性**：AItrader 侧目前存在 **4 份 `data_client.py`（单体/backtest/trading/analysis）+ 1 份 `factor_client.py`（trading）**，各自重复实现 B 端 HTTP 契约——鉴权头、TLS `verify`、超时、秒↔毫秒换算各写各的，且口径不一致：trading/analysis **缺 `X-Service-Key` 与 `verify=False`**，B 端启用鉴权（DS-12）或证书切换后，因子链与 AI 分析链将 401/TLS 报错。收敛决策（AItrader 侧 D7）：**若 B 端提供官方 SDK，则 4 份客户端全部替换为 SDK，不建内部共享包**（避免重复造轮子）；B 端 SDK 未就绪前，AItrader 侧先做最小对齐止血（补鉴权头 + verify + 配置统一，2026-08-06 已规划）。

**要求**：B 端提供官方 Python SDK（pip 包，SemVer 版本管理），一个客户端类收编以下全部端点：

```
Client(base_url, api_key)   # 单构造：base_url + X-Service-Key 内置

  /bars                     → OHLCV + 因子列（支持 market_type=spot|swap、start/end 毫秒、limit）
  /factors/catalog          → 因子目录
  /factors/current          → 最新因子（symbols + category，含 DS-13 ML 因子）
  /factors/history          → 逐 bar 因子历史（symbol/timeframe/ids/start/end/limit）
  /snapshots                → 板块快照（type 参数）
  /ticker                   → 实时报价（symbol + market_type + market）
  /symbol/resolve           → 符号解析
  /symbols/search           → 符号搜索（keyword/market/limit）
  /policy/broker-market     → 券商市场策略
  /stats /health            → 统计/健康
```

**SDK 核心能力（对应 AItrader 5 份客户端的痛点）**：
- **鉴权内置**：自动带 `X-Service-Key`（DS-12），调用方零配置
- **TLS 可配置**：`verify` 参数（应对当前 B 端证书不可信现状，或 B 端提供正确 CA）
- **限流配套**：429 识别 + 重试/退避（与 B 端限流机制配合）
- **fail-silent 语义**：与现有客户端一致——B 端不可用返回空/None 不抛错，业务不中断
- **时间单位归一化**：秒↔毫秒转换内置（当前单体/backtest 各自换算）
- **类型注解**：方法与返回类型标注，便于 IDE 与静态检查

**交付建议**：
- 发布到私有 pip 源或 git 引用；文档含 README + 各端点示例。
- 依赖 B 端 API 稳定后交付：建议与 **DS-12（鉴权上线）同批**；当前限流/数据覆盖（DS-7/8/9）未解决前 SDK 意义有限。
- 契约变更走 SemVer 版本升级，AItrader 侧升级 SDK 即可，无需改业务代码。

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
DS-13 ML 因子并入   → 增强项（依赖 ml-service 产数确认）；先 catalog+current 后 history
DS-14 官方 SDK      → 建议与 DS-12 同批（API 稳定后交付）；SDK 未就绪前 AItrader 侧先最小对齐止血
```

---

## 7. 验收标准（B 端上线后 AItrader 侧验证）

1. `/ticker`：BTC/USDT（spot+swap）、任一美股、任一外汇标的返回非 0 `price`，字段齐全。
2. `/bars`：BTC/USDT `1m` 最近 30 天连续无缺口；`1D` 最近 3 年；ETH/SOL 同；任一美股 `1D` ≥ 1 年；`BTC/USDT:USDT`（或 `market_type=swap`）可查。
3. `/symbols/search?keyword=btc` 返回 ≥ 10 个 USDT 交易对（含 spot 与 swap），全部 `active=true`。
4. `/snapshots?type=commodities|forex_pairs|market_overview` 均返回非空数据。
5. 全部端点（除 `/health`）带 `X-Service-Key`：无 key → 401，有 key → 200。
6. AItrader 单体删除本地 `data_sources/`、`data_providers/` 后，kline/持仓现价/告警/符号搜索/仪表盘全流程可用。
7. `/factors/catalog` 含 ML 类别因子（`tree_direction`/`tree_prob_up`/`finbert_sentiment` 等，以 B 端产出为准）；`/factors/current` 对 BTC 返回 ML 因子非空；`/factors/history` 返回的 ML 因子历史与 bar asof 对齐（回测引用时无未来函数）。
8. 官方 SDK（DS-14）：pip 可安装，单构造 `Client(base_url, api_key)` 调通全部端点（含鉴权/verify/429 重试）；AItrader 侧 4 份 `data_client` + `factor_client` HTTP 层替换为 SDK 后功能回归一致。
