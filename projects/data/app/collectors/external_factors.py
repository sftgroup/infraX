"""External factor collector — periodic fetch → raw_snapshots.

Fetches free public data sources (no API key required):
  - Fear & Greed Index (alternative.me)
  - VIX, DXY, US10Y (yfinance)

Design: fail-silent background thread, writes via factors.save_snapshot().
"""

from __future__ import annotations

import logging
import os
import threading
import time
from typing import Optional

import requests
import numpy as np

from app.factors import save_snapshot
from app.collectors.urls import ALTERNATIVE_ME_FNG_URL

logger = logging.getLogger(__name__)

# ── Config ─────────────────────────────────────────────────

COLLECT_INTERVAL = int(os.getenv("FACTOR_COLLECT_INTERVAL_SEC", "300"))  # 5 min


# ── Fetchers (fail-silent, return None on error) ──────────


def _fetch_fear_greed() -> Optional[int]:
    """Fear & Greed Index from alternative.me (free, no key)."""
    try:
        resp = requests.get(ALTERNATIVE_ME_FNG_URL, timeout=10)
        data = resp.json().get("data", [])
        if data:
            return int(data[0]["value"])
    except Exception:
        logger.debug("Fear & Greed fetch failed", exc_info=True)
    return None


def _fetch_vix() -> Optional[float]:
    """VIX from yfinance."""
    try:
        import yfinance as yf
        ticker = yf.Ticker("^VIX")
        hist = ticker.history(period="5d")
        if not hist.empty:
            return round(float(hist["Close"].iloc[-1]), 2)
    except Exception:
        logger.debug("VIX fetch failed", exc_info=True)
    return None


def _fetch_dxy() -> Optional[float]:
    """US Dollar Index from yfinance."""
    try:
        import yfinance as yf
        ticker = yf.Ticker("DX-Y.NYB")
        hist = ticker.history(period="5d")
        if not hist.empty:
            return round(float(hist["Close"].iloc[-1]), 2)
    except Exception:
        logger.debug("DXY fetch failed", exc_info=True)
    return None


def _fetch_us10y() -> Optional[float]:
    """US 10-year Treasury yield from yfinance."""
    try:
        import yfinance as yf
        ticker = yf.Ticker("^TNX")
        hist = ticker.history(period="5d")
        if not hist.empty:
            return round(float(hist["Close"].iloc[-1]), 2)
    except Exception:
        logger.debug("US10Y fetch failed", exc_info=True)
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

        # VIX
        vix = _fetch_vix()
        if vix is not None:
            save_snapshot("macro", "vix", {"value": vix})
            logger.debug("VIX: %.2f", vix)

        # DXY
        dxy = _fetch_dxy()
        if dxy is not None:
            save_snapshot("macro", "dxy", {"value": dxy})
            logger.debug("DXY: %.2f", dxy)

        # US10Y
        us10y = _fetch_us10y()
        if us10y is not None:
            save_snapshot("macro", "us10y", {"us10y": us10y})
            logger.debug("US10Y: %.2f%%", us10y)
