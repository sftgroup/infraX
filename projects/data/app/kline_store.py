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
from datetime import datetime, timedelta, timezone
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
    KL_SWAP_ENABLED,
    KL_SWAP_SYMBOLS,
    KL_SWAP_TIMEFRAMES,
    KL_FETCH_LIMIT,
    KL_INTERVAL_SEC,
    KL_MULTI_INTERVAL_SEC,
    KL_EXCHANGE,
    KL_BACKFILL_DAYS,
)
from app.data_sources.base import TIMEFRAME_SECONDS
from app.storage import get_db

logger = logging.getLogger(__name__)

# Parse config strings
_SYMBOLS = [s.strip() for s in KL_SYMBOLS.split(",") if s.strip()]
_TIMEFRAMES = [t.strip() for t in KL_TIMEFRAMES.split(",") if t.strip()]
# swap 合约采集（DS-8）：独立标的/周期，存储键 base/quote:quote
_SWAP_SYMBOLS = [s.strip() for s in KL_SWAP_SYMBOLS.split(",") if s.strip()]
_SWAP_TIMEFRAMES = [t.strip() for t in KL_SWAP_TIMEFRAMES.split(",") if t.strip()]


def set_runtime_symbols(symbols=None, timeframes=None, swap_symbols=None, swap_timeframes=None) -> None:
    """运行时更新采集交易对（PUT /admin/symbols 调用）。

    只更新内存中的模块级列表（采集循环下次迭代即生效），
    持久化由调用方（main.py）写 .env 负责。
    """
    global _SYMBOLS, _TIMEFRAMES, _SWAP_SYMBOLS, _SWAP_TIMEFRAMES
    if symbols is not None:
        _SYMBOLS = [s.strip() for s in symbols if str(s).strip()]
    if timeframes is not None:
        _TIMEFRAMES = [t.strip() for t in timeframes if str(t).strip()]
    if swap_symbols is not None:
        _SWAP_SYMBOLS = [s.strip() for s in swap_symbols if str(s).strip()]
    if swap_timeframes is not None:
        _SWAP_TIMEFRAMES = [t.strip() for t in swap_timeframes if str(t).strip()]

# ── 历史深度回填目标（天）────────────────────────────
# 对齐 B 端验收标准（AITRADER_DATA_SERVICE_REQ.md §7）：
#   1m≥30 天；5m/15m/30m≥180 天；1h/4h≥365 天；1d≥1095 天（3 年）
# 未列出 timeframe 默认 30 天。可用 KL_BACKFILL_DAYS JSON 覆盖。
_DEFAULT_BACKFILL_DAYS = {
    "1m": 30,
    "5m": 180,
    "15m": 180,
    "30m": 180,
    "1h": 365,
    "4h": 365,
    "1d": 1095,
}
_BACKFILL_DAYS = dict(_DEFAULT_BACKFILL_DAYS)
if KL_BACKFILL_DAYS:
    try:
        _BACKFILL_DAYS.update(json.loads(KL_BACKFILL_DAYS))
    except Exception:
        logger.warning("KL_BACKFILL_DAYS unparsable: %r (ignored)", KL_BACKFILL_DAYS)


def _tf_seconds(timeframe: str) -> int:
    """timeframe → 秒（'1m'→60, '1d'→86400，未知默认 86400）。"""
    return TIMEFRAME_SECONDS.get(timeframe, 86400)


def _swap_ccxt_symbol(symbol: str) -> str:
    """crypto 交易对 → ccxt swap 符号（BTC/USDT → BTC/USDT:USDT）。

    与 enrich._normalize_kline_symbol(market_type=swap) 的存储键约定一致，
    采集落库键与 /bars 查询键天然对齐。
    """
    if ":" in symbol:
        return symbol
    if "/" in symbol:
        base, quote = symbol.split("/", 1)
        if ":" in quote:
            return symbol
        return f"{base}/{quote}:{quote}"
    return symbol

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
        self._multi_cycle = 0  # 多市场轮换游标（forex 周期轮流采集）

    # ── start / stop ────────────────────────────────────────

    def start(self):
        """Start background collection loop."""
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._loop, daemon=True, name="kline-collector")
        self._thread.start()
        swap_note = f", swap={KL_SWAP_ENABLED and (f'{_SWAP_SYMBOLS}@{_SWAP_TIMEFRAMES}' or '') or 'off'}"
        logger.info("KlineStore started (symbols=%s, timeframes=%s, interval=%ds, multi_interval=%ds%s)",
                     _SYMBOLS, _TIMEFRAMES, KL_INTERVAL_SEC, KL_MULTI_INTERVAL_SEC, swap_note)

    def stop(self):
        self._running = False

    def _loop(self):
        last_multi = 0.0
        while self._running:
            try:
                self._backfill_all()  # 历史深度回填（幂等，DS-8 验收标准）
                self._collect_all()
                if KL_SWAP_ENABLED:
                    self._collect_swap()
                # 多市场（美股/外汇/期货/A股/港股）独立周期 KL_MULTI_INTERVAL_SEC：
                # 仅 1d 日线 + Twelve Data 免费 tier 限流，避免每 5 分钟拉 6 对外汇超额 429。
                if time.monotonic() - last_multi >= KL_MULTI_INTERVAL_SEC:
                    self._collect_multi_market()
                    last_multi = time.monotonic()
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
        """Fetch → compute → upsert for one symbol+timeframe (spot)."""
        ohlcv = ex.fetch_ohlcv(symbol, timeframe, limit=KL_FETCH_LIMIT)
        if not ohlcv or len(ohlcv) < 30:
            logger.debug("KlineStore: %s returned %d bars (skip)", symbol, len(ohlcv) if ohlcv else 0)
            return
        self._upsert_bars_with_indicators(symbol, timeframe, ohlcv)

    def _collect_swap(self):
        """Fetch swap（永续合约）K-lines → compute → upsert（DS-8）。

        ccxt 符号 ``base/quote:quote``（BTC/USDT:USDT）显式路由 swap 市场，
        存储键与 ``/bars?market_type=swap`` 查询键一致。独立 try/except，
        失败不影响 spot 采集。
        """
        if not KL_SWAP_ENABLED or not _SWAP_SYMBOLS:
            return
        ex = self._get_exchange()
        for sym in _SWAP_SYMBOLS:
            ccxt_sym = _swap_ccxt_symbol(sym)
            for tf in _SWAP_TIMEFRAMES:
                try:
                    ohlcv = ex.fetch_ohlcv(ccxt_sym, tf, limit=KL_FETCH_LIMIT)
                    if not ohlcv or len(ohlcv) < 30:
                        logger.debug("KlineStore swap: %s returned %d bars (skip)",
                                     ccxt_sym, len(ohlcv) if ohlcv else 0)
                        continue
                    self._upsert_bars_with_indicators(ccxt_sym, tf, ohlcv)
                except Exception:
                    logger.warning("KlineStore swap fetch failed %s %s", ccxt_sym, tf, exc_info=True)

    # ── 历史深度回填（DS-8 / B 端验收标准）────────────────

    def _backfill_all(self):
        """补齐所有 (symbol, timeframe) 与 swap 的历史深度缺口。

        幂等：库中最早 ts 已覆盖目标窗口时跳过（仅一次 SQL 查询）。
        在每轮采集循环开头调用，深度保持由目标窗口 + 增量采集共同维持。
        """
        ex = self._get_exchange()
        for symbol in _SYMBOLS:
            for tf in _TIMEFRAMES:
                try:
                    n = self._backfill_gap(ex, symbol, tf)
                    if n:
                        logger.info("KlineStore backfill: %s %s +%d bars", symbol, tf, n)
                except Exception:
                    logger.warning("KlineStore backfill failed %s %s", symbol, tf, exc_info=True)
        if KL_SWAP_ENABLED and _SWAP_SYMBOLS:
            for sym in _SWAP_SYMBOLS:
                ccxt_sym = _swap_ccxt_symbol(sym)
                for tf in _SWAP_TIMEFRAMES:
                    try:
                        n = self._backfill_gap(ex, ccxt_sym, tf)
                        if n:
                            logger.info("KlineStore backfill: %s %s +%d bars", ccxt_sym, tf, n)
                    except Exception:
                        logger.warning("KlineStore backfill failed %s %s", ccxt_sym, tf, exc_info=True)

    def _backfill_gap(self, ex: ccxt.Exchange, symbol: str, timeframe: str) -> int:
        """补齐单个 (symbol, timeframe) 的历史缺口 → 返回回填 bar 数（无缺口返回 0）。

        目标起点 = now - 目标深度（天）。若库中 MIN(ts) 已不晚于目标起点则视为
        深度达标。否则从目标起点分页拉取（fetch_ohlcv since + limit=1000）直到
        覆盖已有最早数据 / 当前时间，去重后统一 upsert（含指标重算）。
        """
        target_days = _BACKFILL_DAYS.get(timeframe, _DEFAULT_BACKFILL_DAYS.get("1m", 30))
        target_since = int(
            (datetime.now(timezone.utc) - timedelta(days=target_days)).timestamp() * 1000
        )
        db = get_db()
        row = db.execute(
            "SELECT MIN(ts), MAX(ts) FROM kline WHERE symbol=? AND timeframe=?",
            (symbol, timeframe),
        ).fetchone()
        min_ts = row[0] if row and row[0] else None
        if min_ts is not None and min_ts <= target_since:
            return 0  # 深度已达标

        now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
        end_ms = min(min_ts, now_ms) if min_ts is not None else now_ms
        if end_ms <= target_since:
            return 0
        tf_ms = _tf_seconds(timeframe) * 1000

        all_ohlcv: list = []
        cur = target_since
        batch_limit = 1000
        empty_streak = 0
        while cur < end_ms:
            try:
                batch = ex.fetch_ohlcv(symbol, timeframe, since=cur, limit=batch_limit)
            except Exception as exc:
                logger.warning(
                    "KlineStore backfill fetch failed %s %s @%d: %s",
                    symbol, timeframe, cur, exc,
                )
                break
            if not batch:
                empty_streak += 1
                if empty_streak >= 3:
                    break
                cur += tf_ms * min(batch_limit, 64)
                continue
            empty_streak = 0
            all_ohlcv.extend(batch)
            last_ts = batch[-1][0]
            if last_ts >= end_ms:
                break
            if last_ts <= cur:  # 交易所未推进（防御死循环）
                cur += tf_ms * min(batch_limit, 16)
                continue
            cur = last_ts + tf_ms

        if not all_ohlcv:
            return 0
        by_ts = {int(r[0]): r for r in all_ohlcv if len(r) >= 6}
        merged = sorted(by_ts.values(), key=lambda r: r[0])
        return self._upsert_bars_with_indicators(symbol, timeframe, merged)

    def _upsert_bars_with_indicators(self, symbol: str, timeframe: str, ohlcv: list) -> int:
        """OHLCV → 指标 → upsert（spot/swap 共用）。返回落库 bar 数。"""
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
        return len(rows)

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

    def reload_multi_config(self) -> None:
        """失效 multi 配置缓存，下次采集重新读取 data_config.json（PUT /admin/symbols 调用）。"""
        if hasattr(self, "_multi_config"):
            del self._multi_config

    def _collect_multi_market(self):
        """Fetch multi-market K-lines and write OHLCV (no indicators).

        数据源（绕过 Yahoo 限流）：
          - us_stocks → 1d akshare 新浪日线（stock_us_daily）；1h/4h yfinance
                        （生产 IP 常被 Yahoo 限流 429 → 记 failed，等待 B 端提供
                          Twelve Data 付费 tier / Alpha Vantage 配额）
          - futures   → 1d akshare 东财外盘期货日线（futures_foreign_hist）；1h/4h yfinance
          - forex     → Twelve Data（interval 参数化 1m~1day）。**轮换采集**：每周期只拉
                        1 个 timeframe（7 对 × 1 请求），请求间节流 ≥8s，适配免费
                        tier（8 次/分、800 credits/天，且与机会/宏观/DXY 等共用）
          - cn_stocks → 1d 腾讯日线 + 15m/1h 腾讯分钟线（akshare stock_zh_a_minute，
                        免费无额度）+ 4h 由 1h 聚合
          - hk_stocks → 1d 腾讯日线（分钟级源待扩展，仅 1d）

        timeframes 取自 data_config.json multi_kline.<market>.timeframes（需求目标）；
        源不支持的周期跳过并记入 failed（如 hk 分钟级）。
        """
        cfg = self._get_multi_config()
        if not cfg:
            return
        socket.setdefaulttimeout(10)
        fetch_bars = cfg.get("fetch_bars", 200)
        cycle = self._multi_cycle  # 轮换游标：forex 各周期轮流采集
        self._multi_cycle = cycle + 1
        total = 0
        failed = []
        # 新浪/东财接口对快速连续请求会返回空（风控），每 symbol 间节流
        _THROTTLE = 2.0
        # Twelve Data 免费 tier 限 8 次/分，请求间再叠加节流避免 429
        _TD_THROTTLE = 8.0

        def _upsert(sym: str, tf: str, rows: list) -> bool:
            nonlocal total
            if not rows:
                return False
            self._upsert_ohlcv(sym, tf, rows)
            total += 1
            return True

        # US stocks → 1d akshare + 1h/4h yfinance
        us = cfg.get("us_stocks") or {}
        us_tfs = [t for t in (us.get("timeframes") or ["1d"]) if t in ("1d", "1h", "4h")]
        for sym in us.get("symbols", []):
            time.sleep(_THROTTLE)
            for tf in us_tfs:
                rows = (self._fetch_akshare_us(sym["symbol"], fetch_bars) if tf == "1d"
                        else self._fetch_yfinance(sym["symbol"], tf, fetch_bars))
                if not _upsert(sym["symbol"], tf, rows):
                    failed.append(f"{sym['symbol']} {tf}")

        # Futures → 1d akshare (东财) + 1h/4h yfinance
        ft = cfg.get("futures") or {}
        ft_tfs = [t for t in (ft.get("timeframes") or ["1d"]) if t in ("1d", "1h", "4h")]
        for sym in ft.get("symbols", []):
            time.sleep(_THROTTLE)
            for tf in ft_tfs:
                rows = (self._fetch_akshare_futures(sym["symbol"], fetch_bars) if tf == "1d"
                        else self._fetch_yfinance(sym["symbol"], tf, fetch_bars))
                if not _upsert(sym["symbol"], tf, rows):
                    failed.append(f"{sym['symbol']} {tf}")

        # Forex → Twelve Data 轮换采集：每周期只拉 1 个 timeframe（额度友好）
        fx = cfg.get("forex") or {}
        fx_tfs = [t for t in (fx.get("timeframes") or ["1d"])
                  if t in ("1m", "5m", "15m", "30m", "1h", "2h", "4h", "1d")]
        if fx_tfs:
            fx_tf = fx_tfs[cycle % len(fx_tfs)]
            for sym in fx.get("symbols", []):
                time.sleep(_THROTTLE)
                rows = self._fetch_forex(sym["symbol"], fx_tf, fetch_bars)
                if not _upsert(sym["symbol"], fx_tf, rows):
                    failed.append(f"{sym['symbol']} {fx_tf}")
                time.sleep(_TD_THROTTLE)

        # A-shares → 1d 腾讯日线 + 15m/1h 腾讯分钟线 + 4h 由 1h 聚合
        cn = cfg.get("cn_stocks") or {}
        cn_tfs = [t for t in (cn.get("timeframes") or ["1d"]) if t in ("15m", "1h", "4h", "1d")]
        for sym in cn.get("symbols", []):
            time.sleep(_THROTTLE)
            market = sym.get("market", "sh")
            for tf in cn_tfs:
                if tf == "1d":
                    rows = self._fetch_akshare_cn(sym["symbol"], market, fetch_bars)
                elif tf in ("15m", "1h"):
                    rows = self._fetch_tencent_minute(sym["symbol"], market, tf)
                else:  # 4h → 聚合 1h 分钟线
                    rows = self._resample_1h_to_tf(
                        self._fetch_tencent_minute(sym["symbol"], market, "1h"), 4)
                if not _upsert(sym["symbol"], tf, rows):
                    failed.append(f"{sym['symbol']} {tf}")

        # HK stocks → 1d 腾讯日线（分钟级源待扩展）
        hk = cfg.get("hk_stocks") or {}
        for sym in hk.get("symbols", []):
            time.sleep(_THROTTLE)
            rows = self._fetch_akshare_hk(sym["symbol"], fetch_bars)
            if not _upsert(sym["symbol"], "1d", rows):
                failed.append(sym["symbol"])

        if total:
            logger.info("KlineStore: multi-market saved %d symbol(s)", total)
        if failed:
            logger.warning("KlineStore: multi-market failed %d symbol(s): %s", len(failed), ", ".join(failed))

    @staticmethod
    def _fetch_forex(symbol: str, timeframe: str = "1d", bars: int = 200) -> list:
        """外汇 K 线：Twelve Data（配置 key 时优先，interval 参数化）→ yfinance 回退。

        symbol 为 Yahoo 代码（如 EURUSD=X）；Twelve Data 需要 EUR/USD 格式。
        timeframe 支持 1d/1h/4h/15m/30m/5m/1m（Twelve Data 原生 interval）。
        """
        rows = KlineStore._fetch_forex_twelve(symbol, bars, timeframe)
        if rows:
            return rows
        return KlineStore._fetch_yfinance(symbol, timeframe, bars)

    @staticmethod
    def _fetch_forex_twelve(symbol: str, bars: int = 200, timeframe: str = "1d") -> list:
        """外汇 K 线 from Twelve Data (api.twelvedata.com, 需 TWELVE_DATA_API_KEY).

        Twelve Data interval 支持：1min/5min/15min/30min/45min/1h/2h/4h/1day/1week/1month。
        datetime 含时分秒（intraday）时解析完整时间戳，避免同日期多行互相覆盖。
        """
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
            interval_map = {
                "1m": "1min", "5m": "5min", "15m": "15min", "30m": "30min",
                "45m": "45min", "1h": "1h", "2h": "2h", "4h": "4h",
                "1d": "1day",
            }
            interval = interval_map.get(str(timeframe).strip().lower(), "1day")
            td_symbol = f"{pair[:3]}/{pair[3:]}"
            resp = requests.get(
                "https://api.twelvedata.com/time_series",
                params={
                    "symbol": td_symbol,
                    "interval": interval,
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
                dt_s = v.get("datetime", "")
                try:
                    if " " in dt_s:
                        ts = int(_dt.strptime(dt_s, "%Y-%m-%d %H:%M:%S").timestamp() * 1000)
                    else:
                        ts = int(_dt.strptime(dt_s[:10], "%Y-%m-%d").timestamp() * 1000)
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
            # Yahoo 无原生 4h：1h/4h 均拉 1h interval，4h 在下方聚合
            interval = "1h" if timeframe in ("1h", "4h") else "1d"
            period = {"1d": f"{bars}d", "1h": "60d", "4h": "60d"}.get(timeframe, f"{bars}d")
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
            if timeframe == "4h":
                rows = KlineStore._resample_1h_to_tf(rows, 4)
            return rows[-bars:]
        except Exception as exc:
            # 生产 IP 常被 Yahoo 限流（429），降为 debug，汇总由 multi-market failed 行承担
            logger.debug("yfinance fetch failed %s %s: %s", symbol, timeframe, exc)
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

    @staticmethod
    def _fetch_tencent_minute(symbol: str, market: str, timeframe: str) -> list:
        """A股分钟线 from akshare 腾讯（stock_zh_a_minute，免费、无额度限制）。

        timeframe: '15m' → period 15；'1h' → period 60。腾讯分钟 bar 时间戳为
        bar 结束时间（北京时间 UTC+8），与日线 ts 约定一致（毫秒）。
        单次约返回 1970 根；upsert 幂等，可反复拉取增量。
        """
        period_map = {"1m": "1", "5m": "5", "15m": "15", "30m": "30", "1h": "60"}
        period = period_map.get(str(timeframe).strip().lower())
        if not period:
            return []
        try:
            import akshare as ak
            df = ak.stock_zh_a_minute(symbol=f"{market}{symbol}", period=period)
            if df is None or df.empty:
                return []
            rows = []
            for _, row in df.iterrows():
                day = str(row.get("day", ""))
                if len(day) < 19:
                    continue
                dt = datetime.strptime(day[:19], "%Y-%m-%d %H:%M:%S").replace(
                    tzinfo=timezone(timedelta(hours=8)))
                ts = int(dt.timestamp() * 1000)
                rows.append((ts, round(float(row["open"]), 4), round(float(row["high"]), 4),
                             round(float(row["low"]), 4), round(float(row["close"]), 4),
                             round(float(row.get("volume", 0) or 0), 0)))
            return rows
        except Exception as exc:
            logger.debug("Tencent minute fetch failed %s %s: %s", symbol, timeframe, exc)
            return []

    @staticmethod
    def _resample_1h_to_tf(rows: list, bars_per: int) -> list:
        """把升序 1h bars 按 bars_per 根为一组聚合为更大周期 OHLCV。

        rows: [(ts, o, h, l, c, v), ...]（ts 升序）。组内 ts 取首根，OHLC 聚合、
        volume 求和；尾部不足一组丢弃。yfinance 4h 与 A股 4h 共用。
        """
        if bars_per <= 1 or len(rows) < bars_per:
            return list(rows) if bars_per <= 1 else []
        out = []
        n = len(rows) - len(rows) % bars_per
        for i in range(0, n, bars_per):
            grp = rows[i:i + bars_per]
            out.append((grp[0][0], grp[0][1],
                        max(g[2] for g in grp), min(g[3] for g in grp),
                        grp[-1][4], round(sum(g[5] for g in grp), 4)))
        return out

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
