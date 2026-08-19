# AItrader 侧 lr_ RAG Key 接入情况说明与需求文档

> 提交方：AItrader 项目 ｜ 日期：2026-08-19
> 背景：AItrader 图谱可视化（GF-5 实体图）与图谱因子端点（GF-3）依赖 B 端 ragservicer（`/api/rag/*` → `:9721`，租户 `aitrader`）。本单为 **lr_ RAG key 接入核查结论** + 需 B 端配合项。
> 状态标记：🔲 待 B 端 ｜ ✅ 已确认 ｜ ⚠️ 异常待修。

---

## 1. 情况说明（AItrader 侧实测，2026-08-19）

### 1.1 Key 现状

| 项 | 值 | 说明 |
|---|---|---|
| AItrader 专用 key | `lr_a1a683d4b905e9c32ef10d3569b8ef38edad9c3f1eab5af7` | 已登记 `PRODUCTION_CREDENTIALS.md` §7（GF-6，租户 `aitrader`，永不过期） |
| **AItrader 生产 213 `.env`** | `RAGSERVICER_API_KEY=YOUR_ADMIN_KEY` | ⚠️ **占位符，从未配置真实 key** → analysis-service `LIGHTRAG_API_KEY` 亦为占位符 |
| 此前误用 | `dx_9aa40733d…`（data 服务 key）访问 RAG | 结果 401（dx_ 不能访问 rag 服务，属正常隔离） |

### 1.2 端点实测矩阵（2026-08-19，公网 `https://infrax.0xainet.top/api/rag`）

| 端点 | lr_ key | dx_ key | 说明 |
|---|---|---|---|
| `GET /api/v1/health` | 200 | 200 | 免鉴权 |
| `GET /api/v1/namespaces/market/documents?limit=3` | ✅ **200** | 401 | **key 本身有效** |
| `GET /api/v1/graph/entities?symbol=BTC` | ⚠️ **503** `graph data unavailable` | 401 | **图数据文件缺失/不可读（含 X-Tenant-ID: default 亦 503）** |
| `GET /api/v1/factors/graph?symbol=BTC` | ⚠️ **403** `Service-level key required for factor endpoints` | 403 | **该端点要求 service-level key，普通租户 key 不可用** |
| `POST /api/v1/namespaces/market/query` | 401（未带 key）| 401 | 鉴权正常 |
| `GET /api/v1/graph/search?query=BTC` | 404 | 404 | 路径不存在（疑为旧文档路径） |

### 1.3 结论

1. **lr_ key 已签发且有效**（documents 200），AItrader 侧需把真实 key 配置到 213 生产 `.env` 并重建 analysis-service（AItrader 侧操作，需 key 归属确认）。
2. **`graph/entities` 503**：生产 ragservicer（43.156.78.59）GraphML 图数据不可用——即使回退 default 租户亦 503，**疑似生产机图谱数据文件缺失/未随 M-3 迁移**，请 B 端检查。
3. **`factors/graph` 403**：该端点要求 **service-level key**（本地 master 源码 `auth.py` 无此逻辑 → **生产代码与 master 不同步**）。请 B 端说明 service-level key 的签发/获取方式，或放宽为租户 key 可访问。

---

## 2. 需求清单

| 编号 | 需求 | 状态 | 优先级 |
|---|---|---|---|
| RK-1 | B 端确认 `lr_a1a683d4…` 为 AItrader 专用且可长期使用 | 🔲 待 B 端确认 | **P0** |
| RK-2 | B 端修复 `graph/entities` 503（生产机图数据可用） | 🔲 待 B 端 | **P0** |
| RK-3 | B 端开放 `factors/graph` 访问：签发 service-level key 或放宽鉴权，并同步 master 源码 | 🔲 待 B 端 | **P1** |
| RK-4 | 同步生产代码与 master（`auth.py` 等差异），避免文档/实测不一致 | 🔲 待 B 端 | P1 |
| RK-5 | AItrader 侧将真实 lr_ key 配置到 213 生产并重建 analysis-service，端到端验证 | 🔲 待 AItrader（待 RK-1~RK-3 就绪） | P0 |

---

## 3. 请 B 端配合项

1. 确认 `lr_a1a683d4…` key 归属 AItrader 且建议长期使用（GF-6）。
2. 排查 `graph/entities` 503：检查生产机（43.156.78.59）`graph_chunk_entity_relation.graphml` 与 `kv_store_*` 数据文件是否存在/可读（含 default 租户回退路径），M-3 迁移后是否遗漏。
3. 说明 `factors/graph` 的 service-level key 机制：是哪个端点守卫、如何签发、AItrader 如何获取；若可放宽，请放开租户 key 访问并同步 master。
4. 同步生产与 master 代码差异（尤其 `auth.py`），避免契约漂移。
