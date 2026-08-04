"""全局市场快照采集（DS-10）— commodities / forex_pairs / market_overview 落库。

对标单体缓存 TTL：商品/外汇 30min、市场概览 15min。

每轮（GLOBAL_MARKET_COLLECT_INTERVAL_SEC，默认 900s）：
  - commodities      30min 节流：fetch_commodities() → raw_snapshots(provider=global_market)
  - forex_pairs      30min 节流：fetch_forex_pairs()  → raw_snapshots(provider=global_market)
  - market_overview  每轮：聚合 crypto/commodities/forex/indices 涨跌分布

fail-silent：任一数据源失败不影响其他；空结果跳过写入。
落库后 /snapshots?type=commodities|forex_pairs|market_overview 由
get_snapshots() 通用逻辑自动生效。
"""
from __future__ import annotations

import logging
import threading
import time
from typing import Any, Optional

from app.config import (
    GLOBAL_MARKET_COLLECT_ENABLED,
    GLOBAL_MARKET_COLLECT_INTERVAL_SEC,
)
from app.factors import save_snapshot

logger = logging.getLogger(__name__)

PROVIDER = "global_market"
# 商品/外汇对标单体 30min 缓存 TTL（概览跟随轮询间隔 15min）
SLOW_TTL_SEC = 1800


# ─── 归一化工具（兼容各 provider 字段名差异） ─────────────

def _price(item: dict) -> float:
    for k in ("price", "usdPrice", "last", "close"):
        v = item.get(k)
        if isinstance(v, (int, float)):
            return float(v)
    return 0.0


def _pct(item: dict) -> float:
    for k in ("change", "change_24h", "changePercent", "pct_change"):
        v = item.get(k)
        if isinstance(v, (int, float)):
            return float(v)
    return 0.0


def _display_name(item: dict) -> str:
    return item.get("name") or item.get("name_en") or item.get("name_cn") or ""


def _compute_market_overview() -> Optional[dict]:
    """多市场概览聚合（涨跌分布）。

    返回 {"sections": {crypto|commodities|forex|indices: [...], ...},
          "summary": {up, down, flat, total}}；全部失败返回 None。
    """
    try:
        from app.data_providers.commodities import fetch_commodities
        from app.data_providers.crypto import fetch_crypto_prices
        from app.data_providers.forex import fetch_forex_pairs
        from app.data_providers.indices import fetch_stock_indices
    except Exception as exc:
        logger.debug("market_overview providers import failed: %s", exc)
        return None

    fetchers = {
        "crypto": fetch_crypto_prices,
        "commodities": fetch_commodities,
        "forex": fetch_forex_pairs,
        "indices": fetch_stock_indices,
    }
    sections: dict[str, list[dict]] = {}
    for name, fn in fetchers.items():
        try:
            items = fn() or []
        except Exception as exc:
            logger.debug("market_overview %s fetch failed: %s", name, exc)
            continue
        norm = []
        for it in items:
            if not isinstance(it, dict):
                continue
            p = _price(it)
            c = _pct(it)
            if p <= 0:
                continue  # 无有效价格不参与统计
            norm.append({
                "symbol": it.get("symbol", ""),
                "name": _display_name(it),
                "price": p,
                "change_pct": c,
                "up": c > 0,
            })
        if norm:
            sections[name] = norm

    if not sections:
        return None

    summary = {"up": 0, "down": 0, "flat": 0, "total": 0}
    for items in sections.values():
        for it in items:
            summary["total"] += 1
            if it["change_pct"] > 0:
                summary["up"] += 1
            elif it["change_pct"] < 0:
                summary["down"] += 1
            else:
                summary["flat"] += 1

    return {"sections": sections, "summary": summary}


# ─── Collector ───────────────────────────────────────────

class GlobalMarketCollector:
    """周期抓取全局市场快照（商品/外汇/多市场概览）写入 raw_snapshots。"""

    def __init__(self):
        self._running = False
        self._thread: Optional[threading.Thread] = None
        self._last_slow_ts: float = 0.0  # 商品/外汇 30min 节流基准

    def start(self):
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(
            target=self._loop, daemon=True, name="global-market-collector"
        )
        self._thread.start()
        logger.info(
            "GlobalMarketCollector started (interval=%ds, enabled=%s)",
            GLOBAL_MARKET_COLLECT_INTERVAL_SEC, GLOBAL_MARKET_COLLECT_ENABLED,
        )

    def stop(self):
        self._running = False

    def _loop(self):
        while self._running:
            try:
                self._pull_and_save()
            except Exception:
                logger.warning("GlobalMarketCollector cycle failed", exc_info=True)
            time.sleep(GLOBAL_MARKET_COLLECT_INTERVAL_SEC)

    def _pull_and_save(self) -> None:
        if not GLOBAL_MARKET_COLLECT_ENABLED:
            return
        now = time.time()
        # 慢速数据（商品/外汇）：30min 节流，避免重复打上游
        if now - self._last_slow_ts >= SLOW_TTL_SEC:
            self._collect_commodities()
            self._collect_forex()
            self._last_slow_ts = now
        # 概览：每轮（15min）
        self._collect_overview()

    def _collect_commodities(self) -> None:
        try:
            from app.data_providers.commodities import fetch_commodities

            items = fetch_commodities()
        except Exception as exc:
            logger.debug("global_market commodities fetch failed: %s", exc)
            return
        if not items:
            return
        # 过滤占位/无效价条目（placeholder 特征 price=0），避免假数据落库
        valid = [it for it in items if isinstance(it, dict) and _price(it) > 0]
        if not valid:
            logger.debug("global_market commodities: no valid prices, skip")
            return
        save_snapshot(PROVIDER, "commodities", {"items": valid})
        logger.info("GlobalMarketCollector commodities: %d items", len(valid))

    def _collect_forex(self) -> None:
        try:
            from app.data_providers.forex import fetch_forex_pairs

            items = fetch_forex_pairs()
        except Exception as exc:
            logger.debug("global_market forex fetch failed: %s", exc)
            return
        if not items:
            return
        valid = [it for it in items if isinstance(it, dict) and _price(it) > 0]
        if not valid:
            logger.debug("global_market forex: no valid prices, skip")
            return
        save_snapshot(PROVIDER, "forex_pairs", {"items": valid})
        logger.info("GlobalMarketCollector forex_pairs: %d items", len(valid))

    def _collect_overview(self) -> None:
        overview = _compute_market_overview()
        if not overview:
            return
        save_snapshot(PROVIDER, "market_overview", overview)
        s = overview["summary"]
        logger.info(
            "GlobalMarketCollector market_overview: up=%d down=%d flat=%d total=%d",
            s["up"], s["down"], s["flat"], s["total"],
        )
