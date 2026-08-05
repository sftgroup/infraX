"""链上区块扫描位点聚合快照采集（合并旧栈 rawdata collector）。

后台线程：每 ONCHAIN_COLLECT_INTERVAL_SEC（默认 60s）从旧栈 collector
（COLLECTOR_URL，Express :9101）拉取：
  GET /api/v2/data/health    → checkpoints（chain / collector_name / last_block / status / last_fetch_at）
  GET /api/v2/data/stats     → chains（chain / event_count / latest_block / last_fetch / status）

按 chain 合并为聚合统计快照（每链已扫高度 / 事件数 / 最近抓取时间 / 状态），
写入 raw_snapshots(provider=collector_onchain, data_type=onchain_checkpoints)。
设计（用户确认）：
  - 只做"聚合统计快照"，不进全量 events（数亿条不适合 SQLite）
  - fail-silent：COLLECTOR_URL / COLLECTOR_API_KEY 未配置或请求失败时整线程空转
  - 鉴权：旧栈中间件只认 X-API-Key header（非 Bearer）
"""
from __future__ import annotations

import logging
import threading
import time
from typing import Any, Optional

import requests

from app.config import (
    COLLECTOR_API_KEY,
    COLLECTOR_URL,
    ONCHAIN_COLLECT_ENABLED,
    ONCHAIN_COLLECT_INTERVAL_SEC,
)
from app.factors import save_snapshot

logger = logging.getLogger(__name__)

PROVIDER = "collector_onchain"
_TIMEOUT = 15


def _headers() -> dict:
    return {"X-API-Key": COLLECTOR_API_KEY} if COLLECTOR_API_KEY else {}


def _fetch_health(base: str) -> list[dict]:
    resp = requests.get(
        f"{base}/api/v2/data/health", headers=_headers(), timeout=_TIMEOUT
    )
    resp.raise_for_status()
    data = (resp.json() or {}).get("data") or {}
    cps = data.get("checkpoints") or []
    return [c for c in cps if isinstance(c, dict)]


def _fetch_stats(base: str) -> list[dict]:
    resp = requests.get(
        f"{base}/api/v2/data/stats", headers=_headers(), timeout=_TIMEOUT
    )
    resp.raise_for_status()
    data = (resp.json() or {}).get("data") or {}
    chains = data.get("chains") or []
    return [c for c in chains if isinstance(c, dict)]


def _merge_checkpoints(cps: list[dict], stats: list[dict]) -> list[dict]:
    """按 chain 合并 /health 与 /stats，输出聚合统计快照 items。"""
    stat_by_chain = {c.get("chain"): c for c in stats if c.get("chain")}
    merged: dict[str, dict] = {}
    for cp in cps:
        chain = cp.get("chain")
        if not chain:
            continue
        st = stat_by_chain.get(chain, {})
        merged[chain] = {
            "chain": chain,
            "collector_name": cp.get("collector_name", ""),
            "last_block": cp.get("last_block", st.get("latest_block")),
            "event_count": st.get("event_count"),
            "status": st.get("status", cp.get("status")),
            "last_fetch_at": cp.get("last_fetch_at", st.get("last_fetch")),
        }
    # stats 中有、health 缺失的链也保留（如 solana 无 checkpoint 但有统计行）
    for chain, st in stat_by_chain.items():
        if chain and chain not in merged:
            merged[chain] = {
                "chain": chain,
                "collector_name": "",
                "last_block": st.get("latest_block"),
                "event_count": st.get("event_count"),
                "status": st.get("status"),
                "last_fetch_at": st.get("last_fetch"),
            }
    return list(merged.values())


class OnchainCollector:
    """周期拉取旧栈链上扫描位点聚合快照 → raw_snapshots。"""

    def __init__(self):
        self._running = False
        self._thread: Optional[threading.Thread] = None

    def start(self):
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(
            target=self._loop, daemon=True, name="onchain-collector"
        )
        self._thread.start()
        logger.info(
            "OnchainCollector started (interval=%ds, enabled=%s, url=%s)",
            ONCHAIN_COLLECT_INTERVAL_SEC, ONCHAIN_COLLECT_ENABLED, COLLECTOR_URL,
        )

    def stop(self):
        self._running = False

    def _loop(self):
        while self._running:
            try:
                self._pull_and_save()
            except Exception:
                logger.warning("OnchainCollector cycle failed", exc_info=True)
            time.sleep(ONCHAIN_COLLECT_INTERVAL_SEC)

    def _pull_and_save(self) -> None:
        if not ONCHAIN_COLLECT_ENABLED:
            return
        base = (COLLECTOR_URL or "").strip().rstrip("/")
        if not base or not COLLECTOR_API_KEY:
            return  # fail-silent：未配置不空转打上游
        try:
            cps = _fetch_health(base)
            stats = _fetch_stats(base)
        except requests.Timeout:
            logger.debug("onchain collector fetch timeout")
            return
        except requests.RequestException as exc:
            logger.debug("onchain collector fetch failed: %s", exc)
            return
        items = _merge_checkpoints(cps, stats)
        if not items:
            return
        save_snapshot(PROVIDER, "onchain_checkpoints", {"items": items})
        logger.info("OnchainCollector onchain_checkpoints: %d chains", len(items))
