# B 端 InfraX RAGservicer 图谱因子需求文档（AItrader 侧提交）

> 提交方：AItrader 项目 ｜ 日期：2026-08-18
> 背景：AItrader 已接入 B 端 InfraX RAGservicer（LightRAG 知识图谱，`https://infrax.0xainet.top/api/rag`，namespace `market`）。当前可注入/可列出文档（1163 篇，更新至 08-16），但**存量文档检索返回 `[no-context]`**，无法产出图谱上下文；且 B 端尚无**图谱派生数值因子**端点。本文档为图谱因子的完整需求：存量修复（GF-1/GF-2）+ 图谱因子端点（GF-3/GF-4）+ 可视化数据（GF-5）+ 密钥治理（GF-6）。
> 状态标记：🔲 待 B 端实现 ｜ ⚠️ 待确认 ｜ ✅ 已完成（AItrader 侧）。

---

## 1. 需求总览

| 编号 | 需求 | 状态 | 优先级 |
|---|---|---|---|
| GF-1 | 存量文档图谱构建修复（检索不再 `[no-context]`） | 🔲 待 B 端 | **P0** |
| GF-2 | 图谱检索回归验证（query/retrieve 返回实体上下文） | 🔲 待 B 端 | **P0** |
| GF-3 | 图谱因子端点 `/factors/graph`（数值化图谱信号） | 🔲 待 B 端 | **P1** |
| GF-4 | 图谱因子目录并入 `/factors/catalog` | 🔲 待 B 端 | P1 |
| GF-5 | 可视化数据端点 `/graph/entities`（力导向图 nodes/edges） | 🔲 待 B 端 | P1 |
| GF-6 | AItrader 专用 `RAGSERVICER_API_KEY`（现借用 aiservicer） | 🔲 待 B 端 | P2 |

---

## 2. 问题诊断（GF-1 依据，AItrader 已实测）

### 2.1 症状
- `POST /api/v1/namespaces/market/query`（mode 任意）与 `/retrieve`（top_k=5）对存量 1163 篇文档均返回：
  `"context": "Sorry, I'm not able to provide an answer to that question.[no-context]"`
- 但 `GET /namespaces/market/documents` 能列出全部 doc_id（`crypto:daily:*`，更新至 `2026-08-16`）。

### 2.2 AItrader 对照实验（证明服务本身正常）
- 用 bridge key **同步注入**一篇中文测试文档：
  `POST /namespaces/market/documents?sync=1` → `{"code":0,"data":{"doc_id":"aitrader-diagnose-20260818",...}}`
- 立即 `POST /namespaces/market/retrieve`（query "BTC 美联储 降息 情绪"）→ **命中**，返回：
  `Knowledge Graph Data (Entity): {"entity":"美联储","type":"organization",...}{"entity":"BTC","type":"artifact",...}`
- **结论**：注入→实体抽取→检索链路正常；问题在**存量文档**——疑似异步注入任务（`POST /documents` 默认 202 + task_id 后台处理）存在失败/未完成（实体抽取或向量化阶段），文档"在库但未建图"。

### 2.3 请 B 端排查
1. `GET /api/v1/admin/tasks`（需 admin key）：检查写任务 status 分布（queued/processing/success/failed），统计失败率与失败原因
2. `GET /api/v1/admin/config`：确认 LLM（DeepSeek）与 embedding（all-MiniLM-L6-v2 / DashScope）配置、密钥有效
3. 对存量 `crypto:daily:*` 文档执行**批量重灌**（`POST /documents/batch`，`async=false` 同步）或触发重构建任务
4. 重灌后回归：`retrieve` 命中 `crypto:daily:20260816*` 内容

---

## 3. 图谱因子端点 `GET /factors/graph`（GF-3）

> 契约目标：把知识图谱（实体-关系-事件网络）量化为**数值因子**，并入 AItrader 因子体系，与 `tree_direction`/`fear_greed` 等并列。

### 3.1 契约

```
GET /factors/graph
  query: symbol  必填，如 BTC（或 BTC/USDT）
响应 200:
{
  "symbol": "BTC",
  "ts": 1787011200000,
  "factors": {
    "graph_entity_count": 23,          // 关联实体总数（去重）
    "graph_relation_count": 41,        // 实体间关系数
    "graph_sentiment": 0.42,           // 关联实体加权情绪 -1~1（新闻/情绪标签按边权重聚合）
    "graph_event_intensity": 0.7,      // 近期关联事件密度 0~1（近 7 天事件数归一化）
    "graph_centrality": 0.55,          // 资产在图谱子图中的中心度 0~1（PageRank 归一化）
    "graph_momentum_affinity": 0.3,    // 与近期上涨/下跌主导实体的关联度 -1~1
    "graph_policy_exposure": 0.2,      // 政策/监管类实体关联权重 0~1
    "graph_top_entities": ["美联储", "BlackRock", "Binance", "减半"],  // 关联度 Top N
    "graph_top_events": ["ETF 净流入", "美联储 9 月降息预期"],            // 近期关联事件
  }
}
```

### 3.2 语义说明
| 因子 | 定义 | 方向性 |
|---|---|---|
| graph_sentiment | 关联实体（机构/央行/KOL）情绪按关联强度加权 → 目标资产 | >0 偏多 |
| graph_event_intensity | 事件密度峰值提示波动率放大 | 高=警惕 |
| graph_centrality | 资产在生态/信息网络中的枢纽地位 | 高=系统性影响 |
| graph_policy_exposure | 监管政策实体关联权重（SEC/央行/合规） | 高=政策敏感 |
| graph_momentum_affinity | 与当前市场主导动量的实体关联方向 | >0 顺趋势 |

### 3.3 数据源与构建
- 输入：knowledge-injector 已注入的 `crypto:daily:*` 文档（或扩展注入市场分析/公告/新闻）
- 过程：实体抽取 → 关系构建（已有）→ 按目标资产聚合子图 → 图算法（PageRank/最短路径/边加权情绪）→ 归一化输出
- 频率：随注入器日频更新（`crypto:daily:*` 即日频），无需实时

---

## 4. 可视化数据端点 `GET /graph/entities`（GF-5）

> 供前端**力导向图**（ECharts graph 系列）渲染，展示目标资产的关联实体网络。

```
GET /graph/entities
  query: symbol 必填
响应 200:
{
  "symbol": "BTC",
  "ts": 1787011200000,
  "nodes": [
    {"id": "BTC", "label": "BTC", "category": "asset", "size": 20, "sentiment": 0.3},
    {"id": "美联储", "label": "美联储", "category": "central_bank", "size": 12, "sentiment": -0.2}
  ],
  "edges": [
    {"source": "美联储", "target": "BTC", "relation": "rate_decision_affects", "weight": 0.8}
  ]
}
```

- `category` 枚举：asset / central_bank / exchange / fund / whale / project / media / event / policy
- `relation` 枚举：affects / funding / custody / listing / whale_move / etf_flow / regulation / sentiment_correlate
- 前端按 sentiment 着色、按 size=中心度、edges 显示 relation 标签

---

## 5. 验证方式

1. **GF-1/GF-2 回归**：`curl -X POST .../namespaces/market/retrieve -d '{"query":"Bitcoin macro sentiment","mode":"hybrid"}'` 返回非 no-context 上下文；对比文档 `crypto:daily:2026081*`
2. **GF-3 数值合理性**：`/factors/graph?symbol=BTC` 与 `/factors/live` 的 `fear_greed`/`finbert_sentiment` 方向一致性 ≥ 70%
3. **GF-5 前端**：ECharts graph 渲染节点/边不报错，点击实体可下钻
4. AItrader 侧集成：`graph_sentiment` 并入快速分析 `crypto_factors` + 报告"知识图谱" section

---

## 6. 附：AItrader 侧已完成的对接（无需 B 端动作）

- `analysis-service/app/services/graph_client.py`：查询 `/api/v1/namespaces/{ns}/query`（mode mix，Bearer key，fail-silent 过滤 no-context）
- 快速分析响应新增 `knowledge_graph` 字段；前端 FastAnalysisReport 新增「知识图谱 (LightRAG)」section
- 自部署 lightrag-service / knowledge-injector / app.services.graph 已清理下线（commit 76f6116）
- 生产 `.env` 已配 `LIGHTRAG_URL=https://infrax.0xainet.top/api/rag` + `RAGSERVICER_API_KEY`（暂借用 aiservicer，见 GF-6）
