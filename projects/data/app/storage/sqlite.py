"""SQLite connection manager — WAL mode, thread-safe.

Single file data/data.db with two tables:
  kline         — OHLCV + pre-computed indicators (multi-timeframe)
  raw_snapshots — external factor raw JSON snapshots
"""

import os
import sqlite3
import threading

from app.config import DATA_DB_PATH
from app.utils.logger import get_logger

logger = get_logger(__name__)

_DB_PATH = DATA_DB_PATH
_local = threading.local()
_lock = threading.Lock()


def _conn() -> sqlite3.Connection:
    """Per-thread SQLite connection (WAL mode)."""
    if not hasattr(_local, "conn") or _local.conn is None:
        os.makedirs(os.path.dirname(_DB_PATH), exist_ok=True)
        conn = sqlite3.connect(_DB_PATH, check_same_thread=False)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute("PRAGMA busy_timeout=5000")
        conn.row_factory = sqlite3.Row
        _local.conn = conn
    return _local.conn


def get_db() -> sqlite3.Connection:
    """Get per-thread connection (auto-create if missing)."""
    return _conn()


def init_db():
    """Create tables + migrate schema if needed. Idempotent."""
    with _lock:
        conn = _conn()
        conn.executescript(_SCHEMA)
        _migrate_v2_kline(conn)
        _migrate_macro_predict(conn)
        conn.commit()
    logger.info("SQLite initialized: %s", _DB_PATH)


def _migrate_macro_predict(conn: sqlite3.Connection):
    """老库 macro_history 无 predict_value 列（MM-4：moomoo 宏观一致预期）→ ALTER 补列。

    moomoo get_macro_indicator_history 返回 predict_value（分析师一致预期），
    FRED 无此值。旧库补列后新老库均可写入（幂等，重复执行安全）。
    """
    try:
        cols = [r[1] for r in conn.execute("PRAGMA table_info(macro_history)").fetchall()]
        if "predict_value" not in cols:
            conn.execute("ALTER TABLE macro_history ADD COLUMN predict_value REAL")
            logger.info("macro_history 已补 predict_value 列（MM-4）")
    except Exception as exc:
        logger.warning("macro_history predict_value migration skipped: %s", exc)


def _migrate_v2_kline(conn: sqlite3.Connection):
    """Migrate from kline_1m to kline (adds timeframe column)."""
    # Check if old table exists
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='kline_1m'"
    ).fetchone()
    if not row:
        return
    # Count rows
    cnt = conn.execute("SELECT COUNT(*) FROM kline_1m").fetchone()[0]
    logger.info("Migrating kline_1m → kline (%d rows)", cnt)
    conn.execute(
        """INSERT OR IGNORE INTO kline
           (symbol, timeframe, ts, open, high, low, close, volume,
            rsi_14, macd, macd_signal, macd_hist,
            bb_upper, bb_middle, bb_lower, atr_14,
            ma_5, ma_10, ma_20)
           SELECT symbol, '1m', ts, open, high, low, close, volume,
                  rsi_14, macd, macd_signal, macd_hist,
                  bb_upper, bb_middle, bb_lower, atr_14,
                  ma_5, ma_10, ma_20
           FROM kline_1m"""
    )
    conn.execute("DROP TABLE kline_1m")
    conn.commit()
    logger.info("Migration complete: kline_1m → kline")


_SCHEMA = """
CREATE TABLE IF NOT EXISTS kline (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    symbol      TEXT    NOT NULL,
    timeframe   TEXT    NOT NULL DEFAULT '1m',
    ts          INTEGER NOT NULL,   -- unix ms
    open        REAL,
    high        REAL,
    low         REAL,
    close       REAL,
    volume      REAL,
    rsi_14      REAL,
    macd        REAL,
    macd_signal REAL,
    macd_hist   REAL,
    bb_upper    REAL,
    bb_middle   REAL,
    bb_lower    REAL,
    atr_14      REAL,
    ma_5        REAL,
    ma_10       REAL,
    ma_20       REAL,
    UNIQUE(symbol, timeframe, ts)
);

CREATE INDEX IF NOT EXISTS idx_kline_sym_tf_ts ON kline(symbol, timeframe, ts);

CREATE TABLE IF NOT EXISTS raw_snapshots (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    provider    TEXT    NOT NULL,
    data_type   TEXT    NOT NULL,
    symbol      TEXT    NOT NULL DEFAULT '',
    raw_json    TEXT,
    fetched_at  REAL    NOT NULL,    -- unix ms
    checksum    TEXT
);

CREATE INDEX IF NOT EXISTS idx_snap_provider_ts ON raw_snapshots(provider, fetched_at);

CREATE TABLE IF NOT EXISTS ml_predictions (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    model          TEXT    NOT NULL,   -- bolt | moirai | timesfm
    symbol         TEXT    NOT NULL,   -- 归一化裸代号（BTC/USDT → BTC）
    generated_at   INTEGER NOT NULL,   -- unix ms（预测时间）
    direction      TEXT,               -- up / down
    prob_up        REAL,
    uncertainty    TEXT,               -- low / moderate / high
    point_forecast TEXT,               -- JSON 数组
    quantiles      TEXT,               -- JSON（{0.1,0.5,0.9} 或 {min,max}）
    fetched_at     REAL NOT NULL,      -- 落库时间（unix ms）
    UNIQUE(model, symbol, generated_at)
);

CREATE INDEX IF NOT EXISTS idx_mlpred_model_sym_ts ON ml_predictions(model, symbol, generated_at);

CREATE TABLE IF NOT EXISTS macro_history (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    series_id      TEXT    NOT NULL,   -- FRED series id（CPIAUCSL / PAYEMS / FEDFUNDS ...）
                                       -- 或 moomoo 宏观命名空间（MM:US:CPI，MM-4）
    date           TEXT    NOT NULL,   -- 观测日期 YYYY-MM-DD
    value          REAL,
    predict_value  REAL,               -- moomoo 宏观一致预期（FRED 无此值，MM-4）
    fetched_at     REAL    NOT NULL,   -- 落库时间（unix ms）
    UNIQUE(series_id, date)
);

CREATE INDEX IF NOT EXISTS idx_macrohist_series_date ON macro_history(series_id, date);
"""
