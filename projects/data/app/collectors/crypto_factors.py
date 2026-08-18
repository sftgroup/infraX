"""加密衍生品因子采集器（GX-3.5.3 资金费率数据面）。

周期拉取核心币种衍生品指标（funding_rate / open_interest /
open_interest_change_24h / long_short_ratio，Coinglass 主源 + Binance 兜底）
→ db_cache `collector:crypto_factors:{sym}`（ttl 300s），供
`/factors/crypto-derivatives` 端点与 ml-service 图谱引擎 FundingRateAdapter 读取。

设计（对齐 MoomooExtraCollector）：
  - daemon 线程 + interval（默认 300s，与缓存 ttl 一致）；
  - fetch 层 fail-silent（外部 API 异常/限流 → 该标的跳过，不抛错）；
  - 单标的失败不影响其余标的。
"""
from __future__ import annotations

import threading
import time
from typing import Callable

from app.utils.logger import get_logger

logger = get_logger(__name__)

# 核心衍生品标的（图谱引擎 crypto 节点域）
_CRYPTO_SYMBOLS = ["BTC", "ETH", "SOL", "XRP"]

_DEFAULT_INTERVAL = int(__import__("os").getenv("CRYPTO_FACTORS_INTERVAL_SEC", "300"))


class CryptoFactorsCollector:
    """加密衍生品因子采集器：周期刷新 → db_cache collector:crypto_factors:*。"""

    def __init__(self):
        self._running = False
        self._thread: threading.Thread | None = None

    def start(self):
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(
            target=self._run_loop, daemon=True, name="crypto-factors",
        )
        self._thread.start()
        logger.info("CryptoFactorsCollector started (interval=%ds, symbols=%s)",
                    _DEFAULT_INTERVAL, ",".join(_CRYPTO_SYMBOLS))

    def stop(self):
        self._running = False

    def _run_loop(self):
        while self._running:
            try:
                n = self.collect()
                if n:
                    logger.info("CryptoFactorsCollector: refreshed %d symbol(s)", n)
            except Exception:
                logger.warning("CryptoFactorsCollector cycle failed", exc_info=True)
            time.sleep(_DEFAULT_INTERVAL)

    def collect(self) -> int:
        """刷新一轮衍生品因子，返回成功落库的标的数量。"""
        try:
            from app.market_data.crypto import MarketDataCollector
        except Exception as exc:  # 依赖缺失/import 链异常 → fail-silent
            logger.warning("CryptoFactorsCollector deps unavailable: %s", exc)
            return 0
        collector = MarketDataCollector()
        ok = 0
        for sym in _CRYPTO_SYMBOLS:
            try:
                raw = collector.refresh_crypto_factors(sym, {}, [])
                if raw:
                    ok += 1
            except Exception:
                logger.debug("CryptoFactorsCollector %s failed", sym, exc_info=True)
        return ok
