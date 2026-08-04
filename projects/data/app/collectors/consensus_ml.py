"""Cross-model consensus collector — 跨模型共识快照调度器（M3）。

后台线程：每 CONSENSUS_COLLECT_INTERVAL_SEC 从 ml-service GET /ml/consensus
（聚合在 ml-service 完成：tree + Kronos + FinBERT 三路信号 → 确定性规则）
→ save_snapshot("ml", "consensus", ...)。

设计：fail-silent。ML_SERVICE_URL 未配置或请求失败时整个线程空转
（不产生任何数据/快照）。共识是派生数据，原始信号仍各自独立入快照。
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

COLLECT_INTERVAL = int(os.getenv("CONSENSUS_COLLECT_INTERVAL_SEC", "1800"))  # 30 min


class ConsensusCollector:
    """Periodically pull cross-model consensus from ml-service."""

    def __init__(self):
        self._running = False
        self._thread: Optional[threading.Thread] = None

    def start(self):
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._loop, daemon=True, name="consensus-collector")
        self._thread.start()
        logger.info("ConsensusCollector started (interval=%ds, ml-service=%s)", COLLECT_INTERVAL, bool(ml_client.ML_SERVICE_URL))

    def stop(self):
        self._running = False

    def _loop(self):
        while self._running:
            try:
                self._pull_and_save()
            except Exception:
                logger.warning("Consensus cycle failed", exc_info=True)
            time.sleep(COLLECT_INTERVAL)

    def _pull_and_save(self) -> None:
        """从 ml-service 拉取共识 payload → 写快照（无数据跳过）。"""
        payload = ml_client.fetch_consensus()
        if not payload:
            logger.debug("Consensus: ml-service unavailable or no signals, skip snapshot")
            return
        save_snapshot("ml", "consensus", payload)
        logger.info(
            "Consensus snapshot saved: %d symbols, avg_consensus=%s, risk=%s, divergence=%d",
            payload.get("n_symbols", 0),
            payload.get("avg_consensus_score"),
            payload.get("market_risk_flag"),
            payload.get("n_divergence", 0),
        )
