"""去重决策透出单测（RAGSERVICER_DEDUP_REQ，P1）。

覆盖：
- _disposition_from_failed：比对 insert 前后 FAILED 桶增量识别去重
- _map_doc_status：真实状态映射（不再恒显 indexing）
- insert_document / insert_documents_batch：响应携带去重处置
"""
from types import SimpleNamespace

from api.engine import (
    _disposition_from_failed,
    _map_doc_status,
    insert_document,
    insert_documents_batch,
)


def _dup_record(dup_id="dup-abc123", kind="content_hash", original="orig.txt",
                file_path="new.txt"):
    return SimpleNamespace(
        metadata={"is_duplicate": True, "duplicate_kind": kind,
                  "original_doc_id": original},
        content_length=100, chunks_count=0, created_at="t",
        status="failed", file_path=file_path,
    )


def _plain_record(status="processed", chunks=5):
    return SimpleNamespace(metadata={}, content_length=50, chunks_count=chunks,
                           created_at="t", status=status)


# ── _disposition_from_failed ─────────────────────────────────

def test_no_new_dup_returns_none():
    before = {"dup-keep": _dup_record(kind="filename")}
    after = dict(before)
    assert _disposition_from_failed(after, set(before)) is None


def test_content_hash_dup_detected():
    before: dict = {}
    after = {"dup-new": _dup_record(kind="content_hash", original="orig.txt")}
    d = _disposition_from_failed(after, set(before))
    assert d is not None
    assert d["deduplicated"] is True
    assert d["dedup_reason"] == "content_hash_dup"
    assert d["matched_doc_id"] == "orig.txt"
    assert d["status"] == "duplicate"


def test_filename_dup_mapped():
    d = _disposition_from_failed({"dup-x": _dup_record(kind="filename", original="a.txt")}, set())
    assert d["dedup_reason"] == "file_name_dup"
    assert d["matched_doc_id"] == "a.txt"


def test_filename_conflict_mapped():
    # filename_conflict 无唯一 original：metadata 不含 original_doc_id
    rec = SimpleNamespace(
        metadata={"is_duplicate": True, "duplicate_kind": "filename_conflict"},
        content_length=100, chunks_count=0, created_at="t",
        status="failed", file_path="new.txt",
    )
    d = _disposition_from_failed({"dup-y": rec}, set())
    assert d["dedup_reason"] == "filename_conflict"
    assert d["matched_doc_id"] is None  # conflict 无唯一 original


def test_unknown_kind_falls_back():
    d = _disposition_from_failed({"dup-z": _dup_record(kind="mystery")}, set())
    assert d["dedup_reason"] == "unknown"


def test_genuinely_failed_doc_not_mistaken():
    # 真失败文档以自身 doc_id 入 FAILED 桶（非 dup- 前缀）
    before: dict = {}
    after = {"doc.txt": _plain_record(status="failed")}
    assert _disposition_from_failed(after, set(before)) is None


def test_pre_existing_dup_not_reported():
    before = {"dup-old": _dup_record(kind="filename")}
    after = dict(before)
    assert _disposition_from_failed(after, set(before)) is None


# ── _map_doc_status ─────────────────────────────────────────

def test_map_doc_status():
    assert _map_doc_status("processed") == "indexed"
    assert _map_doc_status("failed") == "error"
    assert _map_doc_status("pending") == "indexing"
    assert _map_doc_status("") == "indexing"


# ── insert_document / insert_documents_batch 携带处置 ────────

def test_insert_document_returns_disposition(monkeypatch):
    disp = {"deduplicated": True, "dedup_reason": "content_hash_dup",
            "matched_doc_id": "orig.txt", "status": "duplicate"}
    monkeypatch.setattr("api.engine._run_async", lambda coro: disp)
    monkeypatch.setattr("api.engine.get_rag", lambda *a, **k: object())
    r = insert_document("t1", "ns", "text", "new.txt")
    assert r["doc_id"] == "new.txt"
    assert r["tenant"] == "t1" and r["namespace"] == "ns"
    assert r["deduplicated"] is True
    assert r["dedup_reason"] == "content_hash_dup"
    assert r["matched_doc_id"] == "orig.txt"


def test_insert_documents_batch_returns_per_doc_results(monkeypatch):
    results = [
        {"deduplicated": False, "status": "indexed"},
        {"deduplicated": True, "dedup_reason": "content_hash_dup",
         "matched_doc_id": "a.txt", "status": "duplicate"},
    ]
    monkeypatch.setattr("api.engine._run_async", lambda coro: {"results": results, "count": 2})
    monkeypatch.setattr("api.engine.get_rag", lambda *a, **k: object())
    r = insert_documents_batch("t1", "ns", [{"text": "a"}, {"text": "b"}])
    assert r["count"] == 2
    assert r["results"][0]["status"] == "indexed"
    assert r["results"][1]["deduplicated"] is True
    assert r["results"][1]["dedup_reason"] == "content_hash_dup"
