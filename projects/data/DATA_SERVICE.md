# Data Service — 统一市场数据微服务

> 版本 2.0 | 端口 9112（nginx 前缀 `/api/data/*`） | FastAPI + SQLite
> 迁移自 AItrader data-service（端口 8765 → 9112），仅保留 v2 端点；生产部署见 `docs/infrax_tasklist.md` 与 `projects/data/README.md`。

## 1. 功能总览

Data Service 为整个 InfraX 平台提供**多市场行情数据**和**技术/基本面/宏观因子**，所有数据统一存储在本地 SQLite 中，通过 REST API 对外提供。

### 数据覆盖矩阵

> 深度标准对齐 AItrader 回测区间上限（DS-8）：Crypto 1m≥30 天、5m/15m/30m≥180 天、1h/4h≥1 年、1D≥3 年；美股 1D≥3 年且分钟级≥30 天；外汇/期货/A股/港股 1D≥1 年。timeframes 列为需求目标，传统资产分钟级受数据源限流暂未采集（详见 §3.1 回填策略）。

| 资产类型 | 标的数量 | 时间框架（需求目标） | 数据源 | 状态 |
|----------|:-------:|----------|--------|:--:|
| 加密货币 spot | USDT 对全量（46+ 符号） | 1m/5m/15m/30m/1h/4h/1d | ccxt (Binance) | ✅ 已达标（1m≥30d、5m/15m/30m≥180d、1h/4h≥1y、1d≥3y） |
| 加密货币 swap | 同上（`:USDT` 永续） | 1m/5m/15m/30m/1h/4h/1d | ccxt (Binance usdm) | ✅ 已达标（与 spot 同深度） |
| 美股 | 12 (SPY/QQQ/AAPL/MSFT/GOOGL/AMZN/NVDA/META/TSLA/JPM/V/XOM) | 1m/5m/15m/1h/4h/1d | yfinance / 腾讯 / akshare 日线 | ⚠️ 1d 达标（fetch_bars=400）；分钟级受 Yahoo 限流待扩展 |
| 外汇 | 7 (EURUSD/GBPUSD/USDJPY/AUDUSD/USDCAD/USDCHF/NZDUSD) | 15m/1h/4h/1d | Twelve Data / yfinance | ⚠️ 1d 达标；分钟级待扩展 |
| 期货 | 8 (GC/SI/CL/NG/HG/ES/NQ/YM) | 1h/4h/1d | yfinance / akshare | ⚠️ 1d 达标；分钟级待扩展 |
| A股 | 6 (600519/000858/601318/000333/002594/300750) | 15m/1h/4h/1d | 腾讯日线 / akshare | ✅ 1d 达标 |
| 港股 | 5 (00700/09988/09999/01810/09618) | 15m/1h/4h/1d | 腾讯日线 / akshare | ✅ 1d 达标 |

### 技术指标（每条 K 线自动计算）

| 指标 | 输出字段 | 可配置参数 |
|------|----------|-----------|
| RSI(14) | `rsi_14` | period (默认14) |
| MACD | `macd`, `macd_signal`, `macd_hist` | fast(12), slow(26), signal(9) |
| Bollinger Bands | `bb_upper`, `bb_middle`, `bb_lower` | window(20), num_std(2) |
| ATR(14) | `atr_14` | period (默认14) |
| SMA | `ma_5`, `ma_10`, `ma_20` | windows (默认[5,10,20]) |

### 外部因子

| 因子 | 数据源 | 刷新间隔 |
|------|--------|:-------:|
| Fear & Greed Index | alternative.me (免费) | 5min |
| VIX Volatility | yfinance | 5min |
| US Dollar Index (DXY) | yfinance | 5min |
| US 10Y Treasury Yield | yfinance | 5min |
| BTC Mining Difficulty | blockchain.info | 10min |

### 扩展数据

| 数据类型 | 内容 | 数据源 |
|----------|------|--------|
| 热力图（全市场） | crypto 8 分类×50 + stocks + fx(12对) + commodities(12只) | CoinGecko / Finnhub / frankfurter / yfinance / Tiingo / TwelveData（多源回退，REQ-2） |
| 经济日历 | FOMC/CPI/PPI/NFP/GDP 等12类事件 | Finnhub API / 静态日期 |
| 加密货币价格 | 5币种价格+涨跌幅+市值 | CoinGecko |
| 全球指数 | S&P500/NASDAQ/Dow/Nikkei/EuroStoxx/FTSE/HSI | yfinance |
| DeFi TVL | 前10链总锁仓量 | DeFiLlama |
| 波动率 | VXN/GVZ | yfinance |
| 宏观 (FRED) | CPI/Core PCE/NFP/Unemployment/GDP/FedRate | FRED API |
| 财报 | AAPL/MSFT/NVDA 等20只股票 | Finnhub API |

---

## 2. 代码结构

```
data-service/
├── main.py                  # FastAPI 入口 + 所有路由 + 启动钩子
├── Dockerfile               # Docker 构建 (python:3.11-slim)
├── requirements.txt         # 依赖: fastapi, ccxt, numpy, yfinance, akshare, pandas
├── data_config.json         # 采集配置: 标的/时间框架/指标参数/热力图分类
├── factors.json             # 因子扩展（预留）
├── .env.example             # 环境变量模板
│
└── app/
    ├── config.py            # 环境变量 → 配置常量 (API keys/db/cache/端口)
    ├── factors.py           # 因子定义 + 当前值查询 + 复杂快照查询
    ├── kline_store.py       # K线采集器: ccxt(加密) + yfinance/akshare(多市场) + 指标计算
    ├── enrich.py            # /bars 端点: 查询K线 + 注入链上/TVL 附加数据
    │
    ├── collectors/          # 后台采集线程 (每5-10min执行)
    │   ├── external_factors.py  # Fear & Greed / VIX / DXY / US10Y
    │   ├── calendar.py          # 经济日历 (Finnhub → FOMC静态兜底)
    │   ├── market_data.py       # 快照: 加密货币/指数/链上/DeFi/波动率/宏观/财报
    │   ├── heatmap.py           # 全市场热力图快照 (crypto + stocks/fx/commodities，统一走 generate_heatmap_data)
    │   └── urls.py              # 所有 API URL 集中管理 (env可覆盖)
    │
    ├── storage/             # SQLite 存储层
    │   ├── sqlite.py        # 连接池 + 建表
    │   └── __init__.py
    │
    └── utils/               # 工具
        ├── logger.py        # 日志配置
        └── db.py / db_postgres.py  # PostgreSQL 连接 (旧版v1路由使用)
```

### 关键设计原则

- **单文件入口** — `main.py` 包含所有路由定义 + 启动逻辑，无复杂蓝图嵌套
- **配置分离** — API 密钥和端口在 `app/config.py`（env 读取），采集标的在 `data_config.json`
- **静默失败** — 所有采集器线程 catch 所有异常，单个数据源故障不影响其他
- **去重写入** — `INSERT OR REPLACE` 防止重复数据，按 `(symbol, timeframe, ts)` 去重
- **无外部依赖** — SQLite 本地存储，无需 PostgreSQL/Redis 即可运行核心功能

---

## 3. API 参考

### 健康检查

```
GET /health
```
```json
{"status":"ok","service":"data-service","version":"1.0.0"}
```

### K 线数据

```
GET /bars?symbol=BTC/USDT&timeframe=1h&limit=500&start=1742342400000&end=1785547920000
```
参数:
- `symbol` — 标的代码 (必填)
- `timeframe` — 1m/5m/15m/1h/4h/1d (默认1m)
- `limit` — 最大返回条数 (默认500, 最大5000)
- `start`/`end` — unix毫秒时间戳 (可选)

响应示例:
```json
{
  "symbol": "BTC/USDT",
  "timeframe": "1h",
  "count": 2,
  "bars": [
    {
      "ts": 1785542400000,
      "open": 62887.88,
      "high": 63024.04,
      "low": 62887.87,
      "close": 62938.01,
      "volume": 517.27,
      "rsi_14": 34.34,
      "macd": -365.1,
      "macd_signal": -357.33,
      "macd_hist": -7.77,
      "bb_upper": 64420.4,
      "bb_middle": 63355.29,
      "bb_lower": 62290.17,
      "atr_14": 281.84,
      "ma_5": 62935.47,
      "ma_10": 62957.98,
      "ma_20": 63355.29
    }
  ]
}
```

### 当前因子值

```
GET /factors/current
GET /factors/current?symbols=BTC,ETH,SOL
GET /factors/current?category=external
GET /factors/current?category=heatmap
GET /factors/current?category=calendar
GET /factors/current?category=snapshot
```

category 参数说明:
- (无) — 返回所有简单因子 + 复杂数据摘要
- `external` — 只返回 fear_greed/vix/dxy/us10y/btc_difficulty
- `ml` — ML 因子（tree_direction/consensus_score/bolt/moirai/timesfm，来源 ml-service 快照）
- `heatmap` — 加密热力图分类数据（含完整 token 列表）
- `calendar` — 即将到来的经济日历事件
- `snapshot` — 加密货币价格/全球指数/链上/DeFi/波动率/宏观/财报

### 因子历史

```
GET /factors/history?symbol=BTC/USDT&timeframe=1h&ids=rsi_14,macd&limit=500
```
参数: `symbol`*、`timeframe`（默认 1m）、`ids`（逗号分隔因子 id，缺省返回全部技术因子）、`limit`（默认 500，上限 5000）。
返回逐 bar 因子时序（对齐 /bars ts，回测用，asof 对齐无未来函数）。

### 因子目录

```
GET /factors/catalog
```
返回所有可用因子的元数据（id/名称/类型/范围/分类/描述/单位）。当前 **28 个因子**：technical 11 + macro 3（vix/dxy/us10y，FRED 源 VIXCLS/DTWEXBGS/DGS10）+ sentiment 2 + onchain 2 + ml 10。

### 实时报价

```
GET /ticker?symbol=BTC/USDT&market_type=swap
```
返回 `{symbol, price, change, changePercent, high, low, open, previousClose, ts, market_type}`。支持 crypto/美股/外汇/期货/A股/港股，数据源回退链见 `docs/DATA_SERVICE_CATALOG.md §2.2`。

### 复杂快照

```
GET /snapshots
GET /snapshots?type=heatmap
GET /snapshots?type=calendar
GET /snapshots?type=crypto_prices
GET /snapshots?type=indices
```
独立的快照查询接口，按 `data_type` 过滤（heatmap/calendar/crypto_prices/indices/tvl/volatility/us_indicators/earnings/onchain/commodities/forex_pairs/market_overview 等 27 类）。

### ML 预测（data 侧快照）

```
GET /ml/predictions?model=bolt|moirai|timesfm&symbol=BTC/USDT
```
P2 模型预测明细（data 采集器从 ml-service :9120 周期拉取落库）：`{generated_at, direction, prob_up, uncertainty, point_forecast, quantiles}`。
ml-service 直连端点（`/ml/volatility`、`/ml/tree_predictions`、`/ml/consensus` 等）的异步+预热机制与统一响应结构见 `docs/SERVICE_API_REFERENCE.md §3`。

### 符号与市场

```
GET /symbols?timeframe=1d&min_bars=120      # 达标符号清单（ml-service 训练用）
GET /symbols/search?keyword=btc&market=crypto  # 符号模糊搜索（6 市场）
GET /symbol/resolve?symbol=BTC              # 符号解析（BTC→BTCUSDT、EUR/USD→EURUSD=X）
GET /policy/broker-market                   # 券商市场策略
```

### 管理端点（admin）

```
GET  /admin/status        # 采集器运行状态 + 熔断器 + 数据新鲜度 + key 概览
GET|PUT /admin/config     # 数据源 API key 热配置（掩码回显）
PUT  /admin/symbols       # 交易对热管理（add/remove/set，无需重启）
GET|POST /admin/api-keys  # 多租户 key 签发（dx_ 等前缀）
```

### 统计信息

```
GET /stats
```
```json
{
  "kline_rows": 604164,
  "snapshot_rows": 2190,
  "symbols": 46,
  "time_start": 1691366400000,
  "time_end": 1785547920000
}
```

---

## 4. 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `DATA_SERVICE_PORT` | 9112 | 服务端口 |
| `DATA_DB_PATH` | data/data.db | SQLite 存储路径 |
| `KL_SYMBOLS` | BTC/USDT,ETH/USDT,SOL/USDT | 加密K线标的（spot，USDT 对动态扩展） |
| `KL_SWAP_ENABLED` / `KL_SWAP_SYMBOLS` | false / 空 | 加密永续（swap）采集开关与标的 |
| `KL_TIMEFRAMES` | 1m,5m,15m,1h,4h,1d | K线时间框架 |
| `KL_INTERVAL_SEC` | 300 | K线采集间隔 |
| `KL_MULTI_INTERVAL_SEC` | 1800 | 多市场（美股/外汇/期货/A股/港股）采集间隔（降频防 Twelve Data 限流） |
| `KL_EXCHANGE` | binance | ccxt 交易所 |
| `KL_FETCH_LIMIT` | 500 | 每次采集条数 |
| `KL_BACKFILL_DAYS` | `{"1m":30,"5m":180,"15m":180,"30m":180,"1h":365,"4h":365,"1d":1095}` | 历史深度回填目标（天），JSON 覆盖；对齐 B 端验收标准（1m≥30 天、5m/15m/30m≥180 天、1h/4h≥365 天、1d≥3 年） |
| `FACTOR_COLLECT_INTERVAL_SEC` | 300 | 外部因子采集间隔 |
| `CALENDAR_COLLECT_INTERVAL_SEC` | 600 | 日历采集间隔 |
| `MARKET_COLLECT_INTERVAL_SEC` | 600 | 快照采集间隔 |
| `GLOBAL_MARKET_COLLECT_INTERVAL_SEC` | 900 | 全球市场（商品/外汇对/概览）采集间隔 |
| `ONCHAIN_COLLECT_INTERVAL_SEC` | 60 | 链上数据采集间隔 |
| `OKX_CHAINOS_COLLECT_INTERVAL_SEC` | 60 | OKX ChainOS 热点/指数采集间隔 |
| `P2_COLLECT_ENABLED` / `P2_COLLECT_INTERVAL_SEC` / `P2_RETENTION_DAYS` | true / 1800 / 90 | **ML 预测快照采集**（ml-service 周期拉取落库，30min 间隔、90 天保留） |
| `ML_SERVICE_URL` / `ML_API_KEY` | 空 | ml-service :9120 地址与鉴权 key（未配置则 ML 类 collector 空转） |
| `TICKER_CACHE_TTL_SEC` | 10 | /ticker 短 TTL 内存缓存 |
| `RATE_LIMIT_ENABLED` / `RATE_LIMIT_RPM` | true / 60 | 业务端点限流 |
| `ADMIN_API_KEY` / `MONITOR_API_KEY` | 空 | admin 端点 / 监控只读 key |
| `DATA_CONFIG_PATH` | data_config.json | 采集配置文件路径 |
| `COINGECKO_API_KEY` | 已配置（2026-08-06） | CoinGecko demo key（`x_cg_demo_api_key`）：heatmap/价格请求自动携带提升限流额度；实测 BTC 64513 / ETH 1890.69 出数 |
| `FINNHUB_API_KEY` | 已配置（2026-08-05） | Finnhub：美股 quote/日线备选/财报 earnings/公司档案/情绪；经济日历 free tier 无权限 |
| `FIRECRAWL_API_KEY` | 已配置（2026-08-05） | 统一搜索服务（`app/services/search.py`，search API）：macro_news 新闻搜索补充；未配置时 fail-silent 不影响主链路 |
| `FRED_API_KEY` | 已配置（2026-08-06） | FRED 宏观指标（CPI/PCE/NFP/Unemployment/GDP/Fed Funds）实测出数；DXY 备源 |
| `TWELVE_DATA_API_KEY` | 已配置（2026-08-06） | 外汇 K线主源（优先于 yfinance）；实测 EURUSD 400 根达标。免费 tier 限 8 次/分钟 ~800 credits/天，已降频（KL_MULTI_INTERVAL_SEC=1800，~96 次/天） |
| `NEWSAPI_API_KEY` | 已配置（2026-08-06） | 新闻采集（business/crypto 头条）：实测 top-headlines 返回 54 条；未配置时新闻采集自动禁用 |
| `TIINGO_API_KEY` | 已配置（2026-08-06） | 外汇/期货备源：实测 fx EURUSD bid 1.15446；IEX 美股 quote free tier 无权限（返回 None，美股走 akshare/腾讯） |
| `ALPHA_VANTAGE_KEY` | 已配置（2026-08-06） | DXY 美元指数备源：实测 GLOBAL_QUOTE AAPL 309.38 |
| `CRYPTOCOMPARE_API_KEY` | 已配置（2026-08-06） | 预留（当前 crypto 价格走 ccxt/CoinGecko）：实测 BTC/USD 64516.08 |
| `TUSHARE_TOKEN` | 已配置（2026-08-06） | Tushare A股日线（POST+token，多 key 轮换）：接入 cn_stock Tier 1.5（Twelve Data 后、腾讯前）。⚠️ 当前 token 积分不足（40203，需 ≥2000），fail-silent 回退腾讯；积分到位自动生效 |
| `LOG_LEVEL` | INFO | 日志级别 |

---

## 5. B 端集成指南

**生产接入**：公网 IP 直连 `https://43.163.105.172/api/data/*`（nginx 前缀，`Authorization: Bearer` / `X-API-Key` / `X-Service-Key` 带 `DATA_API_KEY` 或签发 `dx_*` key）；内网直连 `http://<host>:9112`。官方 Python SDK 见 `projects/data/sdk/python`（`InfraDataClient`，鉴权/限流/时间换算内置）。

### 部署方式

```bash
# 构建
cd data-service
docker build -t data-service .

# 运行（挂载自定义配置）
docker run -d \
  --name data-service \
  -p 9112:9112 \
  -v $(pwd)/data_config.json:/app/data_config.json:ro \
  -v $(pwd)/data:/app/data \
  --env-file .env \
  data-service
```

### 集成模式

**模式 A — Sidecar 容器**
```
┌─────────────────────────────────┐
│  Your B-Platform Backend  :8080 │
│  ┌───────────────────────────┐  │
│  │  DataClient  (HTTP :9112) │──┼──→ Data Service Container
│  └───────────────────────────┘  │
└─────────────────────────────────┘
```

**模式 B — 独立服务（nginx `/api/data/*` 前缀）**
```
Your Platform → HTTP → https://infrax.0xainet.top/api/data/bars?symbol=...
                        https://infrax.0xainet.top/api/data/factors/current
                        https://infrax.0xainet.top/api/data/snapshots?type=heatmap
```

### 调用示例

```python
import requests

BASE = "http://<host>:9112"   # 生产：https://infrax.0xainet.top/api/data
HEADERS = {"X-API-Key": "<DATA_API_KEY 或 dx_ key>"}

# K线
resp = requests.get(f"{BASE}/bars", params={
    "symbol": "BTC/USDT", "timeframe": "1h", "limit": 100,
}, headers=HEADERS)
bars = resp.json()["bars"]

# 因子（含 ML 因子）
resp = requests.get(f"{BASE}/factors/current", params={
    "symbols": "BTC,ETH",
}, headers=HEADERS)
factors = resp.json()["factors"]

# 热力图
resp = requests.get(f"{BASE}/snapshots", params={"type": "heatmap"}, headers=HEADERS)
heatmap = resp.json()["snapshots"]["heatmap"]
```

> 也可用官方 Python SDK（`projects/data/sdk/python`）：`client = InfraDataClient(base_url="http://<host>:9112", api_key="...")`，鉴权/429 限流重试/时间换算全部内置。

### 注意事项

1. **无状态设计** — Data Service 不管理用户/认证/计费，可水平扩展多实例
2. **冷启动** — 首次启动后需等待 1 个采集周期才有数据（约5-10分钟）
3. **API Key 可选** — 未配置 CoinGecko/Finnhub/FRED Key 时对应采集器自动降级或跳过；业务端点鉴权 `Authorization: Bearer` / `X-API-Key` / `X-Service-Key` 三选一（`?envelope=1` 可选信封包装）
4. **SQLite 限制** — 单文件数据库，高并发读没问题，写操作在后台线程串行执行
5. **指标参数** — 在 `data_config.json` 的 `kline.indicators` 下可调 RSI/MACD/BB/ATR/SMA 参数
6. **ML 预测** — 预测快照由 data 采集器从 ml-service :9120 周期拉取（`P2_COLLECT_INTERVAL_SEC` 30min）；ml-service 直连端点已异步化+预热（miss 返回 null），实时推理场景见 `docs/SERVICE_API_REFERENCE.md §3`
