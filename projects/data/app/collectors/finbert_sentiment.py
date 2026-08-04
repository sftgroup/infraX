"""FinBERT 文本情绪 collector — 对已采集新闻做 NLP 分类（模型在 ml-service）。

从 raw_snapshots 读最新 news 快照（provider="news", data_type="news"，
NewsCollector 写入），POST 到 ml-service /ml/sentiment 分类聚合，
把结果写 finbert_sentiment 快照（provider="sentiment", data_type="finbert_sentiment"）。

设计：fail-silent 后台线程。ML_SERVICE_URL 未配置、模型不可用或无可分类
新闻时跳过（不写快照，不产生模拟数据）。不覆盖现有 market-rule 的 sentiment_score。
"""
from __future__ import annotations

import os
import threading
import time
from typing import Any, Dict, List, Optional

from app import ml_client
from app.factors import save_snapshot
from app.utils.logger import get_logger

logger = get_logger(__name__)

COLLECT_INTERVAL = int(os.getenv("FINBERT_COLLECT_INTERVAL_SEC", "1800"))  # 30 min


class FinbertSentimentCollector:
    """Periodically classify the latest news snapshot via ml-service."""

    def __init__(self):
        self._running = False
        self._thread: Optional[threading.Thread] = None

    def start(self):
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._loop, daemon=True, name="finbert-sentiment-collector")
        self._thread.start()
        logger.info("FinbertSentimentCollector started (interval=%ds, ml-service=%s)", COLLECT_INTERVAL, bool(ml_client.ML_SERVICE_URL))

    def stop(self):
        self._running = False

    def _loop(self):
        while self._running:
            try:
                self._collect()
            except Exception:
                logger.warning("FinBERT sentiment cycle failed", exc_info=True)
            time.sleep(COLLECT_INTERVAL)

    def _latest_news_items(self) -> List[Dict[str, Any]]:
        """读最新 news 快照的 items（失败返回空列表）。"""
        try:
            import json
            from app.storage import get_db
            row = get_db().execute(
                """SELECT raw_json FROM raw_snapshots
                   WHERE provider = 'news' AND data_type = 'news'
                   ORDER BY fetched_at DESC LIMIT 1"""
            ).fetchone()
            if row and row["raw_json"]:
                payload = json.loads(row["raw_json"])
                return (payload.get("items") or []) if isinstance(payload, dict) else []
        except Exception as exc:
            logger.debug("FinBERT read latest news failed: %s", exc)
        return []

    def _collect(self):
        items = self._latest_news_items()
        if not items:
            logger.debug("FinBERT: no news snapshot available, skip")
            return
        result = ml_client.post_sentiment(items)
        if not result:
            logger.debug("FinBERT: ml-service unavailable or no classifiable text, skip")
            return
        result["analyzed_at"] = int(time.time() * 1000)
        result["source_news_items"] = len(items)
        save_snapshot("sentiment", "finbert_sentiment", result)
        logger.info(
            "FinBERT snapshot saved: total=%d score=%.3f (%s) finbert=%d field=%d skipped=%d",
            result.get("total"), result.get("sentiment_score", 0.0),
            result.get("classification"), result.get("used_finbert", 0),
            result.get("used_field", 0), result.get("skipped", 0),
        )
