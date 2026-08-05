"""Factor definitions — catalog + current-values query + snapshots.

All available factors are declared here (single source of truth).
/GET /factors/catalog returns the full list.
/GET /factors/current returns latest values from raw_snapshots.
/GET /snapshots returns full snapshot data for complex types (heatmap, calendar, etc.).
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Optional

from app.storage import get_db

# ─── Built-in factor catalog ────────────────────────────


_BUILTIN = [
    # -- technical (computed in kline_store, stored in kline_1m) --
    {"id": "rsi_14",     "name": "RSI(14)",            "category": "technical",  "type": "float", "range": [0, 100]},
    {"id": "macd",       "name": "MACD Line",           "category": "technical",  "type": "float", "range": None},
    {"id": "macd_signal", "name": "MACD Signal",        "category": "technical",  "type": "float", "range": None},
    {"id": "macd_hist",  "name": "MACD Histogram",      "category": "technical",  "type": "float", "range": None},
    {"id": "bb_upper",   "name": "BB Upper",            "category": "technical",  "type": "float", "range": None},
    {"id": "bb_middle",   "name": "BB Middle",           "category": "technical",  "type": "float", "range": None},
    {"id": "bb_lower",   "name": "BB Lower",            "category": "technical",  "type": "float", "range": None},
    {"id": "atr_14",     "name": "ATR(14)",             "category": "technical",  "type": "float", "range": [0, None]},
    {"id": "ma_5",       "name": "MA(5)",               "category": "technical",  "type": "float", "range": None},
    {"id": "ma_10",      "name": "MA(10)",              "category": "technical",  "type": "float", "range": None},
    {"id": "ma_20",      "name": "MA(20)",              "category": "technical",  "type": "float", "range": None},
    # -- macro (from external APIs, stored in raw_snapshots) --
    {"id": "vix",        "name": "VIX Volatility",      "category": "macro",      "type": "float", "range": [0, None]},
    {"id": "dxy",        "name": "US Dollar Index",     "category": "macro",      "type": "float", "range": [50, 150]},
    {"id": "us10y",      "name": "US 10Y Yield",        "category": "macro",      "type": "float", "range": [0, 10]},
    # -- sentiment (from external APIs) --
    {"id": "fear_greed", "name": "Fear & Greed Index",  "category": "sentiment",  "type": "int",   "range": [0, 100]},
    {"id": "sentiment_score", "name": "News Sentiment Score", "category": "sentiment", "type": "float", "range": [-1, 1]},
    # -- onchain --
    {"id": "btc_difficulty", "name": "BTC Mining Difficulty", "category": "onchain", "type": "float", "range": [0, None]},
    {"id": "btc_hashrate",   "name": "BTC Hashrate",          "category": "onchain", "type": "float", "range": [0, None]},
]


# crypto 裸对 → 交易对存储键（resolve 返回 BTCUSDT 形式，kline 存 BTC/USDT）。
# 仅识别已知 quote 后缀，非 crypto 符号（AAPL/GC=F/EURUSD/600519）原样返回。
_CRYPTO_QUOTES = ("USDT", "USDC", "BUSD", "FDUSD", "TUSD", "DAI", "BTC", "ETH")


def normalize_crypto_pair(symbol: str, market_type: str = "spot") -> str:
    """crypto 裸对 → 存储键：``BTCUSDT`` → spot ``BTC/USDT`` / swap ``BTC/USDT:USDT``。

    已含 ``/`` 或 ``:`` 的符号原样返回；非 crypto 符号原样返回。
    """
    if "/" in symbol or ":" in symbol:
        return symbol
    for q in _CRYPTO_QUOTES:
        if symbol.endswith(q) and len(symbol) > len(q):
            base = symbol[: -len(q)]
            if market_type == "swap":
                return f"{base}/{q}:{q}"
            return f"{base}/{q}"
    return symbol


def _load_extra_factors() -> list[dict]:
    """Load additional factors from FACTORS_CONFIG_PATH JSON file."""
    path = os.getenv("FACTORS_CONFIG_PATH", "")
    if not path:
        return []
    fp = Path(path)
    if not fp.exists():
        return []
    try:
        data = json.loads(fp.read_text())
        extra = data.get("extra", [])
        valid = []
        for item in extra:
            if isinstance(item, dict) and item.get("id") and item.get("name"):
                item.setdefault("category", "external")
                item.setdefault("type", "float")
                item.setdefault("range", None)
                valid.append(item)
        return valid
    except Exception:
        return []


def get_catalog() -> list[dict]:
    """Return full factor catalog (built-in + extra from config)."""
    return _BUILTIN + _load_extra_factors()


# ─── Category → provider/data_type mapping ─────────────

_CATEGORY_MAP = {
    "external":   [("sentiment", "fear_greed"), ("macro", "vix"), ("macro", "dxy"), ("macro", "us10y")],
    "sentiment":  [
        ("sentiment", "yield_curve"), ("sentiment", "put_call_ratio"),
        ("sentiment", "adanos_sentiment"), ("sentiment", "sentiment_score"),
        ("sentiment", "fear_greed"),
    ],
    "news":       [("news", "news")],
    "opportunities": [("opportunities", "opportunities")],
    "heatmap":    [("market", "heatmap")],
    "calendar":   [("calendar", "calendar")],
    "snapshot":   [
        ("market", "crypto_prices"), ("market", "indices"),
        ("onchain", "btc_difficulty"), ("defi", "tvl"),
        ("volatility", "volatility"), ("macro", "us_indicators"),
        ("fundamental", "earnings"),
        ("global_market", "commodities"), ("global_market", "forex_pairs"),
        ("global_market", "market_overview"),
        ("collector_onchain", "onchain_checkpoints"),
        ("okx_chainos", "okx_hot_tokens"), ("okx_chainos", "okx_index_prices"),
    ],
}
# Flatten: data_type → category
_SIMPLE_FACTOR_IDS = {"fear_greed", "vix", "dxy", "us10y", "btc_difficulty", "sentiment_score"}


def get_current_factors(
    symbols: Optional[list[str]] = None,
    category: Optional[str] = None,
) -> dict:
    """Return latest factor values for given symbols.

    If category is specified, filters by collector type.
    Simple numeric factors are returned per-symbol.
    Complex data (heatmap, calendar) is returned as raw structures.
    """
    db = get_db()
    target = symbols or ["BTC"]

    result: dict = {}
    for sym in target:
        result[sym] = {}

    # Determine which (provider, data_type) pairs to look for
    if category and category in _CATEGORY_MAP:
        wanted = _CATEGORY_MAP[category]
    elif category:
        # Unknown category — try matching data_type prefix
        wanted = []
    else:
        # No filter: include all simple factors + complex snapshots
        wanted = None  # signal: return everything

    # Get latest snapshot per (provider, data_type)
    rows = db.execute(
        """SELECT provider, data_type, raw_json, fetched_at
           FROM raw_snapshots
           ORDER BY fetched_at DESC
           LIMIT 200"""
    ).fetchall()

    seen: set = set()
    max_ts = 0
    complex_data: dict = {}

    for r in rows:
        fid = r["data_type"]
        provider = r["provider"]
        key = (provider, fid)

        if key in seen:
            continue
        seen.add(key)

        fetched = r["fetched_at"]
        if fetched and fetched > max_ts:
            max_ts = fetched

        # Check if this (provider, data_type) is wanted
        if wanted is not None and (provider, fid) not in wanted:
            continue

        try:
            data = json.loads(r["raw_json"]) if r["raw_json"] else {}
        except (json.JSONDecodeError, TypeError):
            continue
        if not data:
            continue

        # Simple numeric factors → map to each target symbol
        if fid in _SIMPLE_FACTOR_IDS:
            field = _FACTOR_FIELD.get(fid)
            if field and field in data:
                val = data[field]
            else:
                val = next((v for v in data.values() if isinstance(v, (int, float))), None)

            if val is not None:
                if isinstance(val, float) and not isinstance(val, int):
                    val = round(val, 6)
                for sym in target:
                    result[sym][fid] = val

        # Complex data (heatmap, calendar, snapshots) → store under "_complex"
        else:
            # Strip envelope: if data has a single key like {"categories": ...}, unwrap
            if len(data) == 1:
                inner_key = next(iter(data))
                complex_data[fid] = data[inner_key]
            else:
                complex_data[fid] = data

    # Also add technical factors from kline table
    for sym in target:
        # kline 表 spot 存储键为 `BTC/USDT`；兼容无市场后缀的裸符号（如默认 BTC）
        row = None
        candidates = [sym]
        normalized = sym.replace("/", "").replace("USDT", "")
        if normalized != sym:
            candidates.append(normalized)
        if "/" not in sym:
            candidates.append(f"{sym}/USDT")
        for cand in candidates:
            row = db.execute(
                "SELECT * FROM kline WHERE symbol = ? ORDER BY ts DESC LIMIT 1",
                (cand,),
            ).fetchone()
            if row is not None:
                break
        if row:
            for fid in _TECH_FACTORS:
                val = row[fid]
                if val is not None:
                    result[sym][fid] = val

    result["_ts"] = int(max_ts)
    if complex_data:
        result["_complex"] = complex_data
    return result


def get_snapshots(data_type: Optional[str] = None) -> dict:
    """Return latest complex snapshot data (heatmap, calendar, indices, etc.).

    If data_type is specified, returns only that type's latest raw_json.
    Otherwise returns all complex snapshots.
    """
    db = get_db()

    # G-4: 汇总别名 → 前缀匹配。onchain 数据实际落 btc_difficulty /
    # btc_transfers / btc_hashrate 及新合并的 onchain_checkpoints 等子类型，
    # type=onchain 聚合返回全部；okx 聚合返回 okx_* 行情子类型。
    _SNAPSHOT_TYPE_ALIASES = {"onchain": ["btc_%", "onchain_%"], "okx": "okx_%"}

    if data_type:
        patterns = _SNAPSHOT_TYPE_ALIASES.get(data_type)
        if patterns:
            if isinstance(patterns, str):
                patterns = [patterns]
            where = " OR ".join(["data_type LIKE ?"] * len(patterns))
            sql = (
                "SELECT provider, data_type, raw_json, fetched_at "
                "FROM raw_snapshots "
                f"WHERE ({where}) "
                "ORDER BY fetched_at DESC "
                "LIMIT 50"
            )
            params = tuple(patterns)
        else:
            sql = """SELECT provider, data_type, raw_json, fetched_at
                     FROM raw_snapshots
                     WHERE data_type = ?
                     ORDER BY fetched_at DESC
                     LIMIT 1"""
            params = (data_type,)
        rows = db.execute(sql, params).fetchall()
    else:
        rows = db.execute(
            """SELECT provider, data_type, raw_json, fetched_at
               FROM raw_snapshots
               ORDER BY fetched_at DESC
               LIMIT 50"""
        ).fetchall()

    seen: set = set()
    result: dict = {}
    max_ts = 0

    for r in rows:
        fid = r["data_type"]
        key = (r["provider"], fid)
        if key in seen:
            continue
        seen.add(key)

        if r["fetched_at"] and r["fetched_at"] > max_ts:
            max_ts = r["fetched_at"]

        try:
            data = json.loads(r["raw_json"]) if r["raw_json"] else {}
        except Exception:
            continue
        if not data:
            continue

        # Unwrap single-key envelopes
        if len(data) == 1:
            inner_key = next(iter(data))
            result[fid] = data[inner_key]
        else:
            result[fid] = data

    result["_ts"] = int(max_ts)
    return result


# Map: factor_id → raw_json field name (only when differs from first-numeric heuristic)
_FACTOR_FIELD = {
    "fear_greed": "value",
    "sentiment_score": "value",
}

# Technical factors come from kline table
_TECH_FACTORS = (
    "rsi_14", "macd", "macd_signal", "macd_hist",
    "bb_upper", "bb_middle", "bb_lower", "atr_14",
    "ma_5", "ma_10", "ma_20",
)


def get_history_factors(
    symbol: str,
    timeframe: str = "1m",
    ids: Optional[list[str]] = None,
    start: Optional[int] = None,
    end: Optional[int] = None,
    limit: int = 500,
) -> dict:
    """Return a per-bar factor time series from the kline table.

    Technical factors (rsi_14/macd/bb/atr/ma_*) are stored per-bar and are
    returned aligned to candle timestamps — this is what backtests need to
    reproduce live factor values bar-by-bar.

    ``ids`` filters to the requested factor ids (default: all technical
    factors). ``ts`` is in milliseconds, matching /bars.
    """
    db = get_db()
    cols = ", ".join(_TECH_FACTORS)
    limit = max(1, min(int(limit or 500), 5000))

    def _query(sym: str):
        where = "symbol = ? AND timeframe = ?"
        params: list = [sym, timeframe]
        if start is not None:
            where += " AND ts >= ?"
            params.append(start)
        if end is not None:
            where += " AND ts <= ?"
            params.append(end)
        return db.execute(
            f"SELECT ts, {cols} FROM kline WHERE {where} ORDER BY ts ASC LIMIT ?",
            (*params, limit),
        ).fetchall()

    rows = _query(symbol)
    if not rows and "/" in symbol:
        rows = _query(symbol.split("/", 1)[0])
    if not rows and "/" not in symbol:
        # crypto 裸对（resolve 返回 BTCUSDT）→ 交易对存储键再查（D7）
        pair = normalize_crypto_pair(symbol)
        if pair != symbol:
            rows = _query(pair)

    wanted = set(ids) if ids else set(_TECH_FACTORS)
    series: list[dict] = []
    for r in rows:
        item: dict = {"ts": r["ts"]}
        for col in _TECH_FACTORS:
            if col in wanted and r[col] is not None:
                item[col] = r[col]
        series.append(item)

    return {
        "symbol": symbol,
        "timeframe": timeframe,
        "count": len(series),
        "series": series,
    }


def save_snapshot(provider: str, data_type: str, data: dict, symbol: str = ""):
    """Save a raw factor snapshot to raw_snapshots table. Best-effort."""
    import hashlib
    import time

    try:
        raw = json.dumps(data, default=str)
        checksum = hashlib.md5(raw.encode()).hexdigest()
        db = get_db()
        db.execute(
            """INSERT INTO raw_snapshots (provider, data_type, symbol, raw_json, fetched_at, checksum)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (provider, data_type, symbol, raw, int(time.time() * 1000), checksum),
        )
        db.commit()
    except Exception as exc:
        # 落库失败不能静默 —— 数据采集链路的关键故障点
        logger.warning(
            "save_snapshot failed provider=%s data_type=%s symbol=%s: %s",
            provider, data_type, symbol, exc,
        )


def query_ml_predictions(
    model: str,
    symbol: str,
    start: Optional[int] = None,
    end: Optional[int] = None,
    limit: int = 500,
) -> list[dict]:
    """P2 单模型预测历史查询（ml_predictions 明细表，§5.7）。

    符号归一化（BTC/USDT → BTC），generated_at 升序，start/end 区间过滤。
    """
    sym = symbol.split("/")[0].strip()
    db = get_db()
    sql = (
        "SELECT generated_at, direction, prob_up, uncertainty, "
        "point_forecast, quantiles FROM ml_predictions "
        "WHERE model=? AND symbol=?"
    )
    params: list = [model, sym]
    if start is not None:
        sql += " AND generated_at >= ?"
        params.append(start)
    if end is not None:
        sql += " AND generated_at <= ?"
        params.append(end)
    sql += " ORDER BY generated_at ASC LIMIT ?"
    params.append(limit)

    rows = db.execute(sql, params).fetchall()
    result = []
    for r in rows:
        result.append({
            "generated_at": r["generated_at"],
            "direction": r["direction"],
            "prob_up": r["prob_up"],
            "uncertainty": r["uncertainty"],
            "point_forecast": json.loads(r["point_forecast"]) if r["point_forecast"] else None,
            "quantiles": json.loads(r["quantiles"]) if r["quantiles"] else None,
        })
    return result
