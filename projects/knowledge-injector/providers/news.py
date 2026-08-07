"""新闻情感聚合。

从 Finnhub 获取新闻 headline，调用 ml-service POST /ml/sentiment
（FinBERT 本地推理）逐条分类并聚合 24h 窗口内的市场情绪。

Finnhub 免费 key 不返回 sentiment 标注（付费 AI 功能），故由
ml-service FinBERT 承担文本情绪分类。ml-service 不可用时 fail-silent
返回 None，不影响注入器主循环。

失败返回 None。
"""
from __future__ import annotations

import logging
from typing import Any

import requests

from config import SETTINGS, rotate_key

logger = logging.getLogger(__name__)

_SOURCE = "Finnhub"
_TIMEOUT = 120  # ml-service 首次加载 FinBERT 模型可能较慢


def fetch_news_sentiment_aggregate(
    hours: int = 24,
    max_articles: int = 50,
) -> dict[str, Any] | None:
    """聚合新闻情感。

    从 Finnhub 获取 general 分类新闻 headline/summary，
    调用 ml-service FinBERT 逐条分类并聚合。

    返回:
        {
            "total": 42,
            "positive": 18,
            "negative": 10,
            "neutral": 14,
            "positive_ratio": 0.43,
            "negative_ratio": 0.24,
            "sentiment_score": 0.19,    # -1 ~ +1
            "classification": "positive",  # positive / negative / neutral
            "source": "Finnhub+FinBERT",
        }
    """
    api_key = rotate_key("FINNHUB_API_KEY")
    if not api_key:
        logger.debug("News sentiment skipped: FINNHUB_API_KEY not set")
        return None

    try:
        resp = requests.get(
            "https://finnhub.io/api/v1/news",
            params={"category": "general", "token": api_key},
            timeout=15,
        )
        resp.raise_for_status()
        articles = resp.json()
    except Exception:
        logger.debug("Finnhub news fetch failed", exc_info=True)
        return None

    if not isinstance(articles, list) or not articles:
        return None

    payload = []
    for art in articles[:max_articles]:
        headline = (art.get("headline") or "").strip()
        summary = (art.get("summary") or "").strip()
        if not headline and not summary:
            continue
        item = {"title": headline, "snippet": summary}
        # Finnhub 免费 key 通常无 sentiment 字段；若有则透传（ml-service
        # 优先回退链会先用它，再走 FinBERT）
        if art.get("sentiment"):
            item["sentiment"] = art["sentiment"]
        payload.append(item)

    if not payload:
        return None

    data = _ml_sentiment(payload)
    if not data or data.get("total", 0) == 0:
        return None

    result = {
        "total": data.get("total", 0),
        "positive": data.get("positive", 0),
        "negative": data.get("negative", 0),
        "neutral": data.get("neutral", 0),
        "positive_ratio": data.get("positive_ratio", 0.0),
        "negative_ratio": data.get("negative_ratio", 0.0),
        "sentiment_score": data.get("sentiment_score", 0.0),
        "classification": data.get("classification", "neutral"),
        "source": f"{_SOURCE}+FinBERT",
    }
    logger.info(
        "News sentiment: %d articles, score=%.3f (%s), model=%s",
        result["total"], result["sentiment_score"], result["classification"],
        data.get("model"),
    )
    return result


def _ml_sentiment(articles: list[dict[str, Any]]) -> dict[str, Any] | None:
    """调用 ml-service FinBERT 文本情绪聚合。失败返回 None。"""
    base = (SETTINGS.ml_service_url or "").strip().rstrip("/")
    if not base:
        logger.debug("News sentiment skipped: ML_SERVICE_URL not set")
        return None
    headers = {"X-API-Key": SETTINGS.ml_api_key} if SETTINGS.ml_api_key else {}
    try:
        resp = requests.post(
            f"{base}/ml/sentiment",
            json={"articles": articles},
            headers=headers,
            timeout=_TIMEOUT,
        )
        if resp.status_code != 200:
            logger.debug("ml-service /ml/sentiment → %s", resp.status_code)
            return None
        data = (resp.json() or {}).get("data")
        return data if isinstance(data, dict) else None
    except requests.Timeout:
        logger.debug("ml-service /ml/sentiment timeout (%ss)", _TIMEOUT)
        return None
    except requests.RequestException as exc:
        logger.debug("ml-service /ml/sentiment request failed: %s", exc)
        return None
    except Exception as exc:
        logger.debug("ml-service /ml/sentiment parse failed: %s", exc)
        return None
