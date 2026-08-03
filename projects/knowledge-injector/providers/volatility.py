"""波动率指标数据源。

VXN（科技股波动）、GVZ（黄金波动）、Put/Call Ratio（看跌/看涨比）。
通过 yfinance 获取，与 VIX 类似。
失败返回 None。
"""
from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)


def fetch_vxn() -> dict[str, Any] | None:
    """Fetch NASDAQ Volatility Index (VXN)."""
    try:
        from providers._yf_helpers import safe_history

        hist = safe_history("^VXN", period="5d")
        if hist is not None and len(hist) >= 1:
            current = float(hist["Close"].iloc[-1])
            level: str = (
                "very_high" if current >= 35 else
                "high" if current >= 28 else
                "moderate" if current >= 22 else
                "low" if current >= 15 else
                "very_low"
            )
            return {"value": round(current, 2), "level": level}
    except Exception:
        logger.debug("VXN fetch failed", exc_info=True)
    return None


def fetch_gvz() -> dict[str, Any] | None:
    """Fetch Gold Volatility Index (GVZ)."""
    try:
        from providers._yf_helpers import safe_history

        hist = safe_history("^GVZ", period="5d")
        if hist is not None and len(hist) >= 1:
            current = float(hist["Close"].iloc[-1])
            level: str = (
                "very_high" if current >= 25 else
                "high" if current >= 20 else
                "moderate" if current >= 16 else
                "low" if current >= 12 else
                "very_low"
            )
            return {"value": round(current, 2), "level": level}
    except Exception:
        logger.debug("GVZ fetch failed", exc_info=True)
    return None


def fetch_put_call_ratio() -> dict[str, Any] | None:
    """Calculate Put/Call Ratio proxy using VIX term structure (VIX vs VIX3M)."""
    try:
        from providers._yf_helpers import safe_history

        vix_hist = safe_history("^VIX", period="5d")
        vix3m_hist = safe_history("^VIX3M", period="5d")

        if vix_hist is None or vix3m_hist is None or len(vix_hist) < 1 or len(vix3m_hist) < 1:
            return None

        vix_val = float(vix_hist["Close"].iloc[-1])
        vix3m_val = float(vix3m_hist["Close"].iloc[-1])
        ratio = vix_val / vix3m_val if vix3m_val > 0 else 1.0

        term: str = (
            "backwardation" if ratio > 1.0 else
            "contango"
        )
        signal: str = (
            "bearish" if ratio > 1.15 else
            "neutral" if ratio > 0.9 else
            "bullish"
        )
        return {
            "value": round(ratio, 3),
            "vix": round(vix_val, 2),
            "vix3m": round(vix3m_val, 2),
            "term_structure": term,
            "signal": signal,
        }
    except Exception:
        logger.debug("Put/Call ratio fetch failed", exc_info=True)
    return None
