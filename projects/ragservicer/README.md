# LightRAG Microservice

独立部署的多租户 RAG（检索增强生成）微服务。支持 REST API 和 MCP 协议，任何项目都可以通过 API Key 接入。

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│                    LightRAG Microservice                     │
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

### 1. 启动服务

```bash
cd lightrag-service
pip install -r requirements.txt
python main.py
```

服务启动后：
- REST API: `http://localhost:9721`
- MCP Server: STDIO 模式（IDE 配置自动启动）

### 2. 创建租户和 API Key

```bash
# 创建租户
curl -X POST http://localhost:9721/api/v1/tenants \
  -H "Authorization: Bearer admin-master-key-change-in-production" \
  -H "Content-Type: application/json" \
  -d '{"tenant_id": "my-project", "name": "我的项目"}'

# 生成 API Key
curl -X POST http://localhost:9721/api/v1/tenants/my-project/keys \
  -H "Authorization: Bearer admin-master-key-change-in-production" \
  -H "Content-Type: application/json" \
  -d '{"name": "默认Key"}'
```

### 3. 使用 API

```bash
# 上传文档
curl -X POST http://localhost:9721/api/v1/namespaces/docs/documents \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"text": "LightRAG 是一个..." , "doc_id": "intro.txt"}'

# 查询
curl -X POST http://localhost:9721/api/v1/namespaces/docs/query \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"query": "LightRAG 是什么？", "mode": "mix"}'
```

### 4. TypeScript SDK

```typescript
import { LightRAGClient } from './sdk';

const rag = new LightRAGClient({
  baseUrl: 'http://localhost:9721',
  apiKey: 'lr_xxxx',
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

## API 路由

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/health` | 健康检查 |
| POST | `/api/v1/namespaces/{ns}/documents` | 插入文档 |
| POST | `/api/v1/namespaces/{ns}/documents/batch` | 批量插入 |
| DELETE | `/api/v1/namespaces/{ns}/documents/{id}` | 删除文档 |
| POST | `/api/v1/namespaces/{ns}/query` | RAG 查询 |
| POST | `/api/v1/tenants` | 创建租户 (admin) |
| GET | `/api/v1/tenants` | 列出租户 (admin) |
| POST | `/api/v1/tenants/{id}/keys` | 生成 API Key (admin) |
| GET | `/api/v1/tenants/{id}/keys` | 列出 Keys (admin) |
| POST | `/api/v1/keys/{id}/revoke` | 撤销 Key (admin) |

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
