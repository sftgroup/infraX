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
import requests
import socket

# akshare 内部大量 requests.get() 不传 timeout，目标源无响应时会无限挂起；
# 打补丁给所有 requests 调用注入默认超时（显式传过 timeout 的不受影响）。
_orig_session_request = requests.Session.request


def _session_request_with_timeout(self, method, url, **kwargs):
    kwargs.setdefault("timeout", 12)
    return _orig_session_request(self, method, url, **kwargs)


requests.Session.request = _session_request_with_timeout

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
        """Fetch multi-market K-lines and write OHLCV (no indicators).

        数据源（绕过 Yahoo 限流）：
          - us_stocks → akshare 新浪日线（stock_us_daily）
          - futures   → akshare 东财外盘期货日线（futures_foreign_hist）
          - forex     → Twelve Data（需 key）→ yfinance 回退
          - cn_stocks → 腾讯日线（不复权）→ akshare 新浪回退
          - hk_stocks → 腾讯日线（前复权）→ akshare 新浪回退
        """
        cfg = self._get_multi_config()
        if not cfg:
            return
        # akshare 内部请求大多不传 timeout，若目标源无响应会无限挂起；
        # 设置进程级 socket 默认超时，让挂起的请求快速失败并进入退避重试。
        socket.setdefaulttimeout(10)
        fetch_bars = cfg.get("fetch_bars", 200)
        total = 0
        failed = []
        # 新浪/东财接口对快速连续请求会返回空（风控），每 symbol 间节流
        _THROTTLE = 2.0

        # US stocks → akshare (新浪) — 仅日线
        us = cfg.get("us_stocks") or {}
        for sym in us.get("symbols", []):
            time.sleep(_THROTTLE)
            rows = self._fetch_akshare_us(sym["symbol"], fetch_bars)
            if rows:
                self._upsert_ohlcv(sym["symbol"], "1d", rows)
                total += 1
            else:
                failed.append(sym["symbol"])

        # Futures → akshare (东财) — 仅日线
        ft = cfg.get("futures") or {}
        for sym in ft.get("symbols", []):
            time.sleep(_THROTTLE)
            rows = self._fetch_akshare_futures(sym["symbol"], fetch_bars)
            if rows:
                self._upsert_ohlcv(sym["symbol"], "1d", rows)
                total += 1
            else:
                failed.append(sym["symbol"])

        # Forex → Twelve Data（配置 key 时优先）→ yfinance 回退
        fx = cfg.get("forex") or {}
        for sym in fx.get("symbols", []):
            time.sleep(_THROTTLE)
            rows = self._fetch_forex(sym["symbol"], fetch_bars)
            if rows:
                self._upsert_ohlcv(sym["symbol"], "1d", rows)
                total += 1
            else:
                failed.append(sym["symbol"])

        # A-shares → akshare
        cn = cfg.get("cn_stocks") or {}
        for sym in cn.get("symbols", []):
            time.sleep(_THROTTLE)
            rows = self._fetch_akshare_cn(sym["symbol"], sym.get("market", "sh"), fetch_bars)
            if rows:
                self._upsert_ohlcv(sym["symbol"], "1d", rows)
                total += 1
            else:
                failed.append(sym["symbol"])

        # HK stocks → akshare
        hk = cfg.get("hk_stocks") or {}
        for sym in hk.get("symbols", []):
            time.sleep(_THROTTLE)
            rows = self._fetch_akshare_hk(sym["symbol"], fetch_bars)
            if rows:
                self._upsert_ohlcv(sym["symbol"], "1d", rows)
                total += 1
            else:
                failed.append(sym["symbol"])

        if total:
            logger.info("KlineStore: multi-market saved %d symbol(s)", total)
        if failed:
            logger.warning("KlineStore: multi-market failed %d symbol(s): %s", len(failed), ", ".join(failed))

    @staticmethod
    def _fetch_forex(symbol: str, bars: int) -> list:
        """外汇日线：Twelve Data（配置 key 时优先）→ yfinance 回退。

        symbol 为 Yahoo 代码（如 EURUSD=X）；Twelve Data 需要 EUR/USD 格式。
        """
        rows = KlineStore._fetch_forex_twelve(symbol, bars)
        if rows:
            return rows
        return KlineStore._fetch_yfinance(symbol, "1d", bars)

    @staticmethod
    def _fetch_forex_twelve(symbol: str, bars: int) -> list:
        """外汇日线 from Twelve Data (api.twelvedata.com, 需 TWELVE_DATA_API_KEY)."""
        try:
            from app.config import APIKeys
            key = APIKeys.rotate("TWELVE_DATA_API_KEY")
            if not key:
                return []
            pair = symbol.upper().replace("=X", "").replace("=", "")
            if len(pair) != 6 or pair not in (
                "EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "USDCHF",
                "NZDUSD", "EURJPY", "GBPJPY", "EURGBP", "USDCNH",
            ):
                return []
            td_symbol = f"{pair[:3]}/{pair[3:]}"
            resp = requests.get(
                "https://api.twelvedata.com/time_series",
                params={
                    "symbol": td_symbol,
                    "interval": "1day",
                    "outputsize": min(bars, 800),
                    "apikey": key,
                },
                timeout=15,
            )
            if resp.status_code != 200:
                logger.warning("Forex (Twelve Data) fetch failed %s: status=%d", symbol, resp.status_code)
                return []
            values = (resp.json().get("values") or [])[-bars:]
            if not values:
                logger.warning("Forex (Twelve Data) fetch empty %s", symbol)
                return []
            from datetime import datetime as _dt
            rows = []
            for v in values:
                try:
                    ts = int(_dt.strptime(v["datetime"][:10], "%Y-%m-%d").timestamp() * 1000)
                except (ValueError, KeyError):
                    continue
                rows.append((
                    ts,
                    round(float(v["open"]), 6),
                    round(float(v["high"]), 6),
                    round(float(v["low"]), 6),
                    round(float(v["close"]), 6),
                    round(float(v.get("volume", 0) or 0), 6),
                ))
            return rows
        except Exception as exc:
            logger.warning("Forex (Twelve Data) fetch failed %s: %s", symbol, exc)
            return []

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
    def _ts_ms(val) -> Optional[int]:
        """兼容 pandas.Timestamp / datetime / '%Y-%m-%d' 字符串的毫秒时间戳解析。"""
        import pandas as pd
        from datetime import datetime as _dt
        if isinstance(val, (pd.Timestamp, _dt)):
            return int(val.timestamp() * 1000)
        if isinstance(val, str):
            try:
                return int(_dt.strptime(val[:10], "%Y-%m-%d").timestamp() * 1000)
            except ValueError:
                return None
        return None

    @staticmethod
    def _fetch_akshare_us(symbol: str, bars: int) -> list:
        """US stocks daily OHLCV from akshare (新浪, free, bypasses Yahoo rate-limit).

        新浪对快速/并发请求会返回空（风控，需静默较长时间恢复）：空或异常退避短
        重试；风控期间重试无益，快速失败留给下一采集周期。
        """
        last_err = ""
        for attempt in range(3):
            try:
                import akshare as ak
                df = ak.stock_us_daily(symbol=symbol)
                if df is not None and not df.empty:
                    rows = []
                    for _, row in df.iterrows():
                        ts = KlineStore._ts_ms(row.get("date"))
                        if ts is None:
                            continue
                        rows.append((ts, round(float(row["open"]), 8), round(float(row["high"]), 8),
                                     round(float(row["low"]), 8), round(float(row["close"]), 8),
                                     round(float(row.get("volume", 0) or 0), 8)))
                    if rows:
                        return rows[-bars:]
                last_err = "empty"
            except Exception as exc:
                last_err = str(exc)
            if attempt < 2:
                time.sleep(3)
        logger.warning("akshare US fetch failed %s: %s", symbol, last_err)
        return []

    @staticmethod
    def _fetch_akshare_futures(symbol: str, bars: int) -> list:
        """Foreign futures daily OHLCV from akshare (东财, free).

        symbol 形如 "GC=F"，映射为东财代码 "GC"；empty 或异常均退避重试。
        """
        code = symbol.replace("=F", "").replace("=f", "")
        last_err = ""
        for attempt in range(3):
            try:
                import akshare as ak
                df = ak.futures_foreign_hist(symbol=code)
                if df is not None and not df.empty:
                    rows = []
                    for _, row in df.iterrows():
                        ts = KlineStore._ts_ms(row.get("date"))
                        if ts is None:
                            continue
                        rows.append((ts, round(float(row["open"]), 8), round(float(row["high"]), 8),
                                     round(float(row["low"]), 8), round(float(row["close"]), 8),
                                     round(float(row.get("volume", 0) or 0), 8)))
                    if rows:
                        return rows[-bars:]
                last_err = "empty"
            except Exception as exc:
                last_err = str(exc)
            if attempt < 2:
                time.sleep(3)
        logger.warning("akshare futures fetch failed %s (%s): %s", symbol, code, last_err)
        return []

    @staticmethod
    def _fetch_tencent_daily(market: str, symbol: str, bars: int) -> list:
        """腾讯日线（web.ifzq.gtimg.cn），规避新浪批量风控与东财 push2his 断连。

        market: 'hk' → 前复权（腾讯港股接口仅支持复权）；'sh'/'sz' → 不复权。
        单请求返回 bars 根，行格式 [date, open, close, high, low, volume, ...]。
        """
        try:
            if market == "hk":
                qid = f"hk{symbol}"
                url = "https://web.ifzq.gtimg.cn/appstock/app/hkfqkline/get"
                params = {"param": f"{qid},day,,,{bars},qfq"}
            else:
                qid = f"{market}{symbol}"
                url = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get"
                params = {"param": f"{qid},day,,,{bars},"}
            resp = requests.get(
                url, params=params, timeout=12,
                headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                                       "AppleWebKit/537.36 Chrome/124.0 Safari/537.36"},
            )
            if resp.status_code != 200:
                return []
            data = (resp.json().get("data") or {}).get(qid) or {}
            kd = data.get("qfqday") or data.get("day") or []
            rows = []
            for item in kd:
                if len(item) < 6:
                    continue
                ts = KlineStore._ts_ms(item[0])
                if ts is None:
                    continue
                rows.append((ts,
                             round(float(item[1]), 4),   # open
                             round(float(item[3]), 4),   # high
                             round(float(item[4]), 4),   # low
                             round(float(item[2]), 4),   # close
                             round(float(item[5] or 0), 0)))  # volume
            return rows[-bars:]
        except Exception as exc:
            logger.warning("Tencent fetch failed %s%s: %s", market, symbol, exc)
            return []

    @staticmethod
    def _fetch_akshare_cn(symbol: str, market: str, bars: int) -> list:
        """A-shares daily: 腾讯日线（不复权）优先 → akshare 新浪（stock_zh_a_daily）回退。

        新浪源在批量周期内会被 IP 风控（约 10+ 次请求后返回空），腾讯源独立于新浪，
        可稳定支撑 A股采集；东财 stock_zh_a_hist 对本机 IP 连接被重置，不可用。
        """
        rows = KlineStore._fetch_tencent_daily(market, symbol, bars)
        if rows:
            return rows
        last_err = "tencent empty"
        for attempt in range(3):
            try:
                import akshare as ak
                df = ak.stock_zh_a_daily(symbol=f"{market}{symbol}")
                if df is not None and not df.empty:
                    rows = []
                    for _, row in df.iterrows():
                        ts = KlineStore._ts_ms(row.get("date"))
                        if ts is None:
                            continue
                        rows.append((ts, round(float(row["open"]), 4), round(float(row["high"]), 4),
                                     round(float(row["low"]), 4), round(float(row["close"]), 4),
                                     round(float(row.get("volume", 0) or 0), 0)))
                    if rows:
                        return rows[-bars:]
                last_err = "empty"
            except Exception as exc:
                last_err = str(exc)
            if attempt < 2:
                time.sleep(3)
        logger.warning("akshare CN fetch failed %s: %s", symbol, last_err)
        return []

    @staticmethod
    def _fetch_akshare_hk(symbol: str, bars: int) -> list:
        """HK stocks daily: 腾讯日线（前复权）优先 → akshare 新浪（stock_hk_daily）回退。"""
        rows = KlineStore._fetch_tencent_daily("hk", symbol, bars)
        if rows:
            return rows
        last_err = "tencent empty"
        for attempt in range(3):
            try:
                import akshare as ak
                df = ak.stock_hk_daily(symbol=symbol)
                if df is not None and not df.empty:
                    rows = []
                    for _, row in df.iterrows():
                        ts = KlineStore._ts_ms(row.get("date"))
                        if ts is None:
                            continue
                        rows.append((ts, round(float(row["open"]), 4), round(float(row["high"]), 4),
                                     round(float(row["low"]), 4), round(float(row["close"]), 4),
                                     round(float(row.get("volume", 0) or 0), 0)))
                    if rows:
                        return rows[-bars:]
                last_err = "empty"
            except Exception as exc:
                last_err = str(exc)
            if attempt < 2:
                time.sleep(3)
        logger.warning("akshare HK fetch failed %s: %s", symbol, last_err)
        return []

    def _upsert_ohlcv(self, symbol: str, timeframe: str, rows: list):
        """Upsert OHLCV-only rows (no indicators) into kline table."""
        db = get_db()
        data = [(symbol, timeframe, ts, o, h, l, c, v)
                for ts, o, h, l, c, v in rows]
        try:
            with db:
                db.executemany(
                    """INSERT OR REPLACE INTO kline
                       (symbol, timeframe, ts, open, high, low, close, volume)
                       VALUES (?,?,?,?,?,?,?,?)""",
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
