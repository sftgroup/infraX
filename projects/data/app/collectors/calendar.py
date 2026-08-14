"""Economic calendar collector — periodic fetch → raw_snapshots.

Data sources (auto-detected, in priority order):
  1. FRED /releases/dates     (if FRED_API_KEY is set) — free tier, US releases
  2. Finnhub /calendar/economic (if FINNHUB_API_KEY is set) — free tier
  3. Static FOMC schedule      (fallback, hardcoded known dates)

Config: reads "calendar" section from data_config.json.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import requests

from app.config import APIKeys
from app.factors import save_snapshot
from app.collectors.urls import FINNHUB_CALENDAR_URL, FRED_RELEASES_DATES_URL

logger = logging.getLogger(__name__)

COLLECT_INTERVAL = int(os.getenv("CALENDAR_COLLECT_INTERVAL_SEC", "600"))
_CONFIG_PATH = os.getenv("DATA_CONFIG_PATH", "data_config.json")


def _load_config() -> dict:
    path = Path(_CONFIG_PATH)
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text())
    except Exception:
        return {}


def _get_calendar_config() -> dict:
    if not hasattr(_get_calendar_config, "_cache"):
        _get_calendar_config._cache = _load_config().get("calendar", {})
    return _get_calendar_config._cache


# ── FOMC 2026 known dates (announced in advance) ────────────

_FOMC_2026 = [
    "2026-01-28",
    "2026-03-18",
    "2026-05-06",
    "2026-06-17",
    "2026-07-29",
    "2026-09-16",
    "2026-10-28",
    "2026-12-16",
]


def _static_fomc_events() -> list[dict]:
    """Generate static FOMC events. Known 2026 dates (future-only + recent)."""
    now = time.time()
    events = []
    for date_str in _FOMC_2026:
        ts = datetime.strptime(date_str, "%Y-%m-%d").replace(
            hour=14, minute=0, tzinfo=timezone.utc
        ).timestamp()
        # 保留未来全部 FOMC（一年 8 次，提前公布）；刚过去的也保留一段以便展示
        if ts >= now - 7 * 86400:
            desc = _event_description("FOMC Meeting")
            events.append({
                "name": "FOMC Meeting",
                "description": desc.get("description"),
                "description_en": desc.get("description_en"),
                "timestamp": ts,
                "date": date_str,
                "impact": "high",
                "category": "monetary",
                "source": "static",
            })
    return events


# ── 事件说明（经济日历指标的解读，中英双语）──────────────────────

_EVENT_DESC: dict[str, dict[str, str]] = {
    "Fed policy (FRED release)": {
        "description": "美联储货币政策决议，影响利率预期与全球风险资产",
        "description_en": "Fed monetary policy decision; moves rate expectations and global risk assets",
    },
    "FOMC Meeting": {
        "description": "美联储议息会议，关注利率决议与点阵图指引",
        "description_en": "FOMC meeting; watch rate decision and dot plot guidance",
    },
    "Fed Interest Rate Decision": {
        "description": "美联储利率决议，加息利空风险资产、降息利多",
        "description_en": "Fed rate decision; hikes pressure risk assets, cuts support them",
    },
    "CPI (FRED release)": {
        "description": "消费者物价指数，核心通胀指标，影响加息预期",
        "description_en": "Consumer Price Index; core inflation gauge that drives rate expectations",
    },
    "CPI MoM": {
        "description": "消费者物价指数（环比），高于预期增强加息预期",
        "description_en": "CPI month-over-month; higher than expected raises rate-hike odds",
    },
    "Core CPI MoM": {
        "description": "核心 CPI（剔除食品与能源，环比），美联储关注指标",
        "description_en": "Core CPI ex food & energy (m/m); key Fed-watched inflation gauge",
    },
    "PPI (FRED release)": {
        "description": "生产者物价指数，上游通胀的先行指标",
        "description_en": "Producer Price Index; leading upstream inflation indicator",
    },
    "PPI MoM": {
        "description": "生产者物价指数（环比），上游价格压力信号",
        "description_en": "Producer Price Index (m/m); signal of upstream price pressure",
    },
    "Employment Situation (FRED release)": {
        "description": "美国非农就业报告（就业/失业/薪资），劳动力市场核心指标",
        "description_en": "US employment report (payrolls/unemployment/wages); core labor market indicator",
    },
    "Nonfarm Payrolls": {
        "description": "非农就业人数变化，衡量就业市场强弱",
        "description_en": "Nonfarm payrolls change; gauges labor market strength",
    },
    "Unemployment Rate": {
        "description": "失业率，劳动力市场健康状况指标",
        "description_en": "Unemployment rate; labor market health indicator",
    },
    "GDP (FRED release)": {
        "description": "国内生产总值，衡量经济增长的核心指标",
        "description_en": "Gross Domestic Product; core economic growth indicator",
    },
    "GDP Growth Rate QoQ": {
        "description": "GDP 季环比增速，反映经济扩张或收缩",
        "description_en": "GDP quarter-over-quarter growth; reflects expansion or contraction",
    },
    "Retail Sales MoM": {
        "description": "零售销售环比，反映消费需求强弱",
        "description_en": "Retail sales (m/m); reflects consumer demand strength",
    },
    "ISM Manufacturing PMI": {
        "description": "ISM 制造业 PMI，50 荣枯线之上为扩张",
        "description_en": "ISM Manufacturing PMI; above 50 signals expansion",
    },
    "ISM Services PMI": {
        "description": "ISM 服务业 PMI，服务业景气度指标",
        "description_en": "ISM Services PMI; services sector activity gauge",
    },
    "Consumer Confidence": {
        "description": "消费者信心指数，前瞻消费支出意愿",
        "description_en": "Consumer confidence; forward-looking spending intent",
    },
}


def _event_description(name: str) -> dict[str, str]:
    return _EVENT_DESC.get(name, {})


# ── FRED ──────────────────────────────────────────────────

def _fetch_fred_calendar() -> Optional[list[dict]]:
    """Fetch release calendar from FRED /releases/dates (free tier).

    返回 {name, timestamp, date, country, impact, category, source:"fred"}。
    配置示例（data_config.json → calendar.fred_releases）:
      [{"release_id": 82, "name": "FOMC Meeting", "impact": "high", "category": "monetary"}, ...]
    时间取发布日 12:00 UTC（FRED 只给日期，不给精确时刻）。
    """
    api_key = APIKeys.rotate("FRED_API_KEY")
    if not api_key:
        return None
    cfg = _get_calendar_config()
    releases = cfg.get("fred_releases", [])
    if not releases:
        return None

    lookahead = cfg.get("lookahead_days", 7)
    now = datetime.now(timezone.utc)
    start = int(now.timestamp() - 14 * 86400)  # 留过去 14 天窗口，覆盖最近发布
    end = int(now.timestamp() + lookahead * 86400)

    events: list[dict] = []
    seen: set[tuple[int, str]] = set()
    for rel in releases:
        rid = rel.get("release_id")
        if not rid:
            continue
        try:
            resp = requests.get(
                FRED_RELEASES_DATES_URL,
                params={
                    "api_key": api_key,
                    "file_type": "json",
                    "release_id": rid,
                    "start": datetime.fromtimestamp(start, tz=timezone.utc).strftime("%Y-%m-%d"),
                    "end": datetime.fromtimestamp(end, tz=timezone.utc).strftime("%Y-%m-%d"),
                },
                timeout=10,
            )
            if resp.status_code != 200:
                logger.warning("FRED calendar fetch failed (release %s): HTTP %s", rid, resp.status_code)
                continue
            raw = resp.json()
            if not isinstance(raw, dict):
                continue
            dates = raw.get("release_dates") or []
            for item in dates:
                date_str = (item or {}).get("date", "")
                try:
                    ts = int(datetime.strptime(date_str, "%Y-%m-%d").replace(
                        hour=12, tzinfo=timezone.utc
                    ).timestamp())
                except Exception:
                    continue
                if ts < start or ts > end:
                    continue
                # 同一 release 同一发布日可能有多条 series 记录，去重
                key = (rid, date_str)
                if key in seen:
                    continue
                seen.add(key)
                desc = _event_description(rel.get("name", ""))
                events.append({
                    "name": rel.get("name", f"FRED Release {rid}"),
                    "description": desc.get("description"),
                    "description_en": desc.get("description_en"),
                    "timestamp": ts,
                    "date": date_str,
                    "country": "US",
                    "impact": rel.get("impact", "medium"),
                    "category": rel.get("category", "macro"),
                    "source": "fred",
                })
        except Exception as exc:
            logger.warning("FRED calendar fetch failed (release %s): %s", rid, exc)
    return events or None


# ── Finnhub ─────────────────────────────────────────────────

def _fetch_finnhub_calendar() -> Optional[list[dict]]:
    """Fetch economic calendar from Finnhub (free tier)."""
    api_key = APIKeys.rotate("FINNHUB_API_KEY")
    if not api_key:
        return None
    cfg = _get_calendar_config()
    event_types = cfg.get("event_types", [])
    lookahead = cfg.get("lookahead_days", 7)

    now = datetime.now(timezone.utc)
    end = int((now.timestamp() + lookahead * 86400))

    try:
        resp = requests.get(
            FINNHUB_CALENDAR_URL,
            params={
                "token": api_key,
                "from": now.strftime("%Y-%m-%d"),
                "to": datetime.fromtimestamp(end, tz=timezone.utc).strftime("%Y-%m-%d"),
            },
            timeout=10,
        )
        if resp.status_code != 200:
            return None
        raw = resp.json()
        if not isinstance(raw, dict):
            return None

        all_events = raw.get("economicCalendar", [])
        if not all_events:
            return None

        # Filter by configured event types
        type_names = {e["name"].lower() for e in event_types}
        filtered = []
        for e in all_events:
            event_name = (e.get("event") or "").strip()
            if event_name.lower() not in type_names:
                continue
            ts_str = e.get("date", "")
            try:
                ts = datetime.strptime(ts_str, "%Y-%m-%d %H:%M:%S").replace(
                    tzinfo=timezone.utc
                ).timestamp()
            except Exception:
                try:
                    ts = float(e.get("time", 0))
                except (TypeError, ValueError):
                    continue
            desc = _event_description(event_name)
            filtered.append({
                "name": event_name,
                "description": desc.get("description"),
                "description_en": desc.get("description_en"),
                "timestamp": ts,
                "date": ts_str,
                "country": e.get("country", "US"),
                "impact": e.get("impact", "medium"),
                "forecast": e.get("forecast"),
                "previous": e.get("previous"),
                "source": "finnhub",
            })
        return filtered if filtered else None
    except Exception as exc:
        logger.warning("Finnhub calendar fetch failed: %s", exc)
    return None


# ── Moomoo（MM-13：get_economic_calendar，免 key，含 consensus/actual） ──

def _fetch_moomoo_calendar() -> Optional[list[dict]]:
    """moomoo 经济日历：title/star/previous/consensus/actual（免 key）。

    与 FRED/Finnhub 并存：数据并入 events（source="moomoo"），优先使用
    consensus（一致预期），FRED/Finnhub 无此字段。
    """
    try:
        from app.data_sources.moomoo_extra import fetch_economic_calendar

        cfg = _get_calendar_config()
        lookahead = cfg.get("lookahead_days", 7)
        now = datetime.now(timezone.utc)
        start = (now - timedelta(days=7)).date().isoformat()
        end = (now + timedelta(days=lookahead)).date().isoformat()
        rows = fetch_economic_calendar(start, end)
        if not rows:
            return None
        events = []
        for r in rows:
            ts = None
            ts_raw = str(r.get("time") or "")
            try:
                ts = float(ts_raw)
            except (TypeError, ValueError):
                try:
                    ts = datetime.strptime(ts_raw[:19], "%Y-%m-%d %H:%M:%S").replace(
                        tzinfo=timezone.utc
                    ).timestamp()
                except Exception:
                    ts = None
            if ts is None:
                continue
            star = str(r.get("star") or "").upper()
            impact = {
                "HIGH": "high", "H": "high", "5": "high", "4": "high",
                "MEDIUM": "medium", "M": "medium", "3": "medium", "2": "medium",
                "LOW": "low", "L": "low", "1": "low",
            }.get(star, "medium")
            events.append({
                "name": r.get("title", ""),
                "timestamp": ts,
                "date": datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d"),
                "country": r.get("country", "US"),
                "impact": impact,
                "category": "macro",
                "forecast": r.get("consensus"),
                "previous": r.get("previous"),
                "actual": r.get("actual"),
                "source": "moomoo",
            })
        return events or None
    except Exception as exc:
        logger.debug("Moomoo calendar branch skipped: %s", exc)
        return None


# ── Collector ───────────────────────────────────────────────

class CalendarCollector:
    """Periodically fetch economic calendar events → raw_snapshots."""

    def __init__(self):
        self._running = False
        self._thread: Optional[threading.Thread] = None

    def start(self):
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._loop, daemon=True, name="calendar-collector")
        self._thread.start()
        cfg = _get_calendar_config()
        if APIKeys.is_configured("FRED_API_KEY") and cfg.get("fred_releases"):
            source = "fred"
        elif APIKeys.is_configured("FINNHUB_API_KEY"):
            source = "finnhub"
        else:
            source = "static"
        logger.info("CalendarCollector started (interval=%ds, source=%s)", COLLECT_INTERVAL, source)

    def stop(self):
        self._running = False

    def _loop(self):
        while self._running:
            try:
                self._collect()
            except Exception:
                logger.warning("Calendar collector cycle failed", exc_info=True)
            time.sleep(COLLECT_INTERVAL)

    def _collect(self):
        # 数据源策略：FRED（真实近期发布）+ static（未来 FOMC，提前公布）并集。
        # FRED 免费 API 只返回已发布/近排期记录，不含遥远未来；static 补未来 FOMC。
        events: list[dict] = []

        # MM-13：moomoo 经济日历（免 key，含 consensus/actual）→ 并入 events
        moomoo_events = _fetch_moomoo_calendar()
        if moomoo_events:
            logger.info("CalendarCollector: moomoo source (%d event(s))", len(moomoo_events))
            events.extend(moomoo_events)

        fred_events = _fetch_fred_calendar()
        if fred_events:
            logger.info("CalendarCollector: FRED source (%d event(s))", len(fred_events))
            events.extend(fred_events)
        else:
            finnhub_events = _fetch_finnhub_calendar()
            if finnhub_events:
                logger.info("CalendarCollector: Finnhub source (%d event(s))", len(finnhub_events))
                events.extend(finnhub_events)

        static_events = _static_fomc_events()
        if static_events:
            # 去重：FRED 若已含同一 FOMC 日则不重复加（按 date 判重）
            fred_dates = {e["date"] for e in events if e.get("category") == "monetary"}
            add = [e for e in static_events if e["date"] not in fred_dates]
            if add:
                logger.info("CalendarCollector: + static future FOMC (%d event(s))", len(add))
            events.extend(add)

        if not events:
            logger.warning("CalendarCollector: no calendar events from FRED, Finnhub or static source")
            return

        # Keep future events (within configured window) + recent past (发布历史)
        cfg = _get_calendar_config()
        lookahead = cfg.get("lookahead_days", 7)
        now = time.time()
        recent = [e for e in events if e["timestamp"] > now - lookahead * 86400]

        if recent:
            save_snapshot("calendar", "calendar", {"events": recent})
            logger.info("CalendarCollector: saved %d upcoming event(s)", len(recent))
