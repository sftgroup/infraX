"""Tree ML collector — LightGBM 方向预测调度器（P1）。

后台线程：每 TREE_ML_COLLECT_INTERVAL_SEC 检查一次——
  1. 模型缺失或超过 TREE_ML_RETRAIN_HOURS 未重训 → train_models()
  2. 预测全部已训练 symbol → save_snapshot("ml", "tree_predictions", ...)

设计：fail-silent。TREE_ML_ENABLED=false（默认）或 lightgbm 未安装时
整个线程空转（不产生任何数据/快照）。训练与预测都在独立线程内，
不阻塞其他 collector。
"""
from __future__ import annotations

import os
import threading
import time
from typing import Optional

from app.analytics import tree_models as tm
from app.factors import save_snapshot
from app.utils.logger import get_logger

logger = get_logger(__name__)

COLLECT_INTERVAL = int(os.getenv("TREE_ML_COLLECT_INTERVAL_SEC", "1800"))  # 30 min
RETRAIN_HOURS = float(os.getenv("TREE_ML_RETRAIN_HOURS", "24"))


class TreeMlCollector:
    """Periodically train / predict with the LightGBM direction model."""

    def __init__(self):
        self._running = False
        self._thread: Optional[threading.Thread] = None

    def start(self):
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._loop, daemon=True, name="tree-ml-collector")
        self._thread.start()
        logger.info("TreeMlCollector started (interval=%ds, retrain=%sh)", COLLECT_INTERVAL, RETRAIN_HOURS)

    def stop(self):
        self._running = False

    def _loop(self):
        while self._running:
            try:
                if tm._enabled():
                    self._maybe_train()
                    self._predict_and_save()
            except Exception:
                logger.warning("Tree ML cycle failed", exc_info=True)
            time.sleep(COLLECT_INTERVAL)

    def _maybe_train(self) -> None:
        """无模型或超过重训周期 → 训练（数据不足则跳过，不产生数据）。"""
        meta = tm._load_meta()
        stale = meta is None or (
            time.time() * 1000 - meta.get("trained_at_ms", 0)
            > RETRAIN_HOURS * 3600 * 1000
        )
        if not stale:
            return
        new_meta = tm.train_models()
        if new_meta is None:
            logger.info("Tree ML: train skipped (disabled/insufficient data)")

    def _predict_and_save(self) -> None:
        """预测全部 symbol → 写快照（无模型/无数据跳过）。"""
        predictions = tm.predict_all()
        if not predictions:
            logger.debug("Tree ML: no predictions available, skip snapshot")
            return
        payload = {
            "generated_at": int(time.time() * 1000),
            "model": {
                "name": "lightgbm-direction",
                "horizon": tm.HORIZON,
                "n_samples": (tm._load_meta() or {}).get("n_samples"),
                "val_accuracy": (tm._load_meta() or {}).get("val_accuracy"),
            },
            "predictions": predictions,
        }
        save_snapshot("ml", "tree_predictions", payload)
        up = sum(1 for p in predictions if p["direction"] == "up")
        down = sum(1 for p in predictions if p["direction"] == "down")
        logger.info(
            "Tree ML snapshot saved: %d symbols (up=%d down=%d flat=%d)",
            len(predictions), up, down,
            len(predictions) - up - down,
        )
