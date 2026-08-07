"""P2 时序模型预测明细落库采集器（单模型快照，DS 扩展）。

后台线程：每 P2_COLLECT_INTERVAL_SEC（默认 30min）从 ml-service 拉三个 P2 端点
  GET /ml/bolt | /ml/moirai | /ml/timesfm
→ 逐 symbol 写 ml_predictions 明细表（model × symbol × generated_at 唯一，
INSERT OR IGNORE 幂等）→ 顺带滚动清理 P2_RETENTION_DAYS 前的历史。

三端点 ThreadPoolExecutor 并发拉取（每个独立 600s 超时预算），互不等待。

设计（见 docs/DATA_MODULE_RAG_PLAN.md §5.7）：
  - fail-silent：ML_SERVICE_URL 未配置 / 端点失败 / 数据为空时整线程空转，
    任一模型失败不影响其他模型
  - 与 consensus 快照互补：consensus = 聚合最新视图，ml_predictions = 单模型历史明细
  - 符号归一化：BTC/USDT → BTC（与共识层对齐）
"""
from __future__ import annotations

import json
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Optional

from app import ml_client
from app.config import P2_COLLECT_ENABLED, P2_COLLECT_INTERVAL_SEC, P2_RETENTION_DAYS
from app.factors import normalize_ml_symbol
from app.storage import get_db
from app.utils.logger import get_logger

logger = get_logger(__name__)

_MODELS = ("bolt", "moirai", "timesfm")


def _normalize_symbol(symbol: str) -> str:
    """符号归一化（DQ-5）：大写 + 交易对/quote 剥离（BTC/USDT、BTC-USD、btc → BTC）。"""
    return normalize_ml_symbol(symbol)


def _save_predictions(model: str, results: list[dict], now_ms: int) -> int:
    """逐 symbol 写 ml_predictions（幂等）。返回写入行数。"""
    db = get_db()
    rows = []
    for item in results:
        sym = _normalize_symbol((item or {}).get("symbol"))
        if not sym:
            continue
        rows.append((
            model, sym, now_ms,
            item.get("direction"),
            item.get("prob_up"),
            item.get("uncertainty"),
            json.dumps(item.get("point_forecast"), default=str) if item.get("point_forecast") is not None else None,
            json.dumps(item.get("quantiles"), default=str) if item.get("quantiles") is not None else None,
            now_ms,
        ))
    if not rows:
        return 0
    with db:
        db.executemany(
            """INSERT OR IGNORE INTO ml_predictions
               (model, symbol, generated_at, direction, prob_up, uncertainty,
                point_forecast, quantiles, fetched_at)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            rows,
        )
    return len(rows)


def _purge_old(retention_days: int) -> None:
    """滚动清理：删除 retention_days 之前落库的预测。"""
    if retention_days <= 0:
        return
    cutoff = time.time() * 1000 - retention_days * 86400 * 1000
    db = get_db()
    with db:
        db.execute("DELETE FROM ml_predictions WHERE fetched_at < ?", (cutoff,))


class P2MlCollector:
    """周期拉取 P2 三模型预测 → ml_predictions 明细表。"""

    def __init__(self):
        self._running = False
        self._thread: Optional[threading.Thread] = None

    def start(self):
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._loop, daemon=True, name="p2ml-collector")
        self._thread.start()
        logger.info("P2MlCollector started (interval=%ds, retention=%dd, enabled=%s, ml-service=%s)",
                    P2_COLLECT_INTERVAL_SEC, P2_RETENTION_DAYS, P2_COLLECT_ENABLED,
                    bool(ml_client.ML_SERVICE_URL))

    def stop(self):
        self._running = False

    def _loop(self):
        while self._running:
            try:
                self._pull_and_save()
            except Exception:
                logger.warning("P2MlCollector cycle failed", exc_info=True)
            time.sleep(P2_COLLECT_INTERVAL_SEC)

    def _pull_and_save(self) -> None:
        if not P2_COLLECT_ENABLED:
            return
        now_ms = int(time.time() * 1000)
        fetchers = {"bolt": ml_client.fetch_bolt, "moirai": ml_client.fetch_moirai,
                    "timesfm": ml_client.fetch_timesfm}
        # 三模型并发拉取（各自分钟级全量推理/首次缓存 miss 互不等待）；
        # ml-service 端点命中 TTL 缓存后秒回，miss 时并行计算。
        with ThreadPoolExecutor(max_workers=len(_MODELS)) as pool:
            futures = {model: pool.submit(fetchers[model]) for model in _MODELS}
            for model in _MODELS:
                try:
                    results = futures[model].result()
                except Exception as exc:
                    logger.debug("P2MlCollector %s fetch failed: %s", model, exc)
                    continue
                if not results:
                    logger.debug("P2MlCollector %s: no data, skip", model)
                    continue
                n = _save_predictions(model, results, now_ms)
                logger.info("P2MlCollector %s: saved %d predictions (symbols=%d)",
                            model, n, len(results))
        _purge_old(P2_RETENTION_DAYS)
