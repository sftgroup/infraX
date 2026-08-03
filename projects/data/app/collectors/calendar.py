"""Economic calendar collector — periodic fetch → raw_snapshots.

Data sources (auto-detected):
  1. Finnhub /calendar/economic  (if FINNHUB_API_KEY is set) — free tier
  2. Static FOMC schedule        (fallback, hardcoded known dates)

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

from app.factors import save_snapshot
from app.collectors.urls import FINNHUB_CALENDAR_URL

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
    """Generate static FOMC events. Known 2026 dates."""
    now = time.time()
    events = []
    for date_str in _FOMC_2026:
        ts = datetime.strptime(date_str, "%Y-%m-%d").replace(
            hour=14, minute=0, tzinfo=timezone.utc
        ).timestamp()
        if abs(ts - now) < 7 * 86400:
            events.append({
                "name": "FOMC Meeting",
                "timestamp": ts,
                "date": date_str,
                "impact": "high",
                "category": "monetary",
                "source": "static",
            })
    return events


# ── Finnhub ─────────────────────────────────────────────────

def _fetch_finnhub_calendar() -> Optional[list[dict]]:
    """Fetch economic calendar from Finnhub (free tier)."""
    api_key = os.getenv("FINNHUB_API_KEY", "").strip()
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
            filtered.append({
                "name": event_name,
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
        source = "finnhub" if os.getenv("FINNHUB_API_KEY") else "static"
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
        events: Optional[list[dict]] = None

        # Try Finnhub first
        events = _fetch_finnhub_calendar()

        # Fallback: static FOMC dates
        if not events:
            events = _static_fomc_events()
            if events:
                logger.info("CalendarCollector: Finnhub unavailable, using static FOMC (%d event(s))", len(events))
            else:
                logger.warning("CalendarCollector: no calendar events from Finnhub or static source")

        if not events:
            return

        # Keep only future/recent events (within configured window)
        cfg = _get_calendar_config()
        lookahead = cfg.get("lookahead_days", 7)
        now = time.time()
        recent = [e for e in events if abs(e["timestamp"] - now) < lookahead * 86400]

        if recent:
            save_snapshot("calendar", "calendar", {"events": recent})
            logger.info("CalendarCollector: saved %d upcoming event(s)", len(recent))
