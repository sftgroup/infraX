"""OKX ChainOS 行情快照采集（合并旧栈 OKX DEX Market v6）。

后台线程：每 OKX_CHAINOS_COLLECT_INTERVAL_SEC（默认 60s）从旧栈 collector
（COLLECTOR_URL，Express :9101）拉取：
  GET /api/v2/data/market/hot-tokens?chainIndex={id}&limit={n}  → 每链热门代币行情
  GET /api/v2/data/market/index-price?chainIndex={id}&tokenAddress={addr}  → 头部代币指数价格
  GET /api/v2/data/market/candles?chainIndex={id}&tokenAddress={addr}  → 头部代币 K 线（DQ-7）

写入 raw_snapshots：
  provider=okx_chainos, data_type=okx_hot_tokens    → {items:[{chain,symbol,price,volume24h,change24h,...}]}
  provider=okx_chainos, data_type=okx_index_prices  → {items:[{chainIndex,price,time,tokenContractAddress}]}
  provider=okx_chainos, data_type=okx_candles       → {period, items:[{timestamp,open,high,low,close,volume,...}]}

设计：
  - 旧栈已完成 v6 修复（web3.okx.com 官方接口），价格数据自此真实产生
  - 每链独立 fail-silent，单链失败不影响其他链
  - 未配置 COLLECTOR_URL / COLLECTOR_API_KEY 时整线程空转
"""
from __future__ import annotations

import logging
import threading
import time
from typing import Optional

import requests

from app.config import (
    COLLECTOR_API_KEY,
    COLLECTOR_URL,
    OKX_CHAINOS_COLLECT_ENABLED,
    OKX_CHAINOS_COLLECT_INTERVAL_SEC,
    OKX_CHAINS,
    OKX_HOT_LIMIT,
    OKX_INDEX_TOKENS,
    OKX_CANDLE_ENABLED,
    OKX_CANDLE_TOKENS,
    OKX_CANDLE_PERIOD,
    OKX_CANDLE_LIMIT,
)
from app.factors import save_snapshot

logger = logging.getLogger(__name__)

PROVIDER = "okx_chainos"
_TIMEOUT = 15
# OKX v6 对密集 index-price POST 敏感（整轮连打会间歇 500），调用间加间隔
_INDEX_CALL_DELAY = 0.3


def _headers() -> dict:
    return {"X-API-Key": COLLECTOR_API_KEY} if COLLECTOR_API_KEY else {}


def _parse_list(resp: requests.Response) -> list[dict]:
    data = (resp.json() or {}).get("data")
    if not isinstance(data, list):
        return []
    return [d for d in data if isinstance(d, dict)]


class OkxChainosCollector:
    """周期拉取 OKX 热门代币行情 / 指数价格快照 → raw_snapshots。"""

    def __init__(self):
        self._running = False
        self._thread: Optional[threading.Thread] = None

    def start(self):
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(
            target=self._loop, daemon=True, name="okx-chainos-collector"
        )
        self._thread.start()
        logger.info(
            "OkxChainosCollector started (interval=%ds, enabled=%s, chains=%s)",
            OKX_CHAINOS_COLLECT_INTERVAL_SEC, OKX_CHAINOS_COLLECT_ENABLED, OKX_CHAINS,
        )

    def stop(self):
        self._running = False

    def _loop(self):
        while self._running:
            try:
                self._pull_and_save()
            except Exception:
                logger.warning("OkxChainosCollector cycle failed", exc_info=True)
            time.sleep(OKX_CHAINOS_COLLECT_INTERVAL_SEC)

    def _pull_and_save(self) -> None:
        if not OKX_CHAINOS_COLLECT_ENABLED:
            return
        base = (COLLECTOR_URL or "").strip().rstrip("/")
        if not base or not COLLECTOR_API_KEY:
            return  # fail-silent：未配置不空转打上游
        chains = [c.strip() for c in (OKX_CHAINS or "").split(",") if c.strip()]
        if not chains:
            return

        hot_items: list[dict] = []
        index_items: list[dict] = []
        candle_items: list[dict] = []
        for chain in chains:
            try:
                hot = self._fetch_hot_tokens(base, chain)
            except (requests.Timeout, requests.RequestException) as exc:
                logger.debug("okx_chainos hot-tokens chain=%s failed: %s", chain, exc)
                continue
            if not hot:
                continue
            # 旧栈 toplist 忽略 limit 参数（每链返回 ~100），此处按配置截断，
            # 控制 raw_snapshots 行体积（默认 10/链 → 30 项/轮）
            hot = hot[: OKX_HOT_LIMIT]
            hot_items.extend(hot)
            # 头部代币补指数价格（原始高精度字符串价格保留）
            for tok in hot[: OKX_INDEX_TOKENS]:
                addr = tok.get("tokenAddress")
                if not addr:
                    continue
                try:
                    index_items.extend(self._fetch_index_price(base, chain, addr))
                except (requests.Timeout, requests.RequestException) as exc:
                    logger.debug(
                        "okx_chainos index-price chain=%s addr=%s failed: %s",
                        chain, addr, exc,
                    )
                time.sleep(_INDEX_CALL_DELAY)
            # DQ-7: 头部代币补 K 线 candles（经旧栈 /market/candles）
            if OKX_CANDLE_ENABLED:
                for tok in hot[: OKX_CANDLE_TOKENS]:
                    addr = tok.get("tokenAddress")
                    if not addr:
                        continue
                    try:
                        candles = self._fetch_candles(base, chain, addr)
                        for c in candles:
                            c.setdefault("chain", chain)
                            c.setdefault("tokenAddress", addr)
                        candle_items.extend(candles)
                    except (requests.Timeout, requests.RequestException) as exc:
                        logger.debug(
                            "okx_chainos candles chain=%s addr=%s failed: %s",
                            chain, addr, exc,
                        )

        if hot_items:
            save_snapshot(PROVIDER, "okx_hot_tokens", {"items": hot_items})
            logger.info("OkxChainosCollector okx_hot_tokens: %d items", len(hot_items))
        if index_items:
            save_snapshot(PROVIDER, "okx_index_prices", {"items": index_items})
            logger.info(
                "OkxChainosCollector okx_index_prices: %d items", len(index_items)
            )
        if candle_items:
            save_snapshot(PROVIDER, "okx_candles", {
                "period": OKX_CANDLE_PERIOD,
                "items": candle_items,
            })
            logger.info("OkxChainosCollector okx_candles: %d items", len(candle_items))

    def _fetch_hot_tokens(self, base: str, chain: str) -> list[dict]:
        resp = requests.get(
            f"{base}/api/v2/data/market/hot-tokens",
            params={"chainIndex": chain, "limit": OKX_HOT_LIMIT},
            headers=_headers(),
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        items = _parse_list(resp)
        # 归一化：统一 chain 字段，保留价格字段原样
        for it in items:
            it.setdefault("chain", chain)
        return items

    def _fetch_index_price(self, base: str, chain: str, token_address: str) -> list[dict]:
        resp = requests.get(
            f"{base}/api/v2/data/market/index-price",
            params={"chainIndex": chain, "tokenAddress": token_address},
            headers=_headers(),
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        return _parse_list(resp)

    def _fetch_candles(self, base: str, chain: str, token_address: str) -> list[dict]:
        """DQ-7: 经旧栈 /api/v2/data/market/candles 拉取 K 线（返回项含 timestamp/open/high/low/close/volume）。"""
        resp = requests.get(
            f"{base}/api/v2/data/market/candles",
            params={
                "chainIndex": chain,
                "tokenAddress": token_address,
                "period": OKX_CANDLE_PERIOD,
                "limit": OKX_CANDLE_LIMIT,
            },
            headers=_headers(),
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        return _parse_list(resp)
