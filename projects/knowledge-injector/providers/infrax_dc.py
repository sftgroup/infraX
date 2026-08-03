"""InfraX DC 链上 raw 事件拉取。

数据源：DC `/api/v2/data/events`（返回原始链上事件字段）。
配置：DC_URL + DC_API_KEY（空 = 禁用该 provider）。
"""
from __future__ import annotations

import logging

import requests

from config import SETTINGS

logger = logging.getLogger(__name__)

_TIMEOUT = 15


def _events_endpoint() -> str | None:
    base = SETTINGS.dc_url.rstrip("/")
    return f"{base}/api/v2/data/events" if base else None


def fetch_dc_events(
    limit: int = 200,
    chain: str | None = None,
    event_type: str | None = None,
    since_id: int | None = None,
) -> list[dict]:
    """拉取 DC 原始链上事件。

    Args:
        limit:      最大条数
        chain:      按链过滤（如 SOL/ETH/BTC）
        event_type: 按事件类型过滤（如 transfer/swap）
        since_id:   增量游标（大于该 event_id）

    返回 raw event dict 列表；失败返回空列表。
    """
    endpoint = _events_endpoint()
    if not endpoint:
        logger.debug("infrax_dc disabled — DC_URL not set")
        return []

    params: dict = {"limit": min(limit, 500)}
    if chain:
        params["chain"] = chain
    if event_type:
        params["event_type"] = event_type
    if since_id:
        params["since_id"] = since_id

    headers = {}
    if SETTINGS.dc_api_key:
        headers["X-API-Key"] = SETTINGS.dc_api_key

    try:
        resp = requests.get(endpoint, params=params, headers=headers, timeout=_TIMEOUT)
        resp.raise_for_status()
        body = resp.json()
    except requests.HTTPError:
        logger.warning("infrax_dc fetch failed status=%d endpoint=%s params=%s", resp.status_code, endpoint, params)
        return []
    except Exception as exc:
        logger.warning("infrax_dc fetch failed endpoint=%s: %s", endpoint, exc)
        return []

    # 兼容多种响应形态：{data: [...]} / {data: {events: [...]}} / {events: [...]}
    data = body.get("data", body)
    if isinstance(data, list):
        events = data
    elif isinstance(data, dict):
        events = next((data[k] for k in ("events", "items", "results") if isinstance(data.get(k), list)), [])
    else:
        events = []
    logger.debug("infrax_dc fetched %d event(s) from %s", len(events), endpoint)
    return events
