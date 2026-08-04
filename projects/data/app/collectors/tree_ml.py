"""Tree ML collector — LightGBM 方向预测调度器（P1，模型已拆分到 ml-service）。

后台线程：每 TREE_ML_COLLECT_INTERVAL_SEC 从 ml-service GET /ml/tree_predictions
（训练/预测全部在 ml-service 完成）→ save_snapshot("ml", "tree_predictions", ...)。

设计：fail-silent。ML_SERVICE_URL 未配置或请求失败时整个线程空转
（不产生任何数据/快照）。训练与预测不占用本服务资源。
"""
from __future__ import annotations

import os
import threading
import time
from typing import Optional

from app import ml_client
from app.factors import save_snapshot
from app.utils.logger import get_logger

logger = get_logger(__name__)

COLLECT_INTERVAL = int(os.getenv("TREE_ML_COLLECT_INTERVAL_SEC", "1800"))  # 30 min


class TreeMlCollector:
    """Periodically pull LightGBM direction predictions from ml-service."""

    def __init__(self):
        self._running = False
        self._thread: Optional[threading.Thread] = None

    def start(self):
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._loop, daemon=True, name="tree-ml-collector")
        self._thread.start()
        logger.info("TreeMlCollector started (interval=%ds, ml-service=%s)", COLLECT_INTERVAL, bool(ml_client.ML_SERVICE_URL))

    def stop(self):
        self._running = False

    def _loop(self):
        while self._running:
            try:
                self._pull_and_save()
            except Exception:
                logger.warning("Tree ML cycle failed", exc_info=True)
            time.sleep(COLLECT_INTERVAL)

    def _pull_and_save(self) -> None:
        """从 ml-service 拉取预测 payload → 写快照（无数据跳过）。"""
        payload = ml_client.fetch_tree_predictions()
        if not payload:
            logger.debug("Tree ML: ml-service unavailable or no predictions, skip snapshot")
            return
        save_snapshot("ml", "tree_predictions", payload)
        predictions = payload.get("predictions") or []
        up = sum(1 for p in predictions if p.get("direction") == "up")
        down = sum(1 for p in predictions if p.get("direction") == "down")
        logger.info(
            "Tree ML snapshot saved: %d symbols (up=%d down=%d flat=%d)",
            len(predictions), up, down,
            len(predictions) - up - down,
        )
