# InfraX 数据服务 · Python SDK 快速开始（infra-data-client）

> 适用平台：Arbitrage / AItrader / AIHunter SaaS 等 B 端。版本 **0.3.0**（PyPI 已发布，2026-08-19）。
> 数据目录与因子端口全景见 [DATA_SERVICE_CATALOG.md](DATA_SERVICE_CATALOG.md)。

## 1. 安装

```bash
pip install infra-data-client==0.3.0
```

## 2. 初始化

```python
from infra_data_client import InfraDataClient

client = InfraDataClient(
    base_url="https://infrax.0xainet.top/api/data",  # 公网统一域名
    api_key="<你的 dx_* key>",        # X-Service-Key 自动携带（也可 Bearer / X-API-Key）
    verify=True,                       # 生产证书可信，无需关闭校验
    timeout=10.0,
    fail_silent=True,                  # 默认：网络/HTTP 异常返回 None，业务不中断
)
```

## 3. 常用示例

### 3.1 K 线（含 11 技术指标 + 最近外部因子 join）

```python
bars = client.get_bars("BTC/USDT", timeframe="1D", market_type="swap", limit=100)
# bars["bars"][0] → {ts, open, high, low, close, volume, rsi_14, macd, bb_upper, ...}
```

### 3.2 最新因子（外部 8 字段 / ML 21 字段）

```python
# 外部因子：vix/vxn/gvz/dxy/us10y/fear_greed/sentiment_score + _complex.put_call_ratio
ext = client.get_current_factors("BTC", category="external")
# ML 因子 + 技术指标（category=ml 恒附技术指标与 ML 因子）
ml = client.get_current_factors("BTC,ETH,SOL", category="ml")
# 新闻标题流
news = client.get_current_factors("BTC", category="news")["_complex"]["news"]["items"]
```

### 3.3 因子工厂挖掘因子（ml_factory，与 category 无关）

```python
mf = client.get_ml_factory("BTC,ETH")   # 激活因子列表 + 实时值
# mf = {"updated_at": ms, "factors": ["mom_5_20", "ret_1", ...],
#       "values": {"BTC": {"mom_10_30": -0.0036, "vol_20": 0.0112, ...}}}
# 完整响应（含 factors/_complex/ml_factory 原始结构）
full = client.get_current_factors_full("BTC", category="external")
```

### 3.4 完整响应结构参考（factors/current）

```python
# full = {ts, meta, factors: {SYMBOL: {fid: val}, "_complex": {...}}, ml_factory: {...}}
for sym, vals in full["factors"].items():
    if sym == "_complex":
        continue
    print(sym, vals.get("vix"), vals.get("tree_prob_up"))
```

### 3.5 因子历史（回测，逐 bar 对齐 /bars ts）

```python
hist = client.get_history_factors("BTC/USDT", timeframe="1D",
                                  ids=["tree_direction", "bolt_prob_up"], limit=500)
```

### 3.6 复杂快照 / ML 预测明细

```python
cal = client.get_snapshots("calendar")       # 经济日历
heatmap = client.get_snapshots("heatmap")    # 情绪热力图
pred = client.get_ml_predictions("bolt", "BTC")  # ML 预测快照（无快照 → None）
```

## 4. 方法速查

| 方法 | 端点 | 说明 |
|---|---|---|
| `get_bars(symbol, timeframe, market_type, start, end, limit)` | `/bars` | K 线 + 技术指标 + 因子 join |
| `get_current_factors(symbols, category)` | `/factors/current` | 最新因子（裁剪版，无 ml_factory） |
| `get_current_factors_full(symbols, category)` | `/factors/current` | **完整响应**（含 ml_factory） |
| `get_ml_factory(symbols)` | `/factors/current` | 挖掘因子激活列表 + 实时值 |
| `get_factor_catalog()` | `/factors/catalog` | 固定因子目录（49 个） |
| `get_history_factors(symbol, timeframe, ids, ...)` | `/factors/history` | 逐 bar 因子时序（回测） |
| `get_snapshots(type)` | `/snapshots` | 复杂快照（calendar/heatmap/indices/...） |
| `get_ticker(symbol)` | `/ticker` | 实时报价 |
| `get_ml_predictions(model, symbol, ...)` | `/ml/predictions` | ML 预测快照（bolt/moirai/timesfm） |

## 5. 鉴权与错误语义

- 头三选一：`Authorization: Bearer <key>` / `X-API-Key: <key>` / `X-Service-Key: <key>`（SDK 默认 X-Service-Key）
- 429 自动重试（Retry-After 优先，指数退避兜底）
- `fail_silent=True` 时网络/HTTP 异常返回 `None`；`fail_silent=False` 抛 `InfraDataError(status, message)`
- 时间戳一律 unix 毫秒（`start`/`end` 秒或毫秒自动归一化）

## 6. JS 替代

```bash
npm i @0xinfrax/data-sdk@0.1.1
```

```js
const { createDataClient } = require('@0xinfrax/data-sdk');
const d = createDataClient({ dataUrl: 'https://infrax.0xainet.top/api/data', dataApiKey: '<key>' });
const mf = await d.data.mlFactory('BTC,ETH');   // 挖掘因子
const cur = await d.data.factorsCurrent({ symbols: 'BTC', category: 'external' });
```
