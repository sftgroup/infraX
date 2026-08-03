"""情绪 / 宏观经济数据源。

从现有项目（python-backend/app/data_providers/sentiment.py）提取，
去除对 app.config / app.data_sources 的内部依赖。

每个函数：独立 HTTP 调用，fail-silent，失败返回 None。
"""
from __future__ import annotations

import logging
from typing import Any

import requests

logger = logging.getLogger(__name__)

# ─── Fear & Greed ──────────────────────────────────


def fetch_fear_greed_index() -> dict[str, Any] | None:
    """Fetch Fear & Greed Index from alternative.me."""
    try:
        resp = requests.get(
            "https://api.alternative.me/fng/?limit=1",
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
        if data.get("data"):
            item = data["data"][0]
            return {
                "value": int(item.get("value", 50)),
                "classification": item.get("value_classification", "Neutral"),
                "timestamp": int(item.get("timestamp", 0)),
            }
    except Exception:
        logger.debug("Fear & Greed fetch failed", exc_info=True)
    return None


# ─── VIX ──────────────────────────────────────────


def fetch_vix() -> dict[str, Any] | None:
    """Fetch VIX from yfinance."""
    try:
        from providers._yf_helpers import safe_history

        hist = safe_history("^VIX", period="5d")
        if hist is not None and len(hist) >= 1:
            current = float(hist["Close"].iloc[-1])
            if current > 0 and len(hist) >= 2:
                prev = float(hist["Close"].iloc[-2])
            else:
                prev = current
            return {"value": round(current, 2), "change": round(((current - prev) / (prev or 1)) * 100, 2)}
    except Exception:
        logger.debug("VIX fetch failed", exc_info=True)
    return None


# ─── DXY ──────────────────────────────────────────


def fetch_dollar_index() -> dict[str, Any] | None:
    """Fetch US Dollar Index from yfinance."""
    try:
        from providers._yf_helpers import safe_history

        hist = safe_history("DX-Y.NYB", period="5d")
        if hist is not None and len(hist) >= 1:
            current = float(hist["Close"].iloc[-1])
            if len(hist) >= 2:
                prev = float(hist["Close"].iloc[-2])
            else:
                prev = current
            return {"value": round(current, 2), "change": round(((current - prev) / (prev or 1)) * 100, 2)}
    except Exception:
        logger.debug("DXY fetch failed", exc_info=True)
    return None


# ─── US10Y ────────────────────────────────────────


def fetch_yield_curve() -> dict[str, Any] | None:
    """Fetch US10Y from yfinance."""
    try:
        from providers._yf_helpers import safe_history

        hist = safe_history("^TNX", period="5d")
        if hist is not None and len(hist) >= 1:
            us10y = float(hist["Close"].iloc[-1])
            return {"us10y": round(us10y, 2)}
    except Exception:
        logger.debug("US10Y fetch failed", exc_info=True)
    return None


# ─── Crypto Prices ────────────────────────────────


_CRYPTO_COINGECKO_IDS = [
    "bitcoin", "ethereum", "binancecoin", "solana", "ripple",
]


def fetch_crypto_prices() -> list[dict[str, Any]] | None:
    """Fetch top crypto prices from CoinGecko."""
    try:
        ids = ",".join(_CRYPTO_COINGECKO_IDS)
        resp = requests.get(
            f"https://api.coingecko.com/api/v3/simple/price",
            params={
                "ids": ids,
                "vs_currencies": "usd",
                "include_24hr_change": "true",
            },
            timeout=15,
            headers={"Accept": "application/json"},
        )
        resp.raise_for_status()
        data = resp.json()
        result = []
        for cg_id in _CRYPTO_COINGECKO_IDS:
            item = data.get(cg_id, {})
            result.append({
                "symbol": cg_id.upper(),
                "price": item.get("usd", 0),
                "change24h": item.get("usd_24h_change", 0),
            })
        logger.info("Fetched %d crypto prices from CoinGecko", len(result))
        return result
    except Exception:
        logger.debug("Crypto price fetch failed", exc_info=True)
    return None


# ─── Crypto K-line (for technical analysis) ────────

_CRYPTO_YF_SYMBOLS = [
    ("BTC", "BTC-USD"),
    ("ETH", "ETH-USD"),
    ("SOL", "SOL-USD"),
]


def fetch_crypto_klines(
    symbols: list[str] | None = None,
    period: str = "90d",
) -> dict[str, dict[str, Any]]:
    """获取加密币历史 K 线，供技术分析增强注入。

    优先使用 CoinGecko（免费无限制），失败回退 yfinance。

    返回 {symbol: {"close": [...], "current": float, "change_pct": float, "volume": float}}
    """
    target = symbols or ["BTC", "ETH", "SOL"]
    result: dict[str, dict[str, Any]] = {}

    # 1) 尝试 CoinGecko
    result = _fetch_klines_coingecko(target)
    if result:
        logger.info("Fetched klines (CoinGecko) for %d symbols", len(result))
        return result

    # 2) 回退 yfinance
    result = _fetch_klines_yfinance(target, period)
    if result:
        logger.info("Fetched klines (yfinance) for %d symbols", len(result))
    return result


def _fetch_klines_coingecko(
    symbols: list[str],
) -> dict[str, dict[str, Any]]:
    """通过 CoinGecko 免费 API 获取历史价格。"""
    cg_id_map = {"BTC": "bitcoin", "ETH": "ethereum", "SOL": "solana"}
    result: dict[str, dict[str, Any]] = {}

    for sym in symbols:
        cg_id = cg_id_map.get(sym)
        if not cg_id:
            continue
        try:
            resp = requests.get(
                f"https://api.coingecko.com/api/v3/coins/{cg_id}/market_chart",
                params={"vs_currency": "usd", "days": "90"},
                timeout=20,
                headers={"Accept": "application/json"},
            )
            if resp.status_code != 200:
                continue
            data = resp.json()
            prices = data.get("prices", [])
            volumes = data.get("total_volumes", [])
            if len(prices) < 30:
                continue
            close_series = [float(p[1]) for p in prices if p[1] is not None and float(p[1]) > 0]
            if len(close_series) < 30:
                continue
            current = close_series[-1]
            prev = close_series[-2] if len(close_series) >= 2 else current
            change_pct = ((current - prev) / prev) * 100
            vol = float(volumes[-1][1]) if volumes and len(volumes) > 0 else 0.0
            result[sym] = {
                "close": close_series,
                "current": current,
                "change_pct": round(change_pct, 2),
                "volume": vol,
            }
        except Exception:
            logger.debug("CoinGecko kline fetch failed for %s", sym, exc_info=True)

    return result


def _fetch_klines_yfinance(
    symbols: list[str],
    period: str = "90d",
) -> dict[str, dict[str, Any]]:
    """通过 yfinance 获取历史 K 线（回退方案）。"""
    from providers._yf_helpers import safe_history

    ticker_map = dict(_CRYPTO_YF_SYMBOLS)
    result: dict[str, dict[str, Any]] = {}

    for sym in symbols:
        ticker = ticker_map.get(sym)
        if not ticker:
            continue
        try:
            hist = safe_history(ticker, period=period)
            if hist is None or len(hist) < 30:
                continue
            close_series = [float(v) for v in hist["Close"].tolist() if v is not None and float(v) > 0]
            if len(close_series) < 30:
                continue
            current = close_series[-1]
            prev = close_series[-2] if len(close_series) >= 2 else current
            change_pct = ((current - prev) / prev) * 100
            result[sym] = {
                "close": close_series,
                "current": current,
                "change_pct": round(change_pct, 2),
                "volume": float(hist["Volume"].iloc[-1]) if "Volume" in hist.columns and len(hist) > 0 else 0.0,
            }
        except Exception:
            logger.debug("yfinance kline fetch failed for %s", sym, exc_info=True)

    return result
