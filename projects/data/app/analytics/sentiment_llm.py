"""FinBERT 新闻文本情绪分类 — 本地 NLP 推理（真实模型，无模拟回退）。

归属：算法层放 data-service 的 app/analytics/（P1a）。injector 只做
"取数 → 文本化 → 注入 RAG"，不承载模型推理。

行为约定：
  - 懒加载 transformers pipeline（需 FINBERT_ENABLED=true + transformers + torch）。
    首次加载失败置 flag 不重试（与 Kronos 一致），服务重启后可重新加载。
  - 单条回退链：文章自带 sentiment 字段（Finnhub 风格字符串/数值）优先 →
    FinBERT 分类 → 跳过（不产生模拟值）。
  - 聚合输出 [-1, 1] sentiment_score + 正/负/中性分布；模型不可用或
    无可分类文本时返回 None（不写快照，避免污染 RAG）。

启用（部署机）：
  1. pip install torch --index-url https://download.pytorch.org/whl/cpu
     pip install transformers huggingface-hub
  2. .env 置 FINBERT_ENABLED=true（可选 FINBERT_MODEL，默认 ProsusAI/finbert）
"""
from __future__ import annotations

import logging
import os
import threading
from typing import Any

logger = logging.getLogger(__name__)

# 默认模型：ProsusAI/finbert（金融新闻 3 类情绪，英文）。
# 可换 yiyanghkust/finbert-tone（支持中英）等，经 FINBERT_MODEL 配置。
_MODEL_DEFAULT = "ProsusAI/finbert"

_FIELD_LABELS = {"positive": 1.0, "negative": -1.0, "neutral": 0.0}

# ── 管线单例（懒加载） ───────────────────────────────────

_pipeline: Any = None
_pipeline_lock = threading.Lock()
_pipeline_failed = False


def _enabled() -> bool:
    return os.getenv("FINBERT_ENABLED", "false").strip().lower() in ("1", "true", "yes", "on")


def _load_pipeline():
    """懒加载 FinBERT sentiment-analysis pipeline。失败置 flag 不再重试。"""
    global _pipeline, _pipeline_failed
    if _pipeline is not None or _pipeline_failed:
        return _pipeline
    if not _enabled():
        return None
    with _pipeline_lock:
        if _pipeline is not None or _pipeline_failed:
            return _pipeline
        try:
            from transformers import pipeline  # 可选依赖

            model = os.getenv("FINBERT_MODEL", _MODEL_DEFAULT)
            _pipeline = pipeline("sentiment-analysis", model=model)
            logger.info("FinBERT pipeline loaded: %s", model)
        except Exception as exc:  # ImportError / HF 下载失败 / OOM 等
            _pipeline_failed = True
            logger.warning("FinBERT 加载失败（本地文本情绪未启用）: %s", exc)
    return _pipeline


# ── 分类 ──────────────────────────────────────────────────


def classify_texts(texts: list[str], batch_size: int = 16) -> list[dict] | None:
    """对一批文本做 FinBERT 分类，返回与输入对齐的 [{"label", "score"}, ...]。

    模型不可用返回 None（fail-silent）；空文本返回 []。
    """
    cleaned = [(t or "").strip() for t in texts]
    cleaned = [t for t in cleaned if t]
    if not cleaned:
        return []
    pipe = _load_pipeline()
    if pipe is None:
        return None
    try:
        results = pipe(cleaned, batch_size=batch_size, truncation=True)
        return results if isinstance(results, list) else []
    except Exception as exc:
        logger.warning("FinBERT classify failed: %s", exc)
        return None


def _field_score(value: Any) -> float | None:
    """解析文章自带 sentiment 字段：字符串标签或数值（-1~1）。无效返回 None。"""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        score = float(value)
        if -1.0 <= score <= 1.0:
            return score
        return None
    if isinstance(value, str):
        label = value.strip().lower()
        if label in _FIELD_LABELS:
            return _FIELD_LABELS[label]
        # 布尔字符串（Finnhub 部分接口风格）
        if label in ("true", "bullish", "positive"):
            return 1.0
        if label in ("false", "bearish", "negative"):
            return -1.0
    return None


def _article_score(article: dict, finbert_result: dict | None) -> float | None:
    """单条情绪分数（-1~1）。回退链：自带字段 → FinBERT → None（跳过）。"""
    field = _field_score(article.get("sentiment"))
    if field is not None:
        return field
    if not finbert_result:
        return None
    label = (finbert_result.get("label") or "").lower()
    confidence = float(finbert_result.get("score") or 0.0)
    if "positive" in label:
        return confidence
    if "negative" in label:
        return -confidence
    return 0.0


def aggregate_scores(scores: list[float]) -> dict:
    """聚合情绪分数（纯函数，可单测）。返回统计 dict。"""
    total = len(scores)
    if total == 0:
        return {
            "total": 0, "positive": 0, "negative": 0, "neutral": 0,
            "positive_ratio": 0.0, "negative_ratio": 0.0, "neutral_ratio": 0.0,
            "sentiment_score": 0.0, "classification": "neutral",
        }
    positive = sum(1 for s in scores if s > 0)
    negative = sum(1 for s in scores if s < 0)
    neutral = total - positive - negative
    score = round(sum(scores) / total, 4)
    classification = "positive" if score > 0.1 else ("negative" if score < -0.1 else "neutral")
    return {
        "total": total,
        "positive": positive,
        "negative": negative,
        "neutral": neutral,
        "positive_ratio": round(positive / total, 3),
        "negative_ratio": round(negative / total, 3),
        "neutral_ratio": round(neutral / total, 3),
        "sentiment_score": score,
        "classification": classification,
    }


def analyze_articles(articles: list[dict]) -> dict | None:
    """主入口：对新闻列表做文本情绪分类与聚合。

    返回 dict 或 None（模型不可用 / 无可分类文本）。
    """
    if not articles:
        return None
    # 预筛：取 title + snippet 拼接作为分类文本
    pairs = []
    for art in articles:
        title = (art.get("title") or art.get("headline") or "").strip()
        snippet = (art.get("snippet") or art.get("summary") or "").strip()
        text = " ".join(part for part in (title, snippet) if part).strip()
        pairs.append((art, text))

    texts = [text for _, text in pairs if text]
    if not texts:
        return None
    valid = [(art, text) for art, text in pairs if text]  # 与 texts 对齐
    results = classify_texts(texts)
    if results is None:
        return None

    scores: list[float] = []
    per_article: list[dict] = []
    used_finbert = 0
    used_field = 0
    skipped = 0
    for (art, text), finbert_result in zip(valid, results):
        score = _article_score(art, finbert_result)
        if score is None:
            skipped += 1
            continue
        if _field_score(art.get("sentiment")) is not None:
            used_field += 1
        elif finbert_result:
            used_finbert += 1
        scores.append(score)
        per_article.append({
            "title": (art.get("title") or art.get("headline") or "")[:200],
            "link": (art.get("link") or art.get("url") or ""),
            "score": score,
            "label": "positive" if score > 0 else ("negative" if score < 0 else "neutral"),
        })

    if not scores:
        return None
    stats = aggregate_scores(scores)
    stats.update({
        "model": os.getenv("FINBERT_MODEL", _MODEL_DEFAULT).split("/")[-1],
        "analyzed_at": None,  # collector 填充
        "articles": per_article,
        "used_finbert": used_finbert,
        "used_field": used_field,
        "skipped": skipped,
    })
    return stats
