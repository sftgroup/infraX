"""K-line store — periodic OHLCV fetch + indicator computation → SQLite.

Design:
  - ccxt binance (public, no API key) for crypto K-lines
  - numpy pure functions for indicator computation
  - Upsert on (symbol, timeframe, ts) — no duplicates
  - Background thread, fail-silent on fetch errors
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from pathlib import Path
from typing import Optional

import ccxt
import numpy as np

from app.config import (
    KL_SYMBOLS,
    KL_TIMEFRAMES,
    KL_FETCH_LIMIT,
    KL_INTERVAL_SEC,
    KL_EXCHANGE,
)
from app.storage import get_db

logger = logging.getLogger(__name__)

# Parse config strings
_SYMBOLS = [s.strip() for s in KL_SYMBOLS.split(",") if s.strip()]
_TIMEFRAMES = [t.strip() for t in KL_TIMEFRAMES.split(",") if t.strip()]

# ── Indicator params from data_config.json ──────────────────

_CONFIG_PATH = os.getenv("DATA_CONFIG_PATH", "data_config.json")


def _get_indicator_config() -> dict:
    """Lazy-load indicator config from data_config.json, with sensible defaults."""
    if hasattr(_get_indicator_config, "_cache"):
        return _get_indicator_config._cache
    try:
        config = json.loads(Path(_CONFIG_PATH).read_text())
        icfg = config.get("kline", {}).get("indicators", {})
    except Exception:
        icfg = {}
    _get_indicator_config._cache = {
        "rsi_period": icfg.get("rsi", {}).get("period", 14),
        "macd_fast": icfg.get("macd", {}).get("fast", 12),
        "macd_slow": icfg.get("macd", {}).get("slow", 26),
        "macd_signal": icfg.get("macd", {}).get("signal", 9),
        "bb_window": icfg.get("bollinger", {}).get("window", 20),
        "bb_n_std": icfg.get("bollinger", {}).get("num_std", 2),
        "atr_period": icfg.get("atr", {}).get("period", 14),
        "sma_windows": icfg.get("sma", {}).get("windows", [5, 10, 20]),
    }
    return _get_indicator_config._cache


# ─── Indicator math (pure functions, numpy) ────────────────

def _sma(arr: np.ndarray, window: int) -> np.ndarray:
    """Simple moving average."""
    if len(arr) < window:
        return np.full_like(arr, np.nan)
    out = np.full(len(arr), np.nan)
    cumsum = np.cumsum(np.insert(arr, 0, 0))
    out[window - 1:] = (cumsum[window:] - cumsum[:-window]) / window
    return out


def _ema(arr: np.ndarray, period: int) -> np.ndarray:
    """Exponential moving average (SMA seed). Input must be NaN-free."""
    n = len(arr)
    if n < period:
        return np.full_like(arr, np.nan)
    out = np.full(n, np.nan)
    out[period - 1] = np.mean(arr[:period])
    k = 2.0 / (period + 1)
    for i in range(period, n):
        out[i] = (arr[i] - out[i - 1]) * k + out[i - 1]
    return out


def _rsi(close: np.ndarray, period: int = 14) -> np.ndarray:
    """RSI (Wilder smoothing)."""
    if len(close) < period + 1:
        return np.full_like(close, np.nan)
    delta = np.diff(close)
    gains = np.where(delta > 0, delta, 0.0)
    losses = np.where(delta < 0, -delta, 0.0)
    out = np.full(len(close), np.nan)
    avg_gain = gains[:period].mean()
    avg_loss = losses[:period].mean()
    for i in range(period, len(gains)):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period
        rs = avg_gain / avg_loss if avg_loss > 1e-12 else float("inf")
        out[i + 1] = 100.0 - (100.0 / (1.0 + rs)) if avg_loss > 1e-12 else 100.0
    return out


def _macd_series(close: np.ndarray, fast: int = 12, slow: int = 26, signal: int = 9) -> dict[str, np.ndarray]:
    """MACD: line, signal, histogram."""
    n = len(close)
    nan = np.full(n, np.nan)
    if n < slow + signal:
        return {"macd": nan, "macd_signal": nan, "macd_hist": nan}
    ema_fast = _ema(close, fast)
    ema_slow = _ema(close, slow)
    macd_line = ema_fast - ema_slow
    # Compute signal EMA on non-NaN portion of macd_line
    valid = ~np.isnan(macd_line)
    if valid.sum() < signal:
        return {"macd": macd_line, "macd_signal": nan, "macd_hist": nan}
    macd_valid = macd_line[valid]
    sig_valid = _ema(macd_valid, signal)
    macd_sig = np.full(n, np.nan)
    macd_sig[valid] = sig_valid
    hist = macd_line - macd_sig
    return {"macd": macd_line, "macd_signal": macd_sig, "macd_hist": hist}


def _bollinger(close: np.ndarray, window: int = 20, n_std: int = 2) -> dict[str, np.ndarray]:
    """Bollinger Bands."""
    n = len(close)
    if n < window:
        nan = np.full(n, np.nan)
        return {"bb_upper": nan, "bb_middle": nan, "bb_lower": nan}
    middle = _sma(close, window)
    std = np.full(n, np.nan)
    for i in range(window - 1, n):
        std[i] = np.std(close[i - window + 1 : i + 1], ddof=1)
    return {
        "bb_middle": middle,
        "bb_upper": middle + n_std * std,
        "bb_lower": middle - n_std * std,
    }


def _atr(high: np.ndarray, low: np.ndarray, close: np.ndarray, period: int = 14) -> np.ndarray:
    """ATR (Wilder)."""
    n = len(high)
    if n < period + 1:
        return np.full(n, np.nan)
    tr = np.full(n, np.nan)
    for i in range(1, n):
        tr[i] = max(high[i] - low[i], abs(high[i] - close[i - 1]), abs(low[i] - close[i - 1]))
    out = np.full(n, np.nan)
    out[period] = np.mean(tr[1:period + 1])
    for i in range(period + 1, n):
        out[i] = (out[i - 1] * (period - 1) + tr[i]) / period
    return out


# ─── KlineStore ────────────────────────────────────────────


class KlineStore:
    """Periodic K-line collector + indicator computer → SQLite."""

    def __init__(self):
        self._exchange: Optional[ccxt.Exchange] = None
        self._running = False
        self._thread: Optional[threading.Thread] = None

    # ── start / stop ────────────────────────────────────────

    def start(self):
        """Start background collection loop."""
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._loop, daemon=True, name="kline-collector")
        self._thread.start()
        logger.info("KlineStore started (symbols=%s, timeframes=%s, interval=%ds)",
                     _SYMBOLS, _TIMEFRAMES, KL_INTERVAL_SEC)

    def stop(self):
        self._running = False

    def _loop(self):
        while self._running:
            try:
                self._collect_all()
                self._collect_multi_market()
            except Exception:
                logger.warning("KlineStore cycle failed", exc_info=True)
            time.sleep(KL_INTERVAL_SEC)

    # ── collect ─────────────────────────────────────────────

    def _collect_all(self):
        ex = self._get_exchange()
        for symbol in _SYMBOLS:
            for tf in _TIMEFRAMES:
                try:
                    self._collect_one(ex, symbol, tf)
                except Exception:
                    logger.warning("KlineStore fetch failed for %s %s", symbol, tf, exc_info=True)

    def _collect_one(self, ex: ccxt.Exchange, symbol: str, timeframe: str):
        """Fetch → compute → upsert for one symbol+timeframe."""
        ohlcv = ex.fetch_ohlcv(symbol, timeframe, limit=KL_FETCH_LIMIT)
        if not ohlcv or len(ohlcv) < 30:
            logger.debug("KlineStore: %s returned %d bars (skip)", symbol, len(ohlcv) if ohlcv else 0)
            return

        # Convert to numpy columns
        cols = np.array(ohlcv, dtype=float)  # [ts, open, high, low, close, volume]
        ts   = cols[:, 0].astype(int)
        opens  = cols[:, 1]
        highs  = cols[:, 2]
        lows   = cols[:, 3]
        closes = cols[:, 4]
        volumes = cols[:, 5]

        # Compute indicators from config
        icfg = _get_indicator_config()
        rsi14 = _rsi(closes, icfg["rsi_period"])
        macd_d = _macd_series(closes, icfg["macd_fast"], icfg["macd_slow"], icfg["macd_signal"])
        bb_d = _bollinger(closes, icfg["bb_window"], icfg["bb_n_std"])
        atr14 = _atr(highs, lows, closes, icfg["atr_period"])
        windows = icfg["sma_windows"]
        mas = {w: _sma(closes, w) for w in windows}

        # Upsert to SQLite
        db = get_db()
        rows = []
        for i in range(len(ts)):
            rows.append((
                symbol, timeframe, int(ts[i]),
                round(opens[i], 8), round(highs[i], 8), round(lows[i], 8),
                round(closes[i], 8), round(volumes[i], 8),
                round(float(rsi14[i]), 2) if not np.isnan(rsi14[i]) else None,
                round(float(macd_d["macd"][i]), 6) if not np.isnan(macd_d["macd"][i]) else None,
                round(float(macd_d["macd_signal"][i]), 6) if not np.isnan(macd_d["macd_signal"][i]) else None,
                round(float(macd_d["macd_hist"][i]), 6) if not np.isnan(macd_d["macd_hist"][i]) else None,
                round(float(bb_d["bb_upper"][i]), 2) if not np.isnan(bb_d["bb_upper"][i]) else None,
                round(float(bb_d["bb_middle"][i]), 2) if not np.isnan(bb_d["bb_middle"][i]) else None,
                round(float(bb_d["bb_lower"][i]), 2) if not np.isnan(bb_d["bb_lower"][i]) else None,
                round(float(atr14[i]), 6) if not np.isnan(atr14[i]) else None,
                *(round(float(mas[w][i]), 2) if not np.isnan(mas[w][i]) else None for w in windows),
            ))

        # Batch INSERT OR REPLACE
        with db:
            db.executemany(
                """INSERT OR REPLACE INTO kline
                   (symbol, timeframe, ts, open, high, low, close, volume,
                    rsi_14, macd, macd_signal, macd_hist,
                    bb_upper, bb_middle, bb_lower, atr_14,
                    ma_5, ma_10, ma_20)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                rows,
            )

        total = db.execute(
            "SELECT COUNT(*) FROM kline WHERE symbol=? AND timeframe=?",
            (symbol, timeframe),
        ).fetchone()[0]
        logger.info("KlineStore: %s %s upserted %d bars (total=%d)", symbol, timeframe, len(rows), total)

    # ── exchange (lazy) ─────────────────────────────────────

    def _get_exchange(self) -> ccxt.Exchange:
        if self._exchange is None:
            self._exchange = getattr(ccxt, KL_EXCHANGE)({
                "enableRateLimit": True,
                "options": {"defaultType": "spot"},
            })
            logger.info("KlineStore: exchange initialized: ccxt.%s", KL_EXCHANGE)
        return self._exchange

    # ── multi-market K-lines (yfinance / akshare) ───────────

    def _get_multi_config(self) -> dict:
        """Lazy-load multi-market config."""
        if hasattr(self, "_multi_config"):
            return self._multi_config
        try:
            config = json.loads(Path(_CONFIG_PATH).read_text())
            self._multi_config = config.get("multi_kline", {})
        except Exception:
            self._multi_config = {}
        return self._multi_config

    def _collect_multi_market(self):
        """Fetch multi-market K-lines and write OHLCV (no indicators)."""
        cfg = self._get_multi_config()
        if not cfg:
            return
        fetch_bars = cfg.get("fetch_bars", 200)
        total = 0

        # US stocks / Forex / Futures → yfinance
        for market_key in ("us_stocks", "forex", "futures"):
            sect = cfg.get(market_key) or {}
            for sym in sect.get("symbols", []):
                for tf in sect.get("timeframes", ["1d"]):
                    rows = self._fetch_yfinance(sym["symbol"], tf, fetch_bars)
                    if rows:
                        self._upsert_ohlcv(sym["symbol"], tf, rows)
                        total += 1

        # A-shares → akshare
        cn = cfg.get("cn_stocks") or {}
        for sym in cn.get("symbols", []):
            rows = self._fetch_akshare_cn(sym["symbol"], sym.get("market", "sh"), fetch_bars)
            if rows:
                self._upsert_ohlcv(sym["symbol"], "1d", rows)
                total += 1

        # HK stocks → akshare
        hk = cfg.get("hk_stocks") or {}
        for sym in hk.get("symbols", []):
            rows = self._fetch_akshare_hk(sym["symbol"], fetch_bars)
            if rows:
                self._upsert_ohlcv(sym["symbol"], "1d", rows)
                total += 1

        if total:
            logger.info("KlineStore: multi-market saved %d symbol(s)", total)

    @staticmethod
    def _fetch_yfinance(symbol: str, timeframe: str, bars: int) -> list:
        try:
            import yfinance as yf
            interval_map = {"1d": "1d", "4h": "1h", "1h": "1h"}
            period_map = {"1d": f"{bars}d", "4h": "60d", "1h": "60d"}
            interval = interval_map.get(timeframe, "1d")
            period = period_map.get(timeframe, f"{bars}d")
            ticker = yf.Ticker(symbol)
            df = ticker.history(period=period, interval=interval)
            if df is None or df.empty:
                logger.debug("yfinance fetch empty %s %s", symbol, timeframe)
                return []
            import pandas as pd
            rows = []
            for t_idx, row in df.iterrows():
                ts = int(t_idx.timestamp() * 1000)
                rows.append((ts, round(float(row["Open"]), 8), round(float(row["High"]), 8),
                             round(float(row["Low"]), 8), round(float(row["Close"]), 8),
                             round(float(row.get("Volume", 0) or 0), 8)))
            return rows[-bars:]
        except Exception as exc:
            logger.warning("yfinance fetch failed %s %s: %s", symbol, timeframe, exc)
            return []

    @staticmethod
    def _fetch_akshare_cn(symbol: str, market: str, bars: int) -> list:
        try:
            import akshare as ak
            df = ak.stock_zh_a_hist(symbol=symbol, period="daily",
                                    start_date=None, end_date=None, adjust="qfq")
            if df is None or df.empty:
                logger.debug("akshare CN fetch empty %s", symbol)
                return []
            from datetime import datetime
            rows = []
            for _, row in df.iterrows():
                ts_str = str(row.get("日期", ""))
                try:
                    ts = int(datetime.strptime(ts_str, "%Y-%m-%d").timestamp() * 1000)
                except Exception:
                    continue
                rows.append((ts, round(float(row["开盘"]), 4), round(float(row["最高"]), 4),
                             round(float(row["最低"]), 4), round(float(row["收盘"]), 4),
                             round(float(row.get("成交量", 0)), 0)))
            return rows[-bars:]
        except Exception as exc:
            logger.warning("akshare CN fetch failed %s: %s", symbol, exc)
            return []

    @staticmethod
    def _fetch_akshare_hk(symbol: str, bars: int) -> list:
        try:
            import akshare as ak
            df = ak.stock_hk_hist(symbol=symbol, period="daily",
                                  start_date=None, end_date=None, adjust="qfq")
            if df is None or df.empty:
                logger.debug("akshare HK fetch empty %s", symbol)
                return []
            from datetime import datetime
            rows = []
            for _, row in df.iterrows():
                ts_str = str(row.get("日期", ""))
                try:
                    ts = int(datetime.strptime(ts_str, "%Y-%m-%d").timestamp() * 1000)
                except Exception:
                    continue
                rows.append((ts, round(float(row["开盘"]), 4), round(float(row["最高"]), 4),
                             round(float(row["最低"]), 4), round(float(row["收盘"]), 4),
                             round(float(row.get("成交量", 0)), 0)))
            return rows[-bars:]
        except Exception as exc:
            logger.warning("akshare HK fetch failed %s: %s", symbol, exc)
            return []

    def _upsert_ohlcv(self, symbol: str, timeframe: str, rows: list):
        """Upsert OHLCV-only rows (no indicators) into kline table."""
        db = get_db()
        data = [(symbol, timeframe, ts, o, h, l, c, v,
                 None, None, None, None, None, None, None, None, None, None, None)
                for ts, o, h, l, c, v in rows]
        try:
            with db:
                db.executemany(
                    """INSERT OR REPLACE INTO kline
                       (symbol, timeframe, ts, open, high, low, close, volume,
                        rsi_14, macd, macd_signal, macd_hist,
                        bb_upper, bb_middle, bb_lower, atr_14,
                        ma_5, ma_10, ma_20)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    data,
                )
        except Exception:
            logger.warning("KlineStore: upsert failed for %s %s", symbol, timeframe, exc_info=True)


# ─── Singleton (module-level) ──────────────────────────────

_store: Optional[KlineStore] = None


def get_kline_store() -> KlineStore:
    global _store
    if _store is None:
        _store = KlineStore()
    return _store
