"""RDL 删除可用性修复单测（2026-08-21 AIServicer issue 第 8 节）。

- RDL-1: delete_document 透传 LightRAG DeletionResult 四态
         （success → deleted:true；not_found → 幂等 deleted:true+found:false；
          not_allowed / fail → deleted:false，不再掩盖为成功）
- RDL-1: REST DELETE not_allowed → 503 + Retry-After（可重试语义）
- RDL-3: _map_doc_status 枚举映射（DocStatus.PROCESSED → indexed，不再恒显 indexing）
"""
import asyncio
from enum import Enum
from types import SimpleNamespace

from api.engine import _delete_coro, _map_doc_status, delete_document


class _DummyDocStatus(str, Enum):
    PROCESSED = "processed"
    FAILED = "failed"
    PROCESSING = "processing"
    PENDING = "pending"


def _result(status, message="", status_code=200):
    return {"status": status, "message": message, "status_code": status_code}


def _patch_get_rag(monkeypatch):
    """factory 预初始化会调 get_rag（内部 import lightrag，本地未装）→ 以空壳替换。"""
    monkeypatch.setattr("api.engine.get_rag", lambda *a, **k: SimpleNamespace())


# ── RDL-1: delete_document 处置透传 ───────────────────────

def test_delete_success(monkeypatch):
    _patch_get_rag(monkeypatch)
    monkeypatch.setattr("api.engine._run_async",
                        lambda coro: _result("success", "ok", 200))
    r = delete_document("t1", "ns", "doc1")
    assert r["deleted"] is True
    assert r["found"] is True
    assert r["status"] == "success"


def test_delete_not_found_is_idempotent(monkeypatch):
    _patch_get_rag(monkeypatch)
    monkeypatch.setattr("api.engine._run_async",
                        lambda coro: _result("not_found", "Document not found.", 404))
    r = delete_document("t1", "ns", "ghost")
    assert r["deleted"] is True   # 幂等：不存在视为已删除
    assert r["found"] is False
    assert r["status"] == "not_found"


def test_delete_not_allowed_not_masked(monkeypatch):
    """关键回归：pipeline 忙（not_allowed）时删除未执行，绝不再返回 deleted:true。"""
    _patch_get_rag(monkeypatch)
    monkeypatch.setattr("api.engine._run_async",
                        lambda coro: _result("not_allowed", "Pipeline is busy with another operation.", 503))
    r = delete_document("t1", "ns", "doc1")
    assert r["deleted"] is False
    assert r["status"] == "not_allowed"


def test_delete_fail_reported(monkeypatch):
    _patch_get_rag(monkeypatch)
    monkeypatch.setattr("api.engine._run_async",
                        lambda coro: _result("fail", "graph rebuild failed", 500))
    r = delete_document("t1", "ns", "doc1")
    assert r["deleted"] is False
    assert r["status"] == "fail"


# ── _delete_coro 提取 DeletionResult 字段 ─────────────────

def test_delete_coro_extracts_deletion_result(monkeypatch):
    rag = SimpleNamespace()

    async def _adelete(doc_id):
        assert doc_id == "doc1"
        return SimpleNamespace(status="success", message="ok", status_code=200)

    rag.adelete_by_doc_id = _adelete
    monkeypatch.setattr("api.engine.get_rag", lambda *a, **k: rag)

    factory = _delete_coro("t1", "ns", "doc1")
    factory()  # 预初始化（工厂约定）
    out = asyncio.run(factory())
    assert out == {"status": "success", "message": "ok", "status_code": 200}


def test_delete_coro_fallback_on_missing_result(monkeypatch):
    """adelete_by_doc_id 返回 None（异常路径）→ 兜底 fail，防止 AttributeError 泄漏。"""
    rag = SimpleNamespace()

    async def _adelete(doc_id):
        return None

    rag.adelete_by_doc_id = _adelete
    monkeypatch.setattr("api.engine.get_rag", lambda *a, **k: rag)

    factory = _delete_coro("t1", "ns", "doc1")
    factory()
    out = asyncio.run(factory())
    assert out["status"] == "fail"


# ── RDL-3: _map_doc_status 枚举映射 ───────────────────────

def test_map_doc_status_enum_values():
    """DocStatus 是 str 枚举：str() 会得到 'DocStatus.PROCESSED'，必须取 .value。"""
    assert _map_doc_status(_DummyDocStatus.PROCESSED) == "indexed"
    assert _map_doc_status(_DummyDocStatus.FAILED) == "error"
    assert _map_doc_status(_DummyDocStatus.PROCESSING) == "indexing"
    assert _map_doc_status(_DummyDocStatus.PENDING) == "indexing"


def test_map_doc_status_plain_str():
    assert _map_doc_status("processed") == "indexed"
    assert _map_doc_status("failed") == "error"
    assert _map_doc_status("parsing") == "indexing"


def test_map_doc_status_none():
    assert _map_doc_status(None) == "indexing"
