"""
Search service — data-service 统一网页搜索能力。

消费方：macro_news._get_news_from_search（新闻搜索补充），未来 agent/新闻
管道可复用。Provider：Firecrawl（search API，Bearer token）。未配置
FIRECRAWL_API_KEY 时 fail-silent（is_available=False / 返回空），不影响
既有新闻抓取链路。
"""
from __future__ import annotations

import logging
import threading
from dataclasses import dataclass, field
from typing import List, Optional
from urllib.parse import urlparse

import requests

from app.config import APIKeys

logger = logging.getLogger(__name__)

_FIRECRAWL_SEARCH_URL = "https://api.firecrawl.dev/v1/search"
_FIRECRAWL_TIMEOUT = 15  # 秒


@dataclass
class SearchResult:
    """单个搜索结果（对齐 aitrader search.SearchResult 的消费字段）。"""

    title: str
    snippet: str
    url: str
    source: str
    published_date: Optional[str] = None
    sentiment: str = "neutral"

    def to_dict(self) -> dict:
        return {
            "title": self.title,
            "link": self.url,
            "snippet": self.snippet,
            "source": self.source,
            "published": self.published_date or "",
            "sentiment": self.sentiment,
        }


@dataclass
class SearchResponse:
    """搜索结果响应（消费方读取 success / results / provider）。"""

    success: bool
    results: List[SearchResult] = field(default_factory=list)
    provider: str = ""
    error: str = ""


class FirecrawlSearchProvider:
    """Firecrawl search 实现。支持 search + 可扩展 scrape/crawl。"""

    name = "firecrawl"

    def __init__(self, api_key: str):
        self._api_key = api_key

    @property
    def is_available(self) -> bool:
        return bool(self._api_key)

    def search(self, query: str, max_results: int = 5) -> SearchResponse:
        if not self._api_key:
            return SearchResponse(False, provider=self.name, error="no api key")
        try:
            resp = requests.post(
                _FIRECRAWL_SEARCH_URL,
                headers={
                    "Authorization": f"Bearer {self._api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "query": query,
                    "limit": max_results,
                    "timeout": _FIRECRAWL_TIMEOUT * 1000,  # ms
                },
                timeout=_FIRECRAWL_TIMEOUT,
            )
            resp.raise_for_status()
            items = resp.json().get("data") or []
            results: List[SearchResult] = []
            for item in items:
                url = (item.get("url") or "").strip()
                title = (item.get("title") or "").strip()
                if not url or not title:
                    continue
                results.append(
                    SearchResult(
                        title=title[:200],
                        snippet=(item.get("description") or "").strip()[:300],
                        url=url,
                        source=urlparse(url).netloc.replace("www.", ""),
                        sentiment="neutral",
                    )
                )
            return SearchResponse(True, results, provider=self.name)
        except Exception as e:  # fail-silent：搜索失败不影响主链路
            logger.debug("Firecrawl search failed: %s", e)
            return SearchResponse(False, provider=self.name, error=str(e))

    def search_stock_news(
        self,
        stock_code: str,
        stock_name: str,
        market: str,
        max_results: int = 5,
    ) -> SearchResponse:
        """按标的搜索最新新闻（macro_news 消费方契约）。"""
        name = stock_name or stock_code
        query = f"{name} {stock_code} {market} 最新消息 股价"
        return self.search(query, max_results=max_results)


_search_service: Optional[FirecrawlSearchProvider] = None
_search_lock = threading.Lock()


def get_search_service() -> Optional[FirecrawlSearchProvider]:
    """返回搜索服务单例；未配置 FIRECRAWL_API_KEY 时返回 None（消费方 fail-silent）。"""
    global _search_service
    if _search_service is None:
        with _search_lock:
            if _search_service is None:
                key = (APIKeys.rotate("FIRECRAWL_API_KEY") or "").strip()
                if key:
                    _search_service = FirecrawlSearchProvider(key)
                    logger.info("Search service initialized: provider=firecrawl")
                else:
                    logger.debug("FIRECRAWL_API_KEY not configured — search disabled")
    return _search_service
