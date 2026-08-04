"""data-service 联动客户端 — 拉取聚合因子（sentiment_score 等）。

只读、fail-silent：未配置 DATA_SERVICE_URL 或请求失败时返回 None，
不抛异常，不影响注入器主循环。

data-service 暴露的端点（见 data-service/main.py）：
    GET /snapshots?type=<data_type>  → {"ts": ..., "snapshots": {<data_type>: raw_json}}
    GET /factors/current?category=sentiment → {"ts": ..., "factors": {"BTC": {..., "sentiment_score": <float>}}}

sentiment_score 由 data-service SentimentCollector 写入 raw_snapshots
（provider="sentiment", data_type="sentiment_score", payload={"value": score}，
score ∈ [-1, 1]）。
"""
from __future__ import annotations

import logging
from typing import Any

import requests

from config import SETTINGS

logger = logging.getLogger(__name__)

_TIMEOUT = 8


def fetch_sentiment_score() -> dict[str, Any] | None:
    """拉取 data-service 最新 sentiment_score（[-1, 1]）。

    返回:
        {"value": float, "ts": int} 或 None（未配置/失败/无数据）。
    """
    base_url = (SETTINGS.data_service_url or "").strip().rstrip("/")
    if not base_url:
        return None
    try:
        # data-service 业务端点鉴权（DATA_API_KEY）：用本服务同一把 bridge key
        key = SETTINGS.injector_api_key or SETTINGS.ragservicer_api_key
        headers = {"X-API-Key": key} if key else {}
        resp = requests.get(
            f"{base_url}/snapshots",
            params={"type": "sentiment_score"},
            headers=headers,
            timeout=_TIMEOUT,
        )
        if resp.status_code != 200:
            logger.debug("data-service /snapshots → %s", resp.status_code)
            return None
        data = resp.json()
        raw = (data.get("snapshots") or {}).get("sentiment_score")
        # data-service /snapshots 会解包单键 envelope：{"value": -0.45} → -0.45
        if isinstance(raw, dict):
            score = raw.get("value")
        else:
            score = raw
        if not isinstance(score, (int, float)):
            return None
        return {"value": float(score), "ts": data.get("ts", 0)}
    except requests.Timeout:
        logger.debug("data-service sentiment_score timeout (%ss)", _TIMEOUT)
        return None
    except requests.RequestException as exc:
        logger.debug("data-service sentiment_score request failed: %s", exc)
        return None
    except Exception as exc:  # JSON 解析等
        logger.debug("data-service sentiment_score parse failed: %s", exc)
        return None
