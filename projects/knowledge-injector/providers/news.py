"""新闻情感聚合。

从 Finnhub 获取新闻，聚合情感分数（正/负/中性比例），
计算 24h 窗口内的市场情绪。

失败返回 None。
"""
from __future__ import annotations

import logging
from typing import Any

import requests

from config import rotate_key

logger = logging.getLogger(__name__)

_SOURCE = "Finnhub"


def fetch_news_sentiment_aggregate(
    hours: int = 24,
    max_articles: int = 50,
) -> dict[str, Any] | None:
    """聚合新闻情感。

    从 Finnhub 获取 general 分类新闻，
    计算 positive / negative / neutral 的比例。

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
            "source": "Finnhub",
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

    positive = negative = neutral = 0
    count = 0

    for art in articles[:max_articles]:
        sentiment = art.get("sentiment", "") or ""
        if sentiment == "positive":
            positive += 1
            count += 1
        elif sentiment == "negative":
            negative += 1
            count += 1
        elif sentiment == "neutral":
            neutral += 1
            count += 1
        # sentiment="" (unknown) 忽略

    if count == 0:
        return None

    positive_ratio = positive / count
    negative_ratio = negative / count
    # sentiment_score: -1 ~ +1
    sentiment_score = positive_ratio - negative_ratio

    if sentiment_score > 0.1:
        classification = "positive"
    elif sentiment_score < -0.1:
        classification = "negative"
    else:
        classification = "neutral"

    result = {
        "total": count,
        "positive": positive,
        "negative": negative,
        "neutral": neutral,
        "positive_ratio": round(positive_ratio, 3),
        "negative_ratio": round(negative_ratio, 3),
        "sentiment_score": round(sentiment_score, 3),
        "classification": classification,
        "source": _SOURCE,
    }
    logger.info(
        "News sentiment: %d articles, score=%.2f (%s)",
        count, sentiment_score, classification,
    )
    return result
