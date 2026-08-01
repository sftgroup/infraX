"""
Configuration aggregator — the ONLY module that reads os.getenv.
All other modules import config from here. No hardcoded defaults
for secrets (API keys, admin key).
"""
import os
from dataclasses import dataclass


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
            backend=os.getenv("EMBEDDING_BACKEND", "local"),
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
