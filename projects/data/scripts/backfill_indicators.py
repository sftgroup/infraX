"""kline 指标回填脚本（一次性运维工具，2026-08-07）。

背景：早期采集的历史 bar 未计算技术指标（rsi_14/macd/bb/atr/ma 为 NULL），
以及部分序列因前序数据缺失导致指标后移。本脚本复用 KlineStore 同一套
指标函数（_rsi/_macd_series/_bollinger/_atr/_sma + _get_indicator_config），
对每个 (symbol, timeframe) 序列全量重算，仅 UPDATE 存在差异/缺失的行，
保证「查询路径指标与库内真实数据一致」。

用法（生产）：
    cd projects/data && .venv/bin/python scripts/backfill_indicators.py [--db data/data.db]

注意：RSI/BB/ATR/MACD 序列前 N 根（warmup 窗口）数学上无定义，仍为 NULL，
这是正常行为，不是缺失。
"""
from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.kline_store import (  # noqa: E402  # 复用写入路径同一套指标函数
    _atr,
    _bollinger,
    _get_indicator_config,
    _macd_series,
    _rsi,
    _sma,
)

_IND_COLS = (
    "rsi_14", "macd", "macd_signal", "macd_hist",
    "bb_upper", "bb_middle", "bb_lower", "atr_14",
    "ma_5", "ma_10", "ma_20",
)


def round_or_none(v: float, ndigits: int):
    if np.isnan(v):
        return None
    return round(float(v), ndigits)


def backfill(db, symbol: str, timeframe: str) -> int:
    """重算单个序列指标，返回修复行数（有差异才 UPDATE）。"""
    rows = db.execute(
        f"SELECT ts, open, high, low, close, volume, {', '.join(_IND_COLS)} "
        "FROM kline WHERE symbol=? AND timeframe=? ORDER BY ts ASC",
        (symbol, timeframe),
    ).fetchall()
    if not rows:
        return 0
    arr = np.array([[r["ts"], r["open"], r["high"], r["low"], r["close"], r["volume"]]
                    for r in rows], dtype=float)
    closes = arr[:, 4]
    highs, lows = arr[:, 2], arr[:, 3]
    icfg = _get_indicator_config()
    rsi14 = _rsi(closes, icfg["rsi_period"])
    macd_d = _macd_series(closes, icfg["macd_fast"], icfg["macd_slow"], icfg["macd_signal"])
    bb_d = _bollinger(closes, icfg["bb_window"], icfg["bb_n_std"])
    atr14 = _atr(highs, lows, closes, icfg["atr_period"])
    mas = {w: _sma(closes, w) for w in icfg["sma_windows"]}

    updates = []
    for i, r in enumerate(rows):
        new_vals = (
            round_or_none(rsi14[i], 2),
            round_or_none(macd_d["macd"][i], 6),
            round_or_none(macd_d["macd_signal"][i], 6),
            round_or_none(macd_d["macd_hist"][i], 6),
            round_or_none(bb_d["bb_upper"][i], 2),
            round_or_none(bb_d["bb_middle"][i], 2),
            round_or_none(bb_d["bb_lower"][i], 2),
            round_or_none(atr14[i], 6),
            *(round_or_none(mas[w][i], 2) for w in icfg["sma_windows"]),
        )
        old_vals = tuple(r[c] for c in _IND_COLS)
        if new_vals != old_vals:
            updates.append((*new_vals, r["ts"], symbol, timeframe))
    if not updates:
        return 0
    with db:
        db.executemany(
            f"""UPDATE kline SET
                rsi_14=?, macd=?, macd_signal=?, macd_hist=?,
                bb_upper=?, bb_middle=?, bb_lower=?, atr_14=?,
                ma_5=?, ma_10=?, ma_20=?
                WHERE ts=? AND symbol=? AND timeframe=?""",
            updates,
        )
    return len(updates)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="data/data.db", help="SQLite 路径（默认 data/data.db）")
    args = ap.parse_args()

    import sqlite3
    db = sqlite3.connect(args.db, check_same_thread=False)
    db.row_factory = sqlite3.Row
    seqs = db.execute(
        "SELECT DISTINCT symbol, timeframe FROM kline ORDER BY symbol, timeframe"
    ).fetchall()
    print(f"sequences: {len(seqs)}")
    t0 = time.time()
    fixed = 0
    for s in seqs:
        n = backfill(db, s["symbol"], s["timeframe"])
        if n:
            fixed += n
            print(f"  {s['symbol']:16s} {s['timeframe']:4s} +{n}")
    print(f"DONE fixed={fixed} rows in {time.time()-t0:.1f}s")

    # 修复后 rsi_14 缺失率
    total = db.execute("SELECT COUNT(*) FROM kline").fetchone()[0]
    rsi_null = db.execute("SELECT COUNT(*) FROM kline WHERE rsi_14 IS NULL").fetchone()[0]
    print(f"rsi_14 NULL: {rsi_null}/{total} ({rsi_null*100.0/total:.2f}%)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
