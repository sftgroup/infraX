"""app/analytics/sentiment_llm.py 纯函数单测（FinBERT 文本情绪，ml-service）。

只测纯函数与禁用态行为，不加载 transformers/torch：
  - _field_score / _article_score: 回退链（自带字段优先 → FinBERT → 跳过）
  - aggregate_scores: 聚合统计
  - analyze_articles: 空输入 / 无文本 / 模型不可用 → None；正常路径聚合
"""
from __future__ import annotations

import os
import sys
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ["FINBERT_ENABLED"] = "false"  # 测试环境默认禁用（懒加载前设置）

from app.analytics import sentiment_llm as sl  # noqa: E402


class TestFieldScore:
    def test_string_labels(self):
        assert sl._field_score("positive") == 1.0
        assert sl._field_score("NEGATIVE") == -1.0
        assert sl._field_score("neutral") == 0.0

    def test_synonyms(self):
        assert sl._field_score("bullish") == 1.0
        assert sl._field_score("bearish") == -1.0
        assert sl._field_score("true") == 1.0
        assert sl._field_score("false") == -1.0

    def test_numeric(self):
        assert sl._field_score(0.5) == 0.5
        assert sl._field_score(-0.8) == -0.8
        assert sl._field_score(0) == 0.0

    def test_invalid(self):
        assert sl._field_score(None) is None
        assert sl._field_score("") is None
        assert sl._field_score("unknown") is None
        assert sl._field_score(5.0) is None
        assert sl._field_score(-5.0) is None


class TestArticleScore:
    def test_field_priority(self):
        assert sl._article_score({"sentiment": "positive"}, {"label": "NEGATIVE", "score": 0.9}) == 1.0

    def test_finbert_positive(self):
        assert sl._article_score({}, {"label": "positive", "score": 0.99}) == 0.99

    def test_finbert_negative(self):
        assert sl._article_score({}, {"label": "negative", "score": 0.9}) == -0.9

    def test_finbert_neutral(self):
        assert sl._article_score({}, {"label": "neutral", "score": 0.8}) == 0.0

    def test_none(self):
        assert sl._article_score({}, None) is None
        assert sl._article_score({"sentiment": "unknown"}, None) is None


class TestAggregate:
    def test_empty(self):
        stats = sl.aggregate_scores([])
        assert stats["total"] == 0
        assert stats["sentiment_score"] == 0.0
        assert stats["classification"] == "neutral"

    def test_mixed(self):
        stats = sl.aggregate_scores([1.0, 1.0, -1.0])
        assert stats["total"] == 3
        assert stats["positive"] == 2
        assert stats["negative"] == 1
        assert stats["positive_ratio"] == round(2 / 3, 3)
        assert abs(stats["sentiment_score"] - round(1 / 3, 4)) < 1e-9
        assert stats["classification"] == "positive"

    def test_all_negative(self):
        stats = sl.aggregate_scores([-0.9, -0.8, -0.1])
        assert stats["negative"] == 3
        assert stats["classification"] == "negative"

    def test_neutral_band(self):
        stats = sl.aggregate_scores([0.05, -0.05])
        assert stats["classification"] == "neutral"


class TestAnalyzeArticles:
    def test_empty(self):
        assert sl.analyze_articles([]) is None
        assert sl.analyze_articles(None) is None

    def test_no_text(self):
        assert sl.analyze_articles([{"link": "x"}]) is None

    def test_model_disabled(self):
        assert sl.analyze_articles([{"title": "Bitcoin rally"}]) is None

    def test_uses_field_and_finbert(self):
        articles = [
            {"title": "Markets up today", "sentiment": "positive"},
            {"title": "Fed cuts rates"},
            {"title": "War risk", "sentiment": "negative"},
        ]
        finbert_results = [
            {"label": "positive", "score": 0.9},
            {"label": "neutral", "score": 0.6},
            {"label": "negative", "score": 0.8},
        ]
        with patch.object(sl, "classify_texts", return_value=finbert_results) as mocked:
            result = sl.analyze_articles(articles)
        assert mocked.call_count == 1
        assert mocked.call_args.args[0] == ["Markets up today", "Fed cuts rates", "War risk"]
        assert result is not None
        assert result["total"] == 3
        assert result["positive"] == 1
        assert result["negative"] == 1
        assert result["neutral"] == 1
        assert result["used_field"] == 2
        assert result["used_finbert"] == 1
        assert len(result["articles"]) == 3

    def test_skips_unclassifiable(self):
        articles = [{"title": "A"}, {"sentiment": "positive"}, {"title": "B"}]
        finbert_results = [
            {"label": "negative", "score": 0.8},
            {"label": "positive", "score": 0.9},
        ]
        with patch.object(sl, "classify_texts", return_value=finbert_results) as mocked:
            result = sl.analyze_articles(articles)
        assert mocked.call_args.args[0] == ["A", "B"]
        assert result is not None
        assert result["total"] == 2
        assert result["positive"] == 1
        assert result["negative"] == 1

    def test_all_skipped_returns_none(self):
        articles = [{"sentiment": "unknown"}, {"title": "x"}]
        with patch.object(sl, "classify_texts", return_value=[None]):
            result = sl.analyze_articles(articles)
        assert result is None
