"""Full-market heatmap collector — periodic fetch → raw_snapshots.

Data source: 复用 ``app.data_providers.heatmap.generate_heatmap_data``
（crypto CoinGecko/CoinCap + stocks Finnhub + fx/commodities 多源回退），
保证 /snapshots 快照与 /heatmap 端点内容一致（REQ-2 全市场覆盖）。

Config: reads "heatmap" section from data_config.json.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from pathlib import Path
from typing import Optional

from app.factors import save_snapshot
from app.data_providers.heatmap import generate_heatmap_data

logger = logging.getLogger(__name__)

_CONFIG_PATH = os.getenv("DATA_CONFIG_PATH", "data_config.json")


def _load_config() -> dict:
    path = Path(_CONFIG_PATH)
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text())
    except Exception:
        return {}


def _get_heatmap_config() -> dict:
    if not hasattr(_get_heatmap_config, "_cache"):
        _get_heatmap_config._cache = _load_config().get("heatmap", {})
    return _get_heatmap_config._cache


class HeatmapCollector:
    """Periodically fetch full-market heatmap → raw_snapshots."""

    def __init__(self):
        self._running = False
        self._thread: Optional[threading.Thread] = None

    def start(self):
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._loop, daemon=True, name="heatmap-collector")
        self._thread.start()
        cfg = _get_heatmap_config()
        interval = cfg.get("interval_sec", 600)
        logger.info("HeatmapCollector started (interval=%ds)", interval)

    def stop(self):
        self._running = False

    def _loop(self):
        cfg = _get_heatmap_config()
        interval = cfg.get("interval_sec", 600)
        while self._running:
            try:
                self._collect(cfg)
            except Exception:
                logger.warning("HeatmapCollector cycle failed", exc_info=True)
            time.sleep(interval)

    def _collect(self, cfg: dict):
        data = generate_heatmap_data()
        if data:
            save_snapshot("market", "heatmap", {"categories": data})
            count = sum(len(v) for v in data.values())
            logger.info("HeatmapCollector: saved %d cells across %d categories",
                        count, len(data))
