"""InfraX Collector 市场信号拉取。

数据源：Collector `/market/*`（signals / hot-tokens / price）。
配置：COLLECTOR_URL + COLLECTOR_API_KEY（空 = 禁用该 provider）。
"""
from __future__ import annotations

import logging

import requests

from config import SETTINGS

logger = logging.getLogger(__name__)

_TIMEOUT = 15


def _base() -> str:
    return SETTINGS.collector_url.rstrip("/")


def _headers() -> dict:
    h = {}
    if SETTINGS.collector_api_key:
        h["Authorization"] = f"Bearer {SETTINGS.collector_api_key}"
    return h


def _get(path: str, params: dict | None = None) -> list[dict]:
    base = _base()
    if not base:
        logger.debug("infrax_collector disabled — COLLECTOR_URL not set")
        return []
    try:
        resp = requests.get(f"{base}{path}", params=params, headers=_headers(), timeout=_TIMEOUT)
        resp.raise_for_status()
        body = resp.json()
    except requests.HTTPError:
        logger.warning("infrax_collector fetch failed status=%d path=%s", resp.status_code, path)
        return []
    except Exception as exc:
        logger.warning("infrax_collector fetch failed path=%s: %s", path, exc)
        return []

    # 兼容多种响应形态
    data = body.get("data", body)
    if isinstance(data, list):
        items = data
    elif isinstance(data, dict):
        items = next((data[k] for k in ("signals", "items", "results", "tokens") if isinstance(data.get(k), list)), [])
    else:
        items = []
    logger.debug("infrax_collector fetched %d item(s) from %s", len(items), path)
    return items


def fetch_market_signals(limit: int = 50) -> list[dict]:
    """拉取 Collector 市场信号，并附加 data_type=signals。"""
    items = _get("/market/signals", {"limit": min(limit, 200)})
    for it in items:
        it.setdefault("data_type", "signals")
    return items


def fetch_hot_tokens(limit: int = 20) -> list[dict]:
    """拉取 Collector 热门代币，并附加 data_type=hot_tokens。"""
    items = _get("/market/hot-tokens", {"limit": min(limit, 100)})
    for it in items:
        it.setdefault("data_type", "hot_tokens")
    return items
