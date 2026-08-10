# data 服务（数据中心）使用指南（:9112）

> 最后更新：2026-08-11 | 生产状态：🟢 已验证可用（2026-08-11 生产实测）

## 1. 服务定位

**data**（`infrax-data`）是 InfraX 统一市场数据微服务，AItrader data-service 迁入后的数据中枢，提供 **Crypto / 美股 / 港股 / A股 / 外汇 / 期货** 六大类资产的行情、K 线、因子与快照数据：

| 能力 | 端点 | 说明 |
|---|---|---|
| 历史 K 线（OHLCV + 预计算指标 + 外部因子） | `/bars` | timeframe 支持 1m/5m/15m/30m/1h/4h/1d |
| 实时报价 | `/ticker` | crypto→ccxt；usstock/forex/futures→yfinance+Twelve Data；cnstock/hkstock→腾讯 |
| 因子目录 / 最新因子 / 逐 bar 因子历史 | `/factors/*` | 技术因子 + 外部因子 + ML 因子（回测无未来函数） |
| 复杂快照 | `/snapshots` | heatmap / calendar / crypto_prices / indices / tvl / volatility / us_indicators / earnings / onchain 等 |
| 符号搜索 / 解析 | `/symbols/search`、`/symbol/resolve` | 全市场模糊搜索与标准交易对解析 |
| 数据库统计 | `/stats` | kline/snapshot 行数、symbol 数、覆盖范围、数据质量 |
| P2 单模型预测历史 | `/ml/predictions` | bolt / moirai / timesfm 明细表 |
| 健康检查 | `/health` | 免鉴权 |

**生产实测（2026-08-11）**：`GET /ticker?symbol=BTC/USDT` → 200（BTC 实时价 64093.6）；`GET /stats` → 200（kline_rows ≈ 107 万）。

**网络拓扑**：服务绑定 `127.0.0.1:9112`，仅本机可直连；外部经 nginx 公网入口访问，前缀 `/api/data/*` → `:9112`（如 `/api/data/health`）。生产机 `43.163.105.172`（新加坡），域名 `infrax.0xainet.top`（Cloudflare 代理）。

## 2. 鉴权方式

统一鉴权契约（`projects/shared/app_auth.py`，data / knowledge-injector / ragservicer 四栈共用）：

- **key 携带方式三选一，任一匹配即通过**：
  - `Authorization: Bearer <key>`
  - `X-API-Key: <key>`
  - `X-Service-Key: <key>`（AItrader 服务间调用统一约定此 header）
- **平台 bridge key**：`DATA_API_KEY`（回退链 `RAGSERVICER_API_KEY` → `DOC_API_KEY` → `LIGHTRAG_API_KEY`）；未配置任何 key 时保持开放（向后兼容），配置后强制校验。
- **只读监控 key**：`MONITOR_API_KEY` 仅允许 GET/HEAD/OPTIONS（写操作一律拒绝）。
- **多租户签发 key**（`/admin/api-keys` 签发，与 bridge key 等价，SHA-256 哈希存储，不存明文）：
  - `dx_`（data 业务端点）/ `mx_`（mcp）/ `px_`（payment）/ `vx_`（vault）/ `mp_`（mpc）
  - 完整 key 仅在创建 / 轮换响应中返回一次；支持 per-key RPM 限流、启用/禁用、用量跟踪。
- **豁免（免 key）**：`/health` `/metrics` `/docs` `/redoc` `/openapi.json`；`/admin/*` 前缀走独立 `ADMIN_API_KEY`（Bearer）。
- **统一 401 响应体**：`{"code": 401, "message": "unauthorized", "data": null}`。

## 3. 端点清单

### 3.1 业务端点（bridge key / monitor key（只读）/ 多租户 key 任一）

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/health` | 豁免 | 健康检查：`{"code":0,"message":"ok","data":{"service":"infrax-data","version":"1.0.0"}}` |
| GET | `/docs` `/redoc` `/openapi.json` | 豁免 | Swagger / OpenAPI 文档 |
| GET | `/metrics` | 豁免 | Prometheus 指标 |
| GET | `/bars` | ✓ | K 线。`symbol`(必填，如 BTC/USDT)、`timeframe`(默认 1m)、`market_type`(spot\|swap，带 `:` 后缀自动判定 swap)、`start`/`end`(unix ms，秒级自动 ×1000)、`limit`(1-5000，默认 500) |
| GET | `/ticker` | ✓ | 实时报价。`symbol`(必填)、`market_type`、`exchange_id`(crypto，默认 binance)、`market`(crypto/usstock/forex/futures/cnstock/hkstock) |
| GET | `/factors/catalog` | ✓ | 全部可用因子目录（含 ML 因子） |
| GET | `/factors/current` | ✓ | 最新因子值。`symbols`(逗号分隔，默认 BTC)、`category`(external/sentiment/news/opportunities/heatmap/calendar/snapshot/ml) |
| GET | `/factors/history` | ✓ | 逐 bar 因子时间序列。`symbol`、`timeframe`、`ids`(逗号分隔)、`start`/`end`、`limit` |
| GET | `/snapshots` | ✓ | 复杂快照。`type`：heatmap/calendar/crypto_prices/indices/tvl/volatility/us_indicators/earnings/onchain |
| GET | `/symbols` | ✓ | 某 timeframe 下有足够 K 线的 symbol 列表（ml-service 训练标的发现用）。`timeframe`(默认 1d)、`min_bars` |
| GET | `/symbols/search` | ✓ | 符号模糊搜索。`keyword`(必填)、`market`(默认 crypto)、`limit`(默认 20，上限 100) |
| GET | `/symbol/resolve` | ✓ | 单符号解析为标准交易对。`symbol`(必填)、`market`；失败 404 |
| GET | `/policy/broker-market` | ✓ | 券商市场策略（crypto 交易所清单 + 默认市场） |
| GET | `/macro/history` | ✓ | FRED 宏观观测值序列。`series`(逗号分隔)、`start`/`end`(YYYY-MM-DD)、`limit` |
| GET | `/ml/predictions` | ✓ | P2 单模型预测历史。`model`(bolt\|moirai\|timesfm)、`symbol`、`start`/`end`、`limit` |
| POST | `/api-keys/verify` | ✓ | 校验外部签发 key（scope=mcp/payment/vault/mpc），供各服务入站鉴权调用。body: `{"api_key": "...", "scope": "mcp"}` |

### 3.2 管理端点（Bearer `ADMIN_API_KEY`，非业务 bridge key）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/admin/config` | 数据源 API key 配置快照（掩码展示，热更新） |
| PUT | `/admin/config` | 行级原子写 .env 更新 key（`{"keys": {...}}`） |
| GET | `/admin/status` | 采集器运行状态 + 熔断器状态 + 各数据源最近落库时间 |
| PUT | `/admin/symbols` | 交易对热管理（add/remove/set，无需重启） |
| GET | `/admin/api-keys` | 多租户 key 列表（掩码展示） |
| POST | `/admin/api-keys` | 签发新 key。body: `{"label": "...", "scope": "data", "rate_limit": 100}` |
| PATCH | `/admin/api-keys/{key_id}` | 更新 label / enabled / rate_limit |
| POST | `/admin/api-keys/{key_id}/rotate` | 轮换 key（旧 key 立即失效，返回新完整 key） |
| DELETE | `/admin/api-keys/{key_id}` | 删除 key |

## 4. 样例代码

> 以下 key 均为占位符，替换为实际签发的 key 即可。BASE_URL 三选一：
> - 直连（仅生产机本机）：`http://127.0.0.1:9112`
> - 公网 nginx：`https://infrax.0xainet.top/api/data`
> - 域名恢复前走 IP + Host 头：`curl -k -H 'Host: infrax.0xainet.top' https://43.163.105.172/api/data/...`

### 4.1 curl

```bash
# ── 健康检查（免鉴权）──
curl -s http://127.0.0.1:9112/health
# {"code":0,"message":"ok","data":{"service":"infrax-data","version":"1.0.0"}}

# ── 实时报价（生产实测 200，BTC 64093.6）──
curl -s "http://127.0.0.1:9112/ticker?symbol=BTC/USDT" \
  -H "X-API-Key: <DATA_API_KEY>"
# {"symbol":"BTC/USDT","price":64093.6,...,"market_type":"spot"}

# ── K 线（BTC/USDT 1h，最近 10 根）──
curl -s "http://127.0.0.1:9112/bars?symbol=BTC/USDT&timeframe=1h&limit=10" \
  -H "Authorization: Bearer <DATA_API_KEY>"
# {"symbol":"BTC/USDT","timeframe":"1h","market_type":"spot","count":10,"bars":[...]}

# ── 数据库统计（生产实测 kline_rows≈107万）──
curl -s "http://127.0.0.1:9112/stats" \
  -H "X-Service-Key: <DATA_API_KEY>"
# {"kline_rows":1070000,"snapshot_rows":...,"symbols":...,"quality":{...}}

# ── 公网示例（nginx 前缀 + IP 直连 + Host 头）──
curl -sk -H 'Host: infrax.0xainet.top' \
  -H "X-API-Key: <DATA_API_KEY>" \
  "https://43.163.105.172/api/data/ticker?symbol=BTC/USDT"
```

### 4.2 JS SDK（`@0xinfrax/infrax-dk` v0.6.0）

`infra.data.*` 覆盖 data 服务全部数据面端点（bars/ticker/factorsCatalog/factorsCurrent/factorsHistory/snapshots/symbols/searchSymbols/resolveSymbol/stats/health/brokerMarketPolicy/mlPredictions）。通过 `dataUrl` + `dataApiKey` 独立配置（回退 `baseUrl` + `apiKey`）。

```bash
npm install @0xinfrax/infrax-dk
```

```typescript
import { InfraX } from '@0xinfrax/infrax-dk';

const ix = new InfraX({
  dataUrl: 'https://infrax.0xainet.top/api/data', // 或 http://127.0.0.1:9112
  dataApiKey: '<DATA_API_KEY>',                    // 自动携带 x-api-key 头
});

// 实时报价
const t = await ix.data.ticker({ symbol: 'BTC/USDT' });
console.log(t.price); // 64093.6

// K 线
const bars = await ix.data.bars({ symbol: 'BTC/USDT', timeframe: '1h', limit: 10 });
console.log(bars.count, bars.bars);

// 数据库统计
const stats = await ix.data.stats();
console.log(stats.kline_rows); // ~1070000

// 符号搜索 / 解析
const hits = await ix.data.searchSymbols({ keyword: 'btc', market: 'crypto', limit: 5 });
const resolved = await ix.data.resolveSymbol({ symbol: 'BTC' });
```

### 4.3 Python SDK（`infra-data-client` v0.2.0）

```bash
pip install infra-data-client==0.2.0
```

```python
from infra_data_client import InfraDataClient

client = InfraDataClient(
    base_url="http://127.0.0.1:9112",   # 生产经 nginx 前缀如 https://infrax.0xainet.top/api/data 亦可
    api_key="<DATA_API_KEY>",           # SDK 自动携带 X-Service-Key 头（DS-12 契约）
    verify=False,                       # 生产证书暂不可信时关闭校验
)

# K 线（start/end 秒或毫秒均可，自动归一化）
bars = client.get_bars("BTC/USDT", timeframe="1h", limit=10)

# 实时报价
ticker = client.get_ticker("BTC/USDT", market_type="spot")
print(ticker["price"])

# 数据库统计
stats = client.get_stats()
print(stats["kline_rows"])
```

> 其余方法：`get_factor_catalog()` / `get_current_factors("BTC,ETH")` / `get_history_factors(...)` / `get_snapshots("heatmap")` / `get_ml_predictions(model, symbol)` / `resolve_symbol("BTC")` / `search_symbols("btc")` / `get_broker_market_policy()` / `health()`。fail-silent 默认开（网络/非 2xx 返回 None），`fail_silent=False` 时抛 `InfraDataError`；429 自动指数退避重试。

### 4.4 常见错误码

统一响应信封 `{"code": <status>, "message": ..., "data": null}`：

| 状态码 | 含义 | 排查建议 |
|---|---|---|
| 401 | 未携带 key 或 key 不匹配（`unauthorized`） | 检查三 header 之一是否携带、key 是否正确 |
| 403 | key 已禁用（`API key disabled`） | `/admin/api-keys` 查看 enabled 状态 |
| 404 | 无数据（ticker 无报价 / symbol 无法解析 / 预测历史为空） | 确认 symbol 拼写与市场 |
| 422 | 参数校验失败（如 market_type 非 spot/swap、limit 超范围） | 核对请求参数 |
| 429 | 限流（客户端 IP 或 per-key RPM） | 降低频率，SDK 已内置退避重试 |
| 500 | 服务内部错误 | 查看 data 服务日志 |

## 参考

- 源码：`projects/data/main.py`、`projects/data/app/`（storage/factors/enrich/ticker/symbol_search/api_keys）
- 统一鉴权契约：`projects/shared/app_auth.py`
- Python SDK：`projects/data/sdk/python/README.md`（PyPI：infra-data-client==0.2.0）
- 生产部署与 key 治理：`docs/infrax_tasklist.md` §2/§4（nginx `/api/data/*` → :9112）
