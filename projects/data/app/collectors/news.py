"""News collector — periodic NewsAPI fetch → raw_snapshots.

Ports the NewsAPI fetchers from the legacy ``data_providers/news.py`` into the
data-service collector architecture. Business + crypto headlines are stored as
a single ``news`` snapshot (provider="news", data_type="news").

MM-5（moomoo 新闻分支）：`get_search_news`（免 key，Moomoo News/MT Newswires/
Benzinga）按自选池+市场关键词抓取 → 单独落 provider="news_moomoo"（url 幂等
去重，与 NewsAPI 并存；NewsAPI key 未配置时 moomoo 为主源）。

Design: fail-silent background thread. Requires ``NEWSAPI_API_KEY`` (free
tier); when the key is absent the collector logs once and skips.
"""

from __future__ import annotations

import os
import threading
import time
from typing import Any, Dict, List

import requests

from app.config import APIKeys
from app.factors import save_snapshot
from app.utils.logger import get_logger

logger = get_logger(__name__)

NEWSAPI_BASE = "https://newsapi.org/v2"
COLLECT_INTERVAL = int(os.getenv("NEWS_COLLECT_INTERVAL_SEC", "900"))  # 15 min

# MM-5：moomoo 新闻关键词（自选池 + 市场级，按需覆盖）
MOOMOO_NEWS_KEYWORDS = [k.strip() for k in os.getenv(
    "MOOMOO_NEWS_KEYWORDS", "SPY,QQQ,AAPL,MSFT,NVDA,TSLA,bitcoin,ethereum"
).split(",") if k.strip()]
MOOMOO_NEWS_MAX_PER_KEY = int(os.getenv("MOOMOO_NEWS_MAX_PER_KEY", "10"))

# Quota-friendly default: en + zh. Override via NEWS_LANGS.
_LANGS = [l.strip() for l in os.getenv("NEWS_LANGS", "en,cn").split(",") if l.strip()]

_API_LANG_MAP = {
    "en": "en", "cn": "zh", "ja": "ja", "ko": "ko",
    "de": "de", "fr": "fr", "ar": "ar", "th": "th", "vi": "vi",
}

_CRYPTO_QUERIES = {
    "en": "cryptocurrency OR bitcoin OR ethereum OR crypto OR blockchain",
    "cn": "加密货币 比特币 以太坊 区块链 数字货币",
    "ja": "暗号通貨 ビットコイン イーサリアム 仮想通貨",
    "ko": "암호화폐 비트코인 이더리움 블록체인",
    "de": "Kryptowährung Bitcoin Ethereum Crypto Blockchain",
    "fr": "cryptomonnaie bitcoin ethereum crypto blockchain",
    "ar": "العملات الرقمية البيتكوين الإيثيريوم بلوكتشين",
    "th": "คริปโตเคอเรนซี บิทคอยน์ อีเธอร์เรียม บล็อกเชน",
    "vi": "tiền điện tử bitcoin ethereum blockchain crypto",
}


def _article_to_dict(art: dict, category: str, lang: str) -> Dict[str, Any]:
    """Convert a raw NewsAPI article to a unified dict."""
    return {
        "title": (art.get("title") or "").strip(),
        "link": (art.get("url") or "").strip(),
        "snippet": (art.get("description") or "").strip(),
        "source": (art.get("source") or {}).get("name", ""),
        "published": (art.get("publishedAt") or ""),
        "category": category,
        "lang": lang,
    }


def _fetch_newsapi_business(lang: str) -> List[Dict[str, Any]]:
    """Fetch business headlines via NewsAPI top-headlines."""
    api_lang = _API_LANG_MAP.get(lang, "en")
    try:
        resp = requests.get(
            f"{NEWSAPI_BASE}/top-headlines",
            params={"apiKey": APIKeys.rotate("NEWSAPI_API_KEY"), "language": api_lang, "category": "business", "pageSize": 20},
            timeout=8,
        )
        if resp.status_code == 200:
            articles = resp.json().get("articles", [])
            return [
                _article_to_dict(a, "business", lang)
                for a in articles
                if (a.get("title") or "").strip() and (a.get("url") or "").strip()
            ]
        if resp.status_code == 429:
            logger.warning("NewsAPI quota exceeded for business lang=%s", lang)
        else:
            logger.warning("NewsAPI business returned %s for lang=%s", resp.status_code, lang)
    except Exception as e:
        logger.debug("NewsAPI business request failed for lang=%s: %s", lang, e)
    return []


def _fetch_newsapi_crypto(lang: str) -> List[Dict[str, Any]]:
    """Fetch crypto headlines via NewsAPI everything endpoint."""
    api_lang = _API_LANG_MAP.get(lang, "en")
    query = _CRYPTO_QUERIES.get(lang, _CRYPTO_QUERIES["en"])
    try:
        resp = requests.get(
            f"{NEWSAPI_BASE}/everything",
            params={"apiKey": APIKeys.rotate("NEWSAPI_API_KEY"), "q": query, "language": api_lang, "sortBy": "publishedAt", "pageSize": 10},
            timeout=10,
        )
        if resp.status_code == 200:
            articles = resp.json().get("articles", [])
            return [
                _article_to_dict(a, "crypto", lang)
                for a in articles
                if (a.get("title") or "").strip() and (a.get("url") or "").strip()
            ]
        if resp.status_code == 429:
            logger.warning("NewsAPI quota exceeded for crypto lang=%s", lang)
        else:
            logger.warning("NewsAPI crypto returned %s for lang=%s", resp.status_code, lang)
    except Exception as e:
        logger.debug("NewsAPI crypto request failed for lang=%s: %s", lang, e)
    return []


# ── MM-5 moomoo 新闻分支（get_search_news，免 key） ───────────

def _fetch_moomoo_news() -> List[Dict[str, Any]]:
    """按自选池+市场关键词抓 moomoo 新闻 → 统一结构（fail-silent 返回 []）。"""
    try:
        from app.data_sources.moomoo_extra import fetch_search_news

        items: List[Dict[str, Any]] = []
        for kw in MOOMOO_NEWS_KEYWORDS:
            for art in fetch_search_news(kw, max_count=MOOMOO_NEWS_MAX_PER_KEY, sub_type="ALL"):
                items.append({
                    "title": art.get("title", ""),
                    "link": art.get("url", ""),
                    "snippet": art.get("title", "")[:160],
                    "source": art.get("source", ""),
                    "published": art.get("publish_time", ""),
                    "category": "market",
                    "lang": "en",
                    "keyword": kw,
                })
        return items
    except Exception as exc:
        logger.debug("moomoo news branch skipped: %s", exc)
        return []


def _dedupe_by_url(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """按 link/url 幂等去重（保持顺序，MM-5.2 双源去重）。"""
    seen: set = set()
    out = []
    for it in items:
        key = (it.get("link") or it.get("url") or "").strip().lower()
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(it)
    return out


class NewsCollector:
    """Periodically fetch financial news and write to raw_snapshots."""

    def __init__(self):
        self._running = False
        self._thread: threading.Thread | None = None
        self._warned_no_key = False

    def start(self):
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._loop, daemon=True, name="news-collector")
        self._thread.start()
        logger.info("NewsCollector started (interval=%ds)", COLLECT_INTERVAL)

    def stop(self):
        self._running = False

    def _loop(self):
        while self._running:
            try:
                self._collect()
            except Exception:
                logger.warning("News collector cycle failed", exc_info=True)
            time.sleep(COLLECT_INTERVAL)

    def _collect(self):
        # MM-5：moomoo 新闻分支（免 key，独立于 NewsAPI；缓存供 NewsAPI url 去重）
        global _last_moomoo_items
        try:
            _last_moomoo_items = _dedupe_by_url(_fetch_moomoo_news())
            if _last_moomoo_items:
                save_snapshot("news_moomoo", "news_moomoo",
                              {"items": _last_moomoo_items, "fetched_at": int(time.time() * 1000)})
                logger.info("Moomoo news snapshot saved: %d items", len(_last_moomoo_items))
        except Exception:
            logger.debug("Moomoo news branch failed", exc_info=True)
        # NewsAPI 主链：未配置 key 时跳过（moomoo 已作主源）
        if not APIKeys.is_configured("NEWSAPI_API_KEY"):
            if not self._warned_no_key:
                self._warned_no_key = True
                logger.warning("NEWSAPI_API_KEY not configured — NewsAPI branch disabled (moomoo news active)")
            return
        items: List[Dict[str, Any]] = []
        for lang in _LANGS:
            items.extend(_fetch_newsapi_business(lang))
            items.extend(_fetch_newsapi_crypto(lang))
        # MM-5.2：NewsAPI 与 moomoo 双源 url 去重后落库
        items = _dedupe_by_url(items + list(_last_moomoo_items or []))
        if items:
            save_snapshot("news", "news", {"items": items, "fetched_at": int(time.time() * 1000)})
            logger.info("News snapshot saved: %d items", len(items))


# NewsCollector 跨轮去重辅助：最近一次 moomoo 新闻（进程内缓存，供 NewsAPI url 去重）
_last_moomoo_items: List[Dict[str, Any]] | None = None
