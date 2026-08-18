"""graph 因子历史快照存储（GX-2.4.2）。

ml-service graph 引擎每次计算出全市场图因子（gf_*）后，由 main.py 调用
snapshot_graph_values 追加进本地 SQLite（graph_history.db），作为 FF 挖掘
（GX-2.4）IC/ICIR 评估与衰退淘汰（FF-4.4）的历史数据源。

表 graph_factor_history(ts, symbol, factor_key, value) 主键 (ts, symbol,
factor_key) 幂等——同 ts 重复快照直接覆盖；ts 归一化为自然日 0 时（ms），
保证每天每标的每因子一条。
"""
from __future__ import annotations

import logging
import os
import sqlite3
import threading
import time
from typing import Optional

import pandas as pd

import config

logger = logging.getLogger(__name__)

_DDL = """
CREATE TABLE IF NOT EXISTS graph_factor_history (
    ts INTEGER NOT NULL,
    symbol TEXT NOT NULL,
    factor_key TEXT NOT NULL,
    value REAL,
    PRIMARY KEY (ts, symbol, factor_key)
);
CREATE INDEX IF NOT EXISTS idx_gfh_ts ON graph_factor_history(ts);
"""

_store: Optional["GraphHistoryStore"] = None
_store_lock = threading.Lock()


def _db_path() -> str:
    p = (config.GRAPH_HISTORY_DB_PATH or "").strip()
    if p:
        return p
    base = os.path.dirname(os.path.abspath(config.FACTOR_DB_PATH))
    return os.path.join(base, "graph_history.db")


class GraphHistoryStore:
    """graph 因子历史快照（SQLite 单连接 + 锁，模式同 jobs.JobStore）。"""

    def __init__(self, path: str | None = None) -> None:
        self.path = path or _db_path()
        os.makedirs(os.path.dirname(os.path.abspath(self.path)), exist_ok=True)
        self._conn = sqlite3.connect(self.path, check_same_thread=False)
        self._lock = threading.Lock()
        with self._lock:
            self._conn.executescript(_DDL)
            self._conn.commit()

    def snapshot(self, values: dict, updated_at_ms: int) -> int:
        """写入一次全市场图因子快照（幂等覆盖），返回写入条数。"""
        day = int(updated_at_ms) // 86400000 * 86400000  # 归一化到自然日
        rows = []
        for sym, factors in (values or {}).items():
            for key, v in (factors or {}).items():
                if v is None or not isinstance(v, (int, float)):
                    continue
                rows.append((day, str(sym), str(key), float(v)))
        if not rows:
            return 0
        with self._lock:
            self._conn.executemany(
                "INSERT OR REPLACE INTO graph_factor_history (ts, symbol, factor_key, value) "
                "VALUES (?, ?, ?, ?)", rows)
            self._conn.commit()
        return len(rows)

    def load(self, days: int = 90) -> pd.DataFrame:
        """加载最近 days 天历史，返回 DataFrame(ts, symbol, factor_key, value)。"""
        since = (int(time.time() * 1000) // 86400000 * 86400000) - int(days) * 86400000
        with self._lock:
            rows = self._conn.execute(
                "SELECT ts, symbol, factor_key, value FROM graph_factor_history "
                "WHERE ts >= ? ORDER BY ts", (since,)).fetchall()
        return pd.DataFrame(rows, columns=["ts", "symbol", "factor_key", "value"])


def get_store() -> GraphHistoryStore:
    global _store
    if _store is None:
        with _store_lock:
            if _store is None:
                _store = GraphHistoryStore()
    return _store


def snapshot_graph_values(updated_at_ms: int, values: dict) -> int:
    """main.py 图因子计算后调用：追加历史快照（失败仅日志，不影响计算）。"""
    try:
        n = get_store().snapshot(values, updated_at_ms)
        if n:
            logger.info("graph history snapshot: %d rows @ %s", n, updated_at_ms)
        return n
    except Exception as exc:
        logger.warning("graph history snapshot failed: %s", exc)
        return 0


def load_graph_history(days: int | None = None) -> pd.DataFrame:
    """加载 graph 因子历史（供评估/衰退淘汰），失败返回空 DataFrame（fail-silent）。"""
    try:
        return get_store().load(days or config.FACTOR_MINER_GRAPH_DAYS)
    except Exception as exc:
        logger.warning("graph history load failed: %s", exc)
        return pd.DataFrame(columns=["ts", "symbol", "factor_key", "value"])
