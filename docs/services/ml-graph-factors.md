# ml-service 图谱因子引擎与扩展接入指南（GX-1 / GX-2 / GX-3）

> 来源：infrax_tasklist §9.22 图谱因子统一方案（GF/GX）。
> 本文档对应 ml-service `app/graph_engine.py` 的实现规范与扩展机制（GX-3.6 文档交付）。

## 1. 概览

ml-service 图谱因子引擎在 `:9120` 提供 18 个图因子（结构/邻居/嵌入），数据源全部经
data-service HTTP 拉取（fail-silent，任一数据面不可用不阻塞整体）。

```
data-service                        ml-service :9120
  /snapshots?type=heatmap  ───────▶ HeatmapAdapter（GX-1 静态图：板块/市值/价格）
  /bars                     ───────▶ BarsAttributeInjector + CorrelationEdgeBuilder（GX-2 动态图）
                                    │
                                    ▼
                              networkx 全市场图（industry / supply_chain / corr 边合并）
                                    │
                                    ▼
                              18 个图因子（gf_*）→ /ml/graph_factors、/ml/graph/catalog
                                    │
                                    ▼
                           data-service /factors/current 透传 response["graph"]
```

### 端点契约

| 端点 | 响应 data |
|---|---|
| `GET /ml/graph_factors?symbols=BTC,ETH` | `{"updated_at": ms, "values": {symbol: {gf_*: value}}}` |
| `GET /ml/graph/catalog` | `[18 个 graph 因子条目]`（id/name/category/type/range/description/unit） |

- 全图 + 结构因子走 `_async_runner` TTL 缓存（`ML_CACHE_TTL_SEC`，后台线程计算 + 预热周期刷新），
  端点只做字典过滤，秒回。
- 首次 miss 时后台计算、请求立即返回空 `values`（fail-silent，不产生模拟数据）。
- 符号归一化：`BTC/USDT`、`BTCUSDT`、`BTC-USD`、`btc` → `BTC`（非 crypto 仅大写）。

### 因子清单（18）

| id | 含义 | 来源 |
|---|---|---|
| `gf_degree` / `gf_betweenness` / `gf_pagerank` | 度/介数/PageRank 中心性 | 合并图结构 |
| `gf_community` | 社区编号（标签传播，Louvain 类） | 合并图结构 |
| `gf_structural_hole` | 结构洞约束（越低桥接价值越高） | 合并图结构 |
| `gf_neighbor_mom` / `gf_neighbor_vol` | 邻居动量/波动率加权聚合 | 邻居节点属性 |
| `gf_sector_mom` | 同板块动量 | 板块属性 |
| `gf_cc_spillover` | 相关性联动溢出（corr 边按 ρ 加权） | corr 边 ρ |
| `gf_community_mom` | 社区动量 | 社区分组 |
| `gf_node2vec_1..8` | 对称归一化邻接谱嵌入（SVD，类 Node2Vec） | 合并图 |

## 2. 统一图模型扩展机制（GX-3）

新数据面接入**无需改图结构**，只需实现三类组件之一并注册：

### 2.1 SourceAdapter（数据源适配器）

统一接口 `fetch → normalize（GraphSourceData）→ 引擎 upsert`。规范化输出为：

```python
@dataclass
class GraphSourceData:
    nodes: dict[str, dict]   # symbol → 节点属性
    edges: list[GEdge]       # 数据源自带的边（可选）
    meta: dict               # 元信息（可选）

@dataclass
class GEdge:
    u: str; v: str
    kind: str                # 边类型（industry/supply_chain/corr/...）
    weight: float = 1.0
    attrs: dict = {}         # 扩展属性（如 corr 边的 rho）
```

接入示例（实现 `fetch()`，注册 `register_source_adapter()`）：

```python
from app.graph_engine import SourceAdapter, GraphSourceData, register_source_adapter

class MyAdapter(SourceAdapter):
    name = "my_source"                       # 注册名唯一
    def fetch(self) -> GraphSourceData | None:
        rows = fetch_my_source()             # 1) fetch：任意外部数据
        data = GraphSourceData()
        for r in rows or []:
            data.nodes[r["symbol"]] = {"sector": r.get("sector")}   # 2) normalize
        return data or None

register_source_adapter(MyAdapter())          # 3) 注册 → 引擎自动 upsert
```

内置实现：`HeatmapAdapter`（data-service `/snapshots?type=heatmap`，heatmap 不可用时
回退内置 `_SECTOR_MAP` 板块映射）。

### 2.2 EdgeBuilder（边构建器注册表）

每类边独立构建器，注册进 `EDGE_BUILDERS`；引擎按注册顺序把所有构建器产出的边合并进
同一张图（MultiGraph，同对节点多类边 = 关联更强，权重累加）。图层权重在 `GEdge.weight`
中表达（行业 1.0 / 供应链 0.8 / 相关性 |ρ|）。

```python
class MyEdgeBuilder(EdgeBuilder):
    name = "my_edge"
    def build(self, ctx: dict[str, Any]) -> list[GEdge]:
        # ctx 含 {"nodes", "edges", "bars", "returns", "meta"}
        return [GEdge("A", "B", "my_edge", weight=0.5, attrs={...})]

register_edge_builder(MyEdgeBuilder())
```

内置实现：`IndustryEdgeBuilder`（同板块两两相连）、`SupplyChainEdgeBuilder`
（curated 供应链映射 `_SUPPLY_CHAIN`，仅当两端节点都在图中才建边）、
`CorrelationEdgeBuilder`（`/bars` 滚动 60 个共同交易日对数收益，`|ρ|≥0.6` 建边、
共同交易日 ≥30，`weight=|ρ|`、`attrs["rho"]` 保留符号）。

### 2.3 AttributeInjector（属性注入器）

财报/估值/情绪等作为**节点属性**注入（不占图结构），邻居聚合因子（`gf_neighbor_mom`
等）直接从节点属性读取：

```python
class MyInjector(AttributeInjector):
    name = "my_attrs"
    def inject(self, ctx: dict[str, Any], nodes: dict[str, dict]) -> None:
        for sym, attrs in nodes.items():
            attrs["my_metric"] = compute_metric(sym)   # 挂节点，不建边

register_attribute_injector(MyInjector())
```

内置实现：`BarsAttributeInjector`（`ret_1d` / `ret_5d` / `vol_20d`）。

### 2.4 已规划数据面（GX-3.4 / GX-3.5，注册即用）

| 数据面 | 组件 | 状态 |
|---|---|---|
| moomoo F10 财报（income/balance/cashflow/一致预期/估值） | AttributeInjector（节点属性）+ EdgeBuilder（财报事件边/基本面相似边） | 预留 |
| moomoo 卖空兴趣 / 资金流 | AttributeInjector | 预留 |
| 衍生品资金费率 / 链上 defi tvl | SourceAdapter + AttributeInjector | 预留 |

## 3. data-service 透传（GX-1.5）

data-service `/factors/current` 合并 `response["graph"]`：

- `app/ml_client.py`：`fetch_graph_factors`（60s TTL，按 symbols 集合键控）、
  `fetch_graph_catalog`（60s TTL）
- `app/factors.py`：`_GRAPH_FACTORS`（18 条静态 catalog，type/range 与 ml-service 对齐），
  `get_catalog()` 并入 `category="graph"` 分类
- `main.py`：ml_factory 合并后追加 graph block（fail-silent，只保留请求 symbols 对应的值）

## 4. 运维

- 依赖：`networkx>=3.0`、`scipy>=1.9`（requirements.txt 已含）；networkx 缺失时
  `/ml/graph_factors` 返回空 values、`/ml/graph/catalog` 仍可用（fail-silent）。
- 全图计算在后台线程（`_async_runner`），预热线程（`ML_PREWARM_*`）周期刷新；
  单次构建约拉取宇宙（市值前 150）标的 `/bars`，并发 8。
- 排障：`logger.info("graph built: nodes=... edges=... communities=...")` 出现在每次重建；
  端点无值时先确认 `DATA_SERVICE_URL` 可达与 heatmap 快照存在。
