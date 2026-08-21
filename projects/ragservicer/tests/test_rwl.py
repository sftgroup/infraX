"""RWL 修复单测（2026-08-21 AIServicer issue）。

- RWL-1: busy_timeout 从配置读取（默认 30s，可环境覆盖）
- RWL-2: SQLite database is locked → 503 + Retry-After（handle_errors / 全局兜底）
- RWL-3: 审计日志写锁冲突快速降级，不拖慢请求；last_used 写独立短超时连接
"""
import sqlite3

from flask import Flask

from config import load_config
from tenants import manager as tm
from api import code_refactor as cr

load_config()

_app = Flask(__name__)


# ── RWL-2: 锁冲突 503 + Retry-After ─────────────────────────

def test_handle_errors_maps_locked_to_503():
    """handle_errors 捕获 sqlite3.OperationalError(database is locked) → 503 + Retry-After。"""
    logger = None

    @cr.handle_errors(logger, "test", fallback_status=500)
    def boom():
        raise sqlite3.OperationalError("database is locked")

    with _app.app_context():
        resp, status = boom()
    assert status == 503
    assert resp.headers["Retry-After"] == "5"
    body = resp.get_json()
    assert body["code"] == "DATABASE_BUSY"


def test_handle_errors_non_locked_operational_error_reraised():
    """非锁类 sqlite 错误不被吞掉（避免误映射）。"""

    @cr.handle_errors(None, "test", fallback_status=500)
    def boom():
        raise sqlite3.OperationalError("no such table: foo")

    try:
        boom()
        assert False, "should have raised"
    except sqlite3.OperationalError:
        pass


def test_handle_errors_generic_exception_still_500():

    @cr.handle_errors(None, "test", fallback_status=500)
    def boom():
        raise ValueError("boom")

    with _app.app_context():
        _resp, status = boom()
    assert status == 500


# ── RWL-3/RWL-5: 审计写锁冲突快速降级 + 独立库 ──────────────

def test_audit_log_locked_db_degrades_without_raising(monkeypatch, tmp_path):
    """审计写遇锁冲突应静默降级（debug），不抛错不阻塞。"""
    monkeypatch.setattr(tm, "_get_db_path", lambda: tmp_path / "t.db")
    monkeypatch.setattr(tm, "_get_audit_db_path", lambda: tmp_path / "audit.db")
    tm.init_db()

    def _locked_connect(*_a, **_k):
        raise sqlite3.OperationalError("database is locked")

    monkeypatch.setattr(tm.sqlite3, "connect", _locked_connect)
    # 不抛异常即通过（内部捕获降级）
    tm.add_audit_log("t1", "/x", "POST", 200, 1.0)


def test_audit_log_writes_to_separate_db(monkeypatch, tmp_path):
    """RWL-5: 审计日志写入独立 audit.db，与租户元数据库分离。"""
    monkeypatch.setattr(tm, "_get_db_path", lambda: tmp_path / "t.db")
    monkeypatch.setattr(tm, "_get_audit_db_path", lambda: tmp_path / "audit.db")
    tm.init_db()

    tm.add_audit_log("t1", "/x", "POST", 200, 1.0)

    # 审计记录应在独立库中
    audit = sqlite3.connect(str(tmp_path / "audit.db"))
    n_audit = audit.execute("SELECT COUNT(*) FROM audit_logs").fetchone()[0]
    audit.close()
    assert n_audit == 1

    # 租户库不应有 audit_logs 表
    tenant = sqlite3.connect(str(tmp_path / "t.db"))
    tables = {r[0] for r in tenant.execute(
        "SELECT name FROM sqlite_master WHERE type='table'")}
    tenant.close()
    assert "audit_logs" not in tables


def test_touch_last_used_uses_short_timeout_conn(monkeypatch, tmp_path):
    """last_used 写使用 audit 短超时连接（RWL-3）。"""
    monkeypatch.setattr(tm, "_get_db_path", lambda: tmp_path / "t.db")
    monkeypatch.setattr(tm, "_get_audit_db_path", lambda: tmp_path / "audit.db")
    tm.init_db()
    info = tm.generate_api_key("default", "t4", 0)

    captured = {}

    def _short_conn(busy_timeout_ms=None):
        captured["timeout"] = busy_timeout_ms
        conn = sqlite3.connect(str(tmp_path / "t.db"))
        conn.row_factory = sqlite3.Row
        return conn

    monkeypatch.setattr(tm, "_get_conn", _short_conn)
    tm._last_used_ts.clear()
    tm._touch_last_used(None, info["key_id"])
    assert captured["timeout"] == 1000  # audit_busy_timeout_ms 默认值


# ── RWL-1: 配置读取（补充，环境变量测试见 test_tenants） ─────

def test_default_busy_timeout_is_30s():
    """默认 busy_timeout 30s（RWL-1，短锁冲突自动等待）。"""
    cfg = load_config()
    assert cfg.tenant.busy_timeout_ms == 30000


# ── RWL-4: 写锁监控打点（/metrics） ─────────────────────────

def test_locked_503_increments_busy_counter(monkeypatch):
    """锁冲突 503 触发 sqlite_busy_total 计数（RWL-4）。"""
    from metrics import SQLITE_BUSY_TOTAL
    before = SQLITE_BUSY_TOTAL.labels(service="ragservicer")._value.get()

    @cr.handle_errors(None, "test", fallback_status=500)
    def boom():
        raise sqlite3.OperationalError("database is locked")

    with _app.app_context():
        boom()
    assert SQLITE_BUSY_TOTAL.labels(service="ragservicer")._value.get() == before + 1


def test_busy_counter_safe_without_prometheus(monkeypatch):
    """prometheus_client 不可用时打点静默降级（不抛错）。"""
    import builtins
    real_import = builtins.__import__

    def _no_metrics(name, *a, **k):
        if name == "metrics":
            raise ModuleNotFoundError("no metrics")
        return real_import(name, *a, **k)

    monkeypatch.setattr(builtins, "__import__", _no_metrics)
    # 不抛异常即通过
    cr._observe_sqlite_busy()
