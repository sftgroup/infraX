"""多租户 API key 签发与管理（multi-key issuance）— data service。

复用旧栈 collector 的 api_keys 表模式（label / rate_limit / enabled /
用量跟踪 / 掩码列表 / CRUD），按 data 服务环境适配：

  - 存于共享 SQLite（data/data.db，见 app.storage），表 api_keys
  - key 格式按 scope：dx_（data）/ mx_（mcp）+ 24 字节 hex（51 字符）；仅存
    SHA-256 哈希，不存明文（旧栈 collector 存明文，哈希避免 SQLite 文件
    泄漏即密钥泄漏）
  - 每 key RPM 滑动窗口限流（内存，单实例）
  - 用量跟踪：last_used_at / request_count

签发的 key 与平台 bridge key（DATA_API_KEY）等价，可访问全部业务端点；
携带方式沿用统一契约（app_auth）：Authorization: Bearer | X-API-Key |
X-Service-Key 三 header 任一。admin 端点仍仅 ADMIN_API_KEY。
"""

from __future__ import annotations

import hashlib
import secrets
import threading
import time

from app.storage.sqlite import get_db
from app.utils.logger import get_logger

logger = get_logger(__name__)

KEY_PREFIX = "dx_"
# scope → key 前缀（MCP 专用 key 用 mx_ 前缀，权限由调用方校验）
PREFIX_BY_SCOPE = {"data": "dx_", "mcp": "mx_"}
_DEFAULT_PREFIX = "dx_"
_DEFAULT_RATE_LIMIT = 100

# ── 表结构（幂等创建，模块导入时执行）────────────────────────
_DDL = """
CREATE TABLE IF NOT EXISTS api_keys (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    label        TEXT    NOT NULL,
    scope        TEXT    NOT NULL DEFAULT 'data',  -- data | mcp
    key_hash     TEXT    NOT NULL UNIQUE,   -- SHA-256 hex，不存明文
    key_prefix   TEXT    NOT NULL,          -- 前 8 位，掩码展示
    key_tail     TEXT    NOT NULL,          -- 后 4 位，掩码展示
    rate_limit   INTEGER NOT NULL DEFAULT 100,   -- RPM
    enabled      INTEGER NOT NULL DEFAULT 1,
    created_by   TEXT    NOT NULL DEFAULT '',
    last_used_at REAL,                      -- unix ms
    request_count INTEGER NOT NULL DEFAULT 0,
    created_at   REAL    NOT NULL,          -- unix ms
    updated_at   REAL    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
"""

_ensure_lock = threading.Lock()


def _ensure_table() -> None:
    with _ensure_lock:
        db = get_db()
        db.executescript(_DDL)
        # 迁移：低版本表无 scope 列 → ADD COLUMN（SQLite 支持带 DEFAULT）
        cols = {r["name"] for r in db.execute("PRAGMA table_info(api_keys)").fetchall()}
        if "scope" not in cols:
            db.execute("ALTER TABLE api_keys ADD COLUMN scope TEXT NOT NULL DEFAULT 'data'")
        db.commit()


_ensure_table()


# ── per-key 滑动窗口限流（单实例内存，复用 collector 模式）──────
_RL: dict[int, list] = {}
_RL_LOCK = threading.Lock()
_RL_MAX = 256


def _rate_limited(key_id: int, rate_limit: int) -> bool:
    """1 分钟滑动窗口；超限返回 True。"""
    now_ms = time.time() * 1000
    window_ms = 60_000
    with _RL_LOCK:
        if len(_RL) > _RL_MAX:
            # 机会性清理过期窗口，避免无限增长
            for k in [k for k, v in _RL.items() if now_ms - v[0] > window_ms]:
                _RL.pop(k, None)
        win = _RL.get(key_id)
        if win is None or now_ms - win[0] > window_ms:
            _RL[key_id] = [now_ms, 1]
            return False
        if win[1] >= rate_limit:
            return True
        win[1] += 1
        return False


# ── 核心操作 ─────────────────────────────────────────────────

def _hash(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()


def generate_api_key(scope: str = "data") -> str:
    return PREFIX_BY_SCOPE.get(scope, _DEFAULT_PREFIX) + secrets.token_hex(24)


def verify(api_key: str, scope: str = "data") -> int:
    """校验请求携带的 key。返回 0=放行，否则为 HTTP 状态码（401/403/429）。

    scope 决定匹配哪一类 key（data → dx_，mcp → mx_）；业务端点默认
    scope="data"，MCP 入站校验用 scope="mcp"。
    """
    prefix = PREFIX_BY_SCOPE.get(scope, _DEFAULT_PREFIX)
    if not api_key or not api_key.startswith(prefix):
        return 401
    row = get_db().execute(
        "SELECT id, enabled, rate_limit FROM api_keys WHERE key_hash = ? AND scope = ?",
        (_hash(api_key), scope),
    ).fetchone()
    if row is None:
        return 401
    if not row["enabled"]:
        return 403
    if _rate_limited(row["id"], row["rate_limit"] or _DEFAULT_RATE_LIMIT):
        return 429
    _track_usage(row["id"])
    return 0


def _track_usage(key_id: int) -> None:
    """fire-and-forget 用量统计（失败不阻塞请求）。"""
    try:
        db = get_db()
        db.execute(
            "UPDATE api_keys SET last_used_at = ?, request_count = request_count + 1 WHERE id = ?",
            (time.time() * 1000, key_id),
        )
        db.commit()
    except Exception as e:  # pragma: no cover
        logger.warning("api_keys usage tracking failed: %s", e)


def create_key(label: str, rate_limit: int | None = None, created_by: str = "admin", scope: str = "data") -> tuple[str, dict]:
    """签发新 key。返回 (完整 key, 行记录)；完整 key 仅此一次可见。"""
    raw = generate_api_key(scope)
    now_ms = time.time() * 1000
    db = get_db()
    cur = db.execute(
        """INSERT INTO api_keys
           (label, scope, key_hash, key_prefix, key_tail, rate_limit, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (label, scope, _hash(raw), raw[:8], raw[-4:], rate_limit or _DEFAULT_RATE_LIMIT,
         created_by, now_ms, now_ms),
    )
    db.commit()
    return raw, dict(_row_by_id(cur.lastrowid))


def list_keys(scope: str | None = None) -> list[dict]:
    """列表（key 掩码展示：前 8 + ... + 后 4）。scope=None 返回全部。"""
    sql = """SELECT id, label, scope,
                  key_prefix || '...' || key_tail AS key_masked,
                  rate_limit, enabled, created_by,
                  last_used_at, request_count, created_at, updated_at
           FROM api_keys"""
    args: list = []
    if scope:
        sql += " WHERE scope = ?"
        args.append(scope)
    sql += " ORDER BY created_at DESC"
    rows = get_db().execute(sql, args).fetchall()
    return [dict(r) for r in rows]


def update_key(key_id: int, label=None, enabled=None, rate_limit=None) -> bool:
    sets, vals = [], []
    if label is not None:
        sets.append("label = ?")
        vals.append(str(label))
    if enabled is not None:
        sets.append("enabled = ?")
        vals.append(1 if bool(enabled) else 0)
    if rate_limit is not None:
        sets.append("rate_limit = ?")
        vals.append(max(1, int(rate_limit)))
    if not sets:
        return False
    vals.append(time.time() * 1000)
    vals.append(key_id)
    cur = get_db().execute(
        f"UPDATE api_keys SET {', '.join(sets)}, updated_at = ? WHERE id = ?",
        vals,
    )
    get_db().commit()
    return cur.rowcount > 0


def rotate_key(key_id: int) -> str | None:
    """轮换：同 id 生成新 key（旧 key 立即失效）。返回新完整 key。"""
    row = get_db().execute("SELECT scope FROM api_keys WHERE id = ?", (key_id,)).fetchone()
    scope = row["scope"] if row else "data"
    raw = generate_api_key(scope)
    cur = get_db().execute(
        "UPDATE api_keys SET key_hash = ?, key_prefix = ?, key_tail = ?, updated_at = ? WHERE id = ?",
        (_hash(raw), raw[:8], raw[-4:], time.time() * 1000, key_id),
    )
    get_db().commit()
    return raw if cur.rowcount > 0 else None


def delete_key(key_id: int) -> bool:
    cur = get_db().execute("DELETE FROM api_keys WHERE id = ?", (key_id,))
    get_db().commit()
    return cur.rowcount > 0


def _row_by_id(key_id: int):
    return get_db().execute(
        "SELECT * FROM api_keys WHERE id = ?", (key_id,)
    ).fetchone()
