# B 端图谱能力技术需求（infraX）——图谱展示 + 知识增强

- 日期：2026-08-19
- 接收方：B 端数据服务（infraX：data-service 43.163.105.172 / ragservicer 43.156.78.59）
- 来源：AIHunter 图谱展示界面 + 因子增强规划（复用 B 端 GF-1~GF-6 / GX-1~GX-3 已落地能力）
- 前置事实（已确认，**不重复提需求**）：
  - ragservicer 公网**已开放**：`https://infrax.0xainet.top/api/rag/*` → `http://10.3.8.6:9721`（`/api/rag/api/v1/health` 已 200 验证；注意实际前缀为 `/api/rag/api/v1/*`）；鉴权三选一（`x-api-key` / `Authorization: Bearer` / `X-Service-Key`）
  - 知识图谱可视化 **GF-5 已存在**：`GET /api/v1/graph/entities`（nodes category 9 枚举 + size；edges relation 8 枚举 + weight；支持 1-hop 子图）
  - 图谱因子 **GF-3/GF-4 已存在**：`GET /api/v1/factors/graph`、`/api/v1/factors/catalog`
  - 市场图谱因子 `gf_*`（18 项）已经 data-service `/factors/current` 的 `graph` 字段透传（60s TTL）

---

## REQ-G1【高】市场相关性图边数据接口（新增：ml-service GX-2 数据面外露）

### 背景

GX-2 已生产部署：`/bars` 滚动 60 日 |ρ|≥0.6 动态边 + Louvain 社区 + Node2Vec（`gf_node2vec_1..8`）。但对外**仅输出 `gf_*` 标量因子**（`/factors/current` 的 graph 字段），**未暴露边表**——AIHunter 无法直接重建相关性图（自行计算 60 日相关矩阵则与 B 端口径不一致，无法复用 community/pagerank 语义）。

### 需求

新增只读接口，返回当前相关性图（nodes + edges，ECharts force-directed 兼容结构，与 GF-5 `/graph/entities` 对齐，便于前端统一渲染）。

建议路径（data-service 统一数据出口，ml-service 计算）：

```
GET /api/data/factors/graph/edges?symbols=BTC,ETH,SOL&window=60&min_abs_corr=0.6&limit=300
```

响应（对齐 `{code, message, data}` 信封）：

```json
{
  "code": 0,
  "data": {
    "updated_at": 1787040000000,
    "window": 60,
    "min_abs_corr": 0.6,
    "nodes": [
      {"id": "BTC", "symbol": "BTC", "community": 2, "pagerank": 0.31, "size": 31}
    ],
    "edges": [
      {"source": "BTC", "target": "ETH", "corr": 0.82, "abs_corr": 0.82, "weight": 0.82}
    ]
  }
}
```

字段说明：

| 字段 | 含义 | 与现有因子的一致性要求 |
| ---- | ---- | ---- |
| `nodes[].community` | Louvain 社区编号 | 与 `gf_community` 完全一致 |
| `nodes[].pagerank` | PageRank 中心度 | 与 `gf_pagerank` 完全一致 |
| `nodes[].size` | 可视化节点大小（pagerank 归一化 ×100） | 同一口径 |
| `edges[].corr` | 原始皮尔逊相关系数 | — |
| `edges[].weight` | 可视化权重（= abs_corr） | — |

约束：

- **数据口径与 GX-2 完全一致**：同一 60 日窗口、同一 |ρ|≥0.6 阈值、同一社区/嵌入计算（不得另起口径）
- 只读接口；鉴权走 data-service 既有 key（`Bearer` / `X-API-Key` 三选一）
- 缓存：与 `gf_*` 同 TTL（60s）或日频重建可放宽至 5min
- 若 symbols 未传，默认返回全图（受 limit 约束）；若提供 symbols，返回这些节点及其 1-hop 边

### 验收

1. `GET /api/data/factors/graph/edges?symbols=BTC,ETH,SOL` → 200，`edges` 非空
2. 任一 symbol 的 `community`/`pagerank` 与 `/factors/current?category=graph` 的 `gf_community`/`gf_pagerank` 一致
3. 连续 3 次采样（间隔 1h）结构稳定（边集合差异 <10%）

---

## REQ-G2【高】为 AIHunter 签发 ragservicer 只读 API key + namespace 确认

### 背景

ragservicer 公网已开放（`/api/rag/*`），AIHunter 需消费 GF-3/4/5 + `retrieve` 用于知识增强与知识图谱展示，但**尚无访问凭据**。

### 需求

1. **签发 key**：为 AIHunter 签发 ragservicer API key（平台签发），scope 建议限制为只读：`retrieve`、`query`、`graph_entities`、`factors/graph`、`factors/catalog`
2. **namespace 确认**：确认 AIHunter 可用的 namespace 枚举（预期 `market`；若按来源细分如 `crypto_overview`/`defi_tvl`/`indices`/`macro` 等，请给出清单及覆盖范围）
3. **配置登记**：key 与公网基址登记（等价 B 端 PRODUCTION_CREDENTIALS.md 方式），供 AIHunter 侧配置

### 验收（用 AIHunter key 公网实测）

| 调用 | 期望 |
| ---- | ---- |
| `GET https://infrax.0xainet.top/api/rag/api/v1/graph/entities?namespace=market&limit=50` | 200，nodes+edges |
| `POST https://infrax.0xainet.top/api/rag/api/v1/namespaces/market/retrieve` body `{"query":"..."}` | 200，上下文文本 |
| `GET https://infrax.0xainet.top/api/rag/api/v1/factors/catalog` | 200，graph 分类目录 |

---

## REQ-G3【中】知识图谱可视化数据范围确认（供 AIHunter 前端设计）

非接口需求，需 B 端确认：

1. `namespace=market` 的当前**节点规模**（千级？万级？）与 `limit` 参数建议上限（GF-5 默认 200）
2. 知识图谱**更新频率**（knowledge-injector 灌入节奏：分钟级/小时级？）——决定前端刷新策略
3. GF-5 的 **category 9 枚举**与 **relation 8 枚举**清单（前端配色/图例/筛选设计用）

---

## 优先级汇总

| 编号 | 需求 | 优先级 | 状态 |
| ---- | ---- | ---- | ---- |
| REQ-G1 | 市场相关性图边数据接口 `/factors/graph/edges` | 高 | 待处理 |
| REQ-G2 | AIHunter ragservicer 只读 key + namespace 确认 | 高 | 待处理 |
| REQ-G3 | 知识图谱规模/频率/枚举确认 | 中 | 待确认 |

---

## 附：AIHunter 侧配套工作（不依赖 B 端，供参考）

- **知识增强适配层**：AItrader 源码 `graph_client` 调 `{LIGHTRAG_URL}/query`（body `question`），与 B 端 `/api/v1/namespaces/{ns}/retrieve`（body `query`）不兼容——AIHunter 将新增适配层或直接使用 `@0xinfrax/ragservicer-sdk` 2.0.0
- **图谱展示界面**：`GraphPage`（ECharts force-directed）——知识图谱渲染走 REQ-G2 key；相关性图渲染走 REQ-G1 接口
- **因子界面/策略因子**：`gf_*` 因子已透传，AIHunter 侧直接接入（无需 B 端改动）

---

# B 端回复（2026-08-19）

## REQ-G1 ✅ 已完成（生产已部署验证）

新增统一入口：

```
GET /api/data/factors/graph/edges?symbols=BTC,ETH&window=60&min_abs_corr=0.6&limit=300
```

- 路径前缀请按 B 端既有接入习惯（`/api/data/*` 或 data-service 公网基址）；鉴权三选一，**dx_ key**
- 返回 `{ts, meta{source, window, min_abs_corr, updated_at}, nodes[{id,symbol,community,pagerank,size}], edges[{source,target,corr,abs_corr,weight,kind}]}`
- 数据口径与 `gf_*` **完全一致**（同一图快照）：实测 BTC `gf_community=0 / gf_pagerank=0.007843` == edges 节点 `community=0 / pagerank=0.007843`
- `symbols` 缺省返回全图（当前 173 节点 / 3305 边）；提供 symbols 返回其节点 + 1-hop 邻边；edges 按 abs_corr 降序、limit 截断
- 无 key 401 / 带 dx_ key 200（生产已实测）
- 提交 commit `c796f14`

## REQ-G2 说明（key 定位澄清，请勿误解）

- **`lr_` key 是独立的 LightRAG 微服务**（供项目方**上传自己的资料 + 读取资料**：documents 注入/列表、query/retrieve 检索、graph/entities 可视化数据），与因子/金融数据方案无关；**今日（2026-08-19）以前发放的 `lr_` key 全部保持有效**
- **因子（含图谱因子）一律走 data-service `dx_` key**：`/factors/graph`（语义图谱 8 因子）、`/factors/graph/edges`（相关性图）、`/factors/current`（gf_* 18 因子）。ragservicer 因子端点已锁服务间（仅内部透传，B 端 lr_ key 访问返回 403）
- AIHunter 已持有 data-service `dx_` key（600 RPM）——**因子/图谱数据消费仅需该 key**；若需 LightRAG 知识增强（retrieve/query），用既有 `lr_` key 即可
- namespace：`market`（主数据面）+ `onchain`（链上）可用

## REQ-G3 确认

| 项 | 实况 |
| ---- | ---- |
| 节点规模 | `market` 图谱 **1176 节点**（graphml 3.4MB，2026-08-19 实测）；`limit` 建议 ≤300 |
| 更新频率 | knowledge-injector **日频持续灌入**（`crypto:daily:*`，08-19 03:36 仍在更新）→ 前端可日频刷新 |
| category 9 枚举 | `central_bank` / `exchange` / `fund` / `whale` / `project` / `media` / `policy` / `event` / `asset` |
| relation 8 枚举 | `funding` / `custody` / `listing` / `whale_move` / `etf_flow` / `regulation` / `sentiment_correlate` / `affects` |
