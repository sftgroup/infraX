"""
Tenant & API Key Management.
Uses SQLite for lightweight multi-tenant API key storage.
"""
import hashlib
import logging
import secrets
import sqlite3
import threading
import time
from pathlib import Path
from datetime import datetime, timedelta, timezone

from config import get_config

logger = logging.getLogger("ragservicer.tenants")


def _get_db_path() -> Path:
    return Path(get_config().tenant.db_path)


def _get_audit_db_path() -> Path:
    # RWL-5: 审计日志独立库（高频写）与租户元数据分离。
    return Path(get_config().tenant.audit_db_path)


# ── Connection (lazy, no module-level side effects) ─
# RWL-6: 线程本地 + 按 db_path 缓存连接（避免每请求建连/关连）。
# SQLite 连接绑定创建线程；每线程最多为每个库保持一条连接，
# 由 _release_conn 归还（回滚未提交事务后复用），多线程由 WAL + busy_timeout 协调。
_local = threading.local()


def _get_conn(busy_timeout_ms: int | None = None) -> sqlite3.Connection:
    db_path = str(_get_db_path())
    conns = getattr(_local, "conns", None)
    if conns is None:
        conns = {}
        _local.conns = conns
    conn = conns.get(db_path)
    if conn is None:
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conns[db_path] = conn
    # RWL-1: busy_timeout 从配置读取（默认 30s），短锁冲突自动等待而非直接抛错。
    if busy_timeout_ms is None:
        busy_timeout_ms = get_config().tenant.busy_timeout_ms
    conn.execute(f"PRAGMA busy_timeout={int(busy_timeout_ms)}")
    return conn


def _release_conn(conn: sqlite3.Connection) -> None:
    """归还连接：线程本地缓存连接回滚事务后复用；独立连接（如审计库）真正关闭。"""
    cached = getattr(_local, "conns", {}).get(str(_get_db_path()))
    if cached is conn:
        try:
            conn.rollback()
        except sqlite3.Error:
            pass
        return
    try:
        conn.close()
    except sqlite3.Error:
        pass


# last_used_at 写入节流（2026-08-21 并发写锁修复）：
# 鉴权热路径在 WAL + busy_timeout 下仍可能因并发突发排空超时 → 500。
# 每把 key 至多 60s 落一次库，且失败仅记 debug（鉴权读不受写锁影响）。
_used_lock = threading.Lock()
_last_used_ts: dict[str, float] = {}


def _touch_last_used(conn: sqlite3.Connection, key_id: str) -> None:
    now = time.time()
    with _used_lock:
        if now - _last_used_ts.get(key_id, 0.0) < 60.0:
            return
        _last_used_ts[key_id] = now
    try:
        # RWL-3: 使用独立短超时连接执行（复用传入的只读连接会延长事务、
        # 阻塞请求）；写失败仅 debug 降级，不影响鉴权主流程。
        wconn = _get_conn(busy_timeout_ms=get_config().tenant.audit_busy_timeout_ms)
        try:
            wconn.execute(
                "UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?",
                (key_id,),
            )
            wconn.commit()
        finally:
            _release_conn(wconn)
    except sqlite3.Error as exc:
        logger.debug("last_used_at update skipped: %s", exc)


def init_db():
    db_path = _get_db_path()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    # RWL-5: 审计日志独立库初始化（高频写不再占用主库写锁）。
    _init_audit_db()
    conn = _get_conn()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS tenants (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT DEFAULT '',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            active INTEGER NOT NULL DEFAULT 1
        );

        CREATE TABLE IF NOT EXISTS api_keys (
            id TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL,
            name TEXT NOT NULL,
            key_hash TEXT NOT NULL,
            key_prefix TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            last_used_at TEXT,
            expires_at TEXT,
            active INTEGER NOT NULL DEFAULT 1,
            FOREIGN KEY (tenant_id) REFERENCES tenants(id)
        );

        CREATE INDEX IF NOT EXISTS idx_tenant_apikeys ON api_keys(tenant_id);
        CREATE INDEX IF NOT EXISTS idx_key_hash ON api_keys(key_hash);

        -- Default tenant for backward compatibility
        INSERT OR IGNORE INTO tenants (id, name, description)
        VALUES ('default', 'Default', 'Default tenant for existing integrations');
    """)
    # R-TN: tenant_scope（幂等迁移，旧表不回填；兼容 SQLite < 3.35 的 PRAGMA 检查）
    #  NULL/''        → 仅 key 绑定租户（默认）
    #  '*'            → 共享 key：可经 X-Tenant-ID 访问任意已存在租户
    #  't1,t2,...'    → 共享 key：仅允许列出的已存在租户
    cols = {r[1] for r in conn.execute("PRAGMA table_info(api_keys)")}
    if "tenant_scope" not in cols:
        conn.execute("ALTER TABLE api_keys ADD COLUMN tenant_scope TEXT")
    conn.commit()
    _release_conn(conn)


# ── Audit logs（G-8：结构化审计，谁/何时/改了什么）──────────
# RWL-5: 审计日志写入独立 audit.db（高频写），与租户元数据库分离，
# 避免 after_request 审计写与鉴权/租户管理互抢写锁。

def _init_audit_db() -> None:
    db_path = _get_audit_db_path()
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(db_path))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=1000")
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS audit_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts TEXT NOT NULL DEFAULT (datetime('now')),
            tenant TEXT NOT NULL,
            endpoint TEXT NOT NULL,
            method TEXT NOT NULL,
            status INTEGER NOT NULL,
            duration_ms REAL NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_audit_tenant_ts ON audit_logs(tenant, ts);
    """)
    conn.commit()
    conn.close()


def add_audit_log(tenant: str, endpoint: str, method: str, status: int, duration_ms: float) -> None:
    """写入一条审计记录；失败仅记 debug，不影响请求本身。

    RWL-3: 审计写走独立短超时连接（默认 1s），锁冲突快速降级，
    避免 after_request 同步写被长事务持锁拖慢所有请求（晚间 10s 慢响应根因）。
    RWL-5: 审计写入独立 audit.db，与租户元数据写锁解耦。
    """
    try:
        conn = sqlite3.connect(str(_get_audit_db_path()))
        conn.execute("PRAGMA busy_timeout=%d" % get_config().tenant.audit_busy_timeout_ms)
        conn.execute(
            "INSERT INTO audit_logs (tenant, endpoint, method, status, duration_ms) VALUES (?, ?, ?, ?, ?)",
            (tenant, endpoint, method, status, duration_ms),
        )
        conn.commit()
        conn.close()
    except Exception as exc:  # noqa: BLE001 — 审计降级绝不影响请求
        logger.debug("audit log write skipped: %s", exc)


# ── Tenant CRUD ────────────────────────────────────────────

def create_tenant(tenant_id: str, name: str, description: str = "") -> dict:
    conn = _get_conn()
    conn.execute(
        "INSERT INTO tenants (id, name, description) VALUES (?, ?, ?)",
        (tenant_id, name, description)
    )
    conn.commit()
    _release_conn(conn)
    return {"tenant_id": tenant_id, "name": name, "description": description}


def list_tenants() -> list[dict]:
    conn = _get_conn()
    rows = conn.execute(
        "SELECT id, name, description, created_at, active FROM tenants ORDER BY created_at DESC"
    ).fetchall()
    _release_conn(conn)
    return [dict(r) for r in rows]


def get_tenant(tenant_id: str) -> dict | None:
    conn = _get_conn()
    row = conn.execute("SELECT * FROM tenants WHERE id = ?", (tenant_id,)).fetchone()
    _release_conn(conn)
    return dict(row) if row else None


def delete_tenant(tenant_id: str):
    conn = _get_conn()
    conn.execute("DELETE FROM api_keys WHERE tenant_id = ?", (tenant_id,))
    conn.execute("DELETE FROM tenants WHERE id = ?", (tenant_id,))
    conn.commit()
    _release_conn(conn)


# ── API Key Management ─────────────────────────────────────

def _hash_key(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()


def generate_api_key(tenant_id: str, name: str, expires_days: int = 0) -> dict:
    """Generate a new API key for a tenant. Returns the plaintext key ONCE."""
    plain_key = f"lr_{secrets.token_hex(24)}"
    key_id = f"key_{secrets.token_hex(8)}"
    key_hash = _hash_key(plain_key)
    expires_at = (datetime.now(timezone.utc) + timedelta(days=expires_days)).isoformat() if expires_days > 0 else None

    conn = _get_conn()
    conn.execute(
        "INSERT INTO api_keys (id, tenant_id, name, key_hash, key_prefix, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
        (key_id, tenant_id, name, key_hash, plain_key[:12], expires_at)
    )
    conn.commit()
    _release_conn(conn)

    return {
        "key_id": key_id,
        "tenant_id": tenant_id,
        "name": name,
        "key": plain_key,  # ⚠️ Only returned once
        "key_prefix": plain_key[:12],
        "created_at": datetime.now(timezone.utc).isoformat(),
        "expires_at": expires_at,
    }


def validate_api_key(plain_key: str) -> dict | None:
    """Validate an API key; return tenant info if valid."""
    key_hash = _hash_key(plain_key)
    conn = _get_conn()
    row = conn.execute("""
        SELECT k.*, t.name as tenant_name
        FROM api_keys k
        JOIN tenants t ON k.tenant_id = t.id
        WHERE k.key_hash = ? AND k.active = 1 AND t.active = 1
        AND (k.expires_at IS NULL OR k.expires_at > datetime('now'))
    """, (key_hash,)).fetchone()

    if row:
        _touch_last_used(conn, row["id"])

    _release_conn(conn)

    if not row:
        return None

    return {
        "tenant_id": row["tenant_id"],
        "tenant_name": row["tenant_name"],
        "key_id": row["id"],
        "key_name": row["name"],
    }


def list_api_keys(tenant_id: str) -> list[dict]:
    conn = _get_conn()
    rows = conn.execute(
        "SELECT id, tenant_id, name, key_prefix, created_at, last_used_at, expires_at, active FROM api_keys WHERE tenant_id = ? ORDER BY created_at DESC",
        (tenant_id,)
    ).fetchall()
    _release_conn(conn)
    return [dict(r) for r in rows]


def revoke_api_key(key_id: str):
    conn = _get_conn()
    conn.execute("UPDATE api_keys SET active = 0 WHERE id = ?", (key_id,))
    conn.commit()
    _release_conn(conn)


# ── R-TN: X-Tenant-ID 授权边界（共享 key 多租户）─────────────

def set_key_scope(key_id: str, scope: str | None) -> None:
    """设置 key 的租户访问范围（admin API 调用）。

    scope 语义（与 init_db 迁移注释一致）：
      None/'' → 仅 key 绑定租户（默认，X-Tenant-ID 无效）
      '*'     → 可经 X-Tenant-ID 访问任意已存在租户
      't1,t2' → 仅允许列出的已存在租户
    """
    conn = _get_conn()
    conn.execute("UPDATE api_keys SET tenant_scope = ? WHERE id = ?", (scope or "", key_id))
    conn.commit()
    _release_conn(conn)


def is_tenant_allowed(key_id: str, bound_tenant: str, target: str) -> bool:
    """校验 key 是否被授权访问 ``target`` 租户（X-Tenant-ID 场景）。

    - target 为空或等于 key 绑定租户 → 放行（默认行为）
    - tenant_scope='*' → target 必须已存在（租户由服务端创建，不自动隐式创建）
    - tenant_scope='t1,t2' → target 在列表且已存在
    - tenant_scope 为空 → 仅绑定租户，其他 target 拒绝
    """
    if not target or target == bound_tenant:
        return True
    conn = _get_conn()
    row = conn.execute("SELECT tenant_scope FROM api_keys WHERE id = ?", (key_id,)).fetchone()
    _release_conn(conn)
    scope = (row["tenant_scope"] or "").strip() if row else ""
    if not scope:
        return False
    # 目标租户必须已存在（防止任意 key 隐式创建数据空间）
    if not get_tenant(target):
        return False
    if scope == "*":
        return True
    allowed = {t.strip() for t in scope.split(",") if t.strip()}
    return target in allowed
