"""
InfraX Doc Engine — multi-tenant, namespace-aware wrapper.
Each (tenant_id, namespace) pair gets its own isolated LightRAG instance.

Uses config.py for all settings (zero hardcoded values).
Uses api.adapters for LLM/Embedding factories.
"""
import asyncio
import logging
import threading
from enum import Enum
from pathlib import Path
from typing import Any, Optional

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
                # 生产 fork 版 LightRAG 的共享存储层（shared_storage.py）以
                # (workspace, namespace) 为键缓存 KV/锁；workspace 为空时所有实例
                # 键相同 → 跨 namespace 数据合并 + 存储锁争用（2026-08-21 生产
                # 排查实证：admin 租户 16 个 namespace 全污染）。
                # 必须显式 workspace=<namespace>：fork 会把文件落在
                # working_dir/<workspace>/ 下，故 working_dir 用租户目录、workspace
                # 用 namespace，磁盘路径保持 data/<tenant>/<namespace>/ 不变。
                wd = str(Path(cfg.storage.working_dir) / tenant_id)
                Path(wd).mkdir(parents=True, exist_ok=True)

                rag = LightRAG(
                    working_dir=wd,
                    workspace=namespace,
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

# ── 去重决策透出（RAGSERVICER_DEDUP_REQ，P1） ──────────────
# LightRAG 流水线内部三通道去重（filename / content_hash / filename_conflict）
# 命中后仅生成 `dup-<md5>` FAILED 记录，内容不入索引；本模块在 insert 后
# 比对 FAILED 桶增量，把"被丢弃"透出给调用方（响应体 + 任务结果 + 列表状态）。

# LightRAG 内部 duplicate_kind → API 稳定语义（供调用方对账）
_DEDUP_REASON_MAP = {
    "filename": "file_name_dup",
    "content_hash": "content_hash_dup",
    "filename_conflict": "filename_conflict",
}


def _disposition_from_failed(after_failed: dict, before_ids: set) -> dict | None:
    """纯函数：比对 insert 前后 FAILED 桶增量，返回去重处置（无增量 → None）。

    - 新增 `dup-*` 记录 = 本次插入被去重（未入索引）；
    - 真失败文档以自身 doc_id 出现在 FAILED 桶，不会误判。
    """
    new = {k: v for k, v in after_failed.items() if k not in before_ids}
    for dup_id, st in new.items():
        if not str(dup_id).startswith("dup-"):
            continue
        meta = getattr(st, "metadata", None) or {}
        return {
            "deduplicated": True,
            "dedup_reason": _DEDUP_REASON_MAP.get(str(meta.get("duplicate_kind", "")), "unknown"),
            "matched_doc_id": meta.get("original_doc_id") or None,
            "status": "duplicate",
        }
    return None


async def _get_docs_by_ids(rag, doc_id: str) -> dict:
    """跨版本取文档状态：优先 aget_docs_by_ids（v1.5+），回退 get_docs_by_ids。"""
    fn = getattr(rag, "aget_docs_by_ids", None) or getattr(rag, "get_docs_by_ids", None)
    if fn is None:
        return {}
    res = fn([doc_id])
    if asyncio.iscoroutine(res):
        return await res
    return res


async def _insert_one_locked(rag, text: str, doc_id: str) -> dict:
    """单文档 upsert + 去重检测（batch 与单篇共用的唯一实现）。

    ⚠️ 必须显式传 file_paths=[doc_id]：不传时 LightRAG 把 file_path 存为
    "unknown_source"，filename 去重与 dup 记录将无法按 doc_id 对账。
    """
    from lightrag.base import DocStatus

    before_ids = set((await rag.get_docs_by_status(DocStatus.FAILED)).keys())
    try:
        await rag.adelete_by_doc_id(doc_id)
    except Exception:
        logger.debug(f"Doc {doc_id} not found for pre-delete, safe to insert")
    await rag.ainsert(text, ids=doc_id, file_paths=[doc_id])

    after = await rag.get_docs_by_status(DocStatus.FAILED)
    disposition = _disposition_from_failed(after, before_ids)
    if disposition is not None:
        return disposition

    # 未被去重：以文档自身状态为准（processed → indexed / failed → error / 其他 → indexing）
    by_id = await _get_docs_by_ids(rag, doc_id)
    st = by_id.get(doc_id)
    status = _map_doc_status(getattr(st, "status", None)) if st is not None else "indexing"
    return {"deduplicated": False, "status": status}


# 同 namespace 插入串行化（2026-08-21 生产并发 500 修复）：
# 并发 sync 插入/批量插入会让 LightRAG 自身 SQLite 存储（KV/doc_status）争用，
# 偶发 pipeline 错误 → 500。全部 LightRAG 操作跑在单全局事件循环，
# 用 asyncio.Lock 按 (tenant, namespace) 串行化插入；同时使 FAILED 桶
# before/after diff 无竞态。
_insert_ns_locks: dict[tuple[str, str], asyncio.Lock] = {}
_insert_ns_locks_guard = threading.Lock()


def _ns_insert_lock(tenant_id: str, namespace: str) -> asyncio.Lock:
    key = (tenant_id, namespace)
    with _insert_ns_locks_guard:
        lock = _insert_ns_locks.get(key)
        if lock is None:
            lock = asyncio.Lock()
            _insert_ns_locks[key] = lock
        return lock


async def _insert_one(rag, tenant_id: str, namespace: str, text: str, doc_id: str) -> dict:
    """按 (tenant, namespace) 串行化插入，锁内执行真正的 upsert 逻辑。

    锁保证同一 namespace 的并发插入互斥，消除 LightRAG 自身 SQLite 存储
    （KV/doc_status）争用导致的偶发 pipeline 错误；同时让 FAILED 桶
    before/after diff 无竞态，去重判定不会串位。
    """
    async with _ns_insert_lock(tenant_id, namespace):
        return await _insert_one_locked(rag, text, doc_id)


def _insert_coro(tenant_id: str, namespace: str, text: str, doc_id: str):
    """任务工厂：worker 线程先预初始化实例（loop 外），再返回注入 coroutine。

    不能在 loop 线程内 get_rag 首次初始化（自死锁），故把初始化前移到
    coro_factory 执行（tasks worker 在 loop 外调用工厂）。
    """
    def _factory():
        get_rag(tenant_id, namespace)  # 幂等；非 loop 线程，阻塞等待 loop 完成

        async def _do():
            rag = get_rag(tenant_id, namespace)
            return await _insert_one(rag, tenant_id, namespace, text, doc_id)
        return _do()
    return _factory


def _insert_batch_coro(tenant_id: str, namespace: str, documents: list[dict]):
    """批量任务工厂：逐篇走单文档路径（修复 batch 异步不执行 + 提供逐篇处置）。"""
    def _factory():
        get_rag(tenant_id, namespace)

        async def _do():
            rag = get_rag(tenant_id, namespace)
            results = []
            for i, doc in enumerate(documents):
                results.append(await _insert_one(rag, tenant_id, namespace, doc["text"], doc.get("doc_id", f"doc_{i}")))
            return {"results": results, "count": len(results)}
        return _do()
    return _factory


def _delete_coro(tenant_id: str, namespace: str, doc_id: str):
    def _factory():
        get_rag(tenant_id, namespace)

        async def _do():
            rag = get_rag(tenant_id, namespace)
            # RDL-1: 透传 LightRAG DeletionResult（success / not_found /
            # not_allowed / fail）——此前忽略返回值，pipeline 忙（not_allowed）
            # 时删除未执行仍返回 deleted:true，造成"删不掉但报成功"。
            res = await rag.adelete_by_doc_id(doc_id)
            return {
                "status": getattr(res, "status", "fail"),
                "message": getattr(res, "message", ""),
                "status_code": getattr(res, "status_code", 500),
            }
        return _do()
    return _factory


def insert_document(tenant_id: str, namespace: str, text: str, doc_id: str) -> dict:
    """同步插入（MCP / legacy 使用，请求线程会阻塞到完成）。

    返回含去重处置：deduplicated / dedup_reason / matched_doc_id / status。
    """
    disposition = _run_async(_insert_coro(tenant_id, namespace, text, doc_id)())
    return {"doc_id": doc_id, "tenant": tenant_id, "namespace": namespace, **disposition}


def insert_documents_batch(tenant_id: str, namespace: str, documents: list[dict]) -> dict:
    """同步批量插入（MCP / legacy 使用）。逐篇执行，返回每篇处置明细。"""
    result = _run_async(_insert_batch_coro(tenant_id, namespace, documents)())
    return {
        "count": result["count"],
        "tenant": tenant_id,
        "namespace": namespace,
        "results": result["results"],
    }


def delete_document(tenant_id: str, namespace: str, doc_id: str) -> dict:
    """同步删除（MCP / legacy / REST 同步路径共用）。

    RDL-1：透传 LightRAG 删除处置，不再无条件 `deleted:true`：
      - success     → {"deleted": true,  "found": true}
      - not_found   → {"deleted": true,  "found": false}（幂等：不存在视为已删除）
      - not_allowed → {"deleted": false, "status": "not_allowed", "message": ...}
                     （pipeline 忙，删除未执行——REST 层转 503 + Retry-After）
      - fail        → {"deleted": false, "status": "fail", "message": ...}
    """
    result = _run_async(_delete_coro(tenant_id, namespace, doc_id)())
    status = result.get("status", "fail")
    payload = {
        "doc_id": doc_id,
        "deleted": status in ("success", "not_found"),
        "found": status == "success",
        "status": status,
        "message": result.get("message", ""),
    }
    return payload


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

def _map_doc_status(status: Any) -> str:
    """Map LightRAG DocStatus → SDK-friendly status (indexed/indexing/error).

    DocStatus 是 str 枚举：str(DocStatus.PROCESSED) 返回 "DocStatus.PROCESSED"
    而非 "processed"，直接 str() 比对会恒显 indexing（RDL-3）——统一取 .value。
    """
    if status is None:
        return "indexing"
    value = status.value if isinstance(status, Enum) else str(status)
    if value == "processed":
        return "indexed"
    if value == "failed":
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
        # 去重记录透出（RAGSERVICER_DEDUP_REQ：status 不再恒显 indexing）
        meta = getattr(st, "metadata", None) or {}
        is_dup = str(doc_id).startswith("dup-") or meta.get("is_duplicate") is True
        entry = {
            "doc_id": doc_id,
            "tenant": tenant_id,
            "namespace": namespace,
            "size_bytes": getattr(st, "content_length", 0),
            "chunk_count": getattr(st, "chunks_count", 0) or 0,
            "created_at": getattr(st, "created_at", ""),
            "status": "duplicate" if is_dup else _map_doc_status(getattr(st, "status", None)),
        }
        if is_dup:
            entry["dedup_reason"] = _DEDUP_REASON_MAP.get(str(meta.get("duplicate_kind", "")), "unknown")
            entry["matched_doc_id"] = meta.get("original_doc_id") or None
        documents.append(entry)

    return {
        "namespace": namespace,
        "tenant": tenant_id,
        "documents": documents,
        "total": total,
        "page": page,
        "limit": limit,
    }
