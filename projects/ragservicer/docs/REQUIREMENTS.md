# LightRAG Microservice — 需求规格说明书

> 版本: 2.0 | 日期: 2026-07-30 | 状态: Draft

---

## 1. 项目背景与目标

### 1.1 背景

AIServicer 是一个多 Bot（客服/销售/自定义/链上交易）SaaS 平台，Bot 需要基于上传的文档（产品手册、FAQ、技术文档等）进行 RAG（检索增强生成）问答。当前 LightRAG 以内嵌服务方式运行，与主后端紧耦合。

客户和第三方项目同样有 RAG 需求——上传项目文档后，通过 API 或 AI Agent（MCP）进行智能检索。**需要将 LightRAG 抽象为独立微服务**，任何项目只需获取一个 API Key 即可接入。

### 1.2 目标

| 目标 | 描述 | 成功指标 |
|------|------|----------|
| **独立部署** | LightRAG 作为独立进程运行，与 AIServicer 主服务解耦 | Docker / systemd 一键部署 |
| **多租户隔离** | 不同项目（租户）之间的文档完全隔离 | 租户 A 查询不到租户 B 的文档 |
| **3 种接入方式** | REST API / MCP 协议 / SDK（TS+Python） | 每种方式端到端可用 |
| **API Key 管理** | 管理员可创建租户、签发/撤销 API Key | Web UI 或 Admin API 操作 |
| **生产就绪** | 速率限制、审计日志、监控指标、优雅关闭 | 99.5% 可用性 |

### 1.3 非目标（不做）

- 不提供 Web UI 管理界面（复用 AIServicer 主面板）
- 不做文档解析（PDF/Word→文本由调用方处理）
- 不做用户权限系统（租户内部不再细分用户）
- 不做分布式集群（单实例 + PG 足够）

---

## 2. 用户角色与场景

### 2.1 角色定义

| 角色 | 职责 | 权限 |
|------|------|------|
| **系统管理员** | 管理租户、签发 API Key、监控服务 | 所有 Admin API |
| **项目开发者** | 在自己的 namespace 上传文档、执行查询 | tenant 范围内的文档 CRUD + Query |
| **AI Agent** | 通过 MCP 协议自动调用 RAG 工具 | 与项目开发者相同 |

### 2.2 核心使用场景

#### 场景 1: AIServicer Bot 知识库

```
商家上传产品文档 → AIServicer 后端调用 LightRAG API
→ 文档被分块、Embedding、存入向量索引
→ 终端用户提问 → Bot 调用 LightRAG Query → 返回相关上下文 → LLM 生成回答
```

#### 场景 2: 第三方项目本地接入

```
第三方开发者注册 → 管理员创建 tenant + 签发 API Key
→ 开发者配置 SDK: new LightRAGClient({apiKey: 'lr_xxx'})
→ client.insert('docs', projectContent, 'README.md')
→ client.query('docs', '如何部署？') → 返回相关文档片段
```

#### 场景 3: AI Agent 自动调用（MCP）

```
IDE 配置 mcp.json → Claude/Cursor 启动 MCP Server
→ Agent 调用 lightrag_insert_document(namespace="my-project", text="...", doc_id="spec.md")
→ Agent 调用 lightrag_query(namespace="my-project", query="数据库设计？")
→ Agent 获得检索结果，辅助代码生成/问答
```

---

## 3. 功能需求

### 3.1 租户管理（Admin API）

| ID | 功能 | 接口 | 备注 |
|----|------|------|------|
| F-T01 | 创建租户 | `POST /api/v1/tenants` | 需 Admin Key 认证 |
| F-T02 | 列出所有租户 | `GET /api/v1/tenants` | 返回 id, name, status, created_at |
| F-T03 | 停用/删除租户 | `DELETE /api/v1/tenants/{id}` | 级联删除其 API Key，保留数据 |
| F-T04 | 查询租户详情 | `GET /api/v1/tenants/{id}` | 返回用量统计 |

### 3.2 API Key 管理

| ID | 功能 | 接口 | 备注 |
|----|------|------|------|
| F-K01 | 为租户生成 API Key | `POST /api/v1/tenants/{id}/keys` | 支持设置过期时间，Key 仅返回一次 |
| F-K02 | 列出租户所有 Key | `GET /api/v1/tenants/{id}/keys` | 不返回完整 Key，仅返回前缀 |
| F-K03 | 撤销 API Key | `POST /api/v1/keys/{id}/revoke` | 立即生效 |
| F-K04 | Key 使用统计 | 内嵌于 F-K02 | last_used_at, 调用次数 |

### 3.3 文档管理

| ID | 功能 | 接口 | 备注 |
|----|------|------|------|
| F-D01 | 上传文档 | `POST /api/v1/namespaces/{ns}/documents` | text + doc_id，支持 upsert |
| F-D02 | 批量上传 | `POST /api/v1/namespaces/{ns}/documents/batch` | 最多 50 篇/批次 |
| F-D03 | 删除文档 | `DELETE /api/v1/namespaces/{ns}/documents/{id}` | 删除 chunks + embeddings |
| F-D04 | 列出已上传文档 | `GET /api/v1/namespaces/{ns}/documents` | 分页，返回 doc_id + 状态 + 时间 |
| F-D05 | 获取文档详情 | `GET /api/v1/namespaces/{ns}/documents/{id}` | chunk 数量等 |

### 3.4 RAG 查询

| ID | 功能 | 接口 | 备注 |
|----|------|------|------|
| F-Q01 | 文本查询 | `POST /api/v1/namespaces/{ns}/query` | 支持 5 种模式: naive/local/global/hybrid/mix |
| F-Q02 | 流式查询 (SSE) | `POST /api/v1/namespaces/{ns}/query/stream` | 适用于聊天场景 |
| F-Q03 | 仅检索（无 LLM） | `POST /api/v1/namespaces/{ns}/retrieve` | 返回原始 chunks，不调用 LLM |

### 3.5 MCP 工具

| ID | 工具名称 | 参数 | 说明 |
|----|----------|------|------|
| F-M01 | `lightrag_insert_document` | namespace, text, doc_id | 插入文档 |
| F-M02 | `lightrag_query` | namespace, query, mode | RAG 查询 |
| F-M03 | `lightrag_delete_document` | namespace, doc_id | 删除文档 |
| F-M04 | `lightrag_list_documents` | namespace | 列出文档 |
| F-M05 | `lightrag_retrieve` | namespace, query, top_k | 仅检索 chunks |

### 3.6 系统运维

| ID | 功能 | 接口 | 备注 |
|----|------|------|------|
| F-S01 | 健康检查 | `GET /api/v1/health` | 无需认证 |
| F-S02 | Prometheus Metrics | `GET /metrics` | 请求数/延迟/错误率/活跃实例 |
| F-S03 | 审计日志 | 文件/appender | 记录所有 API 调用 |
| F-S04 | 速率限制 | 中间件 | 按 API Key + IP，默认 100 req/min |

---

## 4. 非功能需求

### 4.1 性能

| 指标 | 目标 | 测试方法 |
|------|------|----------|
| 文档插入延迟 | < 5s（10KB 文本） | 单文档插入 P95 |
| 查询延迟 | < 3s（mix 模式） | P95 |
| 并发查询 | 10 QPS 不降级 | 压测 |

### 4.2 安全

| 要求 | 实现方式 |
|------|----------|
| API 认证 | Bearer Token (lr_xxx)，SHA-256 哈希存储 |
| 传输加密 | 反向代理 TLS（Caddy/Nginx） |
| 租户隔离 | (tenant_id, namespace) 独立 LightRAG 实例 |
| 密钥安全 | 所有密钥通过环境变量注入，不入库 |
| 输入校验 | JSON Schema 校验请求体 |

### 4.3 可靠性

- 优雅关闭：SIGTERM → 停止接收新请求 → 等待进行中请求完成 → 退出（最长 30s）
- 自动重启：systemd `Restart=always` 或 Docker `restart: unless-stopped`
- 数据持久化：Worker 目录映射到持久化卷（本地或 PG）

### 4.4 可维护性

- 模块解耦：routes / engine / tenants / adapters 独立模块
- 零硬编码：所有配置值通过 config.py + 环境变量管理
- 大文件限制：单文件 ≤ 200 行，超过则拆分
- 测试覆盖：核心逻辑 ≥ 80%

---

## 5. SDK 与分发需求

### 5.1 TypeScript SDK

```typescript
// npm install @aiservicer/lightrag-sdk
import { LightRAGClient } from '@aiservicer/lightrag-sdk';
const rag = new LightRAGClient({ baseUrl: '...', apiKey: 'lr_xxx' });
await rag.insert('ns', 'text', 'id');
const result = await rag.query('ns', 'question');
```

### 5.2 Python SDK

```python
# pip install lightrag-client
from lightrag_client import LightRAGClient
rag = LightRAGClient(base_url="...", api_key="lr_xxx")
rag.insert("ns", "text", "id")
result = rag.query("ns", "question")
```

### 5.3 分发渠道

| 包 | 平台 | 包名 |
|----|------|------|
| TypeScript SDK | npm | `@aiservicer/lightrag-sdk` |
| Python SDK | PyPI | `lightrag-client` |
| Docker 镜像 | Docker Hub | `aiservicer/lightrag:latest` |

---

## 6. 约束与假设

### 约束

- LLM 后端依赖 DeepSeek API（可替换为任何 OpenAI 兼容 API）
- Embedding 默认使用本地 `all-MiniLM-L6-v2`（避免外部 API 费用）
- Python 3.11+（与 LightRAG 库兼容）
- SQLite 用于租户管理（轻量），RAG 数据存储可选 local/Postgres

### 假设

- 调用方负责文档预处理（PDF/Word→纯文本）
- 单文档大小 < 500KB（受 LLM token 限制）
- MCP 客户端支持 STDIO 传输（Claude/Cursor/Trae 均支持）
- 生产环境有反向代理提供 TLS

---

## 7. 术语表

| 术语 | 定义 |
|------|------|
| **Tenant（租户）** | 一个独立的项目/组织，拥有自己的文档和 API Key |
| **Namespace（命名空间）** | 租户内的文档集合（如 `docs`, `faq`, `manual`） |
| **API Key** | 格式 `lr_` + 48 位十六进制，用于认证 API 请求 |
| **RAG** | Retrieval-Augmented Generation，检索增强生成 |
| **MCP** | Model Context Protocol，AI Agent 与工具之间的标准协议 |
| **SSE** | Server-Sent Events，服务端推送（流式响应） |
| **Chunk** | 文档分块，是 RAG 检索的最小单位 |
| **Embedding** | 文本向量化，用于语义检索 |
