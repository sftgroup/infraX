"""moomoo 宏观指标采集器（MM-4，FRED 的 moomoo 增强）。

独立于 FRED MacroHistoryCollector：moomoo get_macro_indicator_list/history
免 API key（账号已登录 OpenD），**含 predict_value（分析师一致预期）与
release_time（发布时间）**——FRED 无预测值，是本源的核心增量。

落库（双写）：
  - macro_history 表：series_id 用 `MM:{region}:{name}` 命名空间
    （如 `MM:US:CPI`，name 去括号去空格、US 前缀裁剪），value + predict_value；
  - raw_snapshots 表：provider=`moomoo_macro`，data_type=`mm_macro_{region}`，
    含 release_time/previous_value/unit_type 全字段，供投研/FinBERT 消费。

行为：
  - 启动首轮回填 MOOMOO_MACRO_BACKFILL（默认 400）条观测，之后每
    MOOMOO_MACRO_INTERVAL_SEC（默认 6h，对齐 FRED 采集器）刷新
    MOOMOO_MACRO_REFRESH（默认 90）条；
  - fail-silent：SDK 未安装 / OpenD 未启动 / 无权限 → 整线程空转，不影响其他采集器；
  - 与 FRED 并存：/macro/history 按 series_id 过滤，moomoo 默认优先、FRED 兜底。
"""

from __future__ import annotations

import logging
import re
import threading
import time
from typing import Any, Optional

from app.config import (
    MOOMOO_HOST,
    MOOMOO_MACRO_BACKFILL,
    MOOMOO_MACRO_ENABLED,
    MOOMOO_MACRO_INTERVAL_SEC,
    MOOMOO_PORT,
    MOOMOO_MACRO_REFRESH,
    MOOMOO_MACRO_REGIONS,
)
from app.factors import save_macro_observations, save_snapshot

logger = logging.getLogger(__name__)

_REGIONS = [r.strip().upper() for r in MOOMOO_MACRO_REGIONS.split(",") if r.strip()]


def _slug_name(region: str, name: str) -> str:
    """indicator name → series_id 后缀（MM:US:CPI 可读命名）。

    "US CPI (YoY)" → "US CPI" → 裁掉 US 前缀 → "CPI"；
    非字母数字（含中文/空格）转下划线并折叠，保持 ASCII 稳定。
    """
    s = re.sub(r"\([^)]*\)", "", str(name or "")).strip()  # 去掉 (YoY)/(MoM) 等后缀
    if region == "US" and s.upper().startswith("US "):
        s = s[3:].strip()
    s = re.sub(r"[^A-Za-z0-9]+", "_", s).strip("_")
    return s or "INDICATOR"


def _to_float(v) -> Optional[float]:
    """moomoo 宏观值可能为 'N/A' 字符串或 float。"""
    try:
        if v is None or str(v).strip().upper() in ("N/A", "NA", ""):
            return None
        f = float(v)
        return None if f != f else f
    except (TypeError, ValueError):
        return None


def _parse_date(v) -> str:
    """data_time（YYYY-MM-DD 或带时分秒）→ 日期字符串。"""
    s = str(v or "").strip()
    return s[:10]


def _fetch_macro_indicators(ctx, sdk, region: str) -> list[dict]:
    """get_macro_indicator_list(region) → [{indicator_id, name, category_name}]。"""
    try:
        ret, data = ctx.get_macro_indicator_list(region)
        if ret != sdk.RET_OK or data is None:
            logger.debug("moomoo macro list %s ret=%s %s", region, ret, data)
            return []
        out = []
        n = len(data)
        for i in range(n):
            row = data.iloc[i] if hasattr(data, "iloc") else data[i]
            out.append({
                "indicator_id": row.get("indicator_id") if isinstance(row, dict) else row["indicator_id"],
                "name": row.get("name") if isinstance(row, dict) else row["name"],
                "category_name": row.get("category_name") if isinstance(row, dict) else row["category_name"],
            })
        return out
    except Exception as exc:
        logger.debug("moomoo macro list %s failed: %s", region, exc)
        return []


def _fetch_macro_history(ctx, sdk, indicator_id: int, max_count: int) -> Optional[list[dict]]:
    """get_macro_indicator_history → [{date, value, predict_value, release_time, ...}]。"""
    try:
        ret, data = ctx.get_macro_indicator_history(indicator_id, max_count=max_count)
        if ret != sdk.RET_OK or data is None or len(data) == 0:
            return None
        out = []
        n = len(data)
        for i in range(n):
            row = data.iloc[i] if hasattr(data, "iloc") else data[i]
            get = (lambda k: row.get(k)) if isinstance(row, dict) else (lambda k: row[k])
            out.append({
                "date": _parse_date(get("data_time")),
                "value": _to_float(get("value")),
                "predict_value": _to_float(get("predict_value")),
                "previous_value": _to_float(get("previous_value")),
                "release_time": str(get("release_time") or ""),
                "unit_type": str(get("unit_type") or ""),
            })
        return out
    except Exception as exc:
        logger.debug("moomoo macro history %s failed: %s", indicator_id, exc)
        return None


class MoomooMacroCollector:
    """周期拉取 moomoo 宏观指标 → macro_history + raw_snapshots。"""

    def __init__(self):
        self._running = False
        self._thread: Optional[threading.Thread] = None
        self._backfilled = False

    def start(self):
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._loop, daemon=True, name="moomoo-macro-collector")
        self._thread.start()
        logger.info(
            "MoomooMacroCollector started (regions=%s, interval=%ds, backfill=%d, refresh=%d)",
            _REGIONS, MOOMOO_MACRO_INTERVAL_SEC, MOOMOO_MACRO_BACKFILL, MOOMOO_MACRO_REFRESH,
        )

    def stop(self):
        self._running = False

    def _loop(self):
        while self._running:
            try:
                self._collect(backfill=not self._backfilled)
                self._backfilled = True
            except Exception:
                logger.warning("MoomooMacroCollector cycle failed", exc_info=True)
            time.sleep(MOOMOO_MACRO_INTERVAL_SEC)

    def _collect(self, backfill: bool = False) -> int:
        if not MOOMOO_MACRO_ENABLED:
            return 0
        try:
            import moomoo as sdk
        except Exception as exc:
            logger.debug("moomoo SDK not installed: %s", exc)
            return 0
        try:
            ctx = sdk.OpenQuoteContext(host=MOOMOO_HOST, port=MOOMOO_PORT)
        except Exception as exc:
            logger.warning("moomoo OpenD connect failed: %s", exc)
            return 0
        try:
            return self._collect_with_ctx(ctx, sdk, backfill)
        finally:
            try:
                ctx.close()
            except Exception:
                pass

    def _collect_with_ctx(self, ctx, sdk, backfill: bool) -> int:
        max_count = MOOMOO_MACRO_BACKFILL if backfill else MOOMOO_MACRO_REFRESH
        total = 0
        for region in _REGIONS:
            indicators = _fetch_macro_indicators(ctx, sdk, region)
            if not indicators:
                continue
            latest: dict[str, Any] = {}
            for ind in indicators:
                iid = ind["indicator_id"]
                name = ind["name"] or f"INDICATOR_{iid}"
                hist = _fetch_macro_history(ctx, sdk, iid, max_count)
                if not hist:
                    continue
                series_id = f"MM:{region}:{_slug_name(region, name)}"
                obs = [{"date": h["date"], "value": h["value"], "predict_value": h["predict_value"]}
                       for h in hist]
                n = save_macro_observations(series_id, obs)
                total += n
                latest[name] = {
                    "series_id": series_id,
                    "indicator_id": iid,
                    "category": ind["category_name"],
                    "unit_type": hist[0].get("unit_type", ""),
                    "latest": {
                        "data_time": hist[0].get("date"),
                        "value": hist[0].get("value"),
                        "predict_value": hist[0].get("predict_value"),
                        "previous_value": hist[0].get("previous_value"),
                        "release_time": hist[0].get("release_time"),
                    },
                }
            if latest:
                # 全字段快照（含 release_time/unit_type），provider=moomoo_macro
                save_snapshot(
                    provider="moomoo_macro",
                    data_type=f"mm_macro_{region}",
                    data={"region": region, "indicators": latest},
                    symbol="",
                )
        if total:
            logger.info("MoomooMacroCollector: saved %d observation(s) (%s)",
                        total, "backfill" if backfill else "refresh")
        return total
