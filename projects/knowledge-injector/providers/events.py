"""重大事件检测。

使用搜索引擎（NewsAPI）搜索近期事件新闻，
通过正则模式匹配判断事件类型和严重程度。

事件类型:
  - war_conflict: 战争/武装冲突
  - pandemic: 疫情/病毒
  - natural_disaster: 自然灾害
  - policy_shock: 政策突变/制裁
  - financial_crisis: 金融危机

严重程度:
  - severe: 直接影响市场的重大事件
  - moderate: 可能影响市场的事件
  - low: 值得关注但影响有限

失败返回空列表（无事件也返回空列表，不是 None）。
"""
from __future__ import annotations

import logging
import re
from typing import Any

import requests

logger = logging.getLogger(__name__)

# ─── 事件检测模式 ────────────────────────────────────

_EVENT_PATTERNS: dict[str, list[re.Pattern]] = {
    "war_conflict": [
        re.compile(r"\b(?:war|wars|warfare|wartime)\b", re.I),
        re.compile(r"\b(?:invasion|invaded|invading|invade)\b", re.I),
        re.compile(r"\b(?:airstrike|air\s*strikes?|missile\s+strike)\b", re.I),
        re.compile(r"\b(?:military\s+(?:attack|conflict|action|coup))\b", re.I),
        re.compile(r"\b(?:ceasefire\s+(?:broken|violated|collapse))\b", re.I),
        re.compile(r"\b(?:sanctions?\s+(?:on|against|targeting|hit))\b", re.I),
        re.compile(r"\b(?:地缘政治|战争|军事(?:冲突|打击|行动)|制裁|空袭|导弹)\b"),
    ],
    "pandemic": [
        re.compile(r"\b(?:pandemic|epidemic|outbreak|quarantine|lockdown)\b", re.I),
        re.compile(r"\b(?:新型病毒|疫情|大流行|封城|隔离)\b"),
    ],
    "natural_disaster": [
        re.compile(r"\b(?:earthquake|tsunami|hurricane|flood|wildfire)\b", re.I),
        re.compile(r"\b(?:地震|海啸|洪水|山火|台风)\b"),
    ],
    "policy_shock": [
        re.compile(r"\b(?:tariff|trade\s+war|nationalization|expropriation)\b", re.I),
        re.compile(r"\b(?:emergency\s+(?:meeting|rate\s+hike|declaration))\b", re.I),
        re.compile(r"\b(?:关税|贸易战|国有化|紧急(?:会议|加息))\b"),
    ],
    "financial_crisis": [
        re.compile(r"\b(?:bank\s+(?:run|failure|collapse)|systemic\s+risk)\b", re.I),
        re.compile(r"\b(?:credit\s+(?:crunch|freeze)|liquidity\s+crisis)\b", re.I),
    ],
}

# 严重程度关键词（粗匹配增强）
_SEVERE_KEYWORDS = [
    "ukraine", "russia", "israel", "gaza", "iran", "north korea", "taiwan",
    "explosion", "attack", "casualties", "death toll", "evacuate",
    "nuclear", "chemical weapon", "biological",
]


def _classify_severity(text: str) -> str:
    """根据事件文本判断严重程度。"""
    low = text.lower()
    for kw in _SEVERE_KEYWORDS:
        if kw in low:
            return "severe"
    # 匹配到多个关键词也视为 severe
    match_count = 0
    for patterns in _EVENT_PATTERNS.values():
        for p in patterns:
            if p.search(text):
                match_count += 1
                break
    if match_count >= 2:
        return "severe"
    if match_count == 1:
        return "moderate"
    return "low"


def _detect_event_type(text: str) -> str | None:
    """判断事件类型。"""
    for event_type, patterns in _EVENT_PATTERNS.items():
        for p in patterns:
            if p.search(text):
                return event_type
    return None


# ─── 搜索引擎查询 ────────────────────────────────────


def _search_news(query: str, max_results: int = 3) -> list[dict[str, Any]]:
    """用 NewsAPI 搜索新闻。无 API Key 时返回空列表。"""
    import os

    api_key = os.getenv("NEWSAPI_KEY", "")
    if not api_key:
        # 尝试用 Finnhub 替代
        api_key = os.getenv("FINNHUB_API_KEY", "")
        if api_key:
            return _search_finnhub(query, max_results)
        return []

    try:
        resp = requests.get(
            "https://newsapi.org/v2/everything",
            params={
                "q": query,
                "language": "en",
                "sortBy": "publishedAt",
                "pageSize": max_results,
            },
            headers={"X-Api-Key": api_key},
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()
        articles = data.get("articles", [])
        results = []
        for art in articles[:max_results]:
            title = (art.get("title") or "").strip()
            desc = (art.get("description") or "").strip()
            if title:
                results.append({
                    "title": title,
                    "snippet": desc,
                    "source": art.get("source", {}).get("name", "NewsAPI"),
                    "url": art.get("url", ""),
                    "published_at": art.get("publishedAt", ""),
                })
        return results
    except Exception:
        logger.debug("NewsAPI search failed", exc_info=True)
        return []


def _search_finnhub(query: str, max_results: int = 3) -> list[dict[str, Any]]:
    """用 Finnhub 新闻作为事件检测的备选。"""
    import os

    api_key = os.getenv("FINNHUB_API_KEY", "")
    if not api_key:
        return []
    try:
        resp = requests.get(
            "https://finnhub.io/api/v1/news",
            params={"category": "general", "token": api_key},
            timeout=10,
        )
        resp.raise_for_status()
        articles = resp.json()
        results = []
        for art in articles[:max_results * 2]:
            headline = (art.get("headline") or "").strip()
            summary = (art.get("summary") or "").strip()
            combined = f"{headline} {summary}"
            if _detect_event_type(combined):
                results.append({
                    "title": headline,
                    "snippet": summary[:200],
                    "source": art.get("source", "Finnhub"),
                    "url": art.get("url", ""),
                    "published_at": art.get("datetime", ""),
                })
                if len(results) >= max_results:
                    break
        return results
    except Exception:
        logger.debug("Finnhub event search failed", exc_info=True)
        return []


# ─── 公开接口 ───────────────────────────────────────

_EVENT_QUERIES = [
    "war conflict breaking news today",
    "earthquake tsunami flood disaster",
    "pandemic outbreak health emergency",
    "tariff trade war economic sanctions",
    "bank failure financial crisis",
]


def check_major_events(
    max_events: int = 5,
) -> list[dict[str, Any]]:
    """检查重大事件。

    对多个查询执行搜索，过滤出匹配事件模式的结果。

    返回:
        [
            {
                "event_type": "war_conflict",
                "description": "...",
                "severity": "severe",
                "source": "NewsAPI",
                "title": "...",
            },
            ...
        ]
    """
    events: list[dict[str, Any]] = []
    seen_urls: set[str] = set()

    for query in _EVENT_QUERIES:
        if len(events) >= max_events:
            break
        articles = _search_news(query, max_results=2)
        for art in articles:
            if art.get("url") in seen_urls:
                continue
            seen_urls.add(art.get("url", ""))

            combined = f"{art.get('title', '')} {art.get('snippet', '')}"
            event_type = _detect_event_type(combined)
            if not event_type:
                continue

            events.append({
                "event_type": event_type,
                "description": f"{art['title']}. {art.get('snippet', '')}"[:200],
                "severity": _classify_severity(combined),
                "source": art.get("source", "unknown"),
                "title": art.get("title", ""),
            })
            if len(events) >= max_events:
                break

    if events:
        logger.info("Found %d major events", len(events))
    return events
