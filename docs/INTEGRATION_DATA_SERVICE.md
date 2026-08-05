# InfraX 数据服务使用文档（data-service）

> 最后更新：2026-08-06 | 适用版本 v0.3.0（SDK）/ v1.0.0（服务）
> 适用方：金融量化平台等需要行情/因子/链上数据的下游系统
> 覆盖：REST API（:9112）· MCP（hub-index :3008）· JS SDK（@0xinfrax/infrax-dk）

---

## 1. 服务简介

data-service 是 InfraX 的统一市场数据服务，提供：

- **K 线**（`/bars`）：crypto（spot/swap）、美股、外汇、期货、A股、港股 OHLCV + 预计算技术指标（RSI/MACD/BB/ATR/MA）
- **实时行情**（`/ticker`）：crypto 走 ccxt，美股/外汇/期货走 yfinance，A股/港股走腾讯
- **因子**（`/factors/*`）：技术指标、外部宏观（VIX/DXY/US10Y/Fear&Greed）、情绪、机会、日历、快照因子
- **快照**（`/snapshots`）：宏观、股指、加密价格、链上（onchain_checkpoints / btc_transfers / btc_difficulty）、Defi TVL、波动率、OKX 热门币/指数价格
- **符号服务**（`/symbols`、`/symbols/search`、`/symbol/resolve`）：支持的交易品种查询与模糊搜索、符号规范化
- **ML 预测**（`/ml/predictions`）：bolt / moirai / timesfm 三种模型的预测历史
- **统计**（`/stats`）：库内数据覆盖范围与行数

---

## 2. 接入信息

| 项 | 值 |
|---|---|
| 内网地址 | `http://172.43.163.105.172:9112`（同 VPC/内网访问） |
| 外网地址（HTTPS） | `https://infrax.0xainet.top/api/data`（经 nginx，路径前缀 `/api/data` 会被剥离，如 `/api/data/bars` → `/bars`） |
| OpenAPI | `GET /openapi.json`（需携带有效 key） |
| 鉴权 | 见 §3 |

> ⚠️ 域名 `infrax.0xainet.top` 的 DNS 切到 `43.163.105.172` 后外网地址方可使用；切换前可先用 `https://43.163.105.172/api/data/...`（`--insecure` 或正确 SNI）。

---

## 3. 鉴权

统一平台契约（app_auth），携带方式**三选一**，任一匹配即通过：

```
Authorization: Bearer <key>
X-API-Key: <key>
X-Service-Key: <key>      # 服务间调用约定使用此 header
```

| 场景 | key | 说明 |
|---|---|---|
| 平台 bridge key | `DATA_API_KEY` | 内部服务（injector/ml）联动用；未配置时服务开放 |
| **项目方签发 key** | `dx_` 开头 | 通过管理员签发，独立 label + 独立限流，可启停/轮换/吊销（见 §3.1） |
| 只读监控 key | `MONITOR_API_KEY` | 仅 GET/HEAD/OPTIONS，写操作拒绝 |

未携带/非法 key → `401 {"detail":"unauthorized"}`；key 已禁用 → `403`；超限 → `429`。

### 3.1 项目方获取 key

联系 InfraX 管理员签发（管理员调用管理端点）：

```bash
# 管理员操作（Bearer ADMIN_API_KEY）
curl -X POST https://infrax.0xainet.top/api/data/admin/api-keys \
  -H "Authorization: Bearer <ADMIN_API_KEY>" -H "Content-Type: application/json" \
  -d '{"label":"quant-platform-prod","rate_limit":100}'
# → {"code":0,"message":"ok","data":{"id":1,"api_key":"dx_...","label":"quant-platform-prod","rate_limit":100,"enabled":1}}
```

- 完整 key **仅在签发/轮换响应中出现一次**，请立即保存到环境变量
- `rate_limit` 为每分钟请求上限（RPM，默认 100）
- 项目方只需拿到 `dx_...` 值并配置到自己的环境变量，无需管理端点

---

## 4. REST API 端点

> 成功响应为**裸 JSON**（非信封）；错误统一 `{"code": <status>, "message": ..., "data": ...}`。

### 4.1 K 线 `/bars`

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| symbol | string | ✓ | 如 `BTC/USDT`、`AAPL`、`EURUSD`、`600519`、`GC=F` |
| timeframe | string | | `1m/5m/15m/30m/1h/4h/1d`，默认 `1m` |
| market_type | string | | `spot`（默认）\| `swap`；swap 按 `BTC/USDT:USDT` 存储键查询 |
| start / end | int | | unix 毫秒 |
| limit | int | | 1–5000，默认 500 |

```bash
curl -H "X-Service-Key: $DATA_KEY" \
  'https://infrax.0xainet.top/api/data/bars?symbol=BTC/USDT&timeframe=1d&market_type=spot&limit=5'
```

响应：`{"symbol","timeframe","market_type","count","bars":[{ts,open,high,low,close,volume,rsi_14,macd,...}]}`

### 4.2 实时行情 `/ticker`

`symbol`（必填）、`market_type`（spot/swap）、`exchange_id`（crypto，默认 binance）、`market`（crypto/usstock/forex/futures/cnstock/hkstock）

```bash
curl -H "X-Service-Key: $DATA_KEY" 'https://infrax.0xainet.top/api/data/ticker?symbol=BTC/USDT'
# → {"symbol":"BTC/USDT","price":64899.99,"change":...,"changePercent":...,"high":...,"low":...,"open":...,"previousClose":...,"ts":...}
```

### 4.3 因子

| 端点 | 说明 |
|---|---|
| `GET /factors/catalog` | 全部可用因子清单 |
| `GET /factors/current?symbols=BTC,ETH&category=external` | 最新因子值；category 可选 `external/sentiment/news/opportunities/heatmap/calendar/snapshot` |
| `GET /factors/history?symbol=BTC/USDT&timeframe=1d&ids=rsi_14,macd&start=&end=&limit=` | 逐 bar 因子时序（回测/因子研究用，ts 为毫秒） |

### 4.4 快照 `/snapshots`

| 参数 | 说明 |
|---|---|
| type | 快照类型：`macro` / `indices` / `crypto` / `defi_tvl` / `volatility` / `earnings` / `onchain`（onchain_checkpoints、btc_transfers、btc_difficulty）/ `okx`（okx_hot_tokens、okx_index_prices）等 |
| date | 日期过滤（YYYY-MM-DD） |
| limit | 返回条数，默认 100 |

```bash
curl -H "X-Service-Key: $DATA_KEY" 'https://infrax.0xainet.top/api/data/snapshots?type=onchain&limit=10'
curl -H "X-Service-Key: $DATA_KEY" 'https://infrax.0xainet.top/api/data/snapshots?type=okx'
```

### 4.5 符号服务

| 端点 | 说明 |
|---|---|
| `GET /symbols?timeframe=1d&minBars=1` | 库内已有数据的符号列表 |
| `GET /symbols/search?keyword=btc&market=crypto&limit=20` | 模糊搜索（crypto/usstock/forex/futures/cnstock/hkstock） |
| `GET /symbol/resolve?symbol=BTC&market=crypto` | 符号规范化：`BTC` → `{"query":"BTC","resolved":"BTCUSDT"}` |

### 4.6 ML 预测 `/ml/predictions`

`model`（`bolt|moirai|timesfm`，必填）、`symbol`（必填）、`start`/`end`（unix ms）、`limit`（≤5000）

### 4.7 统计与健康

- `GET /stats` → `{"kline_rows":...,"snapshot_rows":...,"symbols":...,"time_start":...,"time_end":...}`
- `GET /health` → `{"code":0,"message":"ok","data":{"service":"infrax-data","version":"1.0.0"}}`（**免鉴权**）

---

## 5. JS SDK（推荐）

已发布 npm：**`@0xinfrax/infrax-dk` v0.3.0**（含 `DataAPI`）。

```bash
npm install @0xinfrax/infrax-dk
```

```ts
import { InfraX } from '@0xinfrax/infrax-dk';

const ix = new InfraX({
  // data 服务独立配置；不传则回退 baseUrl/apiKey
  dataUrl: 'https://infrax.0xainet.top/api/data',
  dataApiKey: process.env.INFRAX_DATA_KEY!,   // dx_... 或 bridge key
});

// K 线（响应为 data 服务原始 JSON）
const bars = await ix.data.bars({ symbol: 'BTC/USDT', timeframe: '1d', limit: 10 });
console.log(bars.count, bars.bars[0]);

// 实时行情
const t = await ix.data.ticker({ symbol: 'BTC/USDT' });
console.log(t.price);

// 因子
const cat = await ix.data.factorsCatalog();
const cur = await ix.data.factorsCurrent({ symbols: 'BTC,ETH', category: 'external' });
const hist = await ix.data.factorsHistory({ symbol: 'BTC/USDT', timeframe: '1d', limit: 100 });

// 快照（onchain / okx 等类型别名直接可用）
const onchain = await ix.data.snapshots({ type: 'onchain', limit: 5 });
const okx = await ix.data.snapshots({ type: 'okx_hot_tokens' });

// 符号
const list = await ix.data.symbols('1d', 1);
const hit = await ix.data.searchSymbols({ keyword: 'btc', limit: 5 });
const resolved = await ix.data.resolveSymbol({ symbol: 'BTC' });

// ML 预测 / 统计 / 健康
const pred = await ix.data.mlPredictions({ model: 'bolt', symbol: 'BTC', limit: 5 });
const stats = await ix.data.stats();
const ok = await ix.data.health();
```

`DataAPI` 方法总览：`bars` / `ticker` / `factorsCatalog` / `factorsCurrent` / `factorsHistory` / `snapshots` / `symbols` / `searchSymbols` / `resolveSymbol` / `brokerMarketPolicy` / `mlPredictions` / `stats` / `health`。

---

## 6. MCP（AI Agent 接入）

统一 MCP 入口 hub-index（:3008），含全部 data 工具（13 个工具中的 9 个 data_*）+ LightRAG 查询。

**连接地址（Streamable HTTP）：**

```
https://infrax.0xainet.top/mcp/message
```

客户端配置示例（Claude Desktop / Cursor / 自研 Agent）：

```json
{
  "mcpServers": {
    "infrax": {
      "url": "https://infrax.0xainet.top/mcp/message"
    }
  }
}
```

**data 相关工具：**

| 工具 | 说明 |
|---|---|
| `data_bars` | K 线查询（symbol/timeframe/start/end/limit） |
| `data_ticker` | 实时行情 |
| `data_factors` / `data_factors_history` | 当前因子 / 历史因子时序 |
| `data_snapshots` | 快照（onchain/okx/macro/...） |
| `data_symbols` | 符号列表或搜索（传 query 时走 /symbols/search） |
| `data_symbol_search` / `data_symbol_resolve` | 模糊搜索 / 符号规范化 |
| `data_broker_policy` | 券商市场策略 |
| `data_stats` | 库统计 |

> ⚠️ MCP 端点当前**无入站鉴权**，仅供受信方使用；如需公开需自行加网关层校验。

---

## 7. 限流与错误

| 情况 | 响应 |
|---|---|
| 未携带/非法 key | `401 {"detail":"unauthorized"}` |
| key 已禁用 | `403 {"code":403,"message":"API key disabled","data":null}` |
| 超限 | `429`（每 key RPM 滑动窗口 + 每 IP 全局限流 `RATE_LIMIT_RPM`，默认 60/IP） |
| 参数错误 | `422`（`{"code":422,"message":"Validation error","data":[...]}`） |
| 数据不存在 | `404` |
| 服务异常 | `500` |

如需更高吞吐，向管理员申请提高 `rate_limit` 或全局 `RATE_LIMIT_RPM`。

---

## 8. 快速上手（3 步）

```bash
# 1. 配置 key
export INFRAX_DATA_KEY='dx_...'   # 由管理员签发

# 2. 验证连通（免鉴权）
curl -s https://infrax.0xainet.top/api/data/health

# 3. 拉第一条 K 线
curl -s -H "X-Service-Key: $INFRAX_DATA_KEY" \
  'https://infrax.0xainet.top/api/data/bars?symbol=BTC/USDT&timeframe=1d&limit=1'
```

更多：OpenAPI 文档 `GET /api/data/openapi.json`（带 key）；SDK 类型定义见 `dist/index.d.ts`。
