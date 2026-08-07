# infra-data-client — InfraX data-service 官方 Python SDK

InfraX **data-service**（统一市场数据微服务，`/bars` / `/factors/*` / `/snapshots` / `/ticker` / `/symbols/*` / `/stats` / `/health`）的官方 Python 客户端。B 端（AItrader 侧）用这一个类替换各自重复实现的 `data_client.py` / `factor_client.py`，收敛鉴权、TLS、限流、时间换算口径。

- 版本：**0.2.0**（SemVer；契约变更走 minor，bug 修复走 patch，AItrader 侧升级 SDK 即可，无需改业务代码）
- 依赖：`requests>=2.25`（Python ≥ 3.9）

## 安装

```bash
# 本地构建安装
cd projects/data/sdk/python
pip install .

# 或直接 git 引用（发布到私有源后改用 pip install infra-data-client）
pip install "git+https://<你的仓库>/infraX-1.git#subdirectory=projects/data/sdk/python"

# 开发模式（改代码即生效）
pip install -e .
```

## 快速开始

```python
from infra_data_client import InfraDataClient

client = InfraDataClient(
    base_url="http://127.0.0.1:9112",   # 生产经 nginx 前缀如 https://host/api/data 亦可
    api_key="infrax-bridge-...",         # X-Service-Key 自动携带（DS-12）
    verify=False,                        # 生产证书暂不可信时关闭校验
)

# K 线（start/end 秒或毫秒均可，自动归一化）
bars = client.get_bars("BTC/USDT", timeframe="1h", limit=10)

# 最新因子（含 DS-13 ML 因子）
factors = client.get_current_factors("BTC,ETH")

# 实时报价
ticker = client.get_ticker("BTC/USDT", market_type="swap")

# 符号解析 / 搜索
resolved = client.resolve_symbol("BTC")
hits = client.search_symbols("btc", market="crypto", limit=10)
```

## API 一览

| 方法 | 端点 | 说明 |
|---|---|---|
| `get_bars(symbol, timeframe, market_type, start, end, limit)` | `GET /bars` | OHLCV + 指标 + 外部因子，ts 毫秒升序 |
| `get_factor_catalog()` | `GET /factors/catalog` | 因子目录（含 ML category="ml"） |
| `get_current_factors(symbols, category)` | `GET /factors/current` | 最新因子（symbols 支持 `"BTC,ETH"` 或 `["BTC","ETH"]`） |
| `get_history_factors(symbol, timeframe, ids, start, end, limit)` | `GET /factors/history` | 逐 bar 因子历史（asof 对齐，回测无未来函数） |
| `get_snapshots(snapshot_type)` | `GET /snapshots` | 板块快照（heatmap/calendar/crypto_prices/indices/tvl/volatility/us_indicators/earnings/onchain/commodities/forex_pairs/market_overview） |
| `get_ticker(symbol, market_type, exchange_id, market)` | `GET /ticker` | 实时报价 |
| `get_ml_predictions(model, symbol, start, end, limit)` | `GET /ml/predictions` | **P2 模型预测快照（优先路径，30min 落库）**；model=bolt\|moirai\|timesfm，无快照返回 None |
| `resolve_symbol(symbol, market)` | `GET /symbol/resolve` | 符号解析（全市场，DS-11） |
| `search_symbols(keyword, market, limit)` | `GET /symbols/search` | 符号模糊搜索（DS-9） |
| `get_broker_market_policy()` | `GET /policy/broker-market` | 券商市场策略 |
| `get_stats()` | `GET /stats` | 数据库统计 |
| `health()` | `GET /health` | 健康检查（免鉴权） |

## 核心能力

- **鉴权内置**：`api_key` 自动写入 `X-Service-Key` 请求头（DS-12 契约），调用方零配置。
- **TLS 可配置**：`verify=False` 应对生产证书不可信现状（同时抑制 InsecureRequestWarning）。
- **429 限流重试**：命中 429 自动重试，优先 `Retry-After` 头，无则指数退避 `backoff * 2^attempt`；`max_retries=0` 关闭重试。
- **fail-silent**（默认开）：网络错误 / 非 2xx（401/404/500…）返回 `None`，业务不中断；`fail_silent=False` 时抛 `InfraDataError(status, message)` 便于排查。
- **时间单位归一化**：`start`/`end` 传秒或毫秒均可（≥10^12 视为毫秒），SDK 统一换算后上送。
- **类型注解**：全部方法与返回类型标注，IDE 与静态检查友好；`Client` 支持上下文管理器（自动关闭连接池）。

## 示例

- [examples/quickstart.py](examples/quickstart.py) — 全端点走查
- [examples/ml_predictions_integration.py](examples/ml_predictions_integration.py) — **ML 预测集成**：快照优先 + ml-service 直连 `data=null` 兜底（含 `/ml/cache/stats` 就绪判断）

```bash
cd projects/data/sdk/python
python examples/quickstart.py --base-url http://127.0.0.1:9112 --api-key <KEY>
python examples/ml_predictions_integration.py --symbol BTC/USDT --model bolt \
    --data-url http://127.0.0.1:9112 --data-key <KEY> --ml-url http://43.156.25.197:9120
```

## 发布（SemVer）

```bash
cd projects/data/sdk/python
pip install build
python -m build        # 产出 dist/infra_data_client-0.2.0-*.whl / .tar.gz
# 上传到私有 pip 源，或直接分发 wheel
```

契约变更规范：新增端点/参数 → minor；修复行为 → patch；破坏性变更 → major。
