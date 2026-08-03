"""
Free CNBC stock quote scraper — no API key required.

CNBC quote pages are simple HTML with consistently-named CSS classes
that make parsing reliable without a full DOM parser.  Accessible from
most global IPs (unlike Yahoo Finance which rate-limits aggressively).

Rate: ~1 req per symbol.  Keep it low — 0.5 s stagger between symbols.
"""
from __future__ import annotations

import re
import requests
from typing import Any, Dict, Optional

from app.utils.logger import get_logger

logger = get_logger(__name__)

_QUOTE_RE = re.compile(
    r'class="QuoteStrip-(lastPrice|change|changePct|name|symbolAndExchange|volume|lastTradeTime|fiftyTwoWeekRange)"[^>]*>([^<]+)'
)


def fetch_cnbc_quote(symbol: str) -> Optional[Dict[str, Any]]:
    """Fetch a US stock quote from CNBC.com.

    CNBC server-renders two ``QuoteStrip-lastPrice`` values:
      - 1st: after-hours / most-recent price
      - 2nd: regular-market close
    We use the 1st as ``last`` and the 2nd as ``previousClose`` to
    compute ``change`` and ``changePercent``.

    Returns dict with keys: last, change, changePercent, name, volume,
    or None on failure.
    """
    sym = (symbol or "").strip().upper()
    if not sym:
        return None

    try:
        resp = requests.get(
            f"https://www.cnbc.com/quotes/{sym}",
            headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"},
            timeout=12,
        )
        if resp.status_code != 200:
            logger.debug("CNBC quote %s returned HTTP %s", sym, resp.status_code)
            return None

        prices: list[float] = []
        fields: Dict[str, str] = {}
        for m in _QUOTE_RE.finditer(resp.text):
            key = m.group(1)
            val = m.group(2).replace(",", "").replace("%", "").strip()
            if key == "lastPrice":
                prices.append(_safe_float(val))
            elif key not in fields:
                fields[key] = val

        if not prices:
            logger.debug("CNBC quote %s: no price found", sym)
            return None

        last = prices[0]  # most recent (after-hours if market closed)
        prev_close = prices[1] if len(prices) >= 2 else last  # regular close

        if last <= 0:
            return None

        change = last - prev_close
        change_pct = (change / prev_close * 100.0) if prev_close > 0 else 0.0

        return {
            "last": round(last, 2),
            "change": round(change, 2),
            "changePercent": round(change_pct, 2),
            "previousClose": round(prev_close, 2),
            "name": fields.get("name", sym),
            "volume": int(_safe_float(fields.get("volume", "0"))),
            "source": "cnbc",
        }
    except requests.exceptions.Timeout:
        logger.debug("CNBC quote %s timed out", sym)
        return None
    except Exception as e:
        logger.debug("CNBC quote %s failed: %s", sym, e)
        return None


def _safe_float(v: Any) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0
