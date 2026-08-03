"""Database-backed cache for market data."""
import json
import time
from datetime import datetime, timezone
from typing import Any, Optional, Callable
from app.utils.logger import get_logger
from app.utils.db import get_db_connection

logger = get_logger(__name__)


def db_cache_get(key: str) -> Optional[Any]:
    """Get cached value from DB, checking TTL on the DB side."""
    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            # Let PostgreSQL handle TTL check directly via EXTRACT(EPOCH)
            cur.execute(
                "SELECT cache_value FROM qd_market_cache "
                "WHERE cache_key = %s "
                "AND EXTRACT(EPOCH FROM (NOW() - updated_at)) < ttl_seconds",
                (key,)
            )
            row = cur.fetchone()
            if row:
                return row['cache_value']
    except Exception as e:
        logger.warning("db_cache_get(%s) failed: %s", key, e)
    return None


def db_cache_set(key: str, value: Any, ttl: int = 300):
    """Set cached value in DB (upsert)."""
    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            cur.execute(
                """INSERT INTO qd_market_cache (cache_key, cache_value, updated_at, ttl_seconds)
                   VALUES (%s, %s::jsonb, NOW(), %s)
                   ON CONFLICT (cache_key)
                   DO UPDATE SET cache_value = %s::jsonb, updated_at = NOW(), ttl_seconds = %s""",
                (key, json.dumps(value) if not isinstance(value, str) else value, ttl,
                 json.dumps(value) if not isinstance(value, str) else value, ttl)
            )
            conn.commit()
    except Exception as e:
        logger.warning("db_cache_set(%s) failed: %s", key, e)


def db_cache_get_or_compute(key: str, fn: Callable, ttl: int = 300, force: bool = False) -> Any:
    """Get from DB or compute + store."""
    if not force:
        cached = db_cache_get(key)
        if cached is not None:
            return cached
    value = fn()
    db_cache_set(key, value, ttl)
    return value


def db_cache_clear(key: Optional[str] = None):
    """Clear one or all cache entries."""
    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            if key:
                cur.execute("DELETE FROM qd_market_cache WHERE cache_key = %s", (key,))
            else:
                cur.execute("DELETE FROM qd_market_cache")
            conn.commit()
    except Exception as e:
        logger.warning("db_cache_clear failed: %s", e)
