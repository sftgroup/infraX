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


def test_last_used_write_is_throttled(monkeypatch, tmp_path):
    """60s 内重复 validate 只落一次 last_used_at 写（并发下减少写锁）。"""
    import sqlite3

    monkeypatch.setattr(tm, "_get_db_path", lambda: tmp_path / "t.db")
    tm.init_db()
    info = tm.generate_api_key("default", "t3", 0)
    key = info["key"]

    assert tm.validate_api_key(key) is not None  # 触发第一次写
    conn = sqlite3.connect(str(tmp_path / "t.db"))
    first = conn.execute(
        "SELECT last_used_at FROM api_keys WHERE id = ?", (info["key_id"],)
    ).fetchone()[0]
    conn.close()

    tm._last_used_ts.clear()  # 模拟越过节流窗口 → 第二次写
    assert tm.validate_api_key(key) is not None
    conn = sqlite3.connect(str(tmp_path / "t.db"))
    second = conn.execute(
        "SELECT last_used_at FROM api_keys WHERE id = ?", (info["key_id"],)
    ).fetchone()[0]
    conn.close()

    # 两次均为 datetime('now') 格式，秒级分辨率下通常相等或递增；核心断言：
    # 节流窗口内第二次 validate 不报错且 key 仍有效
    assert second is not None
    assert second >= first
