# InfraX Data Service

统一行情数据微服务（`infrax-data`，**端口 9112**）。聚合 Crypto / 美股 / 港股 / A 股 / 外汇 / 期货行情、K 线、技术指标、基本面、新闻、宏观与因子数据，供 AI Agent / AItrader 及其他微服务经 HTTP 调用。

> 由 AItrader data-service 迁入 InfraX 的 `projects/data`（端口 8765 → **9112**）。仅保留 v2 端点（`/bars`、`/factors/*`、`/snapshots`、`/stats`），旧 `/api/v1/*` 端点已移除。

## 启动

```bash
python -m venv .venv && ./.venv/bin/pip install -r requirements.txt
cp .env.example .env   # 按需修改
./.venv/bin/python main.py   # 默认 9112 端口
```

systemd：`sudo cp infrax-data.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now infrax-data`

> 生产环境完整部署（systemd / .env / 数据源降级链 / 验证清单）见 [docs/infrax_tasklist.md](../../docs/infrax_tasklist.md)。

## 环境变量

见 [.env.example](./.env.example)。核心项：

| 变量 | 默认 | 说明 |
|---|---|---|
| `DATA_SERVICE_PORT` | 9112 | 服务端口 |
| `DATA_DB_PATH` | data/data.db | SQLite 存储路径 |
| `KL_SYMBOLS` | BTC/USDT,ETH/USDT,SOL/USDT | K 线采集标的（REQ-G9 起扩至 ~85 主流币，覆盖 ml-service 图谱 universe；完整清单见 data_config.json `kline.symbols`） |
| `KL_TIMEFRAMES` | 1m | 采集周期 |
| `KL_INTERVAL_SEC` | 300 | 采集间隔 |
| `DATA_CONFIG_PATH` | data_config.json | 采集配置（代币/指数/链上等） |

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查（InfraX 标准格式） |
| GET | `/bars` | 统一 K 线 + 指标 + 外部因子 |
| GET | `/factors/catalog` | 因子目录 |
| GET | `/factors/current` | 最新因子值 |
| GET | `/factors/history` | 因子历史（回测/因子研究） |
| GET | `/factors/graph` | 语义图谱因子（ragservicer 8 因子透传） |
| GET | `/factors/graph/entities` | 力导向图节点/边（REQ-G2.1，节点含 name_en） |
| GET | `/factors/graph/edges` | 相关性图边表（REQ-G1，仅真实 corr 边） |
| GET | `/factors/graph/history` | gf_\* 日频历史（asof 语义，可回测） |
| POST | `/rag/retrieve` | 只读 RAG 检索透传（市场/链上知识增强） |
| GET | `/snapshots` | 复杂快照（heatmap/calendar/indices/tvl 等） |
| GET | `/stats` | DB 统计 |

## 鉴权与 Key 体系

统一鉴权契约（`app_auth.py`）：**Bearer > X-API-Key > X-Service-Key** 任一匹配即可，未携带返回 401。

| 调用方 | 鉴权方式 | 说明 |
|---|---|---|
| 主控台 Insights 页（/factors /graph /rag /ml） | **平台 bridge key**（web server.js 自动注入 `X-Service-Key`） | 前端不携带任何 key，网页直接可用 |
| B 端外部 API 调用（同上端点） | **`dx_` key** | 经 `GET/POST /api/v2/data/my-keys` 签发，与 bridge key 等价、可访问全部业务端点 |
| DC 订阅/链上数据（:9102） | **钱包签名** `x-wallet-address` | 订阅计划 + 配额扣减，与 :9112 数据面独立鉴权 |

要点：

- Insights 与 DC 共用同一 data 能力，但鉴权面不同：**数据面 :9112 走 `dx_` key**（图谱/因子/RAG/ML），**订阅面 :9102 走钱包签名**。
- B 端统一口径：自己调用 insights 数据端点（不经网页）用 `dx_` key 即可，与 DC 订阅同 key 体系；网页内由平台自动代鉴权。

## 数据采集

启动时自动拉起采集器：

- **K 线存储**（`app/kline_store.py`）：按 `KL_SYMBOLS` / `KL_TIMEFRAMES` 定时采集
- **外部因子**（`app/collectors/external_factors.py`）：fear_greed / vix / dxy / us10y
- **日历**（`app/collectors/calendar.py`）：经济事件日历
- **快照**（`app/collectors/heatmap.py` / `market_data.py`）：加密热力图、指数、TVL、波动率、FRED 宏观

详细接口说明见 [DATA_SERVICE.md](./DATA_SERVICE.md)。

## Docker

```bash
docker build -t infrax-data .
docker run -p 9112:9112 --env-file .env infrax-data
```
