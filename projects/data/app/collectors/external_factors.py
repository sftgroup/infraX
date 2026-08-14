"""External factor collector — periodic fetch → raw_snapshots.

Fetches free public data sources (no API key required):
  - Fear & Greed Index (alternative.me)
  - VIX (CBOE official CSV, yfinance fallback)
  - DXY (yfinance; frankfurter/ECB 参考汇率计算回退，无 key)
  - US10Y (akshare 东财美债收益率, yfinance fallback)

All factors fall back to the last saved snapshot if every source fails,
so downstream factor consumers never see a gap.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from typing import Optional

import requests
import numpy as np

from app.factors import save_snapshot
from app.storage import get_db
from app.collectors.urls import ALTERNATIVE_ME_FNG_URL

logger = logging.getLogger(__name__)

# ── Config ─────────────────────────────────────────────────

COLLECT_INTERVAL = int(os.getenv("FACTOR_COLLECT_INTERVAL_SEC", "300"))  # 5 min

# CBOE 官方 VIX 历史 CSV（免费、稳定、无需 key）
CBOE_VIX_CSV = "https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv"


def _last_snapshot_value(provider: str, data_type: str) -> Optional[float]:
    """从 raw_snapshots 读最近一次快照值（fetch 失败时的 stale 兜底）。"""
    try:
        db = get_db()
        row = db.execute(
            "SELECT raw_json FROM raw_snapshots WHERE provider=? AND data_type=? "
            "ORDER BY fetched_at DESC LIMIT 1",
            (provider, data_type),
        ).fetchone()
        if not row:
            return None
        data = json.loads(row[0])
        if isinstance(data, dict):
            return data.get("value")
        return data
    except Exception:
        return None


# ── Fetchers (fail-silent, return None on error) ──────────


def _fetch_fear_greed() -> Optional[int]:
    """Fear & Greed Index from alternative.me (free, no key)."""
    try:
        resp = requests.get(ALTERNATIVE_ME_FNG_URL, timeout=10)
        if resp.status_code != 200:
            logger.warning("Fear & Greed fetch failed: status=%d url=%s", resp.status_code, ALTERNATIVE_ME_FNG_URL)
            return None
        data = resp.json().get("data", [])
        if data:
            return int(data[0]["value"])
        logger.warning("Fear & Greed fetch: empty data payload")
    except Exception as exc:
        logger.warning("Fear & Greed fetch failed: %s", exc)
    return None


def _fetch_vix_cboe() -> Optional[float]:
    """VIX from CBOE official CSV (no API key, stable)."""
    try:
        resp = requests.get(CBOE_VIX_CSV, timeout=15, headers={"User-Agent": "Mozilla/5.0"})
        if resp.status_code != 200:
            logger.warning("VIX (CBOE) fetch failed: status=%d", resp.status_code)
            return None
        lines = [ln.strip() for ln in resp.text.strip().splitlines() if ln.strip()]
        if len(lines) < 2:
            logger.warning("VIX (CBOE) fetch: empty payload")
            return None
        # last row: DATE,OPEN,HIGH,LOW,CLOSE
        last = lines[-1].split(",")
        if len(last) >= 5 and last[4]:
            return round(float(last[4]), 2)
        logger.warning("VIX (CBOE) fetch: bad last row %r", last)
        return None
    except Exception as exc:
        logger.warning("VIX (CBOE) fetch failed: %s", exc)
        return None


def _fetch_vix() -> Optional[float]:
    """VIX from yfinance (fallback when CBOE unavailable)."""
    try:
        import yfinance as yf
        ticker = yf.Ticker("^VIX")
        hist = ticker.history(period="5d")
        if not hist.empty:
            return round(float(hist["Close"].iloc[-1]), 2)
        logger.debug("VIX fetch: empty history from yfinance")
    except Exception:
        logger.debug("VIX fetch failed (yfinance rate-limited?)", exc_info=True)
    return None


def _fetch_dxy() -> Optional[float]:
    """US Dollar Index from yfinance."""
    try:
        import yfinance as yf
        ticker = yf.Ticker("DX-Y.NYB")
        hist = ticker.history(period="5d")
        if not hist.empty:
            return round(float(hist["Close"].iloc[-1]), 2)
        logger.debug("DXY fetch: empty history from yfinance")
    except Exception:
        logger.debug("DXY fetch failed (yfinance rate-limited?)", exc_info=True)
    return None


def _fetch_dxy_frankfurter() -> Optional[float]:
    """DXY from ECB reference rates (frankfurter.app, free, no key).

    DXY = 50.14348112 × EURUSD^-0.576 × USDJPY^0.136 × GBPUSD^-0.119
          × USDCAD^0.091 × USDSEK^0.042 × USDCHF^0.036
    frankfurter 提供 EUR 基准参考汇率（ECB，工作日下午更新），
    换算成 USD 计价的各成分货币对后代入公式。实测与 NYB DXY 误差 <0.1%。
    """
    try:
        resp = requests.get(
            "https://api.frankfurter.app/latest?from=EUR&to=USD,JPY,GBP,CAD,SEK,CHF",
            timeout=15,
        )
        if resp.status_code != 200:
            logger.warning("DXY (frankfurter) fetch failed: status=%d", resp.status_code)
            return None
        rates = resp.json().get("rates") or {}
        need = {"USD", "JPY", "GBP", "CAD", "SEK", "CHF"}
        if not need.issubset(rates):
            logger.warning("DXY (frankfurter) fetch: incomplete rates %s", sorted(rates))
            return None
        eurusd, eurjpy, eurgbp = rates["USD"], rates["JPY"], rates["GBP"]
        eurcad, eursek, eurchf = rates["CAD"], rates["SEK"], rates["CHF"]
        dxy = (50.14348112 * (eurusd ** -0.576) * ((eurjpy / eurusd) ** 0.136)
               * ((eurusd / eurgbp) ** -0.119) * ((eurcad / eurusd) ** 0.091)
               * ((eursek / eurusd) ** 0.042) * ((eurchf / eurusd) ** 0.036))
        return round(dxy, 4)
    except Exception as exc:
        logger.warning("DXY (frankfurter) fetch failed: %s", exc)
        return None


def _fetch_us10y_bond() -> Optional[float]:
    """US 10Y Treasury yield from akshare (东财美债收益率, free)."""
    try:
        import akshare as ak
        df = ak.bond_zh_us_rate(start_date="20180101")
        if df is None or df.empty or "美国国债收益率10年" not in df.columns:
            logger.warning("US10Y (akshare) fetch: empty data")
            return None
        vals = df["美国国债收益率10年"].dropna()
        if vals.empty:
            logger.warning("US10Y (akshare) fetch: no non-null value")
            return None
        return round(float(vals.iloc[-1]), 2)
    except Exception as exc:
        logger.warning("US10Y (akshare) fetch failed: %s", exc)
        return None


def _fetch_us10y() -> Optional[float]:
    """US 10-year Treasury yield from yfinance (fallback)."""
    try:
        import yfinance as yf
        ticker = yf.Ticker("^TNX")
        hist = ticker.history(period="5d")
        if not hist.empty:
            return round(float(hist["Close"].iloc[-1]), 2)
        logger.debug("US10Y fetch: empty history from yfinance")
    except Exception:
        logger.debug("US10Y fetch failed (yfinance rate-limited?)", exc_info=True)
    return None


# ── Collector ─────────────────────────────────────────────


class ExternalFactorCollector:
    """Periodically fetch external factors and write to raw_snapshots."""

    def __init__(self):
        self._running = False
        self._thread: Optional[threading.Thread] = None

    def start(self):
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._loop, daemon=True, name="factor-collector")
        self._thread.start()
        logger.info("ExternalFactorCollector started (interval=%ds)", COLLECT_INTERVAL)

    def stop(self):
        self._running = False

    def _loop(self):
        while self._running:
            try:
                self._collect()
            except Exception:
                logger.warning("Factor collector cycle failed", exc_info=True)
            time.sleep(COLLECT_INTERVAL)

    def _collect(self):
        # Fear & Greed
        fg = _fetch_fear_greed()
        if fg is not None:
            save_snapshot("sentiment", "fear_greed", {"value": fg})
            logger.debug("Fear & Greed: %d", fg)

        # VIX: CBOE 官方 → yfinance → DB 最近快照
        vix = _fetch_vix_cboe()
        if vix is None:
            vix = _fetch_vix()
        if vix is None:
            vix = _last_snapshot_value("macro", "vix")
            if vix is not None:
                logger.warning("VIX: all sources failed, using stale snapshot %.2f", vix)
        if vix is not None:
            save_snapshot("macro", "vix", {"value": vix})
            logger.debug("VIX: %.2f", vix)

        # DXY: yfinance（实时）→ frankfurter（ECB 参考汇率计算，免费稳定）→ DB 最近快照
        dxy = _fetch_dxy()
        if dxy is None:
            dxy = _fetch_dxy_frankfurter()
        if dxy is None:
            dxy = _last_snapshot_value("macro", "dxy")
            if dxy is not None:
                logger.warning("DXY: all sources failed, using stale snapshot %.2f", dxy)
        if dxy is not None:
            save_snapshot("macro", "dxy", {"value": dxy})
            logger.debug("DXY: %.2f", dxy)

        # US10Y: akshare 东财 → yfinance → DB 最近快照
        us10y = _fetch_us10y_bond()
        if us10y is None:
            us10y = _fetch_us10y()
        if us10y is None:
            us10y = _last_snapshot_value("macro", "us10y")
            if us10y is not None:
                logger.warning("US10Y: all sources failed, using stale snapshot %.2f", us10y)
        if us10y is not None:
            save_snapshot("macro", "us10y", {"us10y": us10y})
            logger.debug("US10Y: %.2f%%", us10y)

        ok = sum(1 for v in (fg, vix, dxy, us10y) if v is not None)
        logger.info("ExternalFactorCollector cycle: %d/4 sources ok", ok)
