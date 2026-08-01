# LightRAG Microservice — 开发文档

> 版本: 2.1 | 日期: 2026-08-01 | 状态: 已实现

---

## 目录

1. [设计原则](#1-设计原则)
2. [目标架构](#2-目标架构)
3. [目录结构](#3-目录结构)
4. [模块设计](#4-模块设计)
5. [数据流](#5-数据流)
6. [配置管理](#6-配置管理)
7. [API 完整规范](#7-api-完整规范)
8. [MCP 实现规范](#8-mcp-实现规范)
9. [SDK 实现规范](#9-sdk-实现规范)
10. [部署方案](#10-部署方案)
11. [实施计划](#11-实施计划)
12. [代码规范](#12-代码规范)

---

## 1. 设计原则

| 原则 | 说明 |
|------|------|
| **单一职责** | 每个模块只做一件事。engine 不管路由，routes 不管存储 |
| **依赖注入** | 不在模块顶层创建全局状态，通过参数传递依赖 |
| **零硬编码** | 所有魔法数字/字符串进入 `config.py`，通过环境变量覆盖 |
| **200 行上限** | 单文件 > 200 行即拆分 |
| **适配器模式** | LLM/Embedding 通过适配器隔离，方便切换后端 |
| **向后兼容** | 旧版 `/v1/bots/` 路径保留但标记 deprecated |

---

## 2. 目标架构

### 2.1 分层架构图

```
┌──────────────────────────────────────────────────────────────────┐
│                         Entry Point                              │
│  main.py (50行)                                                  │
│  职责: 组装各模块 → 启动 Flask app                                │
├──────────────────────────────────────────────────────────────────┤
│                      Transport Layer                             │
│  ┌─────────────────────┐  ┌──────────────────────┐               │
│  │  REST API (Flask)    │  │  MCP STDIO Server     │              │
│  │  api/routes/          │  │  mcp_server/server.py │              │
│  │  ├─ documents.py      │  │  mcp_server/tools.py  │              │
│  │  ├─ query.py          │  └──────────┬───────────┘              │
│  │  ├─ admin.py          │             │                          │
│  │  └─ legacy.py         │             │                          │
│  └──────────┬────────────┘             │                          │
│             │                          │                          │
├─────────────┼──────────────────────────┼──────────────────────────┤
│             │     Middleware Layer      │                          │
│  ┌──────────┴──────────────────────────┴──────────┐               │
│  │  api/auth.py      认证 (API Key / Admin / Tenant)│               │
│  │  api/middleware.py 速率限制 + 审计日志            │              │
│  └──────────────────────┬─────────────────────────┘               │
│                         │                                         │
├─────────────────────────┼─────────────────────────────────────────┤
│                         │    Service Layer                        │
│  ┌──────────────────────┴─────────────────────────┐               │
│  │  api/engine.py  (100行)                        │               │
│  │  职责: LightRAG 实例池管理 + CRUD               │               │
│  │  - get_rag(tenant, ns) → LightRAG instance      │               │
│  │  - insert_document / query / delete              │               │
│  └────────┬───────────────────┬───────────────────┘              │
│           │                   │                                   │
│  ┌────────┴───────┐  ┌────────┴───────────┐                      │
│  │ api/adapters.py │  │ tenants/manager.py  │                      │
│  │ (60行)          │  │ (174行, 已稳定)     │                      │
│  │ llm_model_func  │  │ CRUD + API Key      │                      │
│  │ embedding_func  │  └────────────────────┘                      │
│  └────────┬───────┘                                               │
│           │                                                       │
├───────────┼───────────────────────────────────────────────────────┤
│           │              Infrastructure                           │
│  ┌────────┴───────┐  ┌──────────────┐  ┌──────────────────┐      │
│  │ LightRAG (hku) │  │ SQLite (WAL) │  │ Storage Backend   │      │
│  │ lightrag-hku   │  │ tenants.db   │  │ local JSON / PG   │      │
│  └────────────────┘  └──────────────┘  └──────────────────┘      │
└──────────────────────────────────────────────────────────────────┘
```

### 2.2 请求生命周期

```
HTTP Request
  │
  ▼
[Flask App] → @app.before_request
  │
  ▼
[Auth Middleware] api/auth.py
  ├─ 提取 Authorization / X-API-Key / X-Tenant-ID
  ├─ 验证 API Key (tenants/manager.validate_api_key)
  └─ 注入 tenant_id → g.tenant_id
  │
  ▼
[Rate Limiter] api/middleware.py
  ├─ 按 (tenant_id, IP) 检查 token bucket
  └─ 429 若超限
  │
  ▼
[Route Handler] api/routes/*.py
  ├─ 输入校验
  ├─ 调用 api/engine.py
  └─ 返回 JSON
  │
  ▼
[Audit Log] api/middleware.py (after_request)
  └─ 记录: timestamp, tenant, endpoint, status, duration
```

---

## 3. 目录结构

### 目标目录树

```
lightrag-service/
├── main.py                    # 入口 (50行)
├── config.py                  # 配置聚合 (50行) [NEW]
├── requirements.txt           # Python 依赖
├── Dockerfile                # 容器化
├── docker-compose.yml        # 编排
├── .env.example              # 环境变量模板
├── .gitignore                # Git 忽略规则 [NEW]
├── lightrag-microservice.service  # systemd 单元
├── mcp-config.example.json   # IDE MCP 配置模板
├── README.md                 # 项目 README
│
├── api/                      # REST API 包
│   ├── __init__.py           # 导出 api Blueprint
│   ├── auth.py               # 认证中间件 (80行)
│   ├── middleware.py          # 速率限制 + 审计 (100行)
│   ├── engine.py             # RAG 引擎核心 (180行)
│   ├── adapters.py           # LLM/Embedding 适配器 (120行)
│   ├── code_refactor.py      # 集中工具箱 (607行) [v2.1 NEW]
│   └── routes/               # 路由模块
│       ├── __init__.py       # 注册所有子路由
│       ├── documents.py      # 文档 CRUD (48行)
│       ├── query.py          # 查询路由 (41行)
│       ├── admin.py          # 租户/Key 管理 (76行)
│       └── legacy.py         # 向后兼容 (81行)
│
├── mcp_server/               # MCP 协议包
│   ├── __init__.py           # 包标记
│   ├── server.py             # STDIO 主循环 (120行) [REFACTOR]
│   └── tools.py              # 工具定义 + 处理器 (80行) [NEW]
│
├── tenants/                  # 租户管理包 (已稳定)
│   ├── __init__.py
│   └── manager.py            # SQLite CRUD (174行)
│
├── sdk/                      # TypeScript SDK
│   ├── index.ts              # 客户端类 (179行)
│   ├── types.ts              # 类型定义 [NEW]
│   └── package.json          # npm 包描述
│
├── tests/                    # 测试 [NEW]
│   ├── __init__.py
│   ├── test_engine.py        # 引擎测试
│   ├── test_auth.py          # 认证测试
│   ├── test_routes.py        # API 集成测试
│   └── conftest.py           # Fixtures
│
└── docs/                     # 文档
    ├── REQUIREMENTS.md       # 需求规格
    ├── DEVELOPMENT.md        # 本文档
    └── API.md                # API 规范
```

### 与当前状态对照

| 当前文件 | 实际行数 | 变更类型 |
|----------|----------|----------|
| `api/code_refactor.py` | 607 | **v2.1 新增** |
| `api/engine.py` | 180 | 已实现 |
| `api/routes/documents.py` | 48 | 已实现 |
| `api/routes/query.py` | 41 | 已实现 |
| `api/routes/admin.py` | 76 | 已实现 |
| `api/routes/legacy.py` | 81 | 已实现 |
| `api/auth.py` | 68 | 已实现 |
| `api/middleware.py` | 83 | 已实现 |
| `api/adapters.py` | 120 | 已实现 |
| `config.py` | 131 | 已实现 |
| `mcp_server/server.py` | 100 | 已实现 |
| `mcp_server/tools.py` | 126 | 已实现 |
| `tenants/manager.py` | 179 | 已稳定 |
| `sdk/index.ts` | 183 | 已稳定 |
| `sdk/types.ts` | 72 | 已稳定 |

---

## 4. 模块设计

### 4.1 `config.py` — 配置聚合（新建）

**设计约束**: 这是项目中**唯一**可以直接读取环境变量的模块。其他所有模块通过此模块获取配置。

```python
"""
配置聚合模块。
所有配置项通过环境变量覆盖，提供类型安全的默认值。
这是项目中唯一读取 os.getenv 的模块。
"""
import os
from dataclasses import dataclass, field

@dataclass(frozen=True)
class LLMConfig:
    binding: str = "openai"
    base_url: str = "https://api.deepseek.com/v1"
    model: str = "deepseek-chat"
    api_key: str = ""          # 无默认值，生产必须设置
    timeout: int = 120

@dataclass(frozen=True)
class EmbeddingConfig:
    model_name: str = "all-MiniLM-L6-v2"
    dims: int = 384
    max_token_size: int = 512
    timeout: int = 60

@dataclass(frozen=True)
class StorageConfig:
    mode: str = "local"         # local | postgres
    working_dir: str = "./data"

@dataclass(frozen=True)
class RAGConfig:
    max_async: int = 4
    chunk_token_size: int = 1200
    chunk_overlap: int = 100
    top_k: int = 60
    chunk_top_k: int = 20
    summary_language: str = "Chinese"

@dataclass(frozen=True)
class ServerConfig:
    host: str = "0.0.0.0"
    port: int = 9721
    mcp_enabled: bool = True
    mcp_port: int = 9722
    admin_api_key: str = ""     # 无默认值，生产必须设置

@dataclass(frozen=True)
class TenantConfig:
    db_path: str = "./tenants/tenants.db"

@dataclass(frozen=True)
class RateLimitConfig:
    enabled: bool = True
    default_rpm: int = 100      # requests per minute per tenant
    admin_rpm: int = 1000

@dataclass(frozen=True)
class AppConfig:
    llm: LLMConfig
    embedding: EmbeddingConfig
    storage: StorageConfig
    rag: RAGConfig
    server: ServerConfig
    tenant: TenantConfig
    rate_limit: RateLimitConfig
    log_level: str = "INFO"

def load_config() -> AppConfig:
    """从环境变量加载完整配置。"""
    return AppConfig(
        llm=LLMConfig(
            api_key=os.getenv("LLM_BINDING_API_KEY", ""),
            base_url=os.getenv("LLM_BINDING_HOST", LLMConfig.base_url),
            model=os.getenv("LLM_MODEL", LLMConfig.model),
            timeout=int(os.getenv("LLM_TIMEOUT", "120")),
        ),
        embedding=EmbeddingConfig(
            model_name=os.getenv("EMBEDDING_MODEL", EmbeddingConfig.model_name),
            dims=int(os.getenv("EMBEDDING_DIMS", "384")),
        ),
        storage=StorageConfig(
            mode=os.getenv("STORAGE_MODE", "local"),
            working_dir=os.getenv("WORKING_DIR", "./data"),
        ),
        rag=RAGConfig(
            top_k=int(os.getenv("TOP_K", "60")),
            chunk_top_k=int(os.getenv("CHUNK_TOP_K", "20")),
        ),
        server=ServerConfig(
            port=int(os.getenv("REST_PORT", "9721")),
            mcp_enabled=os.getenv("MCP_ENABLED", "true").lower() == "true",
            admin_api_key=os.getenv("ADMIN_API_KEY", ""),
        ),
        tenant=TenantConfig(
            db_path=os.getenv("TENANT_DB_PATH", "./tenants/tenants.db"),
        ),
        rate_limit=RateLimitConfig(),
        log_level=os.getenv("LOG_LEVEL", "INFO"),
    )
```

**关键规则**: 
- `api_key` 和 `admin_api_key` **不设默认值**，确保生产环境必须通过环境变量注入
- 使用 `@dataclass(frozen=True)` 防止运行时修改配置
- 所有硬编码值集中在此文件

### 4.2 `api/adapters.py` — LLM/Embedding 适配器（新建，从 engine.py 提取）

**职责**: 封装 LLM 和 Embedding 的外部依赖，与 LightRAG 库的接口对接。

```python
"""
LLM 和 Embedding 适配器。
封装外部依赖（DeepSeek API, SentenceTransformer），
通过函数工厂注入到 LightRAG 实例中。
"""
import asyncio
import logging

logger = logging.getLogger("lightrag.adapters")

# ── LLM 适配器工厂 ──
def create_llm_func(llm_config):
    """返回符合 LightRAG 接口的 llm_model_func。"""
    from lightrag.llm.openai import openai_complete_if_cache

    async def func(prompt, system_prompt=None, history_messages=[], **kwargs):
        return await openai_complete_if_cache(
            llm_config.model, prompt,
            system_prompt=system_prompt,
            history_messages=history_messages,
            api_key=llm_config.api_key,
            base_url=llm_config.base_url,
            **kwargs,
        )
    return func

# ── Embedding 适配器 ──
_embed_model = None

def load_embedding_model(embed_config):
    """预加载 SentenceTransformer 模型（启动时调用）。"""
    global _embed_model
    from sentence_transformers import SentenceTransformer
    logger.info(f"Loading embedding model: {embed_config.model_name}...")
    _embed_model = SentenceTransformer(embed_config.model_name)
    dim = _embed_model.get_sentence_embedding_dimension()
    logger.info(f"Embedding model loaded, dims={dim}")
    return _embed_model

def create_embedding_func():
    """返回符合 LightRAG 接口的 embedding_func。"""
    from lightrag.utils import EmbeddingFunc

    async def func(texts: list[str]):
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(
            None, lambda: _embed_model.encode(texts, normalize_embeddings=True)
        )
    return EmbeddingFunc(
        embedding_dim=_embed_model.get_sentence_embedding_dimension(),
        max_token_size=512,
        func=func
    )
```

**关键规则**: 
- `load_embedding_model` 在 `main.py` 启动时调用一次
- `create_llm_func` 和 `create_embedding_func` 是工厂函数，防止模块级全局状态
- 不依赖 `config.py` 以外的任何模块

### 4.4 — `api/code_refactor.py` — 集中工具箱 [v2.1 新增]

所有的重复代码模式集中到此模块：

- **请求解析**: `parse_json()` 替代 `request.get_json(silent=True) or {}`
- **输入校验**: `Guard(data).require("query").check_mode("mode")` 链式校验
- **错误处理**: `@handle_errors(logger, "Query failed")` 自动 try/except/log/500
- **响应构建**: `build_success()` / `build_error()` / `build_paginated()` 统一格式
- **异步工具**: `run_async()` 跨线程安全运行异步协程
- **重试**: `@retry_on_failure()` / `async_retry()` 指数退避
- **Flask 集成**: `register_tenant_on_g()` 修复 g.tenant_id 未设置的 bug

### 4.5 `api/engine.py` — RAG 引擎（已实现）

**当前问题**: 
1. 164 行混合配置/适配器/实例管理
2. `load_dotenv` 在 import 时执行（副作用）
3. 全局变量过多

**重构后**:
- 移除 LLM/Embedding 适配器 → `adapters.py`
- 移除配置读取 → 通过参数接收 `AppConfig`
- 保留：事件循环管理 + RAG 实例池 + CRUD 函数
- 目标: ≤ 100 行

```python
"""
LightRAG 引擎 — 多租户实例池管理。
每个 (tenant_id, namespace) 维护独立的 LightRAG 实例。
"""
import asyncio
import logging
import threading
from pathlib import Path
from typing import Optional

logger = logging.getLogger("lightrag.engine")

_loop: Optional[asyncio.AbstractEventLoop] = None

def start_event_loop():
    global _loop
    _loop = asyncio.new_event_loop()
    asyncio.set_event_loop(_loop)
    _loop.run_forever()

def _run_async(coro, timeout=300):
    future = asyncio.run_coroutine_threadsafe(coro, _loop)
    return future.result(timeout=timeout)

# ── 实例池 ──
_rag_instances: dict[str, object] = {}

def _instance_key(tenant_id: str, namespace: str) -> str:
    return f"{tenant_id}/{namespace}"

def get_rag(tenant_id: str, namespace: str, config, llm_func, embed_func):
    """获取或创建 LightRAG 实例。"""
    from lightrag import LightRAG

    key = _instance_key(tenant_id, namespace)
    if key not in _rag_instances:
        wd = str(Path(config.storage.working_dir) / tenant_id / namespace)
        Path(wd).mkdir(parents=True, exist_ok=True)
        rag = LightRAG(
            working_dir=wd,
            llm_model_func=llm_func,
            embedding_func=embed_func,
            addon_params={"language": config.rag.summary_language},
        )

        async def _init():
            await rag.initialize_storages()
        _run_async(_init())

        _rag_instances[key] = rag
        logger.info(f"Created LightRAG instance: {key} → {wd}")
    return _rag_instances[key]

# ── CRUD ──
def insert_document(rag, text: str, doc_id: str) -> dict:
    async def _do():
        try:
            await rag.adelete_by_doc_id(doc_id)
        except Exception:
            pass
        await rag.ainsert(text, ids=doc_id)
    _run_async(_do())
    return {"doc_id": doc_id}

def query(rag, query_text: str, mode: str = "mix") -> str:
    from lightrag import QueryParam
    async def _do():
        param = QueryParam(mode=mode)
        return await rag.aquery(query_text, param=param)
    return _run_async(_do())

def delete_document(rag, doc_id: str) -> dict:
    async def _do():
        await rag.adelete_by_doc_id(doc_id)
    _run_async(_do())
    return {"doc_id": doc_id, "deleted": True}

def list_instances() -> list[dict]:
    results = []
    for key in sorted(_rag_instances.keys()):
        parts = key.split("/", 1)
        results.append({
            "tenant_id": parts[0],
            "namespace": parts[1] if len(parts) > 1 else "default"
        })
    return results
```

**关键变更**: 
- CRUD 函数接收 `rag` 实例而不是 `(tenant_id, namespace)`——调用方负责获取实例，职责更清晰
- `get_rag` 接收 `config, llm_func, embed_func` 参数——依赖注入，不依赖全局

### 4.6 `api/auth.py` — 认证中间件（已实现）

**职责**: API Key 验证、Admin Key 验证、租户提取。

**当前问题**:
1. `_extract_tenant` 中未认证请求回退到 `"default"` 租户（安全漏洞）
2. `ADMIN_KEY` 有硬编码默认值

**设计**:
```python
"""
认证中间件。
提取和验证 API Key / Admin Key / Tenant ID。
"""
import os
import functools
from flask import request, g, jsonify
from tenants import manager as tm

def extract_tenant():
    """
    从请求中提取租户 ID。
    优先级: X-Tenant-ID > Bearer Token > X-API-Key
    认证失败返回 None（而非回退到 default）。
    """
    # 简单模式: 直接头
    tenant_header = request.headers.get("X-Tenant-ID", "")
    if tenant_header:
        return tenant_header

    # API Key 模式
    auth = request.headers.get("Authorization", "")
    api_key = request.headers.get("X-API-Key", "")
    key = ""
    if auth.startswith("Bearer "):
        key = auth[7:]
    elif api_key:
        key = api_key

    if key:
        info = tm.validate_api_key(key)
        if info:
            return info["tenant_id"]

    return None  # 认证失败，不默认回退

def require_tenant(f):
    """装饰器: 需要有效租户认证。"""
    @functools.wraps(f)
    def wrapper(*args, **kwargs):
        tenant = extract_tenant()
        if not tenant:
            return jsonify({"error": "Missing or invalid API key"}), 401
        g.tenant_id = tenant
        return f(*args, **kwargs)
    return wrapper

def require_admin(f):
    """装饰器: 需要管理员认证。"""
    @functools.wraps(f)
    def wrapper(*args, **kwargs):
        auth = request.headers.get("Authorization", "")
        admin_key = os.getenv("ADMIN_API_KEY", "")
        if not admin_key or auth != f"Bearer {admin_key}":
            return jsonify({"error": "Admin access required"}), 403
        return f(*args, **kwargs)
    return wrapper
```

**关键变更**: 
- `extract_tenant()` 认证失败返回 `None`，不再回退到 `"default"` 租户（修复安全漏洞）
- `ADMIN_API_KEY` 不设默认值——未设置则所有 admin 操作返回 403

### 4.7 `api/middleware.py` — 速率限制 + 审计（已实现）

```python
"""
中间件: 速率限制 + 审计日志。
"""
import time
import logging
from collections import defaultdict
from flask import request, g, jsonify

logger = logging.getLogger("lightrag.middleware")

class TokenBucket:
    """简单的 token bucket 速率限制。"""
    def __init__(self, rate: int, per_seconds: int = 60):
        self.rate = rate
        self.per_seconds = per_seconds
        self.tokens = rate
        self.last_refill = time.time()

    def consume(self, count: int = 1) -> bool:
        now = time.time()
        elapsed = now - self.last_refill
        self.tokens = min(self.rate, self.tokens + elapsed * (self.rate / self.per_seconds))
        self.last_refill = now
        if self.tokens >= count:
            self.tokens -= count
            return True
        return False

_buckets: dict[str, TokenBucket] = defaultdict(lambda: TokenBucket(100))

def rate_limit_middleware():
    """Flask before_request 中间件。"""
    tenant = getattr(g, 'tenant_id', 'anonymous')
    bucket = _buckets[tenant]
    if not bucket.consume():
        return jsonify({"error": "Rate limit exceeded. Try again later."}), 429
    g.request_start = time.time()
    return None

def audit_log_middleware(response):
    """Flask after_request 中间件。"""
    tenant = getattr(g, 'tenant_id', 'anonymous')
    endpoint = request.endpoint or 'unknown'
    status = response.status_code
    duration = time.time() - getattr(g, 'request_start', time.time())
    logger.info(f"AUDIT tenant={tenant} endpoint={endpoint} status={status} duration={duration:.3f}s")
    return response
```

### 4.8 `api/routes/` — 路由（已实现）

#### `api/routes/__init__.py` — 路由注册中心

```python
from flask import Blueprint

api = Blueprint("api", __name__, url_prefix="/api/v1")

# 延迟导入避免循环依赖
def register_routes():
    from .documents import register as reg_docs
    from .query import register as reg_query
    from .admin import register as reg_admin
    from .legacy import register as reg_legacy

    reg_docs(api)
    reg_query(api)
    reg_admin(api)
    reg_legacy(api)

    # Health check
    @api.route("/health")
    def health():
        from api.engine import list_instances
        return {"status": "ok", "service": "lightrag-microservice", "instances": len(list_instances())}
```

#### `api/routes/documents.py` — 文档 CRUD

```python
from flask import jsonify
from api.auth import require_tenant
from api.engine import insert_document as eng_insert, insert_documents_batch, delete_document
from api.code_refactor import parse_json, handle_errors, build_success

def register(api):
    @api.route("/namespaces/<namespace>/documents", methods=["POST"])
    @require_tenant
    @handle_errors(logger, "Insert failed")
    def api_insert_document(namespace, _tenant):
        data = parse_json()
        text = data.get("text", "")
        doc_id = data.get("doc_id", data.get("file_name", "document.txt"))
        if not text.strip():
            return jsonify({"error": "text is required"}), 400
        result = eng_insert(_tenant, namespace, text, doc_id)
        return build_success(result, status=201)

    @api.route("/namespaces/<namespace>/documents/batch", methods=["POST"])
    @require_tenant
    @handle_errors(logger, "Batch insert failed")
    def api_insert_documents_batch(namespace, _tenant):
        data = parse_json()
        documents = data.get("documents", [])
        if not documents:
            return jsonify({"error": "documents array is required"}), 400
        for i, doc in enumerate(documents):
            if not isinstance(doc, dict) or not str(doc.get("text", "")).strip():
                return jsonify({"error": f"documents[{i}].text is required"}), 400
        result = insert_documents_batch(_tenant, namespace, documents)
        return build_success(result, status=201)

    @api.route("/namespaces/<namespace>/documents/<doc_id>", methods=["DELETE"])
    @require_tenant
    @handle_errors(logger, "Delete failed")
    def api_delete_document(namespace, doc_id, _tenant):
        result = delete_document(_tenant, namespace, doc_id)
        return build_success(result)
```

#### `api/routes/query.py` — 查询路由

```python
from api.auth import require_tenant
from api.engine import query as rag_query, retrieve as rag_retrieve
from api.code_refactor import parse_json, Guard, handle_errors, build_success

def register(api):
    @api.route("/namespaces/<namespace>/query", methods=["POST"])
    @require_tenant
    @handle_errors(logger, "Query failed")
    def api_query(namespace, _tenant):
        data = parse_json()
        Guard(data).require("query").check_mode("mode")
        result = rag_query(_tenant, namespace, data["query"], data.get("mode", "mix"))
        return build_success(result)

    @api.route("/namespaces/<namespace>/retrieve", methods=["POST"])
    @require_tenant
    @handle_errors(logger, "Retrieve failed")
    def api_retrieve(namespace, _tenant):
        data = parse_json()
        Guard(data).require("query").check_mode("mode")
        result = rag_retrieve(_tenant, namespace, data["query"],
                              data.get("mode", "mix"), data.get("top_k"))
        return build_success(result)
```

### 4.9 `mcp_server/tools.py` — MCP 工具定义（已实现）

```python
"""
MCP 工具定义和处理器。
与 server.py 解耦，可独立测试。
"""
import json
import os

TOOLS = [
    {
        "name": "lightrag_insert_document",
        "description": "Insert a document into the LightRAG knowledge base...",
        "inputSchema": {
            "type": "object",
            "properties": {
                "namespace": {"type": "string", "description": "..."},
                "text": {"type": "string", "description": "..."},
                "doc_id": {"type": "string", "description": "..."},
            },
            "required": ["namespace", "text", "doc_id"]
        }
    },
    # ... 其他工具
]

async def handle_insert(args: dict, tenant_id: str) -> dict:
    from api.engine import insert_document, get_rag
    ns = args.get("namespace", "default")
    rag = get_rag(tenant_id, ns, ...)  # 依赖注入
    result = insert_document(rag, args["text"], args["doc_id"])
    return {"content": [{"type": "text", "text": json.dumps(result)}]}

# ...
```

---

## 5. 数据流

### 5.1 文档插入流程

```
Client (SDK / curl)
  │ POST /api/v1/namespaces/{ns}/documents
  │ { text: "...", doc_id: "readme.md" }
  ▼
Flask → extract_tenant() → validate_api_key() → tenant_id
  │
  ▼
rate_limit_middleware → check token bucket
  │
  ▼
routes/documents.py
  │ get_rag(tenant_id, namespace)
  │   ├─ 检查 _rag_instances 缓存
  │   ├─ 未命中 → 创建 LightRAG 实例
  │   │   ├─ 设置 working_dir = data/{tenant_id}/{namespace}/
  │   │   └─ initialize_storages()
  │   └─ 返回 rag 实例
  │
  │ insert_document(rag, text, doc_id)
  │   ├─ rag.adelete_by_doc_id(doc_id)  # upsert
  │   └─ rag.ainsert(text, ids=doc_id)
  │       ├─ 分块 (chunk_token_size=1200)
  │       ├─ LLM 实体/关系提取 (DeepSeek)
  │       ├─ Embedding (SentenceTransformer)
  │       └─ 存储 (local JSON / PGVector)
  │
  ▼
Response: { "success": true, "doc_id": "readme.md" }
  │
  ▼
audit_log_middleware → LOG: tenant=X endpoint=insert status=200 duration=2.3s
```

### 5.2 查询流程

```
Client
  │ POST /api/v1/namespaces/{ns}/query
  │ { query: "...", mode: "mix" }
  ▼
Auth → Rate Limit → Route
  │
  ▼
query(rag, text, mode="mix")
  ├─ QueryParam(mode="mix")
  │   ├─ local: 向量检索 → top_k chunks
  │   ├─ global: 图谱检索 → 关系路径
  │   └─ hybrid: local + global 融合
  └─ rag.aquery(query, param)
      ├─ 检索相关 chunks
      ├─ LLM 生成答案 (DeepSeek)
      └─ 返回 "reply" 字符串
  │
  ▼
Response: { "reply": "...", "mode": "mix" }
```

---

## 6. 配置管理

### 6.1 配置优先级

```
环境变量 > .env 文件 > config.py 默认值
```

### 6.2 环境变量完整列表

| 变量 | 默认值 | 必需 | 说明 |
|------|--------|------|------|
| `LLM_BINDING_API_KEY` | — | **是** | DeepSeek API Key |
| `LLM_BINDING_HOST` | `https://api.deepseek.com/v1` | 否 | LLM API 地址 |
| `LLM_MODEL` | `deepseek-chat` | 否 | 模型名 |
| `EMBEDDING_MODEL` | `all-MiniLM-L6-v2` | 否 | Embedding 模型 |
| `ADMIN_API_KEY` | — | **是** | 管理员 Key |
| `REST_PORT` | `9721` | 否 | REST API 端口 |
| `MCP_ENABLED` | `true` | 否 | 启用 MCP Server |
| `STORAGE_MODE` | `local` | 否 | 存储后端 |
| `WORKING_DIR` | `./data` | 否 | RAG 数据目录 |
| `TENANT_DB_PATH` | `./tenants/tenants.db` | 否 | 租户数据库 |
| `LOG_LEVEL` | `INFO` | 否 | 日志级别 |
| `TOP_K` | `60` | 否 | 检索返回数 |
| `CHUNK_TOP_K` | `20` | 否 | 分块返回数 |

### 6.3 安全检查清单

- [x] `.env` 在 `.gitignore` 中
- [x] `LLM_BINDING_API_KEY` 和 `ADMIN_API_KEY` 无默认值
- [x] 所有密钥通过环境变量注入到 systemd/Docker
- [x] 生产环境 `ADMIN_API_KEY` 为强随机字符串

---

## 7. API 完整规范

参见 [API.md](./API.md)。

---

## 8. MCP 实现规范

### 8.1 协议版本

- MCP 协议: `2024-11-05`
- 传输: STDIO (stdin/stdout)
- JSON-RPC: 2.0

### 8.2 工具集

| 工具 | MCP Tool Name | 参数 | 返回 |
|------|---------------|------|------|
| 插入文档 | `lightrag_insert_document` | `namespace`, `text`, `doc_id` | `{doc_id, tenant, namespace}` |
| RAG 查询 | `lightrag_query` | `namespace`, `query`, `mode` | `{reply, mode}` |
| 删除文档 | `lightrag_delete_document` | `namespace`, `doc_id` | `{doc_id, deleted}` |
| 列出文档 | `lightrag_list_documents` | `namespace` | `[{doc_id, created_at}]` |
| 仅检索 | `lightrag_retrieve` | `namespace`, `query`, `top_k` | `[{chunk, score}]` |

### 8.3 租户上下文

MCP 通过环境变量 `MCP_TENANT_ID` 指定租户上下文，所有操作自动限定在该租户下。

---

## 9. SDK 实现规范

### 9.1 TypeScript SDK (`sdk/`)

```
sdk/
├── types.ts       # 类型定义 (InsertResult, QueryResult, etc.)
├── index.ts       # LightRAGClient 类
└── package.json   # npm 配置
```

**类型分离**: 从 `index.ts` 中提取类型到 `types.ts`，改善类型复用。

**错误处理**: 添加 `LightRAGError` 类:
```typescript
export class LightRAGError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) { super(message); this.name = 'LightRAGError'; }
}
```

### 9.2 Python SDK（新建）

**目录**: `sdk-python/`

```
sdk-python/
├── lightrag_client/
│   ├── __init__.py   # 导出 LightRAGClient
│   ├── client.py     # 客户端类
│   └── types.py      # 类型定义 (dataclass)
├── pyproject.toml
└── README.md
```

**核心设计**: 与 TS SDK 保持 API 一致。

---

## 10. 部署方案

### 10.1 systemd 部署（轻量，推荐）

```ini
[Unit]
Description=LightRAG Microservice
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/aiservicer/lightrag-service
ExecStart=/usr/bin/python3 main.py
Restart=always
RestartSec=5
Environment="PYTHONUNBUFFERED=1"
EnvironmentFile=/home/ubuntu/aiservicer/lightrag-service/.env

[Install]
WantedBy=multi-user.target
```

### 10.2 Docker 部署

```bash
docker run -d \
  --name lightrag \
  -p 9721:9721 \
  -v ./data:/app/data \
  -v ./.env:/app/.env:ro \
  aiservicer/lightrag:latest
```

### 10.3 反向代理（生产必备）

```nginx
# Nginx 示例
server {
    listen 443 ssl;
    server_name rag.your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:9721;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 300s;
    }
}
```

---

## 11. 实施计划

### Phase 1: 基础重构（1-2天）

| # | 任务 | 产出 | 风险 |
|---|------|------|------|
| 1.1 | 创建 `config.py` | 配置聚合模块 | 低 |
| 1.2 | 从 `engine.py` 提取 `adapters.py` | 适配器独立 | 低 |
| 1.3 | 重构 `engine.py` 为依赖注入模式 | 解耦的引擎 | 中 (API 变更) |
| 1.4 | 创建 `api/auth.py` | 安全认证中间件 | 低 |
| 1.5 | 创建 `api/middleware.py` | 速率限制+审计 | 低 |
| 1.6 | 拆分 `routes.py` → `routes/` 目录 | 模块化路由 | 中 (路径变更) |
| 1.7 | 重构 `main.py` | 组装入口 | 低 |
| 1.8 | 拆分 `mcp_server/server.py` → `tools.py` | MCP 解耦 | 低 |

### Phase 2: 功能补全（2-3天）

| # | 任务 | 产出 |
|---|------|------|
| 2.1 | 实现文档列表 API（`GET /documents`） | F-D04 |
| 2.2 | 实现仅检索 API（`POST /retrieve`） | F-Q03 |
| 2.3 | 实现流式查询 SSE | F-Q02 |
| 2.4 | 实现 Prometheus Metrics | F-S02 |
| 2.5 | 实现优雅关闭 (SIGTERM handler) | 可靠性 |
| 2.6 | MCP 新增 `lightrag_list_documents` | F-M04 |

### Phase 3: SDK & 测试（2天）

| # | 任务 | 产出 |
|---|------|------|
| 3.1 | 创建 Python SDK (`sdk-python/`) | pip 包 |
| 3.2 | TypeScript SDK 拆出 `types.ts` | npm 包优化 |
| 3.3 | 编写单元测试 (pytest) | 核心覆盖率 80% |
| 3.4 | 编写 API 集成测试 | 端到端 |
| 3.5 | 更新 README / 部署文档 | 文档 |

### Phase 4: 发布（1天）

| # | 任务 |
|---|------|
| 4.1 | 发布 `@aiservicer/lightrag-sdk` 到 npm |
| 4.2 | 发布 `lightrag-client` 到 PyPI |
| 4.3 | 构建并推送 Docker 镜像 |
| 4.4 | 部署到生产环境 |
| 4.5 | 端到端验证 |

---

## 12. 代码规范

### 12.1 命名规范

| 类型 | Python | TypeScript |
|------|--------|------------|
| 函数/方法 | `snake_case` | `camelCase` |
| 类 | `PascalCase` | `PascalCase` |
| 常量 | `UPPER_SNAKE` | `UPPER_SNAKE` |
| 模块文件 | `snake_case.py` | `kebab-case.ts` |
| API JSON | `snake_case` | `snake_case` |

### 12.2 禁止事项

- **禁止** 在模块顶层执行有副作用的代码（`load_dotenv`, `mkdir`, HTTP 请求）
- **禁止** 硬编码任何魔法数字/字符串（全部进 `config.py`）
- **禁止** 在业务代码中直接调用 `os.getenv`（通过 `config.py` 获取）
- **禁止** 使用 `from module import *`
- **禁止** 文件超过 200 行（≥ 200 行强制拆分）
- **禁止** 在生产代码中使用 `print()`（用 `logger`）

### 12.3 必须事项

- **必须** 每个模块有 docstring（一行说明用途）
- **必须** 公共函数有类型注解
- **必须** 新增接口更新 `API.md`
- **必须** 敏感配置通过环境变量注入，不设硬编码默认值
- **必须** 新增功能写测试
