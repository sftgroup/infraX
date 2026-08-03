"""SQLite 数据库层。

职责：
  1. 存储每次数据抓取的原始结果（raw_snapshots）
  2. 记录每次 LightRAG 注入的结果（inject_log）
  3. 支持历史查询和失败重放

Schema：
  raw_snapshots — 原始数据快照（去重）
  inject_log    — 注入记录（关联 snapshot）

用法:
    from storage import InjectDB
    db = InjectDB()
    snap_id = db.save_snapshot("sentiment", "vix", raw={"value": 14.2})
    db.log_inject(snap_id, file_source="macro:daily", text="...", status="success")
"""
from __future__ import annotations

import hashlib
import json
import logging
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# 默认数据库路径：项目根目录下的 data/injector.db
DEFAULT_DB_PATH = Path(__file__).resolve().parent.parent / "data" / "injector.db"


class InjectDB:
    """SQLite 注入数据库。

    线程安全，支持多 worker 并发写入。
    """

    def __init__(self, db_path: str | Path | None = None):
        self._db_path = Path(db_path or DEFAULT_DB_PATH)
        self._db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._conn: sqlite3.Connection | None = None
        self._ensure_schema()

    # ── 连接管理 ──────────────────────────────────────

    def _get_conn(self) -> sqlite3.Connection:
        """获取线程本地连接。"""
        if self._conn is None:
            self._conn = sqlite3.connect(str(self._db_path), check_same_thread=False)
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._conn.execute("PRAGMA synchronous=NORMAL")
        return self._conn

    def _ensure_schema(self) -> None:
        """确保表结构存在。"""
        conn = self._get_conn()
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS raw_snapshots (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                provider    TEXT    NOT NULL,
                data_type   TEXT    NOT NULL,
                symbol      TEXT    DEFAULT '',
                raw_json    TEXT    NOT NULL,
                fetched_at  TEXT    NOT NULL,
                checksum    TEXT    NOT NULL,
                UNIQUE(provider, data_type, symbol, checksum)
            );

            CREATE TABLE IF NOT EXISTS inject_log (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                snapshot_id   INTEGER NOT NULL,
                file_source   TEXT    NOT NULL,
                text_content  TEXT    NOT NULL,
                status        TEXT    NOT NULL DEFAULT 'pending',
                injected_at   TEXT,
                error_msg     TEXT,
                FOREIGN KEY(snapshot_id) REFERENCES raw_snapshots(id)
            );

            CREATE INDEX IF NOT EXISTS idx_snap_provider
                ON raw_snapshots(provider, fetched_at);
            CREATE INDEX IF NOT EXISTS idx_snap_type
                ON raw_snapshots(data_type, fetched_at);
            CREATE INDEX IF NOT EXISTS idx_inject_status
                ON inject_log(status);
            CREATE INDEX IF NOT EXISTS idx_inject_snapshot
                ON inject_log(snapshot_id);
        """)
        conn.commit()

    # ── 快照存取 ──────────────────────────────────────

    def save_snapshot(
        self,
        provider: str,
        data_type: str,
        raw: dict[str, Any] | list | None,
        symbol: str = "",
    ) -> int | None:
        """保存原始数据快照。

        通过 checksum 去重：相同数据不重复存储。
        返回 snapshot id，如果重复则返回已有 id。
        """
        if raw is None:
            return None
        try:
            raw_json = json.dumps(raw, ensure_ascii=False, sort_keys=True, default=str)
            checksum = hashlib.sha256(raw_json.encode()).hexdigest()
            now = datetime.now(timezone.utc).isoformat()

            with self._lock:
                conn = self._get_conn()
                # 查重
                row = conn.execute(
                    """SELECT id FROM raw_snapshots
                       WHERE provider=? AND data_type=? AND symbol=? AND checksum=?""",
                    (provider, data_type, symbol, checksum),
                ).fetchone()
                if row:
                    return row[0]

                cur = conn.execute(
                    """INSERT INTO raw_snapshots (provider, data_type, symbol, raw_json, fetched_at, checksum)
                       VALUES (?, ?, ?, ?, ?, ?)""",
                    (provider, data_type, symbol, raw_json, now, checksum),
                )
                conn.commit()
                return cur.lastrowid
        except Exception:
            logger.debug("save_snapshot failed", exc_info=True)
            return None

    # ── 注入日志 ──────────────────────────────────────

    def log_inject(
        self,
        snapshot_id: int | None,
        file_source: str,
        text: str,
        status: str = "success",
        error_msg: str | None = None,
    ) -> int | None:
        """记录一次注入。"""
        try:
            now = datetime.now(timezone.utc).isoformat()
            with self._lock:
                conn = self._get_conn()
                cur = conn.execute(
                    """INSERT INTO inject_log (snapshot_id, file_source, text_content, status, injected_at, error_msg)
                       VALUES (?, ?, ?, ?, ?, ?)""",
                    (snapshot_id or 0, file_source, text, status, now, error_msg),
                )
                conn.commit()
                return cur.lastrowid
        except Exception:
            logger.debug("log_inject failed", exc_info=True)
            return None

    # ── 查询 ──────────────────────────────────────────

    def recent_snapshots(
        self, provider: str | None = None, limit: int = 20
    ) -> list[dict[str, Any]]:
        """获取最近的数据快照。"""
        conn = self._get_conn()
        sql = "SELECT id, provider, data_type, symbol, fetched_at FROM raw_snapshots"
        params: tuple = ()
        if provider:
            sql += " WHERE provider = ?"
            params = (provider,)
        sql += " ORDER BY fetched_at DESC LIMIT ?"
        params += (limit,)
        rows = conn.execute(sql, params).fetchall()
        return [
            {"id": r[0], "provider": r[1], "data_type": r[2], "symbol": r[3], "fetched_at": r[4]}
            for r in rows
        ]

    def recent_injects(
        self, status: str | None = None, limit: int = 20
    ) -> list[dict[str, Any]]:
        """获取最近的注入记录。"""
        conn = self._get_conn()
        sql = """SELECT il.id, il.file_source, il.status, il.injected_at, il.error_msg,
                        rs.provider, rs.data_type
                 FROM inject_log il
                 LEFT JOIN raw_snapshots rs ON il.snapshot_id = rs.id"""
        params: tuple = ()
        if status:
            sql += " WHERE il.status = ?"
            params = (status,)
        sql += " ORDER BY il.injected_at DESC LIMIT ?"
        params += (limit,)
        rows = conn.execute(sql, params).fetchall()
        return [
            {
                "id": r[0], "file_source": r[1], "status": r[2],
                "injected_at": r[3], "error": r[4],
                "provider": r[5], "data_type": r[6],
            }
            for r in rows
        ]

    def stats(self) -> dict[str, Any]:
        """获取整体统计。"""
        conn = self._get_conn()
        total_snap = conn.execute("SELECT COUNT(*) FROM raw_snapshots").fetchone()[0]
        total_inj = conn.execute("SELECT COUNT(*) FROM inject_log").fetchone()[0]
        ok_inj = conn.execute(
            "SELECT COUNT(*) FROM inject_log WHERE status='success'"
        ).fetchone()[0]
        fail_inj = conn.execute(
            "SELECT COUNT(*) FROM inject_log WHERE status='failed'"
        ).fetchone()[0]
        return {
            "total_snapshots": total_snap,
            "total_injects": total_inj,
            "success": ok_inj,
            "failed": fail_inj,
            "db_path": str(self._db_path),
            "db_size_mb": round(self._db_path.stat().st_size / 1024 / 1024, 2) if self._db_path.exists() else 0,
        }

    def close(self) -> None:
        if self._conn:
            self._conn.close()
            self._conn = None
