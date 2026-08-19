# B 端图谱能力技术需求（infraX）——图谱展示 + 知识增强

- 日期：2026-08-19
- 接收方：B 端数据服务（infraX：data-service 43.163.105.172 / ragservicer 43.156.78.59）
- 来源：AIHunter 图谱展示界面 + 因子增强规划（复用 B 端 GF-1~GF-6 / GX-1~GX-3 已落地能力）
- 状态：**2026-08-19 B 端 6 项全部回复并处理完毕，AIHunter 公网实测全部通过** ✅ ｜ REQ-G8 双语支持待 B 端确认 ⏳

---

## 一、B 端回复结论（2026-08-19）

| # | 事项 | B 端结论 | AIHunter 实测 |
| ---- | ---- | ---- | ---- |
| ① | graph 多币种 | GX-2 本就全市场构建（市值前 150 标的），`/factors/current` symbols 参数默认 BTC，显式传参即可 | ✅ 10 币种全部返回 18 个 `gf_*` |
| ② | ml 动量因子过期 | 根因 2 条已修复（采集端 P2 契约未升级 + ML 机 torch 缺 DTensor），ml_predictions 恢复日更 | ✅ bolt/moirai/timesfm age≈318s，fresh=true |
| ③ | REQ-G1 边数据 | `/factors/graph/edges` 已可用，与 GX-2 同口径 | ✅ nodes 150 / edges 5，community/pagerank 与 gf_* 同快照 |
| ④ | REQ-G2 rag 只读 | 已上线，**无需新 key**（沿用 dx_* key，data-service 只读透传） | ✅ `/api/data/rag/retrieve` 返回 market+onchain 上下文 |
| ⑤ | graph 历史 | 已新增 `/factors/graph/history`，自然日 0 时幂等落 1 条（asof 语义可回测） | ✅ BTC/ETH 各因子 2 天序列 |
| ⑥ | gf_* 有效期 | 实时值 30min 重算（ML_CACHE_TTL_SEC=1800）；历史日频 | ✅ meta.age_ms 随重算更新 |

---

## 二、最终接入契约（AIHunter 侧实现依据）

统一前缀：`https://infrax.0xainet.top/api/data/`，鉴权三选一（`Authorization: Bearer` / `X-API-Key` / `X-Service-Key`）。

### 2.1 graph 多币种因子（①）

```
GET /factors/current?symbols=BTC,ETH,SOL,BNB,XRP,DOGE,ADA,AVAX,LINK,DOT
```
- 响应 `graph.values`：每 symbol 18 项 `gf_*`（degree/betweenness/pagerank/community/structural_hole/neighbor_mom/neighbor_vol/cc_spillover/sector_mom/community_mom/node2vec_1..8）
- **关键**：symbols 参数默认只返回 BTC，必须显式传参
- graph.values 覆盖市值前 150 标的（全市场，可传任意白名单）

### 2.2 相关性图边数据（③，REQ-G1 ✅）

```
GET /factors/graph/edges?symbols=&limit=300
```
- 响应 `{ts, meta:{window:60, min_abs_corr:0.6, updated_at}, nodes[], edges[]}`
- 口径：60 日共同交易日对数收益、|ρ|≥0.6、共同交易日≥30
- nodes 的 `community`/`pagerank` 与 `/factors/current` 的 `gf_community`/`gf_pagerank` **同一图快照**（updated_at 一致）
- symbols 空 = 全图（nodes 含全市场资产，图谱页建议按 community 过滤或主流币白名单展示）
- 实测：nodes 150，edges 5（当前窗口高相关边较少，正常）；边含 `kind` 字段（如 industry）

### 2.3 rag 知识检索（④，REQ-G2 ✅ 无需新 key）

```
POST /rag/retrieve
body: {"query": "...", "namespaces": ["market", "onchain"], "top_k": 10}
```
- 响应 `{ts, meta, results:[{namespace, context, top_k, mode:"mix"}]}`
- namespace 枚举：`market`（行情/宏观/新闻）/ `onchain`（链上/DeFi）/ `default`
- 只读不注入；实测 market+onchain 均返回 context（27KB / 21KB）
- 语义图谱因子：`GET /factors/graph?symbols=`（graph_entity_count 等 8 因子，供知识图谱页可视化）

### 2.4 graph 历史（⑤，REQ-G6 ✅）

```
GET /factors/graph/history?symbols=&days=
```
- 响应 `{ts, meta, series:{SYM:{factor_key:[[ts_ms,val],...]}}}`
- **自然日 0 时幂等归一化落 1 条**（asof 语义，可直接回测）
- 历史自 2026-08-18 起累积（当前 2 天），满 60/90 日后完整回测

### 2.5 gf_* 有效期（⑥，REQ-G7 ✅）

- 实时值每 30min 重算（ML_CACHE_TTL_SEC=1800，后台线程+预热）；`meta.age_ms` 随重算更新
- graph_history 按自然日 1 条（日频重建语义）
- **前端约定**：实时值标注 30min 级新鲜度；历史用日频序列
- **ml 因子过期阈值建议 30min**（按 ml_predictions generated_at 计 age）

---

## 三、已闭合需求明细

### REQ-G1【高】相关性图边数据接口 — ✅ 已满足（2026-08-19）

- B 端已实现 `GET /factors/graph/edges`（契约见 2.2），与 GX-2 完全同口径
- 验收对照：实测 nodes 150 / edges 5；`community`/`pagerank` 与 `gf_*` 同快照；连续采样稳定性待图谱页联调时复测

### REQ-G2【高】ragservicer 只读 — ✅ 已上线（无需新 key）

- B 端采用 data-service 只读透传：`POST /api/data/rag/retrieve`，沿用 AIHunter 现有 `dx_*` key
- namespace：market / onchain / default（已实测返回）
- 知识图谱可视化走 `GET /api/data/factors/graph`（语义图谱 8 因子）

### REQ-G3【中】知识图谱范围确认 — ⚠️ 部分确认

- namespace 枚举已确认（market/onchain/default）
- 节点规模/category-relation 枚举：B 端回复未直接给出，AIHunter 前端将基于 `/factors/graph` 8 因子 + `/rag/retrieve` 结果设计，或后续按需再询

### REQ-G4【高】graph 多币种 — ✅ 已满足

- 非缺陷：`/factors/current` symbols 参数默认 BTC，显式传参即可（GX-2 本为全市场 150 标的）
- 实测 10 主流币全部返回 18 项 `gf_*`

### REQ-G5【高】ml 日更链路 — ✅ 已修复上线

- 根因：data-service 采集端 P2 契约未随 ml-service 08-08 统一响应升级（`{generated_at, symbols}`）+ ML 机 torch 2.4.1 缺 DTensor（Chronos-Bolt 无法加载）
- 修复：契约适配 + torch 升级重启；实测 bolt/moirai/timesfm age≈318s fresh=true
- 约定：AIHunter 过期阈值 30min（按 ml_predictions generated_at）

### REQ-G6【中】graph 历史序列 — ✅ 已新增端点

- `GET /factors/graph/history`（asof 自然日 1 条），可直接回测；历史自 2026-08-18 累积

### REQ-G7【中】gf_* 有效期 — ✅ 已确认

- 实时值 30min 重算；历史日频；meta.age_ms 随重算更新

---

## 四、优先级汇总（全部闭合）

| 编号 | 需求 | 优先级 | 状态 |
| ---- | ---- | ---- | ---- |
| REQ-G1 | 市场相关性图边数据接口 `/factors/graph/edges` | 高 | ✅ 已满足 |
| REQ-G2 | ragservicer 只读（data-service 透传，dx_ key） | 高 | ✅ 已上线 |
| REQ-G3 | 知识图谱范围确认（namespace 已确认，枚举待补） | 中 | ⚠️ 部分确认 |
| REQ-G4 | graph 因子多币种（显式传 symbols 即可） | 高 | ✅ 已满足 |
| REQ-G5 | ml 日更链路恢复（契约+torch 修复） | 高 | ✅ 已修复 |
| REQ-G6 | graph 因子历史序列（/factors/graph/history） | 中 | ✅ 已新增 |
| REQ-G7 | gf_* 有效期/频率确认（30min/日频） | 中 | ✅ 已确认 |
| REQ-G8 | RAG 知识库 / 图谱实体双语支持（lang 参数或 name_en） | 中 | ⏳ 待 B 端确认 |

---

## 附：AIHunter 侧配套工作（实施依据）

- **知识增强适配层**：直接调 `POST /api/data/rag/retrieve`（沿用 dx_ key，无需新 key），替代 AItrader 源码 graph_client 的 `/query` 调用
- **图谱展示界面**：GraphPage——知识图谱走 `/factors/graph`（语义图谱 8 因子）+ `/rag/retrieve`；相关性图走 `/factors/graph/edges`（nodes 按 community/主流币白名单过滤）
- **回测 graph 因子**：`/factors/graph/history`（asof）注入 `factor_<gf_*>` 列；历史不足 60 日前用当前值仅注入末行
- **因子界面**：`gf_*` + ml 因子按 2.5 有效期约定展示（30min 新鲜度 / 过期态）
