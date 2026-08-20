"""tenants/manager.py 并发修复单测（2026-08-21 生产实测触发）。

- _get_conn 必须设置 busy_timeout（无则并发写立即抛 database is locked → 500）
- WAL 保持开启
"""
import sqlite3

from tenants import manager as tm


def _conn():
    return tm._get_conn()


def test_get_conn_sets_busy_timeout(monkeypatch, tmp_path):
    monkeypatch.setattr(tm, "_get_db_path", lambda: tmp_path / "t.db")
    conn = _conn()
    try:
        busy = conn.execute("PRAGMA busy_timeout").fetchone()[0]
        wal = conn.execute("PRAGMA journal_mode").fetchone()[0]
        assert busy >= 10000
        assert wal.lower() == "wal"
    finally:
        conn.close()


def test_validate_api_key_roundtrip(monkeypatch, tmp_path):
    monkeypatch.setattr(tm, "_get_db_path", lambda: tmp_path / "t.db")
    tm.init_db()
    info = tm.generate_api_key("default", "t1", 0)
    got = tm.validate_api_key(info["key"])
    assert got is not None
    assert got["tenant_id"] == "default"
    assert tm.validate_api_key("lr_wrong") is None


def test_concurrent_writes_do_not_raise(monkeypatch, tmp_path):
    """10 个线程并发写（validate_api_key 的 last_used_at 更新路径）不应抛锁错误。"""
    import threading

    monkeypatch.setattr(tm, "_get_db_path", lambda: tmp_path / "t.db")
    tm.init_db()
    info = tm.generate_api_key("default", "t2", 0)
    key = info["key"]

    errors: list[Exception] = []

    def worker():
        try:
            for _ in range(10):
                assert tm.validate_api_key(key) is not None
        except Exception as e:  # pragma: no cover
            errors.append(e)

    threads = [threading.Thread(target=worker) for _ in range(10)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert not errors, f"concurrent writes raised: {errors}"
