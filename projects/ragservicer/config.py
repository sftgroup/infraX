"""
Configuration aggregator — the ONLY module that reads os.getenv.
All other modules import config from here. No hardcoded defaults
for secrets (API keys, admin key).
"""
import os
from dataclasses import dataclass

# ── 统一鉴权契约（app_auth）─────────────────────────────────
# 优先加载仓库级共享实现（../shared，systemd/本地 git checkout 路径）；
# Docker 构建无共享目录时回退到项目根同名副本。必须在 import app_auth 前执行。
import sys as _sys
from pathlib import Path as _Path

_SHARED_DIR = _Path(__file__).resolve().parents[1] / "shared"
if _SHARED_DIR.is_dir():
    _sys.path.insert(0, str(_SHARED_DIR))


@dataclass(frozen=True)
class LLMConfig:
    model: str = "deepseek-chat"
    base_url: str = "https://api.deepseek.com/v1"
    api_key: str = ""              # REQUIRED in production
    timeout: int = 120


@dataclass(frozen=True)
class EmbeddingConfig:
    backend: str = "local"         # "local" | "dashscope"
    model_name: str = "all-MiniLM-L6-v2"
    dims: int = 384
    max_token_size: int = 512
    api_key: str = ""              # for cloud backends
    base_url: str = "https://dashscope.aliyuncs.com/compatible-mode/v1"
    api_timeout: int = 60          # HTTP request timeout for cloud backends


@dataclass(frozen=True)
class StorageConfig:
    working_dir: str = "./data"


@dataclass(frozen=True)
class RAGConfig:
    max_async: int = 4
    max_parallel_insert: int = 2
    chunk_token_size: int = 1200
    chunk_overlap_token_size: int = 100
    top_k: int = 60
    chunk_top_k: int = 20
    summary_language: str = "Chinese"
    insert_timeout: int = 300
    default_doc_id: str = "document.txt"
    page_limit_max: int = 200
    # 读写分离：写路径后台队列
    write_workers: int = 2        # 后台注入 worker 数（写串行化，保护 LLM/embedding 配额）
    task_queue_size: int = 200    # 写队列容量（满时返回 503）
    task_ttl_seconds: int = 3600  # 任务记录保留时间


@dataclass(frozen=True)
class ServerConfig:
    host: str = "0.0.0.0"
    port: int = 9721
    mcp_enabled: bool = True
    mcp_tenant_id: str = "default"
    mcp_protocol_version: str = "2024-11-05"
    mcp_server_name: str = "infrax-ragservicer-mcp"
    mcp_server_version: str = "2.0.0"
    admin_api_key: str = ""        # REQUIRED in production
    ragservicer_api_key: str = ""  # Internal key for aiservicer bridge (optional)
    rate_limit_rpm: int = 100
    rate_limit_window: int = 60    # seconds


@dataclass(frozen=True)
class TenantConfig:
    db_path: str = "./tenants/tenants.db"


@dataclass(frozen=True)
class AppConfig:
    llm: LLMConfig
    embedding: EmbeddingConfig
    storage: StorageConfig
    rag: RAGConfig
    server: ServerConfig
    tenant: TenantConfig
    log_level: str = "INFO"


# ── Singleton loader ────────────────────────────────────
_config: AppConfig | None = None


def load_config() -> AppConfig:
    """Build AppConfig from environment variables. Call once at startup."""
    global _config
    if _config is not None:
        return _config

    _config = AppConfig(
        llm=LLMConfig(
            model=os.getenv("LLM_MODEL", LLMConfig.model),
            base_url=os.getenv("LLM_BINDING_HOST", LLMConfig.base_url),
            api_key=os.getenv("LLM_BINDING_API_KEY", ""),
            timeout=int(os.getenv("LLM_TIMEOUT", str(LLMConfig.timeout))),
        ),
        embedding=EmbeddingConfig(
            backend=os.getenv("EMBEDDING_BACKEND", "dashscope"),
            model_name=os.getenv("EMBEDDING_MODEL", EmbeddingConfig.model_name),
            dims=int(os.getenv("EMBEDDING_DIMS", str(EmbeddingConfig.dims))),
            max_token_size=int(os.getenv("EMBEDDING_MAX_TOKENS", str(EmbeddingConfig.max_token_size))),
            api_key=os.getenv("EMBEDDING_API_KEY", ""),
            base_url=os.getenv("EMBEDDING_BASE_URL", EmbeddingConfig.base_url),
            api_timeout=int(os.getenv("EMBEDDING_TIMEOUT", str(EmbeddingConfig.api_timeout))),
        ),
        storage=StorageConfig(
            working_dir=os.getenv("WORKING_DIR", StorageConfig.working_dir),
        ),
        rag=RAGConfig(
            max_async=int(os.getenv("MAX_ASYNC", str(RAGConfig.max_async))),
            max_parallel_insert=int(os.getenv("MAX_PARALLEL_INSERT", str(RAGConfig.max_parallel_insert))),
            chunk_token_size=int(os.getenv("CHUNK_TOKEN_SIZE", str(RAGConfig.chunk_token_size))),
            chunk_overlap_token_size=int(os.getenv("CHUNK_OVERLAP_TOKEN_SIZE", str(RAGConfig.chunk_overlap_token_size))),
            top_k=int(os.getenv("TOP_K", str(RAGConfig.top_k))),
            chunk_top_k=int(os.getenv("CHUNK_TOP_K", str(RAGConfig.chunk_top_k))),
            summary_language=os.getenv("SUMMARY_LANGUAGE", RAGConfig.summary_language),
            write_workers=int(os.getenv("WRITE_WORKERS", str(RAGConfig.write_workers))),
            task_queue_size=int(os.getenv("TASK_QUEUE_SIZE", str(RAGConfig.task_queue_size))),
            task_ttl_seconds=int(os.getenv("TASK_TTL_SECONDS", str(RAGConfig.task_ttl_seconds))),
        ),
        server=ServerConfig(
            host=os.getenv("REST_HOST", ServerConfig.host),
            port=int(os.getenv("REST_PORT", str(ServerConfig.port))),
            mcp_enabled=os.getenv("MCP_ENABLED", "true").lower() == "true",
            mcp_tenant_id=os.getenv("MCP_TENANT_ID", ServerConfig.mcp_tenant_id),
            admin_api_key=os.getenv("ADMIN_API_KEY", ""),
            ragservicer_api_key=os.getenv("RAGSERVICER_API_KEY", "") or os.getenv("DOC_API_KEY", "") or os.getenv("LIGHTRAG_API_KEY", ""),
            rate_limit_rpm=int(os.getenv("RATE_LIMIT_RPM", str(ServerConfig.rate_limit_rpm))),
            rate_limit_window=int(os.getenv("RATE_LIMIT_WINDOW", str(ServerConfig.rate_limit_window))),
        ),
        tenant=TenantConfig(
            db_path=os.getenv("TENANT_DB_PATH", TenantConfig.db_path),
        ),
        log_level=os.getenv("LOG_LEVEL", "INFO"),
    )
    return _config


def get_config() -> AppConfig:
    """Return the already-loaded config (must call load_config first)."""
    if _config is None:
        raise RuntimeError("Config not loaded — call load_config() at startup")
    return _config


def reload_config() -> AppConfig:
    """Rebuild the config singleton from current environment.

    Used after runtime config updates (e.g. admin API changed .env) so the
    process picks up new values without a restart. Returns the new config.
    """
    global _config
    _config = None
    return load_config()
