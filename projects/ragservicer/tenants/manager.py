"""
Tenant & API Key Management.
Uses SQLite for lightweight multi-tenant API key storage.
"""
import hashlib
import logging
import secrets
import sqlite3
from pathlib import Path
from datetime import datetime, timedelta, timezone

from config import get_config

logger = logging.getLogger("ragservicer.tenants")


def _get_db_path() -> Path:
    return Path(get_config().tenant.db_path)


# ── Connection (lazy, no module-level side effects) ─
def _get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(str(_get_db_path()))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db():
    db_path = _get_db_path()
    db_path.parent.mkdir(parents=True, exist_ok=True)
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

        -- G-8: 结构化审计日志（who/when/what，由 audit_log_middleware 落库）
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

        -- Default tenant for backward compatibility
        INSERT OR IGNORE INTO tenants (id, name, description)
        VALUES ('default', 'Default', 'Default tenant for existing integrations');
    """)
    conn.commit()
    conn.close()


# ── Audit logs（G-8：结构化审计，谁/何时/改了什么）──────────

def add_audit_log(tenant: str, endpoint: str, method: str, status: int, duration_ms: float) -> None:
    """写入一条审计记录；失败仅记 warning，不影响请求本身。"""
    try:
        conn = _get_conn()
        conn.execute(
            "INSERT INTO audit_logs (tenant, endpoint, method, status, duration_ms) VALUES (?, ?, ?, ?, ?)",
            (tenant, endpoint, method, status, duration_ms),
        )
        conn.commit()
        conn.close()
    except Exception as exc:
        logger.warning("audit log write failed: %s", exc)


# ── Tenant CRUD ────────────────────────────────────────────

def create_tenant(tenant_id: str, name: str, description: str = "") -> dict:
    conn = _get_conn()
    conn.execute(
        "INSERT INTO tenants (id, name, description) VALUES (?, ?, ?)",
        (tenant_id, name, description)
    )
    conn.commit()
    conn.close()
    return {"tenant_id": tenant_id, "name": name, "description": description}


def list_tenants() -> list[dict]:
    conn = _get_conn()
    rows = conn.execute(
        "SELECT id, name, description, created_at, active FROM tenants ORDER BY created_at DESC"
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_tenant(tenant_id: str) -> dict | None:
    conn = _get_conn()
    row = conn.execute("SELECT * FROM tenants WHERE id = ?", (tenant_id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def delete_tenant(tenant_id: str):
    conn = _get_conn()
    conn.execute("DELETE FROM api_keys WHERE tenant_id = ?", (tenant_id,))
    conn.execute("DELETE FROM tenants WHERE id = ?", (tenant_id,))
    conn.commit()
    conn.close()


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
    conn.close()

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
        conn.execute(
            "UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?",
            (row["id"],)
        )
        conn.commit()

    conn.close()

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
    conn.close()
    return [dict(r) for r in rows]


def revoke_api_key(key_id: str):
    conn = _get_conn()
    conn.execute("UPDATE api_keys SET active = 0 WHERE id = ?", (key_id,))
    conn.commit()
    conn.close()
