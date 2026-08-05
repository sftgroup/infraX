"""
InfraX Doc Engine — multi-tenant, namespace-aware wrapper.
Each (tenant_id, namespace) pair gets its own isolated LightRAG instance.

Uses config.py for all settings (zero hardcoded values).
Uses api.adapters for LLM/Embedding factories.
"""
import asyncio
import logging
import threading
from pathlib import Path
from typing import Optional

from config import get_config
from api.adapters import create_llm_func, create_embedding_func

logger = logging.getLogger("ragservicer.engine")

# ── Persistent Async Loop ─────────────────────────────────

_loop: Optional[asyncio.AbstractEventLoop] = None


def start_event_loop():
    """Start a persistent asyncio event loop in a daemon thread."""
    global _loop
    _loop = asyncio.new_event_loop()
    asyncio.set_event_loop(_loop)

    # Register the loop with code_refactor so MCP server can reuse it
    from api.code_refactor import set_event_loop as _set_loop
    _set_loop(_loop)

    _loop.run_forever()


def _run_async(coro, timeout=None):
    from api.code_refactor import run_async
    if timeout is None:
        timeout = get_config().rag.insert_timeout
    return run_async(coro, timeout=timeout)


# ── Lazy-init factories (set after adapters are ready) ────

_llm_func = None
_embed_func = None


def _get_llm_func():
    global _llm_func
    if _llm_func is None:
        _llm_func = create_llm_func()
    return _llm_func


def _get_embed_func():
    global _embed_func
    if _embed_func is None:
        _embed_func = create_embedding_func()
    return _embed_func


# ── RAG Instance Pool (tenant_id/namespace) ───────────────

_rag_instances: dict[str, object] = {}
_rag_lock = threading.Lock()  # 序列化首次实例创建，防多 worker 竞态


def _instance_key(tenant_id: str, namespace: str) -> str:
    return f"{tenant_id}/{namespace}"


def get_rag(tenant_id: str, namespace: str = "default"):
    """Get or create a LightRAG instance scoped to (tenant, namespace).

    注意：只能在 lightrag-loop 之外的线程调用（MCP/worker/请求线程）。
    实例初始化会阻塞等待 loop 完成，若在 loop 线程内调用将自死锁。
    """
    from lightrag import LightRAG

    key = _instance_key(tenant_id, namespace)
    if key not in _rag_instances:
        with _rag_lock:
            if key not in _rag_instances:
                cfg = get_config()
                wd = str(Path(cfg.storage.working_dir) / tenant_id / namespace)
                Path(wd).mkdir(parents=True, exist_ok=True)

                rag = LightRAG(
                    working_dir=wd,
                    llm_model_func=_get_llm_func(),
                    embedding_func=_get_embed_func(),
                    addon_params={"language": cfg.rag.summary_language},
                )

                async def _init():
                    await rag.initialize_storages()
                _run_async(_init())

                _rag_instances[key] = rag
                logger.info(f"Created LightRAG instance: {key} → {wd}")

    return _rag_instances[key]


# ── Public CRUD API (stable signatures — used by routes + MCP) ──

# 写操作 coroutine 工厂：实际执行逻辑唯一实现，供同步（MCP/legacy）与
# 异步（REST 写队列）两条路径复用。所有 LightRAG 调用仍在全局循环执行。

def _insert_coro(tenant_id: str, namespace: str, text: str, doc_id: str):
    """任务工厂：worker 线程先预初始化实例（loop 外），再返回注入 coroutine。

    不能在 loop 线程内 get_rag 首次初始化（自死锁），故把初始化前移到
    coro_factory 执行（tasks worker 在 loop 外调用工厂）。
    """
    def _factory():
        get_rag(tenant_id, namespace)  # 幂等；非 loop 线程，阻塞等待 loop 完成

        async def _do():
            rag = get_rag(tenant_id, namespace)
            try:
                await rag.adelete_by_doc_id(doc_id)
            except Exception:
                logger.debug(f"Doc {doc_id} not found for pre-delete, safe to insert")
            await rag.ainsert(text, ids=doc_id)
        return _do
    return _factory


def _insert_batch_coro(tenant_id: str, namespace: str, documents: list[dict]):
    texts = [d["text"] for d in documents]
    ids = [d.get("doc_id", f"doc_{i}") for i, d in enumerate(documents)]

    def _factory():
        get_rag(tenant_id, namespace)

        async def _do():
            rag = get_rag(tenant_id, namespace)
            combined = "\n\n---\n\n".join(texts)
            await rag.ainsert(combined, ids="|".join(ids))
        return _do
    return _factory


def _delete_coro(tenant_id: str, namespace: str, doc_id: str):
    def _factory():
        get_rag(tenant_id, namespace)

        async def _do():
            rag = get_rag(tenant_id, namespace)
            await rag.adelete_by_doc_id(doc_id)
        return _do
    return _factory


def insert_document(tenant_id: str, namespace: str, text: str, doc_id: str) -> dict:
    """同步插入（MCP / legacy 使用，请求线程会阻塞到完成）。"""
    _run_async(_insert_coro(tenant_id, namespace, text, doc_id)())
    return {"doc_id": doc_id, "tenant": tenant_id, "namespace": namespace}


def insert_documents_batch(tenant_id: str, namespace: str, documents: list[dict]) -> dict:
    """同步批量插入（MCP / legacy 使用）。"""
    _run_async(_insert_batch_coro(tenant_id, namespace, documents)())
    return {"count": len(documents), "tenant": tenant_id, "namespace": namespace}


def delete_document(tenant_id: str, namespace: str, doc_id: str) -> dict:
    """同步删除（MCP / legacy 使用）。"""
    _run_async(_delete_coro(tenant_id, namespace, doc_id)())
    return {"doc_id": doc_id, "deleted": True}


# 异步写路径：提交到后台写队列，立即返回 task_id（读写分离）。
# 慢注入在队列后台串行执行，不占用请求线程、不阻塞查询。

def submit_insert_document(tenant_id: str, namespace: str, text: str, doc_id: str) -> str:
    from api.tasks import submit
    return submit(_insert_coro(tenant_id, namespace, text, doc_id),
                  kind="insert", tenant=tenant_id, namespace=namespace)


def submit_insert_documents_batch(tenant_id: str, namespace: str, documents: list[dict]) -> str:
    from api.tasks import submit
    return submit(_insert_batch_coro(tenant_id, namespace, documents),
                  kind="batch_insert", tenant=tenant_id, namespace=namespace)


def submit_delete_document(tenant_id: str, namespace: str, doc_id: str) -> str:
    from api.tasks import submit
    return submit(_delete_coro(tenant_id, namespace, doc_id),
                  kind="delete", tenant=tenant_id, namespace=namespace)


def query(tenant_id: str, namespace: str, query_text: str, mode: str = "mix") -> dict:
    """Retrieve relevant context — NO LLM answer generation.
       Returns raw entities, relations, and chunks for the caller's own LLM."""
    rag = get_rag(tenant_id, namespace)
    cfg = get_config().rag

    async def _do():
        from lightrag import QueryParam
        param = QueryParam(mode=mode, top_k=cfg.top_k, chunk_top_k=cfg.chunk_top_k,
                           only_need_context=True)
        return await rag.aquery(query_text, param=param)

    result = _run_async(_do())
    return {
        "context": result,
        "mode": mode,
        "tenant": tenant_id,
        "namespace": namespace,
    }


def retrieve(tenant_id: str, namespace: str, query_text: str,
             mode: str = "mix", top_k: int = None) -> dict:
    """Context-only retrieval with configurable top_k. Does NOT generate LLM answer."""
    rag = get_rag(tenant_id, namespace)
    cfg = get_config().rag

    async def _do():
        from lightrag import QueryParam
        param = QueryParam(mode=mode,
                           top_k=top_k if top_k is not None else cfg.top_k,
                           chunk_top_k=cfg.chunk_top_k,
                           only_need_context=True)
        return await rag.aquery(query_text, param=param)

    result = _run_async(_do())
    return {
        "context": result,
        "mode": mode,
        "top_k": top_k or cfg.top_k,
        "tenant": tenant_id,
        "namespace": namespace,
    }


def list_instances() -> list[dict]:
    results = []
    for key in sorted(_rag_instances.keys()):
        parts = key.split("/", 1)
        results.append({
            "tenant_id": parts[0],
            "namespace": parts[1] if len(parts) > 1 else "default"
        })
    return results


def reload_runtime_config() -> None:
    """Drop cached LLM/embedding factories and existing RAG instances so the
    next access rebuilds them with freshly-loaded config (hot config update).

    Safe under concurrent access: in-flight operations keep their own object
    references; new operations simply build a new instance from disk storage.
    """
    global _llm_func, _embed_func, _rag_instances
    _llm_func = None
    _embed_func = None
    _rag_instances = {}


# ── Document Listing (pagination) ───────────────────────

def _map_doc_status(status: str) -> str:
    """Map LightRAG DocStatus → SDK-friendly status (indexed/indexing/error)."""
    if status == "processed":
        return "indexed"
    if status == "failed":
        return "error"
    return "indexing"


def list_documents(tenant_id: str, namespace: str, page: int = 1, limit: int = 20) -> dict:
    """List documents in a namespace, paginated, deterministically ordered by doc_id."""
    rag = get_rag(tenant_id, namespace)

    async def _do():
        from lightrag.base import DocStatus
        all_docs: dict[str, object] = {}
        # No single "list all" API on the storage backend, so sweep every
        # known status and merge (idempotent via setdefault).
        for s in DocStatus:
            try:
                docs = await rag.get_docs_by_status(s)
                for doc_id, st in docs.items():
                    all_docs.setdefault(doc_id, st)
            except Exception:
                logger.debug(f"get_docs_by_status({s}) failed, skipping")
        return all_docs

    docs = _run_async(_do())
    total = len(docs)
    start = (page - 1) * limit
    paged = sorted(docs.items())[start:start + limit]

    documents = []
    for doc_id, st in paged:
        documents.append({
            "doc_id": doc_id,
            "size_bytes": getattr(st, "content_length", 0),
            "chunk_count": getattr(st, "chunks_count", 0) or 0,
            "created_at": getattr(st, "created_at", ""),
            "status": _map_doc_status(str(getattr(st, "status", ""))),
        })

    return {
        "namespace": namespace,
        "documents": documents,
        "total": total,
        "page": page,
        "limit": limit,
    }
