"""
Finnhub stock data provider (primary US stock data source).
Free tier: 60 requests/minute.
"""

import json
import logging
from typing import Dict, List, Optional, Any
from urllib.request import urlopen, Request
from urllib.error import HTTPError, URLError

logger = logging.getLogger(__name__)

FINNHUB_BASE = "https://finnhub.io/api/v1"
_FINNHUB_API_KEY: Optional[str] = None


def _get_api_key() -> str:
    global _FINNHUB_API_KEY
    if _FINNHUB_API_KEY is None:
        # Delayed import to avoid circular dependency at module level
        from app.config import APIKeys
        _FINNHUB_API_KEY = APIKeys.rotate("FINNHUB_API_KEY") or ""
    return _FINNHUB_API_KEY


def _finnhub_get(path: str, params: Optional[Dict[str, str]] = None) -> Optional[Dict[str, Any]]:
    """Make a GET request to the Finnhub API. Returns parsed JSON or None."""
    key = _get_api_key()
    if not key:
        return None

    qs = f"token={key}"
    if params:
        qs += "&" + "&".join(f"{k}={v}" for k, v in params.items())
    url = f"{FINNHUB_BASE}/{path}?{qs}"

    try:
        req = Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode())
            # Finnhub returns error as {"error": "..."} with 200 status
            if isinstance(data, dict) and "error" in data:
                logger.warning("Finnhub API error for %s: %s", path, data["error"])
                return None
            return data
    except HTTPError as e:
        body = e.read().decode()[:200]
        logger.warning("Finnhub HTTP %s for %s: %s", e.code, path, body)
        return None
    except (URLError, OSError, json.JSONDecodeError) as e:
        logger.debug("Finnhub request failed for %s: %s", path, e)
        return None


def fetch_quote(symbol: str) -> Optional[Dict[str, Any]]:
    """Fetch real-time quote for a single stock symbol.

    Returns dict with keys: last, changePercent, high, low, open, previousClose
    or None on failure.
    """
    data = _finnhub_get("quote", {"symbol": symbol})
    if not data:
        return None

    c = data.get("c")
    if c is None or float(c) <= 0:
        return None

    return {
        "last": float(c),
        "changePercent": float(data.get("dp", 0)),
        "change": float(data.get("d", 0)),
        "high": float(data.get("h", 0)),
        "low": float(data.get("l", 0)),
        "open": float(data.get("o", 0)),
        "previousClose": float(data.get("pc", 0)),
        "timestamp": data.get("t", 0),
    }


def fetch_batch_quotes(symbols: List[str]) -> Dict[str, Optional[Dict[str, Any]]]:
    """Fetch quotes for multiple symbols. Returns dict of symbol -> quote."""
    results = {}
    for sym in symbols:
        results[sym] = fetch_quote(sym)
    return results
