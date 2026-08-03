"""全球主要股指数据源。

通过 yfinance 获取主要国家/地区的股指数据。
无需 API Key，免费。

用法:
    >>> indices = fetch_global_indices()
    >>> indices[0]["name"]
    "S&P 500"
    >>> indices[0]["change_pct"]
    0.45
"""
from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

# ─── 全球主要股指 ─────────────────────────────────────

_INDICES: list[dict[str, str]] = [
    # 美国
    {"region": "US", "name": "S&P 500",     "symbol": "^GSPC"},
    {"region": "US", "name": "NASDAQ",       "symbol": "^IXIC"},
    {"region": "US", "name": "Dow Jones",    "symbol": "^DJI"},
    # 日本
    {"region": "JP", "name": "Nikkei 225",   "symbol": "^N225"},
    # 欧洲
    {"region": "EU", "name": "Euro Stoxx 50","symbol": "^STOXX50E"},
    # 德国
    {"region": "DE", "name": "DAX",          "symbol": "^GDAXI"},
    # 英国
    {"region": "UK", "name": "FTSE 100",     "symbol": "^FTSE"},
    # 中国
    {"region": "CN", "name": "Shanghai Comp", "symbol": "000001.SS"},
    {"region": "HK", "name": "Hang Seng",    "symbol": "^HSI"},
]


def fetch_global_indices() -> list[dict[str, Any]]:
    """获取全球主要股指最新行情。

    返回 [{
        "region": "US",
        "name": "S&P 500",
        "price": 5500.25,
        "change_pct": 0.45,
        "change_abs": 24.5,
    }, ...]

    失败返回空列表（不阻塞）。
    """
    try:
        from providers._yf_helpers import safe_history
    except ImportError:
        logger.debug("yfinance helpers not available")
        return []

    results: list[dict[str, Any]] = []
    for idx in _INDICES:
        try:
            hist = safe_history(idx["symbol"], period="5d")
            if hist is None or len(hist) < 1:
                continue

            price = float(hist["Close"].iloc[-1])
            if len(hist) >= 2:
                prev_close = float(hist["Close"].iloc[-2])
                change_pct = ((price - prev_close) / prev_close) * 100
                change_abs = price - prev_close
            else:
                change_pct = 0.0
                change_abs = 0.0

            results.append({
                "region": idx["region"],
                "name": idx["name"],
                "symbol": idx["symbol"],
                "price": round(price, 2),
                "change_pct": round(change_pct, 2),
                "change_abs": round(change_abs, 2),
            })
        except Exception:
            logger.debug("Index %s fetch failed", idx["symbol"], exc_info=True)

    if results:
        logger.info("Fetched %d global indices", len(results))
    return results


def fetch_indices_by_region(region: str) -> list[dict[str, Any]]:
    """按区域过滤股指。"""
    all_indices = fetch_global_indices()
    return [i for i in all_indices if i.get("region") == region]
