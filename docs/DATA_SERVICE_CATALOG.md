# InfraX 数据服务数据目录（DATA SERVICE CATALOG）

> 本文档明确列出**数据服务可获取的数据和类型**，含行情、因子、ML 预测与 **graph 图谱数据**。
> 契约见 `projects/data/AITRADER_DATA_SERVICE_REQ.md`（DS-1 ~ DS-12）。
> 数据覆盖为 2026-08-06 生产库抽查（`43.163.105.172`）。
> 整体数据流向与端口链路关系见 [DATA_FLOW_ARCHITECTURE.md](DATA_FLOW_ARCHITECTURE.md)。

## 1. 服务组成与接入

数据域由四个服务组成：

| 服务 | systemd 单元 | 端口 | 域名前缀 | 功能 |
|---|---|---|---|---|
| 数据服务 | `infrax-data` | 9112 | `/api/data/*`、`/api/v1/*` | K 线 / 实时报价 / 因子 / ML 预测 / 符号 |
| 数据采集器（DEX/链上） | `infrax-dc` | 9102 | `/api/v2/data/*`（nginx 已配置 2026-08-07；公网走 IP 直连见下注） | 链上 DEX 数据：tokens / OHLCV / 行情 / 交易 / 排行榜 |
| 知识图谱注入器 | `infrax-knowledge-injector` | 9113 | `/api/injector/*` | 把外部数据批量注入 LightRAG 图谱 |
| 图谱查询服务 | `infrax-ragservicer` | 9721 | `/api/rag/*` | LightRAG 知识图谱检索 / RAG 问答 / 图谱数据 |

> **`infrax-data`（:9112）与 `infrax-dc`（:9102）是两个独立服务，职责不同，勿混淆：**
> - **data**：传统行情 + 因子（crypto/美股/港股/A股/外汇/期货，见 §2），因子 catalog 所在服务；
> - **dc**：链上 DEX 数据采集（base 链等，`/api/v2/data/tokens|market/*`），是 data 的**数据源之一**，当前仅内网消费（knowledge-injector 经 `inject_parsed("infrax_dc")` 拉取）。
> - **SDK 接入**：`infrax.data.*` → data（`dataUrl` 可配，默认回退 `baseUrl`）；`infrax.dc.*`、`infrax.market.*` → dc（走 `baseUrl`，nginx 已配 `/api/v2/data/*` 路由）。
> - **公网访问（2026-08-07 实测）**：域名 `infrax.0xainet.top` 经 Cloudflare 回源 `/api/*` 仍 502（面板回源配置问题，见 infrax_tasklist §2.1）；**公网 IP 直连可用**——`https://43.163.105.172/api/v2/data/*`（dc，header `x-dc-api-key` = 租户 `tenants.dc_api_key`）、`https://43.163.105.172/api/data/*`（data，`DATA_API_KEY` 或签发 `dx_*` key）。无需 Host 头，nginx 已按 default_server 路由。B 端临时接入可将 SDK `baseUrl` 配为 `https://43.163.105.172`。

**接入约定**（对齐平台统一契约 `projects/shared/app_auth.py`）：
- 业务端点鉴权：`Authorization: Bearer` 或 `X-API-Key` 或 `X-Service-Key`（任一带 `DATA_API_KEY` 或签发的 `dx_*` 多租户 key）；401 统一 `{"code":401,"message":"unauthorized","data":null}`
- 公开免 key：`/health`、`/metrics`、`/docs`、`/redoc`、`/openapi.json`
- 可选信封：请求带 `?envelope=1` 或 `X-Envelope: 1` → 响应包装为 `{code, message, data}`
- 时间戳：**一律毫秒 UTC（unix ms）**

---

## 2. 行情数据（infrax-data）

### 2.1 K 线 /bars（DS-1 / DS-8）

`GET /api/data/bars?symbol=BTC/USDT&timeframe=1D&market_type=spot|swap&start=&end=&limit=`

**返回字段**（每根 bar）：

| 分组 | 字段 |
|---|---|
| OHLCV | `ts`, `open`, `high`, `low`, `close`, `volume` |
| 技术指标（自动计算） | `rsi_14`, `macd`, `macd_signal`, `macd_hist`, `bb_upper`, `bb_middle`, `bb_lower`, `atr_14`, `ma_5`, `ma_10`, `ma_20` |
| 外部因子（按最近时间 join） | catalog 中声明的因子：`fear_greed`, `vix`, `dxy`, `us10y`, `btc_difficulty`, `sentiment_score` 等 |

**timeframe 与覆盖达标**（生产实测 2026-08-06）：

| timeframe | 存储键 | 根数 | 覆盖区间 | 达标要求 | 状态 |
|---|---|---|---|---|---|
| 1m | `1m` | 310,313 | 2026-07-06 ~ 08-06（31d） | ≥30d | ✅ |
| 5m | `5m` | 364,444 | 2026-02-06 ~ 08-06（6m） | ≥180d | ✅ |
| 15m | `15m` | 121,480 | 2026-02-06 ~ 08-06（6m） | ≥180d | ✅ |
| 30m | `30m` | 60,741 | 2026-02-06 ~ 08-06（6m） | ≥180d | ✅ |
| 1h | `1h` | 60,164 | 2025-08-05 ~ 08-06（1y） | ≥1y | ✅ |
| 4h | `4h` | 15,320 | 2025-08-05 ~ 08-06（1y） | ≥1y | ✅ |
| 1D | `1d` | 24,889 | 2023-08-07 ~ 08-06（3y） | ≥3y | ✅ |

> `timeframe` 大小写不敏感（`1D`/`4H` 均命中存储键 `1d`/`4h`）。
>
> **分页拉取（重要）**：`/bars` 单次 `limit` 上限 **5000 根**（`le=5000`）。30 天 1m 约 4.5 万根/符号，需按 `start`/`end` 分页循环拉取：
> 1. 首次 `start=0&limit=5000` → 取最旧 5000 根，记返回最大 `ts`
> 2. 再次 `start=<上次最大 ts>+1ms&limit=5000` → 直到返回不足 5000 根
> 3. 样例：`/api/data/bars?symbol=BTC/USDT&timeframe=1m&start=0&limit=5000` → 下一页 `&start=1751001600001`
>
> **1m 数据量说明**：上表 310,313 为**全部符号 1m 总和**；单符号 BTC spot 1m 约 4.5 万根（31 天连续），文档早期「1m=31 万根」为误读（31 万是汇总值）。

**市场覆盖**（`market_type` 自动判定：符号含 `:quote` → swap，否则 spot）：

| 市场 | 符号形式 | 覆盖对象 |
|---|---|---|
| crypto spot | `BTC/USDT` | BTC/ETH/SOL/XRP/BNB/DOGE 等（binance spot，quote=USDT 全量） |
| crypto swap | `BTC/USDT:USDT` | 同上（binance usdm，quote=USDT） |
| 美股 | `SPY` `AAPL` | multi_kline.us_stocks：AAPL/MSFT/GOOGL/AMZN/NVDA/META/TSLA/JPM/V/XOM/INTC/SPY/QQQ（1d） |
| 外汇 | `EURUSD=X` | multi_kline.forex：EURUSD/GBPUSD/USDJPY/AUDUSD/USDCAD/USDCHF（1d） |
| 期货 | `GC=F` `CL=F` | multi_kline.futures：GC/SI/CL/NG/HG/ES/NQ/YM 等（1d） |
| A 股 | `600519` `000333` | multi_kline.cn_stocks（腾讯日线，1d） |
| 港股 | `00700` | multi_kline.hk_stocks（腾讯日线，1d） |

**历史数据回填策略（2026-08-07 定）**：

| 资产类别 | 策略 | 现状 |
|---|---|---|
| 加密资产（crypto） | 交易所公开 API 免费，**用 ccxt 持续回填足够历史**（spot + swap，自动补缺口 `_backfill_gap`） | ✅ 已达标：1m≥30d / 5m·15m·30m≥180d / 1h·4h≥365d / 1d≥1095d（`KL_BACKFILL_DAYS` 可调） |
| 传统资产（股票/期货/期权/外汇） | 数据源易受限（Yahoo 429 / Twelve Data 免费限流），**维持现状正常采集、尽量获取历史**：1d 走免限流的免费源（akshare 新浪/东财、腾讯日线），分钟级 yfinance/ Twelve Data 可用即采、受限则跳过记 failed | ⚠️ 1d 已达标（fetch_bars=400≈1.5y）；**分钟级基本未采**（美股 1h 仅 3 根，受 Yahoo 限流），待 B 端提供 Twelve Data 付费 tier / Alpha Vantage 配额后扩展 |

> 加密资产与 DEX 数据为产品范围重点（DS-8 收敛后）；传统资产回填以**免费源能稳定获取为准**，不追受限源的深度。

### 2.2 实时报价 /ticker（DS-7）

`GET /api/data/ticker?symbol=&market_type=&exchange_id=&market=`

**返回字段**：`symbol`, `price`, `change`, `changePercent`, `high`, `low`, `open`, `previousClose`, `ts`, `market_type`（回显 spot/swap，C2 切换依赖）

**数据源回退链**（fail-silent，短 TTL 内存缓存默认 10s，`TICKER_CACHE_TTL_SEC` 可调）：

| 市场 | 实时源 | 备用 |
|---|---|---|
| crypto | ccxt binance（spot/swap） | kline 1d 兜底 |
| 美股 | yfinance fast_info | 腾讯美股实时（qt.gtimg.cn，免费）→ kline 兜底 |
| 外汇 | yfinance（`EURUSD=X`） | Twelve Data（免费 8 次/min）→ kline 兜底 |
| 期货 | yfinance（`GC=F`） | kline 兜底 |
| A 股 / 港股 | 腾讯实时（sh/sz/hk 前缀） | kline 兜底 |

---

## 3. 因子与快照数据（infrax-data）

### 3.1 因子端点（DS-2）

| 端点 | 返回 |
|---|---|
| `/factors/catalog` | 因子目录（**28 个**：18 内置 + 10 ML；七字段结构见下） |
| `/factors/current?symbols=&category=` | 最新因子值（category：external/sentiment/news/opportunities/heatmap/calendar/snapshot） |
| `/factors/history?symbol=&timeframe=&ids=` | 逐 bar 因子时序（对齐 /bars ts，回测用） |

**catalog 条目统一结构**（内置 / ML / extra 三来源一致）：

```json
{
  "id": "us10y", "name": "US 10Y Yield",
  "category": "macro", "type": "float", "range": [0, 10],
  "description": "美国 10 年期国债收益率", "unit": "%"
}
```

| 字段 | 说明 |
|---|---|
| `id` / `name` | 因子标识 / 显示名 |
| `category` | `technical` \| `macro` \| `sentiment` \| `onchain` \| `ml` \| `external` |
| `type` | `float` \| `int` |
| `range` | 合理值域（`null` 表示无限制；`[0, 100]` 为含边界闭区间） |
| `description` | 中文语义描述（新增 2026-08-07，下游展示用） |
| `unit` | 单位：`%`（us10y）、`T`（btc_difficulty）、`EH/s`（btc_hashrate）；价格/概率/方向/指数类为 `null`（新增 2026-08-07） |

**因子清单（28 个）**：

- **technical（11）**：`rsi_14`、`macd`、`macd_signal`、`macd_hist`、`bb_upper`、`bb_middle`、`bb_lower`、`atr_14`、`ma_5`、`ma_10`、`ma_20`（kline_store 自动计算，与 bar 同源）
- **macro（3）**：`vix`、`dxy`、`us10y`（unit=`%`）
- **sentiment（2）**：`fear_greed`（int 0-100）、`sentiment_score`（float -1~1）
- **onchain（2）**：`btc_difficulty`（unit=`T`）、`btc_hashrate`（unit=`EH/s`）
- **ml（10，DS-13，来源 ml-service）**：`tree_direction` / `tree_prob_up`（LightGBM）、`finbert_sentiment`（FinBERT）、`consensus_score`、`bolt_direction` / `bolt_prob_up`、`moirai_direction` / `moirai_prob_up`、`timesfm_direction` / `timesfm_prob_up`（direction 数值化：up=1 / flat=0 / down=-1）

> **宏观因子数据源与显示名（2026-08-08 更新）**：macro 因子 `vix`/`dxy`/`us10y` 由 FRED 系列 **`VIXCLS` / `DTWEXBGS` / `DGS10`** 供给（`data_config.json` 的 `macro.fred_series` 可扩展，映射见 `app/factors.py` `_MACRO_SERIES_NAMES`）；`fear_greed` 显示名映射为 **"Fear & Greed"**（`_MACRO_DISPLAY_EXTRA`，替代 alternative.me 默认显示）。`/factors/history` 不传 `limit` 时默认返回最近 **500** 根（上限 5000）。

> **✅ ML 因子历史已回填（2026-08-08 全部完成）**：ml-service 对已上线 30 符号按历史 1d bars 回放推理并落库——`ml_predictions` 现 **14524 行**（bolt **5126** / moirai **4294** / timesfm **5104**，三模型时间范围均 **2024-09-09 → 2026-08-07**），`tree_predictions` 快照 **1781** 行（**2023-10-06 → 2026-08-07**，LightGBM stale-model 逐日回放聚合）。回测含 ML 因子时早期区间不再为空（2024-09-09 起有 bolt/moirai/timesfm，2023-10-06 起有 tree；timesfm 于停服窗口回填，实测 36min，详见 infrax_tasklist DS-15）。

**灵活扩展（不改代码热扩展）**：`FACTORS_CONFIG_PATH=factors.json` 已启用，向 `factors.json` 的 `extra` 数组追加条目即可（字段规则与上表一致，`category` 默认 `external`、`type` 默认 `float`、`range`/`unit` 默认 `null`、`description` 默认空串），重启后自动进入 catalog。当前 extra 为空。

### 3.2 复杂快照 /snapshots（DS-3 / DS-10）

`GET /api/data/snapshots?type=` —— raw_snapshots 最新结构（heatmap/calendar 等返回原始结构）。

### 3.3 全部数据类型清单（raw_snapshots 27 类，生产实证 2026-08-06）

| provider | data_type | 内容 | 近次落库 |
|---|---|---|---|
| `market` | `crypto_prices` | CoinGecko 现货价格 | 实时 |
| `market` | `indices` | 全球股指 | 实时 |
| `market` | `heatmap` | crypto 板块热度图 | 实时 |
| `macro` | `vix` / `dxy` / `us10y` | 波动率 / 美元指数 / 美债 10Y | 实时 |
| `macro` | `us_indicators` | FRED 宏观指标（CPI/GDP 等） | 实时 |
| `sentiment` | `fear_greed` | 恐惧贪婪指数 | 实时 |
| `sentiment` | `sentiment_score` / `put_call_ratio` / `yield_curve` | 新闻情绪 / 认沽认购比 / 收益率曲线 | 实时 |
| `sentiment` | `adanos_sentiment` | Adanos 舆情 | 实时 |
| `news` | `news` | 新闻（→ finbert_sentiment 输入） | 分钟级 |
| `fundamental` | `earnings` | 财报日历 | 实时 |
| `calendar` | `calendar` | 经济事件日历 | 实时 |
| `defi` | `tvl` | DeFi 总锁仓量（分链） | 实时 |
| `volatility` | `volatility` | VXN/GVZ 波动率指数 | 实时 |
| `onchain` | `btc_difficulty` / `btc_transfers` / `whale_balances` | BTC 挖矿难度 / 巨鲸转账 / 巨鲸余额（新增 2026-08-07） | 实时 |
| `collector_onchain` | `onchain_checkpoints` | 链上检查点聚合 | 实时 |
| `global_market` | `commodities` / `forex_pairs` / `market_overview` | 商品 / 外汇对 / 多市场概览 | 30min |
| `okx_chainos` | `okx_hot_tokens` / `okx_index_prices` | OKX ChainOS 热点代币 / 链指数 | 实时 |
| `ml` | `tree_predictions` / `consensus` | LightGBM 方向预测 / 多模型共识 | 日更 |
| `opportunities` | `opportunities` | 交易机会信号 | 实时 |

---

## 4. ML 预测数据（infrax-data + ml-service）

| 端点 | 内容 |
|---|---|
| `/api/data/ml/predictions?model=bolt\|moirai\|timesfm&symbol=` | P2 单模型预测明细（**data 侧采集快照**）：`{generated_at, direction, prob_up, uncertainty, point_forecast, quantiles}` |
| `/api/data/factors/current?category=ml` | 上述预测 + tree/consensus 落库为 ML 因子（`tree_direction`、`consensus_score` 等） |

采集器生成的预测快照（见上表 `ml/*`）供 AI 策略使用。

### 4.1 ml-service 直连端点（:9120，实时推理）

| 端点 | 模型 | 内容 |
|---|---|---|
| `/ml/tree_predictions` | LightGBM | 方向预测（全 symbol） |
| `/ml/volatility` | Kronos | 波动率预测 |
| `/ml/bolt` `/ml/moirai` `/ml/timesfm` | Chronos-Bolt / Moirai 2.0 / TimesFM 2.5 | P2 概率预测 |
| `/ml/consensus` | 多模型聚合 | 跨模型信号共识 |
| `/ml/sentiment` | FinBERT | 新闻文本情绪（POST） |
| `/ml/macro_features` | FRED 派生 | 宏观环境特征 |
| `/ml/cache/stats` | — | 缓存统计（免鉴权） |

**异步 + 预热机制（2026-08 性能改造）**：直连端点结果走 TTL 缓存（`ML_CACHE_TTL_SEC` 默认 1800s）；缓存 miss 时**立即返回 `data=null`**，推理在后台线程完成；预热线程（`ML_PREWARM_*` 默认开）周期刷新缓存。volatility/bolt/moirai/timesfm 响应已统一为 **dict + 聚合指标**（`{generated_at, n_symbols, model, avg_<score_key>, symbols[]}`，`symbols[]` 内单 symbol 字段不变）。生产符号池以 `P2_TARGET_SYMBOLS` 显式配置 30 个目标符号（覆盖 data-service 动态 46 符号池）。完整说明见 `docs/SERVICE_API_REFERENCE.md §3`。

---

## 5. 符号与市场元数据（infrax-data）

| 端点 | 返回 |
|---|---|
| `/symbols?timeframe=&min_bars=` | 指定 timeframe 内 bar 数 ≥ min_bars 的符号清单（ml-service 训练用） |
| `/symbols/search?keyword=&market=` | 模糊搜索（crypto/usstock/forex/futures/cnstock/hkstock），返回 `{symbol, market, market_type, exchange, active}` |
| `/symbol/resolve?symbol=&market=` | 单符号→标准交易对（DS-4/11）：`BTC→BTCUSDT`、`EUR/USD→EURUSD=X` |
| `/policy/broker-market` | 券商市场策略（DS-5）：crypto 交易所清单，default=Binance |

---

## 6. Graph 图谱数据（ragservicer + knowledge-injector）

### 6.1 图谱是什么

基于 **LightRAG** 的知识图谱：注入的文档经 LLM 抽取**实体（entities）与关系（relations）**构建图结构，同时建向量索引。支持多租户（tenant）× 多命名空间（namespace）隔离。

- 写入：**knowledge-injector**（9113）把外部数据源/文档批量转成 LightRAG 注入
- 存储与检索：**ragservicer**（9721）持有图谱实例（LightRAG 存储落盘 `projects/ragservicer/data/`，已在 .gitignore）

### 6.2 图谱查询端点（ragservicer，前缀 `/api/rag/v1/`）

| 端点 | 说明 |
|---|---|
| `POST /api/rag/v1/namespaces/{ns}/query` | 图谱混合检索，返回 **entities + relations + chunks**（不生成 LLM 答案，供调用方自接 LLM） |
| `POST /api/rag/v1/namespaces/{ns}/retrieve` | 纯检索（`top_k` 可调），只回上下文 |
| `POST /api/rag/v1/namespaces/{ns}/documents` | 注入单篇文档 → 自动抽实体关系建图 + 向量化 |
| `POST /api/rag/v1/namespaces/{ns}/documents/batch` | 批量注入 |
| `GET /api/rag/v1/namespaces/{ns}/documents` / `DELETE .../{doc_id}` | 文档列表 / 删除 |
| `GET /api/rag/v1/namespaces/{ns}/tasks/{task_id}` | 注入任务状态（读写分离异步队列） |
| `GET /api/rag/v1/tenants`、`POST /api/rag/v1/tenants`、`.../{id}/keys` | 租户与 key 管理（admin） |
| `GET /api/rag/v1/instances`、`/api/rag/v1/admin/config`、`/admin/tasks` | 实例 / 热配置 / 任务（admin） |

**查询 mode**（LightRAG QueryParam，`/query` 与 `/retrieve` 共用）：

| mode | 语义 |
|---|---|
| `local` | 图谱局部检索（实体邻居扩展） |
| `global` | 图谱全局社区检索 |
| `hybrid` | local + global 融合 |
| `nl` | 自然语言图谱检索 |
| `mix`（默认） | vector + graph + keyword 混合 |
| `naive` | 纯向量 / 关键词 |

### 6.3 图谱注入端点（knowledge-injector，9113）

| 端点 | 说明 |
|---|---|
| `POST /inject/{source}` | 按数据源注入图谱 |
| `POST /inject/all` | 全量注入 |
| `POST /inject/parsed` | 注入已解析文档 |
| `POST /query` | 图谱查询 |
| `GET /status` / `/injectors` / `/stats` / `/stats/recent` | 注入器状态 / 统计 |
| `GET|PUT /admin/config` | key 热配置（admin） |

### 6.4 MCP 接入

ragservicer 内置 **MCP Server**（STDIO），图谱检索工具经 MCP 协议暴露给智能体（`mcp_server/tools.py`、`mcp_server/server.py`）。

---

## 7. 数据源总览

| 域 | 数据源 |
|---|---|
| crypto | ccxt（binance spot/usdm；okx/bybit 备用）、CoinGecko（价格）、OKX ChainOS |
| 美股 | yfinance、腾讯美股（qt.gtimg.cn）、akshare 日线、Finnhub/Twelve Data（符号 lookup） |
| 外汇 | Twelve Data、yfinance（`EURUSD=X`） |
| 期货 | yfinance（`* =F`）、akshare |
| A 股 / 港股 | 腾讯日线（sh/sz/hk）、AkShare 基本面 |
| 宏观 | FRED（vix/dxy/us10y/us_indicators）、恐惧贪婪 API |
| 舆情 | NEWSAPI / Adanos / FinBERT 情绪 |
| 链上 | BTC 难度/转账（公共链上数据源）、OKX ChainOS |
| 图谱 | LightRAG（实体-关系图 + 向量 + 关键词三路检索） |

---

## 8. 附：管理端点

| 端点 | 说明 |
|---|---|
| `/admin/config` GET/PUT | 数据源 API key 热配置（掩码回显） |
| `/admin/status` | 采集器运行状态 + 熔断器 + 数据新鲜度 + key 概览 |
| `/admin/symbols` PUT | 交易对热管理（add/remove/set，无需重启） |
| `/admin/api-keys` CRUD + `/rotate` | 多租户 key 签发 / 轮换 / 删除（仅存哈希） |
| `/api-keys/verify` | 校验外部服务 key（scope=mcp/payment/vault/mpc） |
| `/stats` `/health` `/metrics` | 库统计 / 健康 / Prometheus |
