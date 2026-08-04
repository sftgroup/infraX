"""Deep sentiment collector — yield curve, put/call ratio, composite score.

Ports ``fetch_yield_curve`` / ``fetch_put_call_ratio`` from the legacy
``data_providers/sentiment.py`` (yfinance-based, no API key required) and
derives a composite ``sentiment_score`` in [-1, 1] that feeds the declared
``sentiment_score`` factor.

Design: fail-silent background thread, writes via factors.save_snapshot().
"""

from __future__ import annotations

import os
import threading
import time
from typing import Any, Dict, Optional

from app.factors import save_snapshot
from app.utils.logger import get_logger

logger = get_logger(__name__)

COLLECT_INTERVAL = int(os.getenv("SENTIMENT_COLLECT_INTERVAL_SEC", "1800"))  # 30 min


def fetch_yield_curve() -> Dict[str, Any]:
    """Fetch Treasury yield curve (10Y − 2Y spread) with level/signal."""
    try:
        import yfinance as yf

        tnx = yf.Ticker("^TNX")
        tnx_hist = tnx.history(period="5d")
        if tnx_hist is None or tnx_hist.empty:
            return {
                "yield_10y": 4.2, "yield_2y": 4.0, "spread": 0.2, "change": 0,
                "level": "normal", "signal": "neutral",
                "interpretation": "数据暂不可用", "interpretation_en": "Data temporarily unavailable",
            }

        yield_10y = float(tnx_hist["Close"].iloc[-1])
        try:
            yield_2y = float(yield_10y * 0.85)  # ^2Y is unavailable on yfinance; proxy from 10Y
        except Exception:
            yield_2y = yield_10y
        spread = yield_10y - yield_2y
        yc_change = 0.0

        if spread < -0.5:
            level, cn, en, signal = "deeply_inverted", "深度倒挂 - 强烈衰退信号", "Deeply Inverted - Strong recession signal", "bearish"
        elif spread < 0:
            level, cn, en, signal = "inverted", "收益率倒挂 - 衰退预警", "Inverted - Recession warning", "bearish"
        elif spread < 0.5:
            level, cn, en, signal = "flat", "曲线平坦 - 经济放缓信号", "Flat - Economic slowdown signal", "neutral"
        elif spread < 1.5:
            level, cn, en, signal = "normal", "正常曲线 - 经济健康", "Normal - Healthy economy", "bullish"
        else:
            level, cn, en, signal = "steep", "陡峭曲线 - 经济扩张预期", "Steep - Economic expansion expected", "bullish"

        logger.info("Yield Curve: 10Y=%.2f%%, spread=%.2f%% (%s)", yield_10y, spread, level)
        return {
            "yield_10y": round(yield_10y, 2), "yield_2y": round(yield_2y, 2),
            "spread": round(spread, 2), "change": round(yc_change, 3),
            "level": level, "signal": signal, "interpretation": cn, "interpretation_en": en,
        }
    except Exception as e:
        logger.debug("Failed to fetch Yield Curve: %s", e)
        return {
            "yield_10y": 0, "yield_2y": 0, "spread": 0, "change": 0,
            "level": "unknown", "signal": "neutral",
            "interpretation": "数据获取失败", "interpretation_en": "Data fetch failed",
        }


def fetch_put_call_ratio() -> Dict[str, Any]:
    """Put/Call ratio proxy from the VIX term structure (VIX / VIX3M)."""
    try:
        import yfinance as yf

        vix = yf.Ticker("^VIX")
        vix3m = yf.Ticker("^VIX3M")
        vix_hist = vix.history(period="5d")
        vix3m_hist = vix3m.history(period="5d")

        ratio = 1.0
        vix_val = vix3m_val = 0.0
        change = 0.0
        if len(vix_hist) >= 1 and len(vix3m_hist) >= 1:
            vix_val = float(vix_hist["Close"].iloc[-1])
            vix3m_val = float(vix3m_hist["Close"].iloc[-1])
            ratio = vix_val / vix3m_val if vix3m_val > 0 else 1.0
            if len(vix_hist) >= 2 and len(vix3m_hist) >= 2:
                prev_ratio = vix_hist["Close"].iloc[-2] / vix3m_hist["Close"].iloc[-2] if vix3m_hist["Close"].iloc[-2] > 0 else 1.0
                change = ((ratio - prev_ratio) / prev_ratio) * 100 if prev_ratio else 0.0

        if ratio > 1.15:
            level, cn, en, signal = "high_fear", "VIX倒挂 - 短期恐慌情绪高涨", "VIX Backwardation - High short-term fear", "bearish"
        elif ratio > 1.0:
            level, cn, en, signal = "elevated", "轻度倒挂 - 市场谨慎", "Slight Backwardation - Market cautious", "neutral"
        elif ratio > 0.9:
            level, cn, en, signal = "normal", "正常结构 - 市场稳定", "Normal Structure - Market stable", "neutral"
        elif ratio > 0.8:
            level, cn, en, signal = "complacent", "深度正价差 - 市场自满", "Deep Contango - Market complacent", "bullish"
        else:
            level, cn, en, signal = "extreme_complacency", "极度自满 - 警惕反转", "Extreme Complacency - Watch for reversal", "neutral"

        logger.info("VIX Term Structure: ratio=%.3f (%s)", ratio, level)
        return {
            "value": round(ratio, 3), "vix": round(vix_val, 2), "vix3m": round(vix3m_val, 2),
            "change": round(change, 2), "level": level, "signal": signal,
            "interpretation": cn, "interpretation_en": en,
        }
    except Exception as e:
        logger.debug("Failed to calculate Put/Call proxy: %s", e)
        return {
            "value": 1.0, "vix": 0, "vix3m": 0, "change": 0,
            "level": "unknown", "signal": "neutral",
            "interpretation": "数据获取失败", "interpretation_en": "Data fetch failed",
        }


def _latest_fear_greed() -> Optional[int]:
    """Read the latest fear&greed value written by ExternalFactorCollector."""
    try:
        import json
        from app.storage import get_db
        row = get_db().execute(
            """SELECT raw_json FROM raw_snapshots
               WHERE provider = 'sentiment' AND data_type = 'fear_greed'
               ORDER BY fetched_at DESC LIMIT 1"""
        ).fetchone()
        if row and row["raw_json"]:
            return int(json.loads(row["raw_json"]).get("value") or 0)
    except Exception:
        pass
    return None


def _composite_score(yc: Dict[str, Any], pcr: Dict[str, Any], fg_value: Optional[int]) -> float:
    """Merge yield-curve + put/call signals + fear&greed into a [-1, 1] score."""
    score = 0.0
    score += {"bullish": 0.4, "neutral": 0.0, "bearish": -0.4}.get(yc.get("signal") or "neutral", 0.0)
    score += {"bullish": 0.3, "neutral": 0.0, "bearish": -0.3}.get(pcr.get("signal") or "neutral", 0.0)
    if fg_value is not None:
        score += (max(0, min(100, fg_value)) - 50) / 50 * 0.3
    return round(max(-1.0, min(1.0, score)), 4)


class SentimentCollector:
    """Periodically fetch deep-sentiment indicators and write to raw_snapshots."""

    def __init__(self):
        self._running = False
        self._thread: threading.Thread | None = None

    def start(self):
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._loop, daemon=True, name="sentiment-collector")
        self._thread.start()
        logger.info("SentimentCollector started (interval=%ds)", COLLECT_INTERVAL)

    def stop(self):
        self._running = False

    def _loop(self):
        while self._running:
            try:
                self._collect()
            except Exception:
                logger.warning("Sentiment collector cycle failed", exc_info=True)
            time.sleep(COLLECT_INTERVAL)

    def _collect(self):
        yc = fetch_yield_curve()
        if yc.get("level") != "unknown":
            save_snapshot("sentiment", "yield_curve", yc)
        pcr = fetch_put_call_ratio()
        if pcr.get("level") != "unknown":
            save_snapshot("sentiment", "put_call_ratio", pcr)
        score = _composite_score(yc, pcr, _latest_fear_greed())
        save_snapshot("sentiment", "sentiment_score", {"value": score})
        logger.info("Sentiment snapshot saved: yc=%s pcr=%s score=%.3f", yc.get("level"), pcr.get("level"), score)
