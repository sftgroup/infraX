"""Stock index data fetcher.

Sources (tiered):
  1. Finnhub ETF quote API — all major indices via country ETFs (free tier, 60 req/min).
  2. yfinance Yahoo Finance — legacy fallback if Finnhub fails.
  3. Fallback db_cache qd_market_cache — if both sources return zero.
"""
from __future__ import annotations

import json
import math
from typing import Any, Dict, List, Optional
from urllib.request import urlopen, Request
from urllib.error import HTTPError, URLError

from app.utils.logger import get_logger

logger = get_logger(__name__)

# ── Index registry ────────────────────────────────────────────
# All indices use a Finnhub ETF proxy (free tier) as primary source.
# The ETF proxies track the same economy/region as the official index.

INDICES = [
    {"symbol": "^GSPC", "etf": "SPY",  "name_cn": "标普500", "name_en": "S&P 500",       "region": "US", "flag": "\U0001f1fa\U0001f1f8", "lat": 40.7, "lng": -74.0},
    {"symbol": "^DJI",  "etf": "DIA",  "name_cn": "道琼斯",  "name_en": "Dow Jones",     "region": "US", "flag": "\U0001f1fa\U0001f1f8", "lat": 38.5, "lng": -77.0},
    {"symbol": "^IXIC", "etf": "QQQ",  "name_cn": "纳斯达克", "name_en": "NASDAQ",        "region": "US", "flag": "\U0001f1fa\U0001f1f8", "lat": 37.5, "lng": -122.4},
    {"symbol": "^GDAXI","etf": "EWG",  "name_cn": "德国DAX",   "name_en": "DAX",          "region": "EU", "flag": "\U0001f1e9\U0001f1ea", "lat": 50.1109, "lng": 8.6821},
    {"symbol": "^FTSE", "etf": "EWU",  "name_cn": "英国富时100","name_en": "FTSE 100",     "region": "EU", "flag": "\U0001f1ec\U0001f1e7", "lat": 51.5074, "lng": -0.1278},
    {"symbol": "^FCHI", "etf": "EWQ",  "name_cn": "法国CAC40",  "name_en": "CAC 40",      "region": "EU", "flag": "\U0001f1eb\U0001f1f7", "lat": 48.8566, "lng": 2.3522},
    {"symbol": "^N225", "etf": "EWJ",  "name_cn": "日经225",   "name_en": "Nikkei 225",   "region": "JP", "flag": "\U0001f1ef\U0001f1f5", "lat": 35.6762, "lng": 139.6503},
    {"symbol": "^KS11", "etf": "EWY",  "name_cn": "韩国KOSPI",  "name_en": "KOSPI",        "region": "KR", "flag": "\U0001f1f0\U0001f1f7", "lat": 37.5665, "lng": 126.9780},
    {"symbol": "^AXJO", "etf": "EWA",  "name_cn": "澳洲ASX200", "name_en": "ASX 200",      "region": "AU", "flag": "\U0001f1e6\U0001f1fa", "lat": -33.8688, "lng": 151.2093},
    {"symbol": "^BSESN","etf": "INDA", "name_cn": "印度SENSEX", "name_en": "SENSEX",       "region": "IN", "flag": "\U0001f1ee\U0001f1f3", "lat": 19.0760, "lng": 72.8777},
]


def _safe_round(v, n=2):
    f = float(v)
    return 0 if math.isnan(f) or math.isinf(f) else round(f, n)


def _finnhub_quote(symbol: str) -> Optional[Dict[str, Any]]:
    """Fetch a single quote from Finnhub free tier."""
    try:
        from app.config.api_keys import APIKeys
        key = APIKeys.FINNHUB_API_KEY
        if not key:
            return None
        url = "https://finnhub.io/api/v1/quote?symbol=%s&token=%s" % (symbol, key)
        req = Request(url, headers={"User-Agent": "AItrader/1.0"})
        resp = urlopen(req, timeout=10)
        data = json.loads(resp.read())
        if "c" in data and data["c"] is not None:
            return data
    except Exception as e:
        logger.debug("Finnhub quote %s failed: %s", symbol, e)
    return None


def _make_result(idx: dict, price: float, change: float) -> dict:
    return {
        "symbol": idx["symbol"],
        "name_cn": idx["name_cn"],
        "name_en": idx["name_en"],
        "price": _safe_round(price),
        "change": _safe_round(change),
        "region": idx["region"],
        "flag": idx["flag"],
        "lat": idx["lat"],
        "lng": idx["lng"],
        "category": "index",
    }


def fetch_stock_indices() -> List[Dict[str, Any]]:
    """Fetch major stock indices — Finnhub ETF proxies for all."""
    import time as _t
    result = []
    yf_fallback_count = 0

    for idx in INDICES:
        etf = idx.get("etf")
        price = 0
        change = 0

        # Primary: Finnhub ETF proxy (skip if no API key configured)
        if etf:
            try:
                q = _finnhub_quote(etf)
                if q:
                    price = q.get("c", 0) or 0
                    change = q.get("dp", 0) or 0
                    result.append(_make_result(idx, price, change))
                    continue
            except Exception:
                pass

        # Fallback: yfinance — add stagger between calls to avoid 429
        if yf_fallback_count > 0:
            _t.sleep(0.5)  # stagger yfinance requests for free-tier rate limits
        yf_fallback_count += 1
        try:
            import yfinance as yf
            ticker = yf.Ticker(idx["symbol"])
            hist = ticker.history(period="5d")
            closes = hist["Close"].dropna() if len(hist) > 0 else []
            if len(closes) >= 2:
                price = float(closes.iloc[-1])
                prev_close = float(closes.iloc[-2])
                change = ((price - prev_close) / prev_close) * 100 if prev_close else 0
            elif len(closes) == 1:
                price = float(closes.iloc[-1])
        except Exception as e:
            logger.debug("yfinance %s failed: %s", idx["symbol"], e)

        result.append(_make_result(idx, price, change))

    logger.info("Indices fetched: %d items, non-zero: %d",
                len(result), sum(1 for r in result if r["price"] > 0))
    return result
