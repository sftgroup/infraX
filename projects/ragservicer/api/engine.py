"""
InfraX Doc Engine — multi-tenant, namespace-aware wrapper.
Each (tenant_id, namespace) pair gets its own isolated LightRAG instance.

Uses config.py for all settings (zero hardcoded values).
Uses api.adapters for LLM/Embedding factories.
"""
import asyncio
import logging
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
    if _loop is None:
        raise RuntimeError("Event loop not started")
    if timeout is None:
        timeout = get_config().rag.insert_timeout
    future = asyncio.run_coroutine_threadsafe(coro, _loop)
    return future.result(timeout=timeout)


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


def _instance_key(tenant_id: str, namespace: str) -> str:
    return f"{tenant_id}/{namespace}"


def get_rag(tenant_id: str, namespace: str = "default"):
    """Get or create a LightRAG instance scoped to (tenant, namespace)."""
    from lightrag import LightRAG

    key = _instance_key(tenant_id, namespace)
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

def insert_document(tenant_id: str, namespace: str, text: str, doc_id: str) -> dict:
    rag = get_rag(tenant_id, namespace)

    async def _do():
        try:
            await rag.adelete_by_doc_id(doc_id)
        except Exception:
            logger.debug(f"Doc {doc_id} not found for pre-delete, safe to insert")
        await rag.ainsert(text, ids=doc_id)

    _run_async(_do())
    return {"doc_id": doc_id, "tenant": tenant_id, "namespace": namespace}


def insert_documents_batch(tenant_id: str, namespace: str, documents: list[dict]) -> dict:
    rag = get_rag(tenant_id, namespace)
    texts = [d["text"] for d in documents]
    ids = [d.get("doc_id", f"doc_{i}") for i, d in enumerate(documents)]

    async def _do():
        combined = "\n\n---\n\n".join(texts)
        await rag.ainsert(combined, ids="|".join(ids))

    _run_async(_do())
    return {"count": len(texts), "tenant": tenant_id, "namespace": namespace}


def delete_document(tenant_id: str, namespace: str, doc_id: str) -> dict:
    rag = get_rag(tenant_id, namespace)

    async def _do():
        await rag.adelete_by_doc_id(doc_id)

    _run_async(_do())
    return {"doc_id": doc_id, "deleted": True}


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
