"""data-service HTTP 客户端 — 拉取 K 线与符号清单（只读）。

ml-service 不直连 SQLite，统一走 data-service HTTP 端点：
    GET /bars?symbol=&timeframe=&limit=  → {"bars": [...]}
    GET /symbols?timeframe=&min_bars=    → {"symbols": [...]}

fail-silent：未配置 DATA_SERVICE_URL 或请求失败返回空/None，不抛异常。
"""
from __future__ import annotations

import logging

import requests

import config

logger = logging.getLogger(__name__)

_TIMEOUT = 15


def _base_url() -> str:
    return (config.DATA_SERVICE_URL or "").strip().rstrip("/")


def _headers() -> dict:
    return {"X-API-Key": config.DATA_API_KEY} if config.DATA_API_KEY else {}


def fetch_bars(symbol: str, timeframe: str = "1d", limit: int = 500) -> list[dict]:
    """拉取某 symbol 日线（升序），返回 [{ts, open, high, low, close, volume, ...指标}]。

    失败/无数据返回 []（fail-silent）。
    """
    base = _base_url()
    if not base:
        return []
    try:
        resp = requests.get(
            f"{base}/bars",
            params={"symbol": symbol, "timeframe": timeframe, "limit": limit},
            headers=_headers(),
            timeout=_TIMEOUT,
        )
        if resp.status_code != 200:
            logger.debug("data-service /bars %s → %s", symbol, resp.status_code)
            return []
        bars = (resp.json().get("bars") or [])
        if not bars:
            return []
        bars.sort(key=lambda b: b["ts"])
        return bars
    except requests.Timeout:
        logger.debug("data-service /bars %s timeout (%ss)", symbol, _TIMEOUT)
        return []
    except requests.RequestException as exc:
        logger.debug("data-service /bars %s request failed: %s", symbol, exc)
        return []
    except Exception as exc:
        logger.debug("data-service /bars %s parse failed: %s", symbol, exc)
        return []


def fetch_symbols(timeframe: str = "1d", min_bars: int = 120) -> list[str]:
    """拉取 data-service 中满足最少 bar 数的 symbol 列表（升序）。

    失败返回 []（fail-silent）。
    """
    base = _base_url()
    if not base:
        return []
    try:
        resp = requests.get(
            f"{base}/symbols",
            params={"timeframe": timeframe, "min_bars": min_bars},
            headers=_headers(),
            timeout=_TIMEOUT,
        )
        if resp.status_code != 200:
            logger.debug("data-service /symbols → %s", resp.status_code)
            return []
        symbols = (resp.json().get("symbols") or [])
        return [s for s in symbols if isinstance(s, str) and s]
    except requests.Timeout:
        logger.debug("data-service /symbols timeout (%ss)", _TIMEOUT)
        return []
    except requests.RequestException as exc:
        logger.debug("data-service /symbols request failed: %s", exc)
        return []
    except Exception as exc:
        logger.debug("data-service /symbols parse failed: %s", exc)
        return []
