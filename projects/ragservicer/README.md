# InfraX RAGservicer（原 LightRAG Microservice）

独立部署的多租户 RAG（检索增强生成）微服务。支持 REST API 和 MCP 协议，任何项目都可以通过 API Key 接入，知识库数据按「租户 + 命名空间」隔离。

## 核心特性

- **多租户隔离**：`(tenant_id, namespace)` 独立数据空间与权限边界
- **灵活租户模型**：租户 Key（key 归属即租户）或共享 Key + `X-Tenant-ID` 分片（服务账号模式）
- **授权边界**：`X-Tenant-ID` 越权访问被拒绝（`403 TENANT_FORBIDDEN`），租户由服务端创建、不隐式自动创建
- **Key 治理**：Admin Key 统一管理租户与 Key（签发/撤销/scope）
- **统一鉴权契约**：`Bearer` / `X-API-Key` / `X-Service-Key`（app_auth）
- **结构化审计**：每次调用写入 SQLite `audit_logs`（谁/何时/改了什么）

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│                    InfraX RAGservicer                        │
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────┐  │
│  │ REST API  │  │ MCP STDIO │  │ Tenant   │  │  RAG Engine │  │
│  │ (Flask)   │  │  Server   │  │ Manager  │  │ (LightRAG)  │  │
│  │ :9721     │  │           │  │ (SQLite) │  │              │  │
│  └─────┬─────┘  └─────┬─────┘  └────┬─────┘  └──────┬───────┘  │
│        │              │             │               │          │
│        └──────────────┴─────────────┴───────────────┘          │
│                              │                                  │
│                    ┌─────────┴─────────┐                       │
│                    │  Storage Backend   │                       │
│                    │  local JSON / PG   │                       │
│                    └───────────────────┘                       │
└─────────────────────────────────────────────────────────────┘
```

## 快速开始

> 生产环境（systemd / Docker）完整部署、`.env` 密钥配置与验证清单见 [docs/infrax_tasklist.md](../../docs/infrax_tasklist.md)。

### 1. 启动服务

```bash
cd lightrag-service
pip install -r requirements.txt
# 启动前配置 .env：ADMIN_API_KEY=<强随机值>（管理端点用），RAGSERVICER_API_KEY=<bridge key>
python main.py
```

服务启动后：
- REST API: `http://localhost:9721`
- MCP Server: STDIO 模式（IDE 配置自动启动）

### 2. 创建租户和 API Key

管理端点使用 `Authorization: Bearer <ADMIN_API_KEY>`（来自环境变量 `ADMIN_API_KEY`）：

```bash
# 创建租户
curl -X POST http://localhost:9721/api/v1/tenants \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"tenant_id": "my-project", "name": "我的项目"}'

# 生成 API Key（响应中的 key 字段仅返回一次，请立即保存）
curl -X POST http://localhost:9721/api/v1/tenants/my-project/keys \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "prod", "expires_days": 0}'
```

### 3. 使用 API

**方式 A：租户 Key（每租户独立 key，天然隔离）**

```bash
# 上传文档
curl -X POST http://localhost:9721/api/v1/namespaces/docs/documents \
  -H "X-API-Key: <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"text": "RAGservicer 支持多租户...", "doc_id": "intro.txt"}'

# 查询
curl -X POST http://localhost:9721/api/v1/namespaces/docs/query \
  -H "X-API-Key: <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"query": "什么是多租户？", "mode": "mix"}'
```

**方式 B：共享 Key + X-Tenant-ID（单 key 多租户分片，B 端平台推荐）**

```bash
# 1) 共享 Key 设置访问范围（scope: "" 仅绑定租户 / "*" 任意已存在租户 / "t1,t2" 列表）
curl -X POST http://localhost:9721/api/v1/keys/{key_id}/scope \
  -H "Authorization: Bearer $ADMIN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"scope": "*"}'

# 2) 业务请求带 X-Tenant-ID 分片（target 租户必须已通过 /tenants 创建）
curl -X POST http://localhost:9721/api/v1/namespaces/{bot-ns}/query \
  -H "X-API-Key: <SHARED_KEY>" \
  -H "X-Tenant-ID: <botId>" \
  -H "Content-Type: application/json" \
  -d '{"query": "xxx", "mode": "mix"}'
# → {"code":0,"data":{"tenant":"<botId>","namespace":"{bot-ns}",...}}
```

> `X-Tenant-ID` 指向未授权或不存在租户时返回 `403 TENANT_FORBIDDEN`（权限边界，实测生效）。

### 4. TypeScript SDK

```typescript
import { LightRAGClient } from './sdk';

const rag = new LightRAGClient({
  baseUrl: 'http://localhost:9721',
  apiKey: 'lr_xxxx',
  tenantId: 'my-bot',   // 可选：服务账号模式传 X-Tenant-ID
});

await rag.insert('docs', '内容...', 'doc-1');
const result = await rag.query('docs', '问题？');
```

### 5. MCP 集成

在 IDE 的 `mcp.json` 中添加：

```json
{
  "mcpServers": {
    "lightrag": {
      "command": "python",
      "args": ["main.py", "--mcp"],
      "cwd": "/path/to/lightrag-service",
      "env": { "MCP_TENANT_ID": "my-project" }
    }
  }
}
```

## 认证与租户模型

### 认证方式（app_auth 统一契约，优先级 Bearer > X-API-Key > X-Service-Key）

| 方式 | Header | 说明 |
|------|--------|------|
| Bearer Token | `Authorization: Bearer <key>` | 推荐（API Key / Admin Key） |
| API Key Header | `X-API-Key: <key>` | 兼容旧版 |
| Service Key Header | `X-Service-Key: <key>` | 服务间调用 |
| Tenant Header | `X-Tenant-ID: <botId>` | 共享 Key 按租户分片 |

### 租户模型

| Key 类型 | X-Tenant-ID 行为 | 适用场景 |
|---|---|---|
| 租户 Key（默认） | 忽略（恒为 key 绑定租户） | 每租户独立 key，天然隔离 |
| 共享 Key（`scope='*'`） | 生效 | 单一共享 key + 按 botId 分片 |
| 共享 Key（`scope='t1,t2'`） | 生效（限列表） | 指定租户白名单 |
| Admin Key | 忽略（恒为 `admin`） | 平台侧租户/Key 管理 |
| Bridge Key（`RAGSERVICER_API_KEY`） | 生效（缺省 `default`） | 内部服务间透传 |

要点：

- 业务端点（文档/检索/图谱）用租户 Key 或共享 Key；`X-Tenant-ID` 指定的租户**必须已存在**（由 Admin API 创建，不隐式自动创建），否则 `403 TENANT_FORBIDDEN`。
- 管理端点仅接受 `Authorization: Bearer <ADMIN_API_KEY>`（不接受 X-API-Key），否则 `403 Admin access required`。
- 共享 Key 授权范围通过 `POST /api/v1/keys/{key_id}/scope` 设置。

## API 路由

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/health` | 健康检查 |
| POST | `/api/v1/namespaces/{ns}/documents` | 插入文档 |
| POST | `/api/v1/namespaces/{ns}/documents/batch` | 批量插入 |
| DELETE | `/api/v1/namespaces/{ns}/documents/{id}` | 删除文档 |
| POST | `/api/v1/namespaces/{ns}/query` | RAG 查询 |
| POST | `/api/v1/namespaces/{ns}/retrieve` | 上下文检索（不带 LLM 生成） |
| GET | `/api/v1/factors/graph/entities` | 图谱实体（服务间 key） |
| GET | `/api/v1/tenants` | 列出租户 (admin) |
| POST | `/api/v1/tenants` | 创建租户 (admin) |
| DELETE | `/api/v1/tenants/{id}` | 删除租户 (admin) |
| GET | `/api/v1/tenants/{id}/keys` | 列出 Keys (admin) |
| POST | `/api/v1/tenants/{id}/keys` | 生成 API Key (admin) |
| POST | `/api/v1/keys/{id}/revoke` | 撤销 Key (admin) |
| POST | `/api/v1/keys/{id}/scope` | 设置 Key 租户访问范围 (admin) |
| GET | `/api/v1/instances` | 活跃实例 (admin) |
| GET | `/api/v1/admin/tasks` | 写任务统计 (admin) |
| GET/PUT | `/api/v1/admin/config` | 运行时配置 (admin) |
| GET | `/api/v1/openapi.json` | OpenAPI 3.0 文档 |

完整接口契约见 [docs/API.md](docs/API.md)。

## MCP 工具

| 工具 | 说明 |
|------|------|
| `lightrag_insert_document` | 插入文档到知识库 |
| `lightrag_query` | 混合检索查询 |
| `lightrag_delete_document` | 删除文档 |
| `lightrag_list_instances` | 列出活跃实例 |

## Docker 部署

```bash
cd lightrag-service
docker-compose up -d
```

## 存储模式

- **local** (默认): JSON 文件存储，零依赖
- **postgres**: PGVector + PGGraph + PGKV，生产环境推荐

切换方式：修改 `.env` 中 `STORAGE_MODE=postgres` 并取消 Postgres 注释。
