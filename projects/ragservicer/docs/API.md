# LightRAG Microservice — API 接口规范

> 版本: 2.1 | 日期: 2026-08-01 | 状态: 已实现

---

## 目录

1. [通用约定](#1-通用约定)
2. [认证接口](#2-认证接口)
3. [健康检查](#3-健康检查)
4. [文档管理](#4-文档管理)
5. [RAG 查询](#5-rag-查询)
6. [租户管理（Admin）](#6-租户管理admin)
7. [API Key 管理（Admin）](#7-api-key-管理admin)
8. [系统接口](#8-系统接口)
9. [错误码](#9-错误码)
10. [向后兼容路由](#10-向后兼容路由)

---

## 1. 通用约定

### 1.1 认证方式

所有 API（除健康检查）需要认证，支持三种方式（app_auth 统一契约，优先级 Bearer > X-API-Key > X-Service-Key）：

| 方式 | Header | 示例 |
|------|--------|------|
| Bearer Token | `Authorization: Bearer lr_xxxx` | 推荐（API Key / Admin Key） |
| API Key Header | `X-API-Key: lr_xxxx` | 兼容旧版 |
| Service Key Header | `X-Service-Key: lr_xxxx` | AItrader 服务间调用 |
| Tenant Header | `X-Tenant-ID: my-bot` | 服务账号多租户分片（见 1.5） |

### 1.4.1 租户模型与鉴权（R-TN）

租户由 **API Key 的归属**决定，并支持 `X-Tenant-ID` 头按租户分片（服务账号模式）：

| Key 类型 | X-Tenant-ID 行为 | 说明 |
|----------|------------------|------|
| **租户 Key**（默认） | 忽略（恒为 key 绑定租户） | 每租户独立 key，天然隔离 |
| **共享 Key**（`tenant_scope='*'`） | 生效 | 可经 X-Tenant-ID 访问**任意已存在**租户 |
| **共享 Key**（`tenant_scope='t1,t2'`） | 生效 | 仅允许列表内的已存在租户 |
| Admin Key | 忽略（恒为 `admin`） | 平台侧管理端点专用 |
| Bridge Key（`RAGSERVICER_API_KEY`） | 生效（缺省 `default`） | 内部服务间透传 |

要点：

- 业务端点（文档/检索/图谱）用租户 Key 或共享 Key；`X-Tenant-ID` 指定的租户**必须已存在**（租户由 Admin API 创建，不会隐式自动创建），否则返回 `403 TENANT_FORBIDDEN`。
- 管理端点（租户 CRUD、Key 签发/revoke/scope）仅接受 `Authorization: Bearer <ADMIN_API_KEY>`（不接受 X-API-Key），否则 `403 Admin access required`。
- 共享 Key 授权范围通过 `POST /api/v1/keys/{key_id}/scope` 设置（`scope`：`''` 仅绑定租户 / `'*'` 任意已存在租户 / `'t1,t2'` 允许列表）。

### 1.2 通用请求头

```
Content-Type: application/json
Authorization: Bearer lr_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### 1.3 通用响应格式

成功:
```json
{
  "success": true,
  "...": "..."
}
```

错误:
```json
{
  "error": "描述信息"
}
```

### 1.4 HTTP 状态码

| 状态码 | 含义 |
|--------|------|
| 200 | 成功 |
| 201 | 创建成功 |
| 400 | 请求参数错误 |
| 401 | 未认证 |
| 403 | 权限不足（非 Admin） |
| 404 | 资源不存在 |
| 429 | 速率限制 |
| 500 | 服务端错误 |

---

## 2. 认证接口

暂无独立的登录/token 接口。API Key 由管理员通过 Admin API 签发后，直接用于认证。

---

## 3. 健康检查

### GET /api/v1/health

无需认证。

**响应** `200`:
```json
{
  "status": "ok",
  "service": "lightrag-microservice",
  "instances": 3
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `status` | string | `"ok"` 或 `"degraded"` |
| `service` | string | 服务标识 |
| `instances` | int | 当前活跃的 (tenant, namespace) 实例数 |

---

## 4. 文档管理

### 4.1 插入/更新文档

```http
POST /api/v1/namespaces/{namespace}/documents
```

> 如 doc_id 已存在则覆盖（upsert）。

**路径参数**:

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `namespace` | string | 是 | 命名空间，如 `docs`, `faq`, `manual` |

**请求体**:
```json
{
  "text": "LightRAG 是一个基于图结构的 RAG 引擎...",
  "doc_id": "intro.md"
}
```

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `text` | string | 是 | — | 文档纯文本内容 |
| `doc_id` | string | 否 | `"document.txt"` | 唯一文档标识，建议用文件名 |
| `metadata` | object | 否 | `{}` | 自定义元数据（暂未实现） |

**响应** `200`:
```json
{
  "success": true,
  "doc_id": "intro.md",
  "tenant": "my-project",
  "namespace": "docs"
}
```

**错误**:
- `400`: `text` 为空
- `401`: 认证失败
- `429`: 速率限制
- `500`: 处理失败

---

### 4.2 批量插入文档

```http
POST /api/v1/namespaces/{namespace}/documents/batch
```

**请求体**:
```json
{
  "documents": [
    { "text": "文档1内容...", "doc_id": "file1.md" },
    { "text": "文档2内容...", "doc_id": "file2.md" }
  ]
}
```

> 单批次最多 50 篇。

**响应** `200`:
```json
{
  "success": true,
  "count": 2,
  "tenant": "my-project",
  "namespace": "docs"
}
```

---

### 4.3 列出文档 [TODO — 路线图 Phase 2]

```http
GET /api/v1/namespaces/{namespace}/documents
```

> **状态**: 接口已定义但后端尚未实现。当前调用返回 404。

**查询参数**:

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `page` | int | `1` | 页码 |
| `limit` | int | `20` | 每页数量 |

**响应** `200`:
```json
{
  "namespace": "docs",
  "documents": [
    {
      "doc_id": "intro.md",
      "size_bytes": 12500,
      "chunk_count": 8,
      "created_at": "2026-07-30T08:30:00Z",
      "status": "indexed"
    }
  ],
  "total": 1,
  "page": 1,
  "limit": 20
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `doc_id` | string | 文档标识 |
| `size_bytes` | int | 原始文本大小 |
| `chunk_count` | int | 分块数量 |
| `created_at` | string | ISO 8601 时间 |
| `status` | string | `"indexed"` / `"indexing"` / `"error"` |

---

### 4.4 获取文档详情 [TODO — 路线图 Phase 2]

```http
GET /api/v1/namespaces/{namespace}/documents/{doc_id}
```

> **状态**: 接口已定义但后端尚未实现。当前调用返回 404。

**响应** `200`:
```json
{
  "doc_id": "intro.md",
  "namespace": "docs",
  "size_bytes": 12500,
  "chunk_count": 8,
  "created_at": "2026-07-30T08:30:00Z",
  "status": "indexed",
  "tenant": "my-project"
}
```

**错误**:
- `404`: 文档不存在

---

### 4.5 删除文档

```http
DELETE /api/v1/namespaces/{namespace}/documents/{doc_id}
```

**响应** `200`:
```json
{
  "success": true,
  "doc_id": "intro.md",
  "deleted": true
}
```

**错误**:
- `404`: 文档不存在

---

## 5. RAG 查询

### 5.1 文本查询

```http
POST /api/v1/namespaces/{namespace}/query
```

**请求体**:
```json
{
  "query": "LightRAG 是什么？",
  "mode": "mix"
}
```

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `query` | string | 是 | — | 查询文本 |
| `mode` | string | 否 | `"mix"` | 查询模式 |

**查询模式说明**:

| mode | 说明 | 适用场景 |
|------|------|----------|
| `mix` | 混合（推荐） | 通用问答 |
| `local` | 局部：向量检索 | 精确匹配 |
| `global` | 全局：图谱检索 | 宏观/总结问题 |
| `hybrid` | local + global 融合 | 综合场景 |
| `naive` | 朴素：仅文本 | 关键词匹配 |

**响应** `200`:
```json
{
  "success": true,
  "context": "LightRAG 是一个基于图结构的检索增强生成（RAG）引擎...",
  "mode": "mix",
  "tenant": "my-project",
  "namespace": "docs"
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `context` | string | 检索到的知识图谱和文档上下文（非 LLM 回答） |
| `mode` | string | 实际使用的查询模式 |
| `tenant` | string | 租户 ID |
| `namespace` | string | 命名空间 |
| `success` | bool | 始终为 `true` |

> **注意**: 本服务只返回检索上下文，不调用 LLM 生成最终回答。调用方需自行将 context 传给自己的 LLM。

---

### 5.2 流式查询（SSE）[TODO — 路线图 Phase 2]

```http
POST /api/v1/namespaces/{namespace}/query/stream
```

> **状态**: 接口已定义但后端尚未实现。

**请求体**: 同 [5.1](#51-文本查询)。

**响应**: `text/event-stream`:
```
event: chunk
data: {"text": "LightRAG "}

event: chunk
data: {"text": "是一个"}

event: chunk
data: {"text": "基于..."}

event: done
data: {}
```

---

### 5.3 仅检索（不调用 LLM）

```http
POST /api/v1/namespaces/{namespace}/retrieve
```

**请求体**:
```json
{
  "query": "LightRAG 工作原理",
  "mode": "mix",
  "top_k": 5
}
```

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `query` | string | 是 | — | 查询文本 |
| `mode` | string | 否 | `"mix"` | 检索模式 |
| `top_k` | int | 否 | `5` | 返回 chunk 数量 |

**响应** `200`:
```json
{
  "success": true,
  "context": "LightRAG 的核心特点是使用知识图谱...\n\n---\n\n实体关系: ...",
  "mode": "mix",
  "top_k": 5,
  "tenant": "my-project",
  "namespace": "docs"
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `context` | string | 检索到的原始上下文（chunks + 图谱路径） |
| `mode` | string | 检索模式 |
| `top_k` | int | 实际使用的 top_k 值 |
| `tenant` | string | 租户 ID |
| `namespace` | string | 命名空间 |
| `success` | bool | 始终为 `true` |

---

## 6. 租户管理（Admin）

> 所有 Admin API 需要 `Authorization: Bearer {ADMIN_API_KEY}` 认证。

### 6.1 创建租户

```http
POST /api/v1/tenants
```

**请求体**:
```json
{
  "tenant_id": "project-alpha",
  "name": "项目 Alpha",
  "description": "产品文档知识库"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `tenant_id` | string | 是 | 唯一标识，建议小写+短横线 |
| `name` | string | 否 | 显示名称，默认等于 tenant_id |
| `description` | string | 否 | 描述 |

**响应** `201`:
```json
{
  "tenant_id": "project-alpha",
  "name": "项目 Alpha",
  "description": "产品文档知识库"
}
```

---

### 6.2 列出所有租户

```http
GET /api/v1/tenants
```

**响应** `200`:
```json
{
  "tenants": [
    {
      "id": "project-alpha",
      "name": "项目 Alpha",
      "description": "产品文档知识库",
      "created_at": "2026-07-30T08:00:00Z",
      "active": true
    }
  ]
}
```

---

### 6.3 获取租户详情 [TODO — 路线图 Phase 3]

```http
GET /api/v1/tenants/{tenant_id}
```

> **状态**: 接口已定义但后端尚未实现。当前调用返回 404。

**响应** `200`:
```json
{
  "tenant_id": "project-alpha",
  "name": "项目 Alpha",
  "description": "产品文档知识库",
  "created_at": "2026-07-30T08:00:00Z",
  "active": true,
  "stats": {
    "document_count": 15,
    "total_size_bytes": 245000,
    "last_activity": "2026-07-30T08:35:00Z"
  }
}
```

---

### 6.4 停用租户

```http
DELETE /api/v1/tenants/{tenant_id}
```

> 停用后 API Key 全部失效，数据保留。

**响应** `200`:
```json
{
  "success": true
}
```

---

## 7. API Key 管理（Admin）

### 7.1 生成 API Key

```http
POST /api/v1/tenants/{tenant_id}/keys
```

**请求体**:
```json
{
  "name": "生产环境",
  "expires_days": 365
}
```

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `name` | string | 否 | `"default"` | Key 名称 |
| `expires_days` | int | 否 | `0`（永不过期） | 过期天数 |

**响应** `201`:
```json
{
  "key_id": "key_a1b2c3d4e5f6g7h8",
  "tenant_id": "project-alpha",
  "name": "生产环境",
  "key": "lr_baad1d9838198cf2d37419d74d8d5302c517339af1d8229a",
  "key_prefix": "lr_baad1d983",
  "created_at": "2026-07-30T08:45:00Z",
  "expires_at": "2027-07-30T08:45:00Z"
}
```

> **重要**: `key` 字段仅在创建时返回一次。请立即安全保存，无法再次获取。

---

### 7.2 列出 API Key

```http
GET /api/v1/tenants/{tenant_id}/keys
```

**响应** `200`:
```json
{
  "keys": [
    {
      "id": "key_a1b2c3d4",
      "tenant_id": "project-alpha",
      "name": "生产环境",
      "key_prefix": "lr_baad1d983",
      "created_at": "2026-07-30T08:45:00Z",
      "last_used_at": "2026-07-30T09:00:00Z",
      "expires_at": "2027-07-30T08:45:00Z",
      "active": true
    }
  ]
}
```

> 不返回完整 Key，仅返回前 12 字符前缀。

---

### 7.3 撤销 API Key

```http
POST /api/v1/keys/{key_id}/revoke
```

**响应** `200`:
```json
{
  "success": true
}
```

> 立即生效，使用该 Key 的后续请求返回 401。

---

### 7.4 设置 Key 租户访问范围（共享 Key / R-TN）

共享 Key 通过 `X-Tenant-ID` 头按租户分片，授权范围在此设置：

```http
POST /api/v1/keys/{key_id}/scope
Authorization: Bearer <ADMIN_API_KEY>
```

**请求体**:
```json
{
  "scope": "*"
}
```

| `scope` 值 | 含义 |
|------------|------|
| `""`（空） | 仅 key 绑定租户（默认，X-Tenant-ID 无效） |
| `"*"` | 可经 X-Tenant-ID 访问任意**已存在**租户 |
| `"t1,t2"` | 仅允许列表内的已存在租户 |

**响应** `200`:
```json
{
  "code": 0,
  "message": "ok",
  "data": { "key_id": "key_a1b2c3d4", "scope": "*" }
}
```

> 目标租户必须已通过 `POST /api/v1/tenants` 创建；`X-Tenant-ID` 指向未授权/不存在的租户时业务端点返回 `403 TENANT_FORBIDDEN`。

---

## 8. Prometheus Metrics [TODO — 路线图 Phase 2]

```http
GET /metrics
```

> **状态**: 接口已定义但后端尚未实现。

返回 Prometheus 格式指标。

**指标列表**:

| 指标 | 类型 | 说明 |
|------|------|------|
| `lightrag_requests_total{endpoint, status}` | Counter | 请求总数 |
| `lightrag_request_duration_seconds{endpoint}` | Histogram | 请求延迟 |
| `lightrag_active_instances` | Gauge | 活跃 RAG 实例数 |
| `lightrag_documents_total{tenant}` | Gauge | 文档总数 |
| `lightrag_llm_errors_total` | Counter | LLM 调用错误 |

---

### 8.2 管理员实例列表

```http
GET /api/v1/instances
```

**响应** `200`:
```json
{
  "instances": [
    { "tenant_id": "project-alpha", "namespace": "docs" },
    { "tenant_id": "project-alpha", "namespace": "faq" },
    { "tenant_id": "project-beta", "namespace": "docs" }
  ]
}
```

---

## 9. 错误码

### 9.1 标准错误

| HTTP | code | error 内容 | 触发条件 |
|------|------|------------|----------|
| 400 | `VALIDATION_ERROR` | `"text is required"` | 插入文档时 text 为空 |
| 400 | `VALIDATION_ERROR` | `"query is required"` | 查询时 query 为空 |
| 400 | `VALIDATION_ERROR` | `"Invalid mode 'xxx'"` | 查询模式不在允许列表中 |
| 400 | `VALIDATION_ERROR` | `"top_k must be >= 1"` | top_k 参数无效 |
| 400 | — | `"documents[0].text is required"` | 批量插入时某文档缺 text |
| 400 | — | `"tenant_id is required"` | 创建租户时缺 tenant_id |
| 401 | — | `"Missing or invalid API key"` | API Key 无效/过期 |
| 403 | — | `"Admin access required"` | 非 Admin 访问 Admin API |
| 403 | — | `"Admin access required for legacy routes"` | 旧版路由需要 admin key |
| 404 | — | `"Tenant 'xxx' not found"` | 租户不存在 |
| 429 | — | `"Rate limit exceeded. Try again later."` | 超过速率限制 |
| 500 | — | `"Internal error: ..."` | 服务端内部错误 |

### 9.2 错误响应格式

```json
{
  "error": "描述信息",
  "code": "VALIDATION_ERROR"
}
```

> `code` 字段仅在验证错误时出现，用于客户端程序化判断。

---

## 10. 向后兼容路由 [移除计划: v3.0]

以下路由为向后兼容保留，**不推荐新项目使用**。这些路由使用 bot_id 同时作为 tenant_id 和 namespace。

> **认证**: 若服务端配置了 `ADMIN_API_KEY`，则需要 `Authorization: Bearer {ADMIN_API_KEY}` Header。若未配置 admin key，则无需认证（向后兼容旧版调用）。

| 方法 | 路径 | 对应新版路由 |
|------|------|-------------|
| POST | `/api/v1/bots/{bot_id}/documents` | `POST /namespaces/{bot_id}/documents` |
| POST | `/api/v1/bots/{bot_id}/documents/batch` | `POST /namespaces/{bot_id}/documents/batch` |
| POST | `/api/v1/bots/{bot_id}/query` | `POST /namespaces/{bot_id}/query` |
