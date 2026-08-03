"""EnrichLayer — query kline + external factors → unified bars.

Pure SQL query layer. No data mutation, no external API calls.
External factors (VIX, fear_greed, etc.) are looked up from raw_snapshots
and joined by nearest timestamp.
"""

from __future__ import annotations

from typing import Optional

from app.storage import get_db
from app.factors import _TECH_FACTORS as TECHNICAL_COLUMNS


def query_bars(
    symbol: str,
    timeframe: str = "1m",
    start: Optional[int] = None,
    end: Optional[int] = None,
    limit: int = 500,
) -> list[dict]:
    """Return unified bars from kline for charting / backtest.

    Bars already contain OHLCV + pre-computed indicators.
    External factors (from raw_snapshots) are joined by nearest timestamp.
    """
    db = get_db()
    params: list = [symbol, timeframe]

    where = "WHERE symbol = ? AND timeframe = ?"
    if start is not None:
        where += " AND ts >= ?"
        params.append(start)
    if end is not None:
        where += " AND ts <= ?"
        params.append(end)

    rows = db.execute(
        f"""SELECT ts, open, high, low, close, volume,
                   rsi_14, macd, macd_signal, macd_hist,
                   bb_upper, bb_middle, bb_lower, atr_14,
                   ma_5, ma_10, ma_20
            FROM kline {where}
            ORDER BY ts DESC
            LIMIT ?""",
        params + [limit],
    ).fetchall()

    bars = []
    for r in reversed(rows):
        bar = {
            "ts": r["ts"],
            "open": r["open"], "high": r["high"], "low": r["low"],
            "close": r["close"], "volume": r["volume"],
        }
        # Indicators (omit None)
        for col in TECHNICAL_COLUMNS:
            if r[col] is not None:
                bar[col] = r[col]
        bars.append(bar)

    # Join latest external factors
    _join_factors(bars, symbol)

    return bars


def _join_factors(bars: list[dict], symbol: str):
    """Attach latest factor values from raw_snapshots to each bar (by nearest time)."""
    db = get_db()
    # Get all factor snapshots
    rows = db.execute(
        """SELECT data_type, raw_json, fetched_at
           FROM raw_snapshots
           WHERE symbol = ? OR symbol = ''
           ORDER BY fetched_at DESC
           LIMIT 50""",
        (symbol,),
    ).fetchall()

    if not rows:
        return

    import json
    factors: dict[int, dict] = {}  # fetched_at_ms → {factor_name: value}

    for r in rows:
        try:
            data = json.loads(r["raw_json"]) if r["raw_json"] else {}
        except (json.JSONDecodeError, TypeError):
            continue
        for k, v in data.items():
            if v is not None:
                factors.setdefault(int(r["fetched_at"]), {})[str(k)] = v

    if not factors:
        return

    # For each bar, find nearest factor snapshot
    sorted_ts = sorted(factors.keys())
    for bar in bars:
        bar_ms = bar["ts"]
        # Find nearest factor ts before this bar
        nearest = None
        for ft in sorted_ts:
            if ft <= bar_ms:
                nearest = ft
        if nearest is None:
            nearest = sorted_ts[-1]  # use latest if all after
        for fname, fval in factors.get(nearest, {}).items():
            if fname not in bar:
                bar[fname] = fval
