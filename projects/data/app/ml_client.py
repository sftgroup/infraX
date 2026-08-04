"""ml-service HTTP 客户端 — 拉取模型推理结果（只读，fail-silent）。

data-service 不再承载模型推理（LightGBM/FinBERT 已拆分到独立 ml-service），
collector 只做"拉取 → 落库"。未配置 ML_SERVICE_URL 或请求失败时返回 None，
不影响其他 collector。

ml-service 端点（见 ml-service/main.py）：
    GET  /ml/tree_predictions  → {"code":0, "data": {"generated_at","model","predictions"}}
    POST /ml/sentiment         → {"code":0, "data": 聚合情绪统计}
"""
from __future__ import annotations

import logging

import requests

from app.config import ML_SERVICE_URL, ML_API_KEY

logger = logging.getLogger(__name__)

_TIMEOUT = 60  # ml-service 首次训练/加载模型可能较慢


def _headers() -> dict:
    return {"X-API-Key": ML_API_KEY} if ML_API_KEY else {}


def fetch_tree_predictions() -> dict | None:
    """拉取 ml-service LightGBM 方向预测 payload（或 None，fail-silent）。"""
    base = (ML_SERVICE_URL or "").strip().rstrip("/")
    if not base:
        return None
    try:
        resp = requests.get(f"{base}/ml/tree_predictions", headers=_headers(), timeout=_TIMEOUT)
        if resp.status_code != 200:
            logger.debug("ml-service /ml/tree_predictions → %s", resp.status_code)
            return None
        data = (resp.json() or {}).get("data")
        if not isinstance(data, dict) or not (data.get("predictions") or []):
            return None
        return data
    except requests.Timeout:
        logger.debug("ml-service tree_predictions timeout (%ss)", _TIMEOUT)
        return None
    except requests.RequestException as exc:
        logger.debug("ml-service tree_predictions request failed: %s", exc)
        return None
    except Exception as exc:
        logger.debug("ml-service tree_predictions parse failed: %s", exc)
        return None


def fetch_consensus() -> dict | None:
    """拉取 ml-service 跨模型共识 payload（/ml/consensus）。

    返回 {"generated_at", "signals", "n_symbols", "avg_consensus_score",
          "market_risk_flag", "n_divergence", "symbols"} 或 None（fail-silent）。
    """
    base = (ML_SERVICE_URL or "").strip().rstrip("/")
    if not base:
        return None
    try:
        resp = requests.get(f"{base}/ml/consensus", headers=_headers(), timeout=_TIMEOUT)
        if resp.status_code != 200:
            logger.debug("ml-service /ml/consensus → %s", resp.status_code)
            return None
        data = (resp.json() or {}).get("data")
        if not isinstance(data, dict) or not (data.get("symbols") or []):
            return None
        return data
    except requests.Timeout:
        logger.debug("ml-service consensus timeout (%ss)", _TIMEOUT)
        return None
    except requests.RequestException as exc:
        logger.debug("ml-service consensus request failed: %s", exc)
        return None
    except Exception as exc:
        logger.debug("ml-service consensus parse failed: %s", exc)
        return None


def post_sentiment(articles: list[dict]) -> dict | None:
    """POST 新闻文章到 ml-service /ml/sentiment，返回聚合情绪统计（或 None）。"""
    base = (ML_SERVICE_URL or "").strip().rstrip("/")
    if not base or not articles:
        return None
    try:
        resp = requests.post(
            f"{base}/ml/sentiment",
            json={"articles": articles},
            headers=_headers(),
            timeout=_TIMEOUT,
        )
        if resp.status_code != 200:
            logger.debug("ml-service /ml/sentiment → %s", resp.status_code)
            return None
        data = (resp.json() or {}).get("data")
        return data if isinstance(data, dict) else None
    except requests.Timeout:
        logger.debug("ml-service sentiment timeout (%ss)", _TIMEOUT)
        return None
    except requests.RequestException as exc:
        logger.debug("ml-service sentiment request failed: %s", exc)
        return None
    except Exception as exc:
        logger.debug("ml-service sentiment parse failed: %s", exc)
        return None
