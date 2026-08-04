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


def fetch_klines(symbol: str, timeframe: str = "1d", limit: int = 500) -> list[dict] | None:
    """拉取 data-service K 线（/bars），返回升序 [{ts, open, high, low, close, volume}, ...]。

    失败/无数据返回 None（fail-silent）。
    """
    base_url = (SETTINGS.data_service_url or "").strip().rstrip("/")
    if not base_url:
        return None
    try:
        key = SETTINGS.injector_api_key or SETTINGS.ragservicer_api_key
        headers = {"X-API-Key": key} if key else {}
        resp = requests.get(
            f"{base_url}/bars",
            params={"symbol": symbol, "timeframe": timeframe, "limit": limit},
            headers=headers,
            timeout=_TIMEOUT,
        )
        if resp.status_code != 200:
            logger.debug("data-service /bars %s → %s", symbol, resp.status_code)
            return None
        bars = (resp.json().get("bars") or [])
        bars = [b for b in bars if all(k in b for k in ("ts", "open", "high", "low", "close"))]
        if not bars:
            return None
        bars.sort(key=lambda b: b["ts"])
        return bars
    except requests.Timeout:
        logger.debug("data-service /bars %s timeout (%ss)", symbol, _TIMEOUT)
        return None
    except requests.RequestException as exc:
        logger.debug("data-service /bars %s request failed: %s", symbol, exc)
        return None
    except Exception as exc:
        logger.debug("data-service /bars %s parse failed: %s", symbol, exc)
        return None


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


def fetch_consensus() -> dict[str, Any] | None:
    """拉取 data-service 跨模型共识快照（/snapshots?type=consensus）。

    返回 {"generated_at", "signals", "n_symbols", "avg_consensus_score",
          "market_risk_flag", "n_divergence", "symbols"}，
    或 None（未配置/失败/无快照）。
    """
    base_url = (SETTINGS.data_service_url or "").strip().rstrip("/")
    if not base_url:
        return None
    try:
        key = SETTINGS.injector_api_key or SETTINGS.ragservicer_api_key
        headers = {"X-API-Key": key} if key else {}
        resp = requests.get(
            f"{base_url}/snapshots",
            params={"type": "consensus"},
            headers=headers,
            timeout=_TIMEOUT,
        )
        if resp.status_code != 200:
            logger.debug("data-service consensus → %s", resp.status_code)
            return None
        data = resp.json()
        payload = (data.get("snapshots") or {}).get("consensus")
        if not isinstance(payload, dict) or not (payload.get("symbols") or []):
            return None
        return payload
    except requests.Timeout:
        logger.debug("data-service consensus timeout (%ss)", _TIMEOUT)
        return None
    except requests.RequestException as exc:
        logger.debug("data-service consensus request failed: %s", exc)
        return None
    except Exception as exc:
        logger.debug("data-service consensus parse failed: %s", exc)
        return None


def fetch_tree_predictions() -> dict[str, Any] | None:
    """拉取 data-service LightGBM 方向预测快照（/snapshots?type=tree_predictions）。

    返回 {"generated_at", "model": {...}, "predictions": [...]}，
    或 None（未配置/失败/未启用 TREE_ML_ENABLED 无快照）。
    """
    base_url = (SETTINGS.data_service_url or "").strip().rstrip("/")
    if not base_url:
        return None
    try:
        key = SETTINGS.injector_api_key or SETTINGS.ragservicer_api_key
        headers = {"X-API-Key": key} if key else {}
        resp = requests.get(
            f"{base_url}/snapshots",
            params={"type": "tree_predictions"},
            headers=headers,
            timeout=_TIMEOUT,
        )
        if resp.status_code != 200:
            logger.debug("data-service tree_predictions → %s", resp.status_code)
            return None
        data = resp.json()
        payload = (data.get("snapshots") or {}).get("tree_predictions")
        if not isinstance(payload, dict) or not (payload.get("predictions") or []):
            return None
        return payload
    except requests.Timeout:
        logger.debug("data-service tree_predictions timeout (%ss)", _TIMEOUT)
        return None
    except requests.RequestException as exc:
        logger.debug("data-service tree_predictions request failed: %s", exc)
        return None
    except Exception as exc:
        logger.debug("data-service tree_predictions parse failed: %s", exc)
        return None
