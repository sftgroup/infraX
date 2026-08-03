"""Persistent market data storage (DB-backed, append-only).

Unlike qd_market_cache (short-lived TTL), this stores every data snapshot
permanently.  The latest row per (market, symbol, data_type, timeframe)
acts as the current value.  A periodic cleanup removes data older than
retention_days (default 7).

Usage:
    from app.data_providers.db_persist import db_data_save, db_data_get_latest

    db_data_save('Crypto', 'BTC/USDT', 'price', '', price_dict, source='binance')
    latest_price = db_data_get_latest('Crypto', 'BTC/USDT', 'price', '')
"""

import json
from typing import Any, Dict, List, Optional

from app.utils.logger import get_logger
from app.utils.db import get_db_connection

logger = get_logger(__name__)


def db_data_save(market: str, symbol: str, data_type: str, timeframe: str,
                 data: Any, source: str = '') -> bool:
    """Save a data snapshot to the persistent store.

    Args:
        market:   e.g. 'Crypto', 'USStock'
        symbol:   e.g. 'BTC/USDT', 'AAPL'
        data_type: 'price' | 'kline' | 'indicators' | 'macro' | 'news' | 'fundamental' | 'crypto_factors'
        timeframe: e.g. '1D', '4H'; empty for non-kline types
        data:     any JSON-serialisable value
        source:   label e.g. 'binance', 'yahoo', 'finnhub'

    Returns:
        True on success, False on failure.
    """
    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            cur.execute("""
                INSERT INTO qd_market_data (market, symbol, data_type, timeframe, data, source)
                VALUES (%s, %s, %s, %s, %s::jsonb, %s)
            """, (market, symbol, data_type, timeframe or '',
                  json.dumps(data) if not isinstance(data, str) else data,
                  source or ''))
            conn.commit()
            return True
    except Exception as e:
        logger.warning("db_data_save(%s:%s:%s) failed: %s", market, symbol, data_type, e)
        return False


def db_data_get_latest(market: str, symbol: str, data_type: str,
                       timeframe: str = '') -> Optional[Any]:
    """Read the latest persisted snapshot for a given key.

    Returns the raw data field (Python object), or None if no record exists.
    """
    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            cur.execute("""
                SELECT data FROM qd_market_data
                WHERE market = %s AND symbol = %s AND data_type = %s AND timeframe = %s
                ORDER BY created_at DESC
                LIMIT 1
            """, (market, symbol, data_type, timeframe or ''))
            row = cur.fetchone()
            if row:
                return row['data']
    except Exception as e:
        logger.warning("db_data_get_latest(%s:%s:%s) failed: %s", market, symbol, data_type, e)
    return None


def db_data_get_history(market: str, symbol: str, data_type: str,
                        timeframe: str = '', limit: int = 100) -> List[Dict[str, Any]]:
    """Read recent persisted snapshots for a given key (including created_at).

    Returns list of {data, created_at} dicts ordered by created_at DESC.
    """
    results = []
    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            cur.execute("""
                SELECT data, created_at FROM qd_market_data
                WHERE market = %s AND symbol = %s AND data_type = %s AND timeframe = %s
                ORDER BY created_at DESC
                LIMIT %s
            """, (market, symbol, data_type, timeframe or '', int(limit)))
            for row in cur.fetchall():
                results.append({
                    'data': row['data'],
                    'created_at': row['created_at'].isoformat() if row['created_at'] else None
                })
    except Exception as e:
        logger.warning("db_data_get_history(%s:%s:%s) failed: %s", market, symbol, data_type, e)
    return results


def db_data_cleanup(retention_days: int = 7) -> int:
    """Delete market data older than retention_days.

    Returns the number of deleted rows.
    """
    try:
        with get_db_connection() as conn:
            cur = conn.cursor()
            cur.execute("SELECT cleanup_old_market_data(%s)", (int(retention_days),))
            row = cur.fetchone()
            conn.commit()
            # Handle both tuple-like and dict-like cursor results
            if row:
                if isinstance(row, dict):
                    deleted = int(list(row.values())[0] if row else 0)
                else:
                    deleted = int(row[0] if row else 0)
            else:
                deleted = 0
            if deleted > 0:
                logger.info("Market data cleanup: deleted %d rows older than %d days", deleted, retention_days)
            return deleted
    except Exception as e:
        logger.warning("db_data_cleanup failed: %s", e)
        return 0
