"""moomoo 增量数据采集器（MM-5/8/11~15，P2）。

独立采集器（provider=moomoo_*，与 FRED/NewsAPI 等并存，互不影响）：
  - mm_capital_flow  资金流（MM-8.1，分钟级，600s）
  - mm_basicinfo     美股自选池候选（MM-8.2，6h）
  - mm_f10           基本面/评级/估值（MM-11.2，6h；financials 权限待生产验证）
  - mm_smart_money   卖空/机构/内部人/ARK（MM-12.2，6h）
  - mm_hot           热力/榜单（MM-14.2，900s；榜单权限待生产验证）
  - mm_screen        板块/产业链（MM-15.2，6h）
  - 新闻（MM-5）在 collectors/news.py 增 moomoo 分支；经济日历（MM-13）
    在 collectors/calendar.py 增 moomoo 分支——见各自文件。

设计（fail-silent）：
  - 每组一个 daemon 线程 + 独立 interval，任何一组失败不影响其他组；
  - fetch 层（app/data_sources/moomoo_extra.py）已 fail-silent，此处仅落库；
  - 生产验证（MM-10.1 降级演练）：OpenD 停 → 全部组静默跳过。
"""
from __future__ import annotations

import threading
import time
from typing import Callable, Optional

from app.config import MOOMOO_EXTRA_ENABLED
from app.data_sources import moomoo_extra as mx
from app.factors import save_snapshot
from app.utils.logger import get_logger

logger = get_logger(__name__)

# 资金流/热力标的（美股核心池，取自 data_config multi_kline.us_stocks）
_FLOW_SYMBOLS = ["SPY", "QQQ", "AAPL", "MSFT", "NVDA"]
# F10 覆盖标的
_F10_SYMBOLS = ["AAPL", "MSFT", "NVDA", "TSLA", "SPY"]

_HOUR = 3600


class MoomooExtraCollector:
    """moomoo 增量数据采集器：多线程分组采集 → raw_snapshots。"""

    def __init__(self):
        self._running = False
        self._threads: list[threading.Thread] = []

    # ── 生命周期 ──────────────────────────────────────────

    def start(self):
        if self._running:
            return
        self._running = True
        groups = [
            ("mm_capital_flow", 600, self._collect_capital_flow),
            ("mm_basicinfo", 6 * _HOUR, self._collect_basicinfo),
            ("mm_f10", 6 * _HOUR, self._collect_f10),
            ("mm_smart_money", 6 * _HOUR, self._collect_smart_money),
            ("mm_hot", 900, self._collect_hot),
            ("mm_screen", 6 * _HOUR, self._collect_screen),
            ("mm_quota", 6 * _HOUR, self._collect_quota),  # MM-10.2 额度监控
        ]
        for name, interval, fn in groups:
            t = threading.Thread(
                target=self._run_group, args=(name, interval, fn),
                daemon=True, name=f"moomoo-{name}",
            )
            t.start()
            self._threads.append(t)
        logger.info("MoomooExtraCollector started: %d groups", len(groups))

    def stop(self):
        self._running = False

    def _run_group(self, name: str, interval: int, fn: Callable[[], int]):
        """单组循环：首轮立即采集，异常不退出，按 interval 休眠。"""
        while self._running:
            try:
                n = fn()
                if n:
                    logger.info("MoomooExtraCollector %s: saved %d record(s)", name, n)
            except Exception:
                logger.warning("MoomooExtraCollector %s cycle failed", name, exc_info=True)
            time.sleep(interval)

    # ── 各分组采集（返回落库记录数，0=无数据） ────────────

    def _collect_capital_flow(self) -> int:
        if not MOOMOO_EXTRA_ENABLED:
            return 0
        total = 0
        for sym in _FLOW_SYMBOLS:
            rows = mx.fetch_capital_flow(sym, "usstock")
            if not rows:
                continue
            latest = rows[-1] if rows else {}
            save_snapshot(
                provider="moomoo_capital_flow",
                data_type="mm_capital_flow",
                data={"symbol": sym, "count": len(rows),
                      "latest": latest, "flow": rows[-60:]},  # 最近 60 分钟
                symbol=sym,
            )
            total += 1
        return total

    def _collect_basicinfo(self) -> int:
        if not MOOMOO_EXTRA_ENABLED:
            return 0
        rows = mx.fetch_stock_basicinfo("US", max_count=3000)
        if not rows:
            return 0
        save_snapshot(
            provider="moomoo_basicinfo",
            data_type="mm_stock_basicinfo",
            data={"market": "US", "count": len(rows), "stocks": rows},
            symbol="",
        )
        return len(rows)

    def _collect_f10(self) -> int:
        if not MOOMOO_EXTRA_ENABLED:
            return 0
        total = 0
        for sym in _F10_SYMBOLS:
            code = f"US.{sym}"
            entry = {"symbol": sym, "code": code}
            fin = mx.fetch_financials(code)
            if fin:
                entry["financials"] = fin[:2]  # 最新 2 期
            consensus = mx.fetch_research_consensus(code)
            if consensus:
                entry["analyst_consensus"] = consensus
            val = mx.fetch_valuation(code)
            if val:
                entry["valuation"] = val[:5]
            if len(entry) <= 2:
                continue  # 无任何 F10 数据（权限/无数据）→ 跳过
            save_snapshot(
                provider="moomoo_f10",
                data_type="mm_f10",
                data=entry,
                symbol=sym,
            )
            total += 1
        return total

    def _collect_smart_money(self) -> int:
        if not MOOMOO_EXTRA_ENABLED:
            return 0
        data: dict = {"at": int(time.time() * 1000)}
        # 卖空/内部人（按标的）
        for sym in _F10_SYMBOLS:
            code = f"US.{sym}"
            si = mx.fetch_short_interest(code)
            if si:
                data[f"short_interest_{sym}"] = si[:5]
            dv = mx.fetch_daily_short_volume(code)
            if dv:
                data[f"daily_short_volume_{sym}"] = dv[:5]
            it = mx.fetch_insider_trades(code)
            if it:
                data[f"insider_trades_{sym}"] = it[:5]
        # 机构/ARK（市场级）
        inst = mx.fetch_institution_holdings("US", count=20)
        if inst:
            data["institution_holdings"] = inst
        ark = mx.fetch_ark_holdings(count=20)
        if ark:
            data["ark_holdings"] = ark
        if len(data) <= 1:
            return 0
        save_snapshot(
            provider="moomoo_smart_money",
            data_type="mm_smart_money",
            data=data,
            symbol="",
        )
        return 1

    def _collect_hot(self) -> int:
        if not MOOMOO_EXTRA_ENABLED:
            return 0
        hm = mx.fetch_heat_map("US", count=30)
        if not hm:
            return 0
        data: dict = {"at": int(time.time() * 1000), "heat_map": hm}
        hot = mx.fetch_hot_list("US", count=20)  # 本机无权限 → 空，生产验证后可开
        if hot:
            data["hot_list"] = hot
        save_snapshot(
            provider="moomoo_hot",
            data_type="mm_hot",
            data=data,
            symbol="",
        )
        return 1

    def _collect_screen(self) -> int:
        if not MOOMOO_EXTRA_ENABLED:
            return 0
        plates = mx.fetch_plate_list("US", "INDUSTRY")
        chains = mx.fetch_industrial_chains("US", count=20)
        if not plates and not chains:
            return 0
        save_snapshot(
            provider="moomoo_screen",
            data_type="mm_screen",
            data={
                "at": int(time.time() * 1000),
                "plates": plates[:100],
                "industrial_chains": chains,
            },
            symbol="",
        )
        return 1

    def _collect_quota(self) -> int:
        """额度监控（MM-10.2）：订阅/历史K线额度 → raw_snapshots + 超限告警日志。

        fetch_quota_status 内部已对 >=90% 使用率打 warning 日志；此处落库供
        观测（raw_snapshots provider=moomoo_quota）。
        """
        if not MOOMOO_EXTRA_ENABLED:
            return 0
        status = mx.fetch_quota_status()
        if not status:
            return 0
        save_snapshot(
            provider="moomoo_quota",
            data_type="mm_quota",
            data=status,
            symbol="",
        )
        return 1
