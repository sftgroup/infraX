# InfraX 数据服务数据目录（DATA SERVICE CATALOG）

> 本文档明确列出**数据服务可获取的数据和类型**，含行情、因子、ML 预测与 **graph 图谱数据**。
> 契约见 `projects/data/AITRADER_DATA_SERVICE_REQ.md`（DS-1 ~ DS-12）。
> 数据覆盖为 2026-08-14 生产库抽查（`43.163.105.172`，46 符号全覆盖；快照 40 类）。
> 整体数据流向与端口链路关系见 [DATA_FLOW_ARCHITECTURE.md](DATA_FLOW_ARCHITECTURE.md)。

## 1. 服务组成与接入

数据域由四个服务组成：

| 服务 | systemd 单元 | 端口 | 域名前缀 | 功能 |
|---|---|---|---|---|
| 数据服务 | `infrax-data` | 9112 | `/api/data/*`、`/api/v1/*` | K 线 / 实时报价 / 因子 / ML 预测 / 符号 |
| 数据采集器（DEX/链上） | `infrax-dc` | 9102 | `/api/v2/data/*`（nginx 已配置 2026-08-07；公网走 IP 直连见下注） | 链上 DEX 数据：tokens / OHLCV / 行情 / 交易 / 排行榜 |
| 知识图谱注入器 | `infrax-knowledge-injector` | 9113 | `/api/injector/*` | 把外部数据批量注入 LightRAG 图谱 |
| 图谱查询服务 | `infrax-ragservicer` | 9721 | `/api/rag/*` | LightRAG 知识图谱检索 / RAG 问答 / 图谱数据 |
| 因子工厂 MCP（R5-3） | `infrax-factor-mcp` | 3014 | MCP（stdio/HTTP） | 因子挖掘任务编排：`factor_factory_start/status/result/list/cancel` 5 工具，出站 `X-Service-Key` → ml-service :9120 |

> **`infrax-data`（:9112）与 `infrax-dc`（:9102）是两个独立服务，职责不同，勿混淆：**
> - **data**：传统行情 + 因子（crypto/美股/港股/A股/外汇/期货，见 §2），因子 catalog 所在服务；
> - **dc**：链上 DEX 数据采集（base 链等，`/api/v2/data/tokens|market/*`），是 data 的**数据源之一**，当前仅内网消费（knowledge-injector 经 `inject_parsed("infrax_dc")` 拉取）。
> - **SDK 接入**：`infrax.data.*` → data（`dataUrl` 可配，默认回退 `baseUrl`）；`infrax.dc.*`、`infrax.market.*` → dc（走 `baseUrl`，nginx 已配 `/api/v2/data/*` 路由）。
> - **公网访问（2026-08-19 实测）**：统一域名 `https://infrax.0xainet.top`，全前缀可用——`/api/data/*`（data，`DATA_API_KEY` 或签发 `dx_*` key）、`/api/v2/data/*`（dc，header `x-dc-api-key` = 租户 `tenants.dc_api_key`）。无需 Host 头/IP 直连。

> **旧栈 collector（`infrax-collector` :9101）**：链上区块扫描 + 行情代理（OKX ChainOS 等）。**行情端点按量计费**（MQ-16 T-2，`marketQuotaEnforce` 中间件）：`market_free` 10000 次/月、`market_pro` 100000 次/月（49/月，payments 链上订阅）。**配额耗尽 → 503 + `{used, quota, plan}` 响应体**，下游 fail-silent 会静默停摆（2026-08-14 实测 okx_hot_tokens 停摆 70h）。data 侧已按配额降频：`OKX_CHAINOS_COLLECT_INTERVAL_SEC=3600` 且仅 hot-tokens（index/candles 关闭），月用量 ≈2160 次。

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
| 外部因子（按最近时间 join） | catalog 中声明的因子：`fear_greed`, `vix`, `vxn`, `gvz`, `dxy`, `us10y`, `btc_difficulty`, `sentiment_score`, `put_call_ratio` 等（2026-08-19 补齐 external 8 字段） |

**timeframe 与覆盖达标**（生产实测 2026-08-08，46 符号）：

| timeframe | 存储键 | 根数 | 覆盖区间 | 达标要求 | 状态 |
|---|---|---|---|---|---|
| 1m | `1m` | 321,887 | 2026-07-06 ~ 08-07（33d） | ≥30d | ✅ |
| 5m | `5m` | 366,760 | 2026-02-06 ~ 08-07（6m） | ≥180d | ✅ |
| 15m | `15m` | 137,363 | 2026-01-30 ~ 08-07（6m+） | ≥180d | ✅ |
| 30m | `30m` | 61,125 | 2026-02-06 ~ 08-07（6m） | ≥180d | ✅ |
| 1h | `1h` | 83,632 | 2024-07-25 ~ 08-07（2y） | ≥1y | ✅ |
| 4h | `4h` | 36,746 | 2024-07-25 ~ 08-07（2y） | ≥1y | ✅ |
| 1D | `1d` | 26,133 | 2023-08-07 ~ 08-07（3y） | ≥3y | ✅ |

> `timeframe` 大小写不敏感（`1D`/`4H` 均命中存储键 `1d`/`4h`）。
>
> **分页拉取（重要）**：`/bars` 单次 `limit` 上限 **5000 根**（`le=5000`）。30 天 1m 约 4.5 万根/符号，需按 `start`/`end` 分页循环拉取：
> 1. 首次 `start=0&limit=5000` → 取最旧 5000 根，记返回最大 `ts`
> 2. 再次 `start=<上次最大 ts>+1ms&limit=5000` → 直到返回不足 5000 根
> 3. 样例：`/api/data/bars?symbol=BTC/USDT&timeframe=1m&start=0&limit=5000` → 下一页 `&start=1751001600001`
>
> **1m 数据量说明**：上表 321,887 为**全部符号 1m 总和**；单符号 BTC spot 1m 约 4.5 万根（33 天连续），文档早期「1m=31 万根」为误读（31 万是汇总值）。

**市场覆盖**（`market_type` 自动判定：符号含 `:quote` → swap，否则 spot）：

| 市场 | 符号形式 | 覆盖对象（2026-08-08 实测） |
|---|---|---|
| crypto spot | `BTC/USDT` | BTC/ETH/SOL/XRP（binance spot，quote=USDT 全量，1d 1097 根≈3y，swap 同步） |
| crypto swap | `BTC/USDT:USDT` | 同上（binance usdm，quote=USDT） |
| 美股 | `SPY` `AAPL` | multi_kline.us_stocks **13**：AAPL/MSFT/GOOGL/AMZN/NVDA/META/TSLA/JPM/V/XOM/INTC/SPY/QQQ（1d 402 根≈1.5y） |
| 外汇 | `EURUSD=X` | multi_kline.forex **7 对**：EURUSD/GBPUSD/USDJPY/AUDUSD/USDCAD/USDCHF/NZDUSD（1d 796-800 根≈1.5y） |
| 期货 | `GC=F` `CL=F` | multi_kline.futures **8**：GC/SI/CL/NG/HG/ES/NQ/YM（1d 402 根） |
| A 股 | `600519` `000333` | multi_kline.cn_stocks **6**：600519/000333/000858/002594/300750/601318（腾讯日线，1d 402 根） |
| 港股 | `00700` | multi_kline.hk_stocks **5**：00700/01810/09618/09988/09999（腾讯日线，1d 402 根） |

**历史数据回填策略（2026-08-14 更新）**：

| 资产类别 | 策略 | 现状（2026-08-14） |
|---|---|---|
| 加密资产（crypto） | 交易所公开 API 免费，**用 ccxt 持续回填足够历史**（spot + swap，自动补缺口 `_backfill_gap`） | ✅ 已达标：1m≥30d / 5m·15m·30m≥180d / 1h·4h≥730d / 1d≥1095d（`KL_BACKFILL_DAYS` 可调） |
| 美股 / 港股 | **moomoo 分钟级主源**（US LV3/HK LV1，1m/5m/15m/30m/1H+4H 聚合），1d 由 akshare 新浪/东财主源 + moomoo 兜底 | ✅ 1d 402 根（≈1.5y）；分钟级由 moomoo 提供（原 yfinance 429 重灾区已替代） |
| 外汇 | **yf_alt 替代层**：frankfurter（ECB 参考汇率，免 key 无配额）日线 + Twelve Data（分钟级） | ✅ 外汇 7 对 1d 796-800 根（≈1.5y）；分钟级 Twelve Data |
| 期货 / 商品 | 无免费源可替换（Twelve Data free 版期货 404），保留 yfinance + 失败降级 | ⚠️ 1d 402 根（≈1.5y）；yfinance 限流时按需查询降级为空 |
| A 股 | 腾讯日线（sh/sz 前缀）+ AkShare 基本面 | ✅ 1d 402 根 |

> 加密资产与 DEX 数据为产品范围重点（DS-8 收敛后）；传统资产回填以**免费源能稳定获取为准**，不追受限源的深度。**Yahoo Finance 对数据中心段限流（腾讯云 429，多 IP 方案证伪）**，已用 moomoo/frankfurter/CBOE/FRED/akshare 等替代高频路径，残余调用点（期货 K 线、指数）保留 yfinance + 降级。

### 2.2 实时报价 /ticker（DS-7）

`GET /api/data/ticker?symbol=&market_type=&exchange_id=&market=`

**返回字段**：`symbol`, `price`, `change`, `changePercent`, `high`, `low`, `open`, `previousClose`, `ts`, `market_type`（回显 spot/swap，C2 切换依赖）

**数据源回退链**（fail-silent，短 TTL 内存缓存默认 10s，`TICKER_CACHE_TTL_SEC` 可调；2026-08-14 更新）：

| 市场 | 实时源 | 备用 |
|---|---|---|
| crypto | ccxt binance（spot/swap） | kline 1d 兜底 |
| 美股 | **moomoo 实时快照**（`get_market_snapshot`，生产实测 `source=moomoo`） | 腾讯美股实时（qt.gtimg.cn，免费）→ kline 兜底 |
| 外汇 | **yf_alt**：frankfurter（ECB，免 key）→ Twelve Data | kline 兜底 |
| 期货 | yfinance（`GC=F`，限流下降级为 None） | kline 兜底 |
| A 股 / 港股 | 腾讯实时（sh/sz/hk 前缀） | kline 兜底 |

---

## 3. 因子与快照数据（infrax-data）

> **因子端口全景（B 端必读，2026-08-19）**：因子分散在多个端口，按用途取用，勿只认一个：

| 端口 | 内容 | 用途 |
|---|---|---|
| `/factors/catalog` | **固定因子目录 49 个**（31 内置/ML + 18 graph，静态清单） | 因子字段名 / 单位 / 取值范围查阅 |
| `/factors/current` | **最新因子值**（symbol 维度，category 过滤）；**顶层恒附** `ml_factory`（挖掘因子，与 category 无关）、`graph`（图谱因子，`?symbols=` 多币种时返回对应 gf_*，2026-08-19 实测 10 币全量）、`_complex`（news / put_call_ratio 等复合结构） | 实时展示 / 决策 |
| `/factors/history` | 逐 bar 因子时序（对齐 /bars ts） | 回测 |
| `/factors/graph` | 语义图谱因子（ragservicer 知识图谱 8 因子，data-service 统一透传） | 图谱联动 / 传导分析 |
| `/factors/graph/entities` | **力导向图节点/边**（ragservicer 知识图谱可视化，REQ-G2.1，B 端免 lr_ key） | 图谱页力导向图（ECharts） |
| `/factors/graph/edges` | **相关性图边**（ml-service GX-2，60 日 \|ρ\|≥0.6 + community/pagerank，REQ-G1） | 相关性图页面（多节点展示） |
| `/factors/graph/history` | **gf_\* 日频历史序列**（自然日归一化，asof 语义，回测用，REQ-G2.5） | 图谱因子回测 |
| `/rag/retrieve` | **只读 RAG 检索透传**（ragservicer market/onchain/default 知识检索，REQ-G2） | 快速分析知识增强 |
| `/ml/predictions` | ML 预测快照明细（model=bolt/moirai/timesfm） | 模型明细核对 |
| 因子工厂 MCP（:3014）/ `/factor-factory/*` | 挖掘任务编排（factor_factory_start/status/result/list/cancel） | 因子挖掘（平台侧） |

> ⚠️ **因子工厂挖掘因子不进 `/factors/catalog`**（catalog 只含内置/ML/graph 固定因子）：激活因子列表经 `/factors/current` 的 `ml_factory.factors` 查询、实时值经 `ml_factory.values`；inactive 因子不对外。挖掘/激活/停用生命周期见 §3.4。

### 3.1 因子端点（DS-2）

| 端点 | 返回 |
|---|---|
| `/factors/catalog` | 因子目录（**49 个**：31 内置/ML + 18 graph；七字段结构见下，2026-08-19 实测） |
| `/factors/current?symbols=&category=` | 最新因子值（category 过滤快照因子，可用：external/sentiment/news/opportunities/heatmap/calendar/snapshot/**ml**；技术指标与 ML 因子**恒附加**，不随 category 过滤） |
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
| `category` | `technical` \| `macro` \| `sentiment` \| `onchain` \| `ml` \| `graph` \| `external` |
| `type` | `float` \| `int` |
| `range` | 合理值域（`null` 表示无限制；`[0, 100]` 为含边界闭区间） |
| `description` | 中文语义描述（新增 2026-08-07，下游展示用） |
| `unit` | 单位：`%`（us10y）、`T`（btc_difficulty）、`EH/s`（btc_hashrate）；价格/概率/方向/指数类为 `null`（新增 2026-08-07） |

**因子清单（31 个）**（catalog 另含 18 个 graph 因子，全量 **49**，见 §6；**因子工厂挖掘因子不在 catalog**，见 §3 端口全景与 §3.4）：

- **technical（11）**：`rsi_14`、`macd`、`macd_signal`、`macd_hist`、`bb_upper`、`bb_middle`、`bb_lower`、`atr_14`、`ma_5`、`ma_10`、`ma_20`（kline_store 自动计算，与 bar 同源）
- **macro（5）**：`vix`、`vxn`、`gvz`、`dxy`、`us10y`（unit=`%`）
- **sentiment（3）**：`fear_greed`（int 0-100）、`sentiment_score`（float -1~1）、`put_call_ratio`（期权认沽认购比，`_complex` 内含 `value/level/signal/interpretation` 解读，2026-08-19 登记）
- **onchain（2）**：`btc_difficulty`（unit=`T`）、`btc_hashrate`（unit=`EH/s`）
- **ml（10，DS-13，来源 ml-service）**：`tree_direction` / `tree_prob_up`（LightGBM）、`finbert_sentiment`（FinBERT）、`consensus_score`、`bolt_direction` / `bolt_prob_up`、`moirai_direction` / `moirai_prob_up`、`timesfm_direction` / `timesfm_prob_up`（direction 数值化：up=1 / flat=0 / down=-1）

> **⚠️ 两类带 "ML" 字样的因子勿混淆（B 端必读）**：

| 维度 | **ML 因子（category=ml）** | **挖掘因子（因子工厂 ml_factory）** |
|---|---|---|
| 定义 | catalog 内**固定** 10 个模型预测因子（tree/bolt/moirai/timesfm 方向+概率、finbert_sentiment、consensus_score） | 因子工厂**每日自动挖掘**产出：`mom_5_20`/`mom_10_30`/`mom_20_60`（多周期动量）、`ret_1/3/5/10/20/60`（多周期收益率）、`vol_20`（波动率） |
| 获取位置 | `/factors/catalog`（category=ml）+ `/factors/current` 的 `factors[SYMBOL]` + `/factors/history` | **仅** `/factors/current` 响应**顶层** `ml_factory`（与 category 无关，external/ml/news 任何 category 均附） |
| 是否静态 | **固定**，不随挖掘变化 | **动态**，随每日挖掘 / IC 评估增减（active/inactive） |
| 是否有历史 | ✅ `/factors/history` 可回测 | ❌ **无历史**，仅当前实时值（`ml_factory.values`） |
| 取列表方式 | 查 `/factors/catalog` 或 `category=ml` | `ml_factory.factors`（激活 key 列表） |

> **external category 覆盖（2026-08-19，Arbitrage 套利平台 PRD §2.1）**：
> `GET /factors/current?symbols=BTC&category=external` 返回 `vix` / `vxn` / `gvz` / `dxy` / `us10y` / `fear_greed` / `sentiment_score`（symbol 维度标量）+ `_complex.put_call_ratio`（含 `value/level/signal/interpretation`）。vxn/gvz 由 `volatility` 复合快照拆分，60s 级更新。

> **宏观因子数据源（2026-08-14 更新，Yahoo 限流后全免费源）**：
> - `dxy`：**frankfurter（ECB 参考汇率）按 DXY 标准公式计算**——`50.14348112 × EURUSD^-0.576 × USDJPY^0.136 × GBPUSD^-0.119 × USDCAD^0.091 × USDSEK^0.042 × USDCHF^0.036`（实测 99.9174 vs 市场 99.898，误差 <0.1%；**勿用 FRED DTWEXBGS**——广义贸易加权指数数值体系 ~119 与 NYB DXY ~99.9 不符）
> - `vix` / `put_call`（VIX3M）：**CBOE 官方 CSV**（`VIX_History.csv` / `VIX3M_History.csv`，免 key）
> - `us10y`：**FRED DGS10** → akshare 东财美债收益率 → yfinance
> - `fear_greed`：alternative.me（显示名 "Fear & Greed"）
> - `yield_curve`（收益率曲线形态 normal/bullish 等）由 DGS10/DGS3M 或 akshare 派生
> - `/factors/history` 不传 `limit` 时默认返回最近 **500** 根（上限 5000）。

> **✅ ML 因子历史已回填（2026-08-08 全部完成）**：ml-service 对已上线 30 符号按历史 1d bars 回放推理并落库——`ml_predictions` 现 **14524 行**（bolt **5126** / moirai **4294** / timesfm **5104**，三模型时间范围均 **2024-09-09 → 2026-08-07**），`tree_predictions` 快照 **1782** 行（**2023-10-06 → 2026-08-07**，LightGBM stale-model 逐日回放聚合）。回测含 ML 因子时早期区间不再为空（2024-09-09 起有 bolt/moirai/timesfm，2023-10-06 起有 tree；timesfm 于停服窗口回填，实测 36min，详见 infrax_tasklist DS-15）。

**灵活扩展（不改代码热扩展）**：`FACTORS_CONFIG_PATH=factors.json` 已启用，向 `factors.json` 的 `extra` 数组追加条目即可（字段规则与上表一致，`category` 默认 `external`、`type` 默认 `float`、`range`/`unit` 默认 `null`、`description` 默认空串），重启后自动进入 catalog。当前 extra 为空。

**B 端使用方式（2026-08-08 定稿）**：统一鉴权头三选一 `Authorization: Bearer <key>` / `X-API-Key: <key>` / `X-Service-Key: <key>`（`dx_*` 租户 key 或 `DATA_API_KEY`）；时间戳一律 unix ms；公网统一域名 `https://infrax.0xainet.top`（详见 §1）。

```bash
export DX_KEY='dx_...'   # 已向 B 端签发的租户 key（登记清单见 PRODUCTION_CREDENTIALS §8：arbitrage / aitrader / aihunter-saas / aiservicer）

# 1) 行情 K 线（含技术指标 + 最近因子 join）
curl "https://infrax.0xainet.top/api/data/bars?symbol=BTC/USDT&timeframe=1d&limit=100" -H "X-API-Key: $DX_KEY"

# 2) 最新因子值（category=ml 取全部 ML 因子）
curl "https://infrax.0xainet.top/api/data/factors/current?symbols=BTC,ETH&category=ml" -H "X-API-Key: $DX_KEY"

# 3) 因子历史（回测，逐 bar 对齐 /bars ts；不传 limit 默认 500 根）
curl "https://infrax.0xainet.top/api/data/factors/history?symbol=BTC/USDT&timeframe=1d&ids=tree_direction,bolt_prob_up,moirai_direction,timesfm_direction&limit=500" -H "X-API-Key: $DX_KEY"

# 4) ML 预测快照明细（data=null 表示该时刻无快照，需容错）
curl "https://infrax.0xainet.top/api/data/ml/predictions?model=bolt&symbol=BTC" -H "X-API-Key: $DX_KEY"
```

SDK：`infra-data-client`（Python，**0.3.0**：`get_ml_factory`/`get_current_factors_full`/`get_ml_predictions` 等，PyPI 已发布）、`@0xinfrax/data-sdk`（npm，**0.1.1**：`data.mlFactory()`/`factorsCurrent` 含 ml_factory；底层 `infrax-dk` 0.8.4）——用法与集成样例见 [SDK_INTEGRATION.md](SDK_INTEGRATION.md)。

### 3.2 复杂快照 /snapshots（DS-3 / DS-10）

`GET /api/data/snapshots?type=` —— raw_snapshots 最新结构（heatmap/calendar 等返回原始结构）。

### 3.3 全部数据类型清单（raw_snapshots 40 类，生产实证 2026-08-14）

| provider | data_type | 内容 | 近次落库 |
|---|---|---|---|
| `market` | `crypto_prices` | CoinGecko 现货价格 | 实时 |
| `market` | `indices` | 全球股指 | 实时 |
| `market` | `heatmap` | crypto 板块热度图 | 实时 |
| `macro` | `vix` / `dxy` / `us10y` | 波动率 / 美元指数 / 美债 10Y（CBOE/FRED/frankfurter，见 §3.1） | 实时 |
| `macro` | `us_indicators` | FRED 宏观指标（CPI/GDP 等） | 实时 |
| `sentiment` | `fear_greed` | 恐惧贪婪指数 | 实时 |
| `sentiment` | `sentiment_score` / `put_call_ratio` / `yield_curve` | 新闻情绪 / 认沽认购比（CBOE VIX+VIX3M）/ 收益率曲线 | 实时 |
| `sentiment` | `adanos_sentiment` | Adanos 舆情 | 实时 |
| `sentiment` | `finbert_sentiment` | FinBERT 情绪（新闻→模型分类） | 日更 |
| `news` | `news` | 新闻（→ finbert_sentiment 输入） | 分钟级 |
| `news_moomoo` | `news_moomoo` | moomoo 新闻（Moomoo News/MT Newswires/Benzinga） | 分钟级 |
| `fundamental` | `earnings` | 财报日历 | 实时 |
| `calendar` | `calendar` | 经济事件日历（FRED/Finnhub/moomoo 多源，含中英 description） | 实时 |
| `defi` | `tvl` | DeFi 总锁仓量（分链） | 实时 |
| `volatility` | `volatility` | VXN/GVZ 波动率指数 | 实时 |
| `onchain` | `btc_difficulty` / `btc_transfers` / `btc_hashrate` / `whale_balances` | BTC 挖矿难度 / 巨鲸转账 / 全网算力 / 巨鲸余额 | 实时 |
| `collector_onchain` | `onchain_checkpoints` | 链上检查点聚合 | 实时 |
| `global_market` | `commodities` / `forex_pairs` / `market_overview` | 商品 / 外汇对 / 多市场概览 | 30min |
| `okx_chainos` | `okx_hot_tokens` | **OKX ChainOS 热门代币榜**（ETH/BSC/Base 每链 10，字段 price/volume24h/marketCap/liquidity/holders/change24h） | **1h**（配额约束，见 §1） |
| `okx_chainos` | `okx_index_prices` / `okx_candles` | 链指数 / K 线（DQ-7） | ⏸ 已关闭（market 配额降频） |
| `ml` | `tree_predictions` / `consensus` | LightGBM 方向预测 / 多模型共识 | 日更 |
| `opportunities` | `opportunities` | 交易机会信号 | 实时 |
| `moomoo_macro` | `mm_macro_US` / `mm_macro_HK` | moomoo 宏观指标（US/HK，含 predict_value 一致预期 + release_time） | 实时 |
| `moomoo_capital_flow` | `mm_capital_flow` | 美股分钟级资金流（super/big/mid/sml） | 实时 |
| `moomoo_hot` | `mm_hot` | 美股热门/榜单（MM-14） | 实时 |
| `moomoo_screen` | `mm_screen` | 选股器结果（MM-15） | 实时 |
| `moomoo_smart_money` | `mm_smart_money` | 主力资金（smart money） | 实时 |
| `moomoo_basicinfo` | `mm_stock_basicinfo` | 个股 F10 基本面（MM-11） | 实时 |

> **因子工厂（FF）相关快照**（另存 `factor_factory.db`，非 raw_snapshots）：jobs（挖掘任务）/ results（候选因子评估）/ catalog（因子登记 active/inactive）。见 §3.4。

### 3.4 因子工厂（FF，R5-3/R5-4/FF-4.1，2026-08-14 生产就绪）

**定位**：把 ml-service 从"固定 28 因子"升级为**可挖掘、可评估、可管理、可入库**的因子引擎；合格因子经 data-service `/factors/current` 透传给下游（AItrader factor_client 零改动感知新因子）。

**数据流**：

```plaintext
对话/定时/手动 ──▶ factor_factory_start（MCP :3014 或 /factor-factory/mine）
                        │ 出站 X-Service-Key → ml-service :9120
                        ▼
              ml-service 因子引擎（jobs 队列 QUEUED→RUNNING→COMPLETED/FAILED）
                        │ SQLite factor_factory.db（jobs/results/catalog 同库）
                        ▼
              register_qualified（FF-3.1）→ catalog 登记（inactive）
                        │ 自动激活（FF-4.3）或 POST /factors/{key}/activate
                        ▼
              active 因子 = /factors/current 的 ml_factory.factors（FF-3.3）
                        │ 挖掘完成自动重评估，|IC|/|ICIR| 衰减 → 自动停用（FF-4.4）
                        ▼
              ml-service 按请求 symbols 算最新值 /factors/values（FF-3.4）
                        ▼
              data /factors/current 附 ml_factory.factors + ml_factory.values（60s TTL）
                        ▼
              任意客户端直接读 ml_factory.factors / ml_factory.values（免复算公式）
```

**能力清单**：

| 能力 | 说明 |
|---|---|
| MCP 服务 `infrax-factor-mcp`（:3014，R5-3） | 5 工具：`factor_factory_start / status / result / list / cancel`；出站 `X-Service-Key`（bridge key）→ ml-service :9120 |
| LLM 意图解析（R5-4） | `/factor-factory/mine` 自然语言意图 → 自动生成挖掘 spec（deepseek-v4-flash，`FACTOR_LLM_API_KEY`/`FACTOR_LLM_MODEL`）；实测"动量波动率 BTC ETH SOL 日线 5个 10分钟"→ 正确解析 → COMPLETED |
| 定时挖掘（FF-4.1） | `app/factorengine/scheduler.py` 进程内 daemon 线程，`FACTOR_MINER_SCHEDULE_ENABLED=true / INTERVAL_H=6 / DELAY_S=60 / SPEC=<JSON>`；负载控制=单 worker + 有任务跳过 + 距上次终态 < interval 跳过 |
| 因子池 | 动态池 + 白名单池；裸符号 `BTC` 自动补 `/USDT` 回退 |
| 评估 | `factor_eval` IC（Spearman 对齐 fail-open）/ 超额 / 稳定性；`FACTOR_EVAL_BARS=800` |
| 生命周期 | `recover()` 懒加载（重启后首次访问标 FAILED）；job 失败标 FAILED（原永久 RUNNING bug 已修） |
| 激活 | 自动激活（FF-4.3，默认开）或 `POST /factors/{key}/activate` → `/factors/current` 可见 |
| 值暴露（FF-3.4） | ml-service `GET /factors/values?symbols=` 按 active 因子 × symbol 算最新值（compute_factor + 最新 bar）；data `/factors/current` 透传为 `ml_factory.values`，客户端免复算公式 |
| 衰退淘汰（FF-4.4） | 挖掘任务 COMPLETED 后对 active 因子用**登记评估环境**（asset_pool/horizon）重评估，`abs(IC)<0.01 或 abs(ICIR)<0.03` 自动停用（`FACTOR_MINER_DEACTIVATE_IC/ICIR/ENABLED` 可调）；未登记环境跳过防跨市场误停 |

**查询方式**（客户端取因子值**直接读 `ml_factory.values`**，无需复算公式）：
- `/factors/current?symbols=` 响应顶层 `ml_factory`：`{"updated_at": <ms>, "factors": ["ret_1","ret_10","ret_20","ret_3","ret_5","vol_20"], "values": {"BTC/USDT": {"ret_1": -0.00076, ...}, "SPY": {...}}}`——`factors`=已激活 FF 因子 id 列表；`values`=按请求 symbols 算好的最新值（data 侧 60s TTL）
- `GET /factors/values?symbols=`（ml-service :9120 直连，实时计算）
- `GET /factor-factory/jobs` / `GET /factor-factory/results` / `GET /factor-factory/catalog`（ml-service :9120）
- 生产实测：自动挖掘 `ff_20260814_*` COMPLETED；catalog 登记 + 激活后 `/factors/current` 可见；FF-3.4 值暴露 + FF-4.4 衰退淘汰生产端到端验证通过（commit c3e7f66）
- **2026-08-14 全工具回归通过**（initialize/tools/list/start/status/result/list/cancel 7 步，R5-4 intent 意图解析→COMPLETED）；修复 `factor_factory_cancel` 405 bug（ml-service cancel 为 POST，commit 88d51ce）——详见 `req-06-factor-factory.md §8`

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

### 6.2 图谱查询端点（ragservicer，公网前缀 `/api/rag/api/v1/`）

> ⚠️ **公网路径**：nginx 将 `/api/rag/*` 去前缀转发到 ragservicer，故公网地址为 `https://infrax.0xainet.top/api/rag/api/v1/...`（2026-08-19 实测，`/api/rag/v1/...` 会 404）。另注意 `/api/v1/*` 走的是 data-service 旧契约兼容段，**不是** ragservicer。

| 端点 | 说明 |
|---|---|
| `POST /api/rag/api/v1/namespaces/{ns}/query` | 图谱混合检索，返回 **entities + relations + chunks**（不生成 LLM 答案，供调用方自接 LLM） |
| `POST /api/rag/api/v1/namespaces/{ns}/retrieve` | 纯检索（`top_k` 可调），只回上下文 |
| `POST /api/rag/api/v1/namespaces/{ns}/documents` | 注入单篇文档 → 自动抽实体关系建图 + 向量化 |
| `POST /api/rag/api/v1/namespaces/{ns}/documents/batch` | 批量注入 |
| `GET /api/rag/api/v1/namespaces/{ns}/documents` / `DELETE .../{doc_id}` | 文档列表 / 删除 |
| `GET /api/rag/api/v1/namespaces/{ns}/tasks/{task_id}` | 注入任务状态（读写分离异步队列） |
| `GET /api/rag/api/v1/tenants`、`POST /api/rag/api/v1/tenants`、`.../{id}/keys` | 租户与 key 管理（admin） |
| `GET /api/rag/api/v1/graph/entities?symbol=&namespace=market` | **力导向图可视化（GF-5）**——`namespace` 必须显式（默认 `default` 无图数据 → 503；`market`/`onchain` 才有） |
| `GET /api/rag/api/v1/instances`、`/api/rag/api/v1/admin/config`、`/admin/tasks` | 实例 / 热配置 / 任务（admin） |

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

### 6.5 data-service 统一图谱 / RAG 端点（B 端推荐入口，REQ-G1/G2/G2.5）

B 端只需 **data-service dx_\* key**，无需另持 ragservicer/ml-service key；data-service 内部持服务 key 透传。全部 fail-silent（上游不可用 → 空数据 + `meta.warning`）。

| 端点 | 说明 |
|---|---|
| `GET /api/data/factors/graph?symbols=BTC,ETH` | 语义图谱因子（ragservicer 知识图谱），`{ts, meta, factors: {SYM: {factor_key: value}}}` |
| `GET /api/data/factors/graph/entities?symbol=&namespace=market&limit=` | **力导向图节点/边**（ragservicer 图谱可视化，REQ-G2.1）——symbol 非空=一跳子图，空=全图 top-N by PageRank；默认 namespace=market（B 端免 lr_ key）；节点含 `name_en`（REQ-G8：中文实体英文名，未命中 null，实测 limit=300 时 124 个带 name_en） |
| `GET /api/data/factors/graph/edges?symbols=&limit=` | 相关性图边表（ml-service GX-2 同一图快照），`{ts, meta, nodes[], edges[]}`；nodes 的 `community`/`pagerank` 与 `/factors/current` 的 `gf_community`/`gf_pagerank` **同口径**（60 日窗、\|ρ\|≥0.6、共同交易日 ≥30）；**REQ-G9：仅真实 corr 边**（`corr` 带符号 ρ∈[-1,1]、`abs_corr`=\|ρ\|、按 abs_corr 降序截断，非 corr 图层边不再输出） |
| `GET /api/data/factors/graph/history?symbols=&days=` | gf_\* 日频历史（graph_history.db 自然日 0 时归一化，asof 语义），`{ts, meta, series: {SYM: {factor_key: [[ts_ms, val], ...]}}}`；历史自 2026-08-18 起累积 |
| `POST /api/data/rag/retrieve` | 只读 RAG 检索透传，body `{"query","namespaces":["market","onchain"],"top_k":10}` → `{ts, meta, results: [{namespace, context, top_k, mode}]}`；namespace 枚举（default 租户）`market`（行情/宏观/新闻）/ `onchain`（链上/DeFi）/ `default` |

---

## 7. 数据源总览

| 域 | 数据源 |
|---|---|
| crypto | ccxt（binance spot/usdm；okx/bybit 备用）、CoinGecko（价格）、OKX ChainOS（热门榜，配额约束） |
| 美股 / 港股 | **moomoo**（OpenD 本地网关 :11111，行情 LV3 快照 + 分钟级 K 线 + 宏观/新闻/资金流/榜单/F10）、腾讯美股（qt.gtimg.cn）、akshare 日线、yfinance（限流降级）、Finnhub/Twelve Data（符号 lookup） |
| 外汇 | **frankfurter**（ECB 参考汇率，免 key 无配额，日线 + DXY 计算）、Twelve Data、yfinance（限流降级） |
| 期货 | yfinance（`* =F`，限流降级）、akshare |
| A 股 | 腾讯日线（sh/sz）、AkShare 基本面 |
| 宏观 | **CBOE 官方 CSV**（VIX/VIX3M）、**FRED**（DGS10/us_indicators）、frankfurter（DXY 计算）、akshare（美债收益率）、恐惧贪婪 API |
| 舆情 | NEWSAPI / moomoo 新闻（MT Newswires/Benzinga）/ Adanos / FinBERT 情绪 |
| 链上 | BTC 难度/转账/算力/巨鲸（公共链上数据源）、OKX ChainOS（热门代币，1h） |
| 因子工厂 | ml-service 因子引擎（SQLite factor_factory.db）→ `/factors/current` ml_factory 透传 |
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
