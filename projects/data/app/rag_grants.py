"""LightRAG 门户自助开通（rag_grants）— data service。

B 端门户"LightRAG 我的订阅"选择套餐后，平台自动分配 lr_ key：
data-service 内部持 ragservicer admin key，为用户（钱包地址）创建独立租户 +
签发 lr_ key，并将完整 key 明文存入本表（平台代管，用户可随时回看，无需
再联系 admin 手动开通）。

安全说明：api_keys 表仅存 SHA-256 哈希（避免库文件泄漏即密钥泄漏）；本表
存明文是产品决策——ragservicer 的 lr_ key 只返回一次，平台代管才能支持
"选套餐自动开通 + 随时回看"的 B 端自助体验。数据库文件应纳入最小权限保护。
"""
from __future__ import annotations

import threading
import time

from app.storage.sqlite import get_db
from app.utils.logger import get_logger

logger = get_logger(__name__)

_DEFAULT_NAMESPACE = "default"

# ── 表结构（幂等创建，模块导入时执行）────────────────────────
_DDL = """
CREATE TABLE IF NOT EXISTS rag_grants (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    owner      TEXT    NOT NULL UNIQUE,   -- 钱包地址（小写），每钱包一个 LightRAG 租户+key
    tenant_id  TEXT    NOT NULL,
    key_id     TEXT    NOT NULL,
    api_key    TEXT    NOT NULL,          -- 平台代管明文（ragservicer lr_ key 仅签发一次）
    key_prefix TEXT    NOT NULL,          -- 掩码展示用（前 12 位）
    namespace  TEXT    NOT NULL DEFAULT 'default',
    plan_id    TEXT    NOT NULL DEFAULT 'lr_free',
    created_at REAL    NOT NULL           -- unix ms
);
CREATE INDEX IF NOT EXISTS idx_rag_grants_owner ON rag_grants(owner);
"""

_ensure_lock = threading.Lock()


def _ensure_table() -> None:
    with _ensure_lock:
        get_db().executescript(_DDL)


_ensure_table()


def _row_to_dict(row) -> dict:
    return {
        "id": row["id"],
        "owner": row["owner"],
        "tenant_id": row["tenant_id"],
        "key_id": row["key_id"],
        "api_key": row["api_key"],
        "key_prefix": row["key_prefix"],
        "namespace": row["namespace"],
        "plan_id": row["plan_id"],
        "created_at": row["created_at"],
    }


def get_for_owner(owner: str) -> dict | None:
    """查询钱包已分配的 LightRAG 开通记录（含完整 key），无则 None。"""
    owner = (owner or "").strip().lower()
    if not owner:
        return None
    row = get_db().execute(
        "SELECT * FROM rag_grants WHERE owner = ? LIMIT 1", (owner,)
    ).fetchone()
    return _row_to_dict(row) if row else None


def list_by_owner(owner: str) -> list[dict]:
    """钱包的 LightRAG 开通记录列表（掩码展示用，含完整 key 字段）。"""
    owner = (owner or "").strip().lower()
    if not owner:
        return []
    rows = get_db().execute(
        "SELECT * FROM rag_grants WHERE owner = ? ORDER BY created_at DESC", (owner,)
    ).fetchall()
    return [_row_to_dict(r) for r in rows]


def insert(
    owner: str,
    tenant_id: str,
    key_id: str,
    api_key: str,
    namespace: str = _DEFAULT_NAMESPACE,
    plan_id: str = "lr_free",
) -> dict:
    """插入一条开通记录（owner 唯一）。并发/重复调用由 UNIQUE 约束兜底。"""
    owner = (owner or "").strip().lower()
    now_ms = time.time() * 1000
    key_prefix = api_key[:12]
    with _ensure_lock:
        db = get_db()
        try:
            db.execute(
                "INSERT INTO rag_grants (owner, tenant_id, key_id, api_key, key_prefix, namespace, plan_id, created_at)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (owner, tenant_id, key_id, api_key, key_prefix, namespace, plan_id, now_ms),
            )
            db.commit()
        except Exception as exc:  # UNIQUE(owner) 冲突 → 读取已存在记录
            db.rollback()
            logger.debug("rag_grants insert conflict (owner=%s): %s", owner, exc)
            row = get_for_owner(owner)
            if row:
                return row
            raise
    row = get_for_owner(owner)
    return row or _row_to_dict({
        "id": None, "owner": owner, "tenant_id": tenant_id, "key_id": key_id,
        "api_key": api_key, "key_prefix": key_prefix, "namespace": namespace,
        "plan_id": plan_id, "created_at": now_ms,
    })
