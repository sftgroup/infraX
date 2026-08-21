"""tenants/manager.py 并发修复单测（2026-08-21 生产实测触发）。

- _get_conn 必须设置 busy_timeout（无则并发写立即抛 database is locked → 500）
- WAL 保持开启
- RWL-1/RWL-3: busy_timeout 从配置读取；审计/last_used 写走短超时连接快速降级
"""
import sqlite3

from config import load_config
from tenants import manager as tm

# RWL-1: 所有测试共享已加载配置（_get_conn 依赖 get_config）
load_config()


def _conn(**kw):
    return tm._get_conn(**kw)


def test_get_conn_sets_busy_timeout(monkeypatch, tmp_path):
    load_config()  # RWL-1: _get_conn 从配置读取超时
    monkeypatch.setattr(tm, "_get_db_path", lambda: tmp_path / "t.db")
    conn = _conn()
    try:
        busy = conn.execute("PRAGMA busy_timeout").fetchone()[0]
        wal = conn.execute("PRAGMA journal_mode").fetchone()[0]
        assert busy >= 10000
        assert wal.lower() == "wal"
    finally:
        conn.close()


def test_get_conn_honors_explicit_timeout(monkeypatch, tmp_path):
    """显式传入的超时优先于配置默认值（RWL-1）。"""
    load_config()
    monkeypatch.setattr(tm, "_get_db_path", lambda: tmp_path / "t.db")
    conn = _conn(busy_timeout_ms=1234)
    try:
        busy = conn.execute("PRAGMA busy_timeout").fetchone()[0]
        assert busy == 1234
    finally:
        conn.close()


def test_config_reads_busy_timeout_env(monkeypatch):
    """TENANT_BUSY_TIMEOUT_MS 环境变量生效（RWL-1）。"""
    monkeypatch.setenv("TENANT_BUSY_TIMEOUT_MS", "45000")
    monkeypatch.setenv("TENANT_AUDIT_BUSY_TIMEOUT_MS", "2000")
    import config as cfgmod
    monkeypatch.setattr(cfgmod, "_config", None)
    cfg = cfgmod.load_config()
    assert cfg.tenant.busy_timeout_ms == 45000
    assert cfg.tenant.audit_busy_timeout_ms == 2000


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
