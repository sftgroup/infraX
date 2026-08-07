"""FRED 宏观历史采集器 — 回填 1 年观测值 + 周期增量更新。

独立于 us_indicators 单点快照：本采集器把 FRED 观测值**序列**落库到
macro_history 表（series_id × date 唯一），供宏观历史/趋势/ML 特征消费。

数据源：FRED /series/observations（免费 key，不限量观测值）。
系列配置：data_config.json → macro.fred_series（与 us_indicators 同源）。

行为：
  - 启动时回填最近 MACRO_HISTORY_BACKFILL_DAYS 天（默认 365）的观测值
  - 每 MACRO_HISTORY_INTERVAL_SEC（默认 6h）增量拉取最近
    MACRO_HISTORY_REFRESH_DAYS 天（默认 35）做幂等 upsert
  - fail-silent：FRED_API_KEY 未配置 / 请求失败时整线程空转，不影响其他采集器
"""

from __future__ import annotations

import logging
import os
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Optional

import requests

from app.config import APIKeys
from app.factors import macro_series_map, save_macro_observations
from app.collectors.urls import FRED_OBSERVATIONS_URL

logger = logging.getLogger(__name__)

BACKFILL_DAYS = int(os.getenv("MACRO_HISTORY_BACKFILL_DAYS", "400"))
REFRESH_DAYS = int(os.getenv("MACRO_HISTORY_REFRESH_DAYS", "35"))
INTERVAL_SEC = int(os.getenv("MACRO_HISTORY_INTERVAL_SEC", str(6 * 3600)))
_TIMEOUT = 15

# Fear & Greed 日频历史（alternative.me，免 key；macro_history 系列 id 用 FNG）
FNG_HISTORY_URL = "https://api.alternative.me/fng/"


def _fetch_fred_series(series_id: str, start_date: str, end_date: str) -> Optional[list[dict]]:
    """拉取单个 FRED 系列观测值（升序 [{date, value}]）。失败返回 None。"""
    api_key = APIKeys.rotate("FRED_API_KEY")
    if not api_key:
        return None
    try:
        resp = requests.get(
            FRED_OBSERVATIONS_URL,
            params={
                "series_id": series_id,
                "api_key": api_key,
                "file_type": "json",
                "sort_order": "asc",
                "observation_start": start_date,
                "observation_end": end_date,
            },
            timeout=_TIMEOUT,
        )
        if resp.status_code != 200:
            logger.warning("FRED %s fetch failed: HTTP %s", series_id, resp.status_code)
            return None
        raw = resp.json()
        obs = raw.get("observations") or []
        result = []
        for o in obs:
            val = o.get("value", "")
            if val and val != ".":
                try:
                    result.append({"date": o["date"], "value": float(val)})
                except (TypeError, ValueError):
                    continue
        return result or None
    except Exception as exc:
        logger.warning("FRED %s fetch failed: %s", series_id, exc)
        return None


def _fetch_fng_history(start_date: str, end_date: str) -> Optional[list[dict]]:
    """alternative.me Fear & Greed 日频历史（免 key，limit=365 天）。

    返回 [{date, value}]（value ∈ [0,100]）或 None；与 FRED 观测同构，
    落库 macro_history series_id='FNG'，供 /factors/history 的 fear_greed 合并。
    """
    try:
        resp = requests.get(
            FNG_HISTORY_URL,
            params={"limit": 365, "format": "json"},
            timeout=_TIMEOUT,
        )
        if resp.status_code != 200:
            logger.warning("FNG fetch failed: HTTP %s", resp.status_code)
            return None
        items = resp.json().get("data") or []
        start_ts = int(datetime.strptime(start_date, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp())
        end_ts = int(datetime.strptime(end_date, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp())
        result: list[dict] = []
        for item in items:
            try:
                ts = int(item.get("timestamp") or 0)
                if not (start_ts <= ts <= end_ts):
                    continue
                val = float(item.get("value"))
                date_str = datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d")
                result.append({"date": date_str, "value": val})
            except (TypeError, ValueError):
                continue
        return result or None
    except Exception as exc:
        logger.warning("FNG fetch failed: %s", exc)
        return None


class MacroHistoryCollector:
    """周期拉取 FRED 宏观历史 → macro_history 表。"""

    def __init__(self):
        self._running = False
        self._thread: Optional[threading.Thread] = None
        self._backfilled = False

    def start(self):
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._loop, daemon=True, name="macro-history-collector")
        self._thread.start()
        logger.info(
            "MacroHistoryCollector started (interval=%ds, backfill=%dd, refresh=%dd)",
            INTERVAL_SEC, BACKFILL_DAYS, REFRESH_DAYS,
        )

    def stop(self):
        self._running = False

    def _loop(self):
        while self._running:
            try:
                self._collect(backfill=not self._backfilled)
                self._backfilled = True
            except Exception:
                logger.warning("MacroHistoryCollector cycle failed", exc_info=True)
            time.sleep(INTERVAL_SEC)

    def _collect(self, backfill: bool = False) -> int:
        if not APIKeys.is_configured("FRED_API_KEY"):
            return 0
        series = macro_series_map()
        if not series:
            return 0

        now = datetime.now(timezone.utc)
        if backfill:
            start = now - timedelta(days=max(BACKFILL_DAYS, REFRESH_DAYS))
            logger.info("MacroHistoryCollector: backfilling %d FRED series since %s",
                        len(series), start.strftime("%Y-%m-%d"))
        else:
            start = now - timedelta(days=REFRESH_DAYS)
        end = now + timedelta(days=1)
        start_str = start.strftime("%Y-%m-%d")
        end_str = end.strftime("%Y-%m-%d")

        total = 0
        for series_id in series:
            obs = _fetch_fred_series(series_id, start_str, end_str)
            if not obs:
                continue
            n = save_macro_observations(series_id, obs)
            total += n
        # Fear & Greed 日频历史（alternative.me，非 FRED；落库 series_id='FNG'）
        fng = _fetch_fng_history(start_str, end_str)
        if fng:
            total += save_macro_observations("FNG", fng)
        if total:
            logger.info("MacroHistoryCollector: saved %d observation(s) (%s)",
                        total, "backfill" if backfill else "refresh")
        return total
