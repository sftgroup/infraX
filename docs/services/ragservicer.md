# ragservicer 服务（LightRAG 知识库）使用指南（:9721）

> 最后更新：2026-08-11 | 生产状态：🟢 已验证可用（2026-08-11 生产实测）

## 0. 快速开始（Quick Start）

**1）安装**

```bash
pip install lightrag-client==2.0.0
```

> 无 JS SDK（@0xinfrax/infrax-dk 未覆盖 rag 服务），用 Python SDK `lightrag-client` 或直接 curl。

**2）获取凭据**

bridge key `RAGSERVICER_API_KEY`（回退 `DOC_API_KEY` → `LIGHTRAG_API_KEY`，映射 default 租户）；或 admin 端点 `POST /api/v1/tenants/{id}/keys` 签发 DB 租户 key。`/api/v1/health` 免鉴权。

**3）最小示例**

```python
from lightrag_client import LightRAGClient

rs = LightRAGClient(
    base_url="http://127.0.0.1:9721",   # 内网直连；公网经 nginx https://infrax.0xainet.top/api/rag（rag 不在 web :9111 代理路由内）
    api_key="<RAGSERVICER_API_KEY>",
    tenant_id="default",                # 可选 X-Tenant-ID
)

# 健康检查
print(rs.health())

# 文档列表（生产实测 200）
docs = rs.list_documents("market", page=1, limit=20)
print(docs["total"])

# 图谱检索
result = rs.query("market", "比特币走势")
```

**4）验证**

```bash
curl -s http://127.0.0.1:9721/api/v1/health   # 免鉴权
```

> 完整端点清单 / 鉴权细节 / 错误码见下文对应章节。

## 1. 服务定位

**ragservicer**（`infrax-ragservicer` v2.0.0）是 InfraX 的 **LightRAG 知识图谱微服务**：文档管理（注入 / 列表 / 删除）、图谱检索（query / retrieve）、实体抽取与关系构建由 LLM（默认 DeepSeek）驱动，向量化由 embedding（本地 all-MiniLM-L6-v2 或 DashScope）驱动。支持多租户 namespace 隔离，并内置 MCP Server（STDIO）供 AI Agent 接入。

数据链路：**knowledge-injector（:9113）定时拉取快照 → 结构化文本 → POST 到本服务 `/api/v1/namespaces/{ns}/documents` 构建知识图谱 → B 端/AI Agent 经 `/query` 检索**。

**生产实测（2026-08-11）**：`GET /api/v1/namespaces/market/documents`（`X-API-Key: <RAGSERVICER_API_KEY>`）→ 200（返回 documents 列表）。

**网络拓扑**：服务绑定 `127.0.0.1:9721`，仅本机直连；外部经 nginx 公网入口 `/api/rag/*` → `:9721`。生产机 `43.163.105.172`（新加坡），域名 `infrax.0xainet.top`（Cloudflare 代理）。

## 2. 鉴权方式

三层租户鉴权（`api/auth.py`），key 携带方式沿用统一契约（`Authorization: Bearer` / `X-API-Key` / `X-Service-Key` 三选一，见 `projects/shared/app_auth.py`）：

| 凭据 | 映射租户 | 说明 |
|---|---|---|
| `RAGSERVICER_API_KEY`（bridge key，回退 `DOC_API_KEY` → `LIGHTRAG_API_KEY`） | `default`（或 `X-Tenant-ID` 头指定） | 内部桥接 key，注入器 / AItrader 用 |
| `MONITOR_API_KEY` | `monitor` | 只读监控 key，仅允许 GET/HEAD/OPTIONS |
| `ADMIN_API_KEY` | `admin` | 管理端点专用（`require_admin`：必须 `Authorization: Bearer <admin_key>`） |
| DB 租户 key（`tenants.db`，admin 端点 `/api/v1/tenants/{id}/keys` 签发） | 绑定租户 | 普通调用方；带 `X-Tenant-ID` 头时作为跨租户 service account |

- 所有业务端点（documents/query/retrieve/tasks）需 `require_tenant` 校验，**不匹配一律 401**（不回退 default 租户）。
- **豁免（免鉴权）**：`GET /api/v1/health`、`GET /api/v1/openapi.json`（无鉴权装饰器，天然公开）。
- 限流：每租户 token bucket，`RATE_LIMIT_RPM` 默认 100 次/分钟，超限 429。
- 写路径读写分离：文档写入默认投递后台写队列（`async: true`，立即返回 202 + `task_id`），队列满返回 503。

## 3. 端点清单

### 3.1 业务端点（require_tenant：bridge key / monitor key（只读）/ DB 租户 key）

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/v1/health` | 豁免 | 健康检查：`{"code":0,"message":"ok","data":{"service":"infrax-ragservicer","instances":N}}` |
| GET | `/api/v1/openapi.json` | 豁免 | OpenAPI 3.0 文档 |
| POST | `/api/v1/namespaces/{ns}/documents` | ✓ | 注入文档。body `{"text": "...", "doc_id": "..."}`；默认异步返回 **202** `{task_id, status:"queued", doc_id}`，`?sync=1` 或 `"async": false` 走同步返回 **201** |
| POST | `/api/v1/namespaces/{ns}/documents/batch` | ✓ | 批量注入。body `{"documents": [{"text","doc_id"}, ...]}`，异步 202 / 同步 201 |
| GET | `/api/v1/namespaces/{ns}/documents` | ✓ | 文档列表（分页）。`page`(默认 1)、`limit`(默认 20，上限 100)，按 doc_id 排序 |
| DELETE | `/api/v1/namespaces/{ns}/documents/{doc_id}` | ✓ | 删除文档（默认异步 202） |
| GET | `/api/v1/namespaces/{ns}/tasks/{task_id}` | ✓ | 写任务状态轮询（status: queued/processing/success/failed） |
| POST | `/api/v1/namespaces/{ns}/query` | ✓ | 图谱检索（只取上下文，不生成 LLM 答案）。body `{"query": "...", "mode": "mix"}`；mode: mix/hybrid/naive/local/global |
| POST | `/api/v1/namespaces/{ns}/retrieve` | ✓ | 纯上下文检索（调用方自接 LLM）。body `{"query","mode","top_k"}` |

### 3.2 管理端点（require_admin：Bearer `ADMIN_API_KEY`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/instances` | 实例列表 |
| GET | `/api/v1/admin/tasks` | 写任务统计 + 最近任务列表（`limit` 默认 20，上限 200） |
| POST | `/api/v1/tenants` | 创建租户。body `{"tenant_id","name","description"}` |
| GET | `/api/v1/tenants` | 租户列表 |
| DELETE | `/api/v1/tenants/{tenant_id}` | 删除租户 |
| POST | `/api/v1/tenants/{tenant_id}/keys` | 签发租户 API key。body `{"name","expires_days"}`（0=永不过期） |
| GET | `/api/v1/tenants/{tenant_id}/keys` | 租户 key 列表 |
| POST | `/api/v1/keys/{key_id}/revoke` | 吊销 key |
| GET | `/api/v1/admin/config` | LLM/Embedding 配置快照（密钥掩码） |
| PUT | `/api/v1/admin/config` | 热更新 LLM/Embedding 配置（写 .env + reload，无需重启）。body `{"llm": {...}, "embedding": {...}}`，传 `"********"` 保留原密钥 |

### 3.3 弃用路由（legacy，v3.0 将移除）

`POST /api/v1/v1/bots/{bot_id}/documents`、`POST /api/v1/v1/bots/{bot_id}/query`、`POST /api/v1/v1/bots/{bot_id}/documents/batch` —— bot_id 直接映射为 tenant/namespace，新接入请改用 `/api/v1/namespaces/{ns}/*`。

## 4. 样例代码

> key 为占位符。BASE_URL 二选一：
> - 直连（仅生产机本机）：`http://127.0.0.1:9721`
> - 公网 nginx：`https://infrax.0xainet.top/api/rag`
>
> namespace 生产已用：`market`（默认，注入器）、`onchain`（链上数据）。

### 4.1 curl

```bash
BASE=http://127.0.0.1:9721
KEY=<RAGSERVICER_API_KEY>

# ── 健康检查（免鉴权）──
curl -s $BASE/api/v1/health

# ── 文档列表（生产实测 200，返回 documents 列表）──
curl -s "$BASE/api/v1/namespaces/market/documents?page=1&limit=20" \
  -H "X-API-Key: $KEY"
# {"code":0,"message":"ok","data":{"namespace":"market","documents":[...],"total":N,"page":1,"limit":20}}

# ── 文档注入（异步，默认返回 202 + task_id）──
curl -s -X POST "$BASE/api/v1/namespaces/market/documents" \
  -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"text": "BTC 走势受美联储利率政策影响，当前市场情绪中性偏多。", "doc_id": "doc-demo-001"}'
# {"code":0,"message":"ok","data":{"task_id":"...","status":"queued","doc_id":"doc-demo-001"}}

# ── 轮询写入任务状态（建议：写后轮询至 status=success 再检索）──
curl -s "$BASE/api/v1/namespaces/market/tasks/<task_id>" -H "X-API-Key: $KEY"

# ── 图谱检索（上下文模式，不生成 LLM 答案）──
curl -s -X POST "$BASE/api/v1/namespaces/market/query" \
  -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"query": "比特币近期走势如何？", "mode": "mix"}'
# {"code":0,"message":"ok","data":{"context":[...],"mode":"mix","tenant":"default","namespace":"market"}}

# ── 公网示例（nginx 前缀 + IP + Host 头）──
curl -sk -H 'Host: infrax.0xainet.top' -H "X-API-Key: $KEY" \
  "https://43.163.105.172/api/rag/api/v1/namespaces/market/documents?limit=5"
```

### 4.2 Python SDK（`lightrag-client` v2.0.0）

> 说明：@0xinfrax/infrax-dk（JS SDK v0.6.0）**未覆盖** rag 服务（无 `infra.rag`），REST 接入用 Python SDK 或直接 curl。

```bash
pip install lightrag-client==2.0.0
```

```python
from lightrag_client import LightRAGClient

rs = LightRAGClient(
    base_url="http://127.0.0.1:9721",   # 或 https://infrax.0xainet.top/api/rag
    api_key="<RAGSERVICER_API_KEY>",
    tenant_id="default",                # 可选 X-Tenant-ID
)

# 1. 文档列表
docs = rs.list_documents("market", page=1, limit=20)
print(docs["total"], len(docs["documents"]))

# 2. 注入（异步提交，返回 {task_id, status, doc_id}）
res = rs.insert("market", "DeFi TVL 回升，ETH 链上活跃度增加。", "doc-demo-002")
print(res)  # {'task_id': '...', 'status': 'queued', 'doc_id': 'doc-demo-002'}

# 批量注入
rs.insert_batch("market", [
    {"text": "链上巨鲸增持 BTC", "doc_id": "doc-3"},
    {"text": "美股 CPI 超预期", "doc_id": "doc-4"},
])

# 3. 图谱检索（上下文检索，无 LLM 生成）
result = rs.query("market", "比特币走势")
print(result)

# 纯上下文检索（自定义 top_k）
ctx = rs.retrieve("market", "利率", top_k=5)

# 删除文档 / 健康检查
rs.delete("market", "doc-demo-002")
rs.health()
```

> Admin 用法（需 admin key）：`rs.create_tenant("market", "Market Data")` / `rs.generate_api_key("market", "prod", expires_days=90)` / `rs.list_api_keys("market")` / `rs.update_config(llm={"api_key": "sk-...", "model": "deepseek-chat"})`。所有方法返回 `data` 载荷，失败抛 `LightRAGClientError(status, code, message)`。

### 4.3 常见错误码

统一响应信封 `{"code": 0, "message": "ok", "data": {...}}`，错误时 `code` = HTTP 状态码：

| 状态码 | 含义 | 排查建议 |
|---|---|---|
| 401 | 未携带 key / key 无效（`Missing or invalid API key`） | 确认三 header 之一携带正确 key |
| 403 | `require_admin` 未带 admin key / legacy 路由未过门禁 | 管理端点必须 `Authorization: Bearer <ADMIN_API_KEY>` |
| 400 | 参数错误（text 为空、documents 数组为空、mode 非法等） | 核对请求体 |
| 404 | 任务/租户/key 不存在 | 确认 task_id、tenant_id |
| 409 | doc_id 已存在（幂等，注入器视为成功） | 无需处理，或用新 doc_id |
| 429 | 租户限流（默认 100 rpm） | 降低频率，或调高 `RATE_LIMIT_RPM` |
| 503 | 写队列满（`WriteQueueFull`） | 稍后重试，或调大 `TASK_QUEUE_SIZE` |

## 参考

- 源码：`projects/ragservicer/api/routes/{documents,query,admin,legacy}.py`、`api/auth.py`、`api/engine.py`
- 统一鉴权契约：`projects/shared/app_auth.py`
- Python SDK：`projects/ragservicer/sdk/python/README.md`（PyPI：lightrag-client==2.0.0），端到端样例 `sdk/python/examples/lightrag_store_and_query.py`
- 生产部署与 key 治理：`docs/infrax_tasklist.md` §4.3（nginx `/api/rag/*` → :9721）
