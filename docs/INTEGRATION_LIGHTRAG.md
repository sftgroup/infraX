# InfraX LightRAG 知识库使用文档

> 最后更新：2026-08-06 | 适用版本：lightrag-client 2.0.0（本地构建，PyPI 待发布）
> 适用方：服务平台等需要**存放资料并做语义检索**（GraphRAG）的下游系统
> 覆盖：ragservicer（:9721，知识库引擎）· knowledge-injector（:9113，自动注入）· Python SDK（lightrag-client）

---

## 1. 服务简介

LightRAG 知识栈由两个服务组成：

- **ragservicer（:9721）**：LightRAG 引擎。文档写入（存入向量库 + 知识图谱）、语义检索（local/global/hybrid/mix 混合检索）。按 `(租户, 命名空间)` 隔离实例。
- **knowledge-injector（:9113）**：定时/手动把数据源（宏观、情绪、链上、OKX 行情等 21 类）自动注入知识库；也可用它的 `/query` 透传查询。

> 服务平台场景：把你们的资料（产品文档、策略说明、研究报告等）写入命名空间，之后用自然语言检索——LightRAG 会自动抽取实体建图，支持全局（global）与局部（local）两种语义检索。

---

## 2. 接入信息

| 项 | 值 |
|---|---|
| ragservicer 内网 | `http://127.0.0.1:9721`（同机/内网） |
| ragservicer 外网 | `https://infrax.0xainet.top/api/rag`（前缀剥离，`/api/rag/api/v1/...` → `/api/v1/...`） |
| injector 内网 | `http://127.0.0.1:9113`（**内部服务，不对外暴露**） |
| 健康检查（免鉴权） | 外网 `GET /api/rag/api/v1/health`；injector 仅内网 `GET http://127.0.0.1:9113/health` |
| OpenAPI（免鉴权） | 外网 `GET /api/rag/api/v1/openapi.json`；injector 仅内网 `GET http://127.0.0.1:9113/openapi.json` |

> ⚠️ `infrax.0xainet.top` DNS 切到 `43.163.105.172` 后可用；切换前用 `https://43.163.105.172/...`。

---

## 3. 鉴权与租户模型

### 3.1 凭据携带（三选一，同平台契约）

```
Authorization: Bearer <key>
X-API-Key: <key>
X-Service-Key: <key>
```

### 3.2 四类 key（ragservicer 逐层匹配）

| key | 作用域 | 说明 |
|---|---|---|
| Bridge key（`RAGSERVICER_API_KEY`） | 租户 `default` | 平台内部服务用；也可加 `X-Tenant-ID` 头指定租户（服务账户） |
| Admin key（`ADMIN_API_KEY`） | 租户 `admin` | 管理端点（tenants/keys/config/instances） |
| Monitor key | 只读监控 | 仅 GET/HEAD/OPTIONS |
| **租户 API key（`lr_` 开头）** | 绑定的租户 | 项目方专用，由管理员签发（见 §3.3） |

### 3.3 项目方开通流程

服务平台需要**独立租户 + API key**，由 InfraX 管理员开通：

```bash
# 管理员操作（Bearer ADMIN_API_KEY）
# 1) 创建租户
curl -X POST https://infrax.0xainet.top/api/rag/api/v1/tenants \
  -H "Authorization: Bearer <ADMIN_API_KEY>" -H "Content-Type: application/json" \
  -d '{"tenant_id":"service-platform","name":"服务平台","description":"资料知识库"}'

# 2) 为租户签发 API key（完整 key 仅此一次返回）
curl -X POST https://infrax.0xainet.top/api/rag/api/v1/tenants/service-platform/keys \
  -H "Authorization: Bearer <ADMIN_API_KEY>" -H "Content-Type: application/json" \
  -d '{"name":"prod","expires_days":365}'
# → {"code":0,"message":"ok","data":{"key_id":...,"key":"lr_<48位hex>","key_prefix":"lr_...",...}}
```

项目方拿到 `lr_...` 后配置到环境变量即可。**数据面方法（写入/查询/删除）凭租户 key 即可，无需 admin key。**

---

## 4. 命名空间（namespace）

- **无显式创建 API**：首次访问某命名空间的文档/查询端点即**隐式创建**（按 `租户/命名空间` 隔离独立实例）。
- 常用命名空间：`market`（市场/宏观资料）、`onchain`（链上资料）；服务平台可自行使用任意命名空间名（建议字母数字下划线）。
- 现有实例查询：`GET /api/rag/api/v1/instances`（admin key）。

```bash
# 写入到 service-platform 租户的 research 命名空间
# 请求带租户 key；SDK 传 tenant_id 时自动加 X-Tenant-ID
```

---

## 5. 存放资料（写入）

### 5.1 REST 方式

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/rag/api/v1/namespaces/<ns>/documents` | POST | 写入单文档，body `{"text":"...","doc_id":"...","async":true}`；`?sync=1` 强制同步；异步返回 202 `{task_id,...}` |
| `/api/rag/api/v1/namespaces/<ns>/documents/batch` | POST | 批量，body `{"documents":[{"text","doc_id"}]}` |
| `/api/rag/api/v1/namespaces/<ns>/documents` | GET | 分页列出 `?page=1&limit=20` |
| `/api/rag/api/v1/namespaces/<ns>/documents/<doc_id>` | DELETE | 删除文档（doc_id 自动 URL 编码） |
| `/api/rag/api/v1/namespaces/<ns>/tasks/<task_id>` | GET | 查询写入任务状态（indexed/indexing/error） |

```bash
curl -X POST https://infrax.0xainet.top/api/rag/api/v1/namespaces/research/documents \
  -H "X-Service-Key: $RAG_KEY" -H "Content-Type: application/json" \
  -d '{"text":"InfraX 量化平台的因子说明文档：...","doc_id":"factor-doc-v1","async":true}'
# → 202 {"code":0,"message":"ok","data":{"task_id":"...","status":"queued","doc_id":"factor-doc-v1"}}
```

### 5.2 Python SDK（推荐，lightrag-client）

**包尚未发布 PyPI**，从我们提供的 wheel 本地安装：

```bash
# 方式 A：直接安装 wheel（由 InfraX 提供文件）
pip install lightrag_client-2.0.0-py3-none-any.whl

# 方式 B：从源码安装
git clone <repo>
cd projects/ragservicer/sdk/python && pip install .
```

**写入样例：**

```python
from lightrag_client import LightRAGClient

client = LightRAGClient(
    base_url="https://infrax.0xainet.top/api/rag",  # 内网则 http://127.0.0.1:9721
    api_key="lr_...",          # 管理员签发的租户 key
    tenant_id="service-platform",  # 传了则自动加 X-Tenant-ID
)

# 单条写入（异步默认；传 sync 轮询状态）
r = client.insert("research", "策略说明：动量因子...", doc_id="mom-factor-001")
print(r)  # {'task_id': '...', 'status': 'queued', 'doc_id': 'mom-factor-001'}

# 批量写入（例如导入一批历史研报）
docs = [
    {"text": "2026-Q2 宏观报告：...", "doc_id": "report-2026q2-001"},
    {"text": "2026-Q2 宏观报告：...", "doc_id": "report-2026q2-002"},
]
client.insert_batch("research", docs)

# 列出已入库文档
client.list_documents("research", page=1, limit=20)

# 删除
client.delete("research", "report-2026q2-001")
```

---

## 6. 检索（语义查询）

> 查询端点**不调用 LLM 生成答案**，只返回检索到的上下文片段（供你自己拼接/生成）。

### 6.1 REST

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/rag/api/v1/namespaces/<ns>/query` | POST | `{"query":"...","mode":"mix"}`；mode ∈ `naive/local/global/hybrid/mix`（默认 mix） |
| `/api/rag/api/v1/namespaces/<ns>/retrieve` | POST | 同上，多 `top_k` 参数 |
| `/api/injector/query`（injector 透传，**仅内网**） | POST | `{"query":"...","top_k":5,"namespace":"market"}`，直接透传 ragservicer 结果 |

```bash
curl -X POST https://infrax.0xainet.top/api/rag/api/v1/namespaces/research/query \
  -H "X-Service-Key: $RAG_KEY" -H "Content-Type: application/json" \
  -d '{"query":"我们关于风险预算有哪些规定？","mode":"hybrid"}'
# → {"code":0,"message":"ok","data":{"context":"...","mode":"hybrid","tenant":"service-platform","namespace":"research"}}
```

### 6.2 SDK

```python
# 混合检索（实体图 + 向量）
r = client.query("research", "我们关于风险预算有哪些规定？", mode="hybrid")
print(r["context"])

# 自定义 top_k
r = client.retrieve("research", "流动性管理", mode="local", top_k=10)
```

---

## 7. 自动注入（knowledge-injector）

平台已内置 21 类数据源的定时自动注入（每 6h 一轮），**服务平台一般无需自己触发**。如需手动（**injector 为内部服务，仅内网调用**）：

| 端点 | 说明 |
|---|---|
| `POST http://127.0.0.1:9113/inject/<source>` | 触发单个注入源，source ∈ `macro / sentiment / crypto_overview / volatility / news_sentiment / major_events / onchain / defi_tvl / macro_trend / fred_economics / earnings_index / evm / global_macro / indices / tech_analysis / tree_ml / consensus / p2_predictions / ml_predictions / onchain_checkpoints / okx_market` |
| `POST http://127.0.0.1:9113/inject/all` | 全量注入（不含 ml_predictions） |
| `POST http://127.0.0.1:9113/inject/parsed` | 配置化解析注入，body `{"source":"infrax_dc|infrax_collector","limit":100,"dry_run":false}` |
| `GET http://127.0.0.1:9113/status` | 注入器状态（`lightrag_enabled` + injectors 列表） |
| `GET http://127.0.0.1:9113/stats` / `GET http://127.0.0.1:9113/stats/recent` | 注入统计 |

```bash
curl -X POST http://127.0.0.1:9113/inject/macro \
  -H "X-Service-Key: $INJECTOR_KEY"
# → {"success":true,"duration_ms":...}
```

> injector 业务端点鉴权：`INJECTOR_API_KEY`（回退 bridge key），未配置则开放。该服务不暴露到外网 nginx，仅服务器内网可达。

---

## 8. 管理端点（管理员专用，Bearer ADMIN_API_KEY）

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/rag/api/v1/instances` | GET | 活跃知识库实例（租户/命名空间） |
| `/api/rag/api/v1/admin/tasks?limit=` | GET | 任务统计与最近任务 |
| `/api/rag/api/v1/tenants` | GET/POST/DELETE | 租户管理（DELETE 级联删 key） |
| `/api/rag/api/v1/tenants/<tid>/keys` | GET/POST | key 列表（掩码）/ 签发 |
| `/api/rag/api/v1/keys/<key_id>/revoke` | POST | 吊销 key |
| `/api/rag/api/v1/admin/config` | GET/PUT | LLM/embedding 配置热更新 |
| `/api/injector/admin/config`（**仅内网**） | GET/PUT | 数据源 key 热更新 |

---

## 9. 快速上手（3 步）

```bash
# 1. 配置租户 key
export RAG_KEY='lr_...'

# 2. 写入一份资料
curl -X POST https://infrax.0xainet.top/api/rag/api/v1/namespaces/research/documents \
  -H "X-Service-Key: $RAG_KEY" -H "Content-Type: application/json" \
  -d '{"text":"示例资料内容...","doc_id":"demo-001","async":true}'

# 3. 检索
curl -X POST https://infrax.0xainet.top/api/rag/api/v1/namespaces/research/query \
  -H "X-Service-Key: $RAG_KEY" -H "Content-Type: application/json" \
  -d '{"query":"示例资料讲了什么？","mode":"mix"}'
```

> 写入是异步的：写入后轮询 `tasks/<task_id>` 至 `indexed` 再查询，检索结果更完整。
