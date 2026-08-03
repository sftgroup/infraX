"""
市场数据采集服务 - AI分析专用

设计理念：
1. 数据为王 - 先把数据获取做好、做稳定
2. 统一数据源 - 完全复用 DataSourceFactory 和 kline_service
3. 复用全球金融板块 - 宏观数据、情绪数据复用 global_market.py 的缓存
4. 快速稳定 - 不依赖慢速外部服务（如Jina Reader）

数据源映射：
- 价格/K线: DataSourceFactory (已验证，与K线模块、自选列表一致)
- 宏观数据: 复用 global_market.py (VIX, DXY, TNX, Fear&Greed等，带缓存)
- 新闻: Finnhub API (结构化数据，无需深度阅读)
- 基本面: Finnhub (美股) / 固定描述 (加密)
"""

import time
from typing import Dict, List, Any, Optional
from datetime import datetime, timedelta
from concurrent.futures import ThreadPoolExecutor, as_completed, TimeoutError

import yfinance as yf
import pandas as pd
import requests

from app.data_sources import DataSourceFactory
from app.kline_service import KlineService
from app.data_providers.db_cache import db_cache_get, db_cache_set
from app.data_providers.db_persist import db_data_save
from app.utils.logger import get_logger
from app.config import APIKeys

logger = get_logger(__name__)

class MarketDataCollector:
    """See __init__.py for full class definition."""

def _get_macro_data(self, market: str, timeout: int = 10) -> Dict[str, Any]:
    """Read macro data from DB cache."""
    return db_cache_get(f"collector:macro:{market}") or {}

def refresh_macro_data(self, market: str, timeout: int = 10) -> Dict[str, Any]:
    cache_key = f"collector:macro:{market}"
    raw = self._get_macro_data_raw(market, timeout)
    if raw: db_cache_set(cache_key, raw, ttl=3600)
    return raw

def _get_macro_data_raw(self, market: str, timeout: int = 10) -> Dict[str, Any]:
    try:
        # 复用 global_market.py 的市场情绪数据 (有5分钟缓存)
        from app.data_providers import get_cached as _get_cached, set_cached as _set_cached
        from app.data_providers.sentiment import (
            fetch_vix as _fetch_vix,
            fetch_dollar_index as _fetch_dollar_index,
            fetch_yield_curve as _fetch_yield_curve,
            fetch_fear_greed_index as _fetch_fear_greed_index,
        )
        
        result = {}
        
        # 1) 尝试从缓存获取 (global_market 的缓存, 6小时有效)
        MACRO_CACHE_TTL = 21600  # 6 hours
        cached_sentiment = _get_cached("market_sentiment", MACRO_CACHE_TTL)
        if cached_sentiment:
            logger.info("Using cached sentiment data from global_market (6h cache)")
            # 转换格式
            if cached_sentiment.get('vix'):
                vix = cached_sentiment['vix']
                result['VIX'] = {
                    'name': 'VIX恐慌指数',
                    'description': vix.get('interpretation', ''),
                    'price': vix.get('value', 0),
                    'change': vix.get('change', 0),
                    'changePercent': vix.get('change', 0),
                    'level': vix.get('level', 'unknown'),
                }
            
            if cached_sentiment.get('dxy'):
                dxy = cached_sentiment['dxy']
                result['DXY'] = {
                    'name': '美元指数',
                    'description': dxy.get('interpretation', ''),
                    'price': dxy.get('value', 0),
                    'change': dxy.get('change', 0),
                    'changePercent': dxy.get('change', 0),
                    'level': dxy.get('level', 'unknown'),
                }
            
            if cached_sentiment.get('yield_curve'):
                yc = cached_sentiment['yield_curve']
                result['TNX'] = {
                    'name': '美债10年收益率',
                    'description': yc.get('interpretation', ''),
                    'price': yc.get('yield_10y', 0),
                    'change': yc.get('change', 0),
                    'changePercent': 0,
                    'spread': yc.get('spread', 0),
                    'level': yc.get('level', 'unknown'),
                }
            
            if cached_sentiment.get('fear_greed'):
                fg = cached_sentiment['fear_greed']
                result['FEAR_GREED'] = {
                    'name': '恐惧贪婪指数',
                    'description': fg.get('classification', 'Neutral'),
                    'price': fg.get('value', 50),
                    'change': 0,
                    'changePercent': 0,
                }
            
            if result:
                return result
        
        # 2) 如果没有缓存，快速并行获取关键指标
        logger.info("Fetching macro data from global_market functions")
        
        with ThreadPoolExecutor(max_workers=4) as executor:
            futures = {
                executor.submit(_fetch_vix): "VIX",
                executor.submit(_fetch_dollar_index): "DXY",
                executor.submit(_fetch_yield_curve): "TNX",
                executor.submit(_fetch_fear_greed_index): "FEAR_GREED",
            }
            
            try:
                for future in as_completed(futures, timeout=timeout):
                    key = futures[future]
                    try:
                        data = future.result(timeout=5)
                        if data:
                            # 转换为统一格式
                            if key == 'VIX':
                                result[key] = {
                                    'name': 'VIX恐慌指数',
                                    'description': data.get('interpretation', ''),
                                    'price': data.get('value', 0),
                                    'change': data.get('change', 0),
                                    'changePercent': data.get('change', 0),
                                    'level': data.get('level', 'unknown'),
                                }
                            elif key == 'DXY':
                                result[key] = {
                                    'name': '美元指数',
                                    'description': data.get('interpretation', ''),
                                    'price': data.get('value', 0),
                                    'change': data.get('change', 0),
                                    'changePercent': data.get('change', 0),
                                    'level': data.get('level', 'unknown'),
                                }
                            elif key == 'TNX':
                                result[key] = {
                                    'name': '美债10年收益率',
                                    'description': data.get('interpretation', ''),
                                    'price': data.get('yield_10y', 0),
                                    'change': data.get('change', 0),
                                    'changePercent': 0,
                                    'spread': data.get('spread', 0),
                                    'level': data.get('level', 'unknown'),
                                }
                            elif key == 'FEAR_GREED':
                                result[key] = {
                                    'name': '恐惧贪婪指数',
                                    'description': data.get('classification', 'Neutral'),
                                    'price': data.get('value', 50),
                                    'change': 0,
                                    'changePercent': 0,
                                }
                    except Exception as e:
                        logger.debug(f"Macro indicator {key} fetch failed: {e}")
            except TimeoutError:
                logger.warning("Macro data fetch timed out")
        
        # 注：黄金等大宗商品数据不再作为宏观指标获取
        # 原因：1) 如果分析的是黄金，价格已在 _get_price 中获取
        #       2) 减少 API 调用，提高稳定性
        pass
        
        return result
        
    except ImportError as e:
        logger.warning(f"Could not import from global_market: {e}")
        return {}
    except Exception as e:
        logger.error(f"_get_macro_data failed: {e}")
        return {}

# ==================== 新闻/情绪数据 ====================

def _get_news(
    self, market: str, symbol: str, company_name: str = None, timeout: int = 8
) -> Dict[str, Any]:
    """Read news from DB cache."""
    cached = db_cache_get(f"collector:news:{market}:{symbol}")
    if cached is not None:
        return cached
    return {"news": [], "sentiment": {}}

def refresh_news(self, market: str, symbol: str, company_name: str = None, timeout: int = 8) -> Dict[str, Any]:
    cache_key = f"collector:news:{market}:{symbol}"
    raw = self._get_news_raw(market, symbol, company_name, timeout)
    if raw: db_cache_set(cache_key, raw, ttl=900)
    return raw

def _get_news_raw(
    self, market: str, symbol: str, company_name: str = None, timeout: int = 8
) -> Dict[str, Any]:
    news_list = []
    sentiment = {}
    
    # === 1) Finnhub 新闻 (美股首选) ===
    if self._finnhub_client:
        try:
            end_date = datetime.now().strftime('%Y-%m-%d')
            start_date = (datetime.now() - timedelta(days=7)).strftime('%Y-%m-%d')
            
            raw_news = []
            
            if market == 'USStock':
                raw_news = self._finnhub_client.company_news(symbol, _from=start_date, to=end_date)
            elif market == 'Crypto':
                # 加密货币通用新闻
                raw_news = self._finnhub_client.general_news('crypto', min_id=0)
            else:
                # 其他市场通用新闻
                raw_news = self._finnhub_client.general_news('general', min_id=0)
            
            if raw_news:
                for item in raw_news[:10]:
                    if not item.get('headline'):
                        continue
                    news_list.append({
                        "datetime": datetime.fromtimestamp(item.get('datetime', 0)).strftime('%Y-%m-%d %H:%M'),
                        "headline": item.get('headline', ''),
                        "summary": item.get('summary', '')[:300] if item.get('summary') else '',
                        "source": item.get('source', 'Finnhub'),
                        "url": item.get('url', ''),
                        "sentiment": item.get('sentiment', 'neutral'),
                    })
                logger.info(f"Finnhub 新闻获取成功: {len(news_list)} 条")
        except Exception as e:
            logger.debug(f"Finnhub news fetch failed: {e}")
    
    # === 2) Finnhub 情绪分数 (美股社交媒体情绪) ===
    if self._finnhub_client and market == 'USStock':
        try:
            social = self._finnhub_client.stock_social_sentiment(symbol)
            if social:
                sentiment['reddit'] = social.get('reddit', {})
                sentiment['twitter'] = social.get('twitter', {})
        except Exception as e:
            logger.debug(f"Finnhub sentiment fetch failed: {e}")
    
    # === 3) 搜索引擎补充 (如果新闻太少) ===
    if len(news_list) < 5:
        search_news = self._get_news_from_search(market, symbol, company_name)
        news_list.extend(search_news)
    
    # === 4) 获取全球重大事件新闻（地缘政治、战争等） ===
    # 这些事件会影响所有市场，特别是加密货币
    global_events = self._get_global_major_events()
    if global_events:
        news_list.extend(global_events)
        logger.info(f"Added {len(global_events)} global major events to news list")
    
    # 去重（按标题）
    seen_titles = set()
    unique_news = []
    for item in news_list:
        title = item.get('headline', '')
        if title and title not in seen_titles:
            seen_titles.add(title)
            unique_news.append(item)
    
    # 按时间排序
    unique_news.sort(key=lambda x: x.get('datetime', ''), reverse=True)
    
    return {
        "news": unique_news[:15],  # 最多15条
        "sentiment": sentiment,
    }

def _get_news_from_search(
    self, market: str, symbol: str, company_name: str = None
) -> List[Dict[str, Any]]:
    """
    从搜索引擎获取新闻
    
    使用增强的搜索服务 (Tavily/Google/Bing/SerpAPI)
    """
    news_list = []
    
    try:
        from app.services.search import get_search_service
        search_service = get_search_service()
        
        if not search_service.is_available:
            return news_list
        
        # 构建搜索名称
        search_name = company_name or symbol
        
        # 搜索股票新闻
        response = search_service.search_stock_news(
            stock_code=symbol,
            stock_name=search_name,
            market=market,
            max_results=5
        )
        
        if response.success and response.results:
            for result in response.results:
                news_list.append({
                    "datetime": result.published_date or datetime.now().strftime('%Y-%m-%d'),
                    "headline": result.title,
                    "summary": result.snippet[:200] if result.snippet else '',
                    "source": f"搜索:{result.source}",
                    "url": result.url,
                    "sentiment": result.sentiment,
                })
            logger.info(f"搜索引擎新闻补充: {len(news_list)} 条 (来源: {response.provider})")
    except Exception as e:
        logger.debug(f"搜索引擎新闻获取失败: {e}")
    
    return news_list

def _get_global_major_events(self) -> List[Dict]:
    """
    获取全球重大事件新闻（地缘政治、战争、重大政策等）
    这些事件会影响所有市场，特别是加密货币
    
    Returns:
        全球重大事件新闻列表
    """
    news_list = []
    
    try:
        from app.services.search import get_search_service
        search_service = get_search_service()
        
        if not search_service.is_available:
            return news_list
        
        # 搜索全球重大事件（最近24小时）
        # 优化：减少搜索次数，只搜索最重要的查询
        global_event_queries = [
            "war conflict breaking news today"  # 只搜索最重要的查询，减少API调用
        ]
        
        for query in global_event_queries:
            try:
                response = search_service.search_with_fallback(
                    query=query,
                    max_results=2,
                    days=1  # 只搜索最近1天的新闻
                )
                
                if response.success and response.results:
                    for result in response.results:
                        # 检查是否是重大事件（包含关键词）
                        title_lower = result.title.lower()
                        snippet_lower = (result.snippet or "").lower()
                        text = f"{title_lower} {snippet_lower}"
                        
                        # 重大事件关键词
                        major_event_keywords = [
                            "war", "conflict", "military", "attack", "strike", "sanctions",
                            "geopolitical", "crisis", "tension", "iran", "israel", "russia",
                            "ukraine", "middle east", "nato", "united states",
                            "战争", "冲突", "军事", "袭击", "制裁", "地缘政治", "危机"
                        ]
                        
                        if any(keyword in text for keyword in major_event_keywords):
                            news_list.append({
                                "datetime": result.published_date or datetime.now().strftime('%Y-%m-%d %H:%M'),
                                "headline": result.title,
                                "summary": result.snippet[:300] if result.snippet else '',
                                "source": f"全球事件:{result.source}",
                                "url": result.url,
                                "sentiment": "negative" if any(kw in text for kw in ["war", "conflict", "attack", "战争", "冲突", "袭击"]) else "neutral",
                                "is_global_event": True  # 标记为全球事件
                            })
                            logger.info(f"Found global major event: {result.title[:60]}")
            except Exception as e:
                logger.debug(f"Failed to search global events with query '{query}': {e}")
                continue
        
        # 去重
        seen_titles = set()
        unique_events = []
        for item in news_list:
            title = item.get('headline', '')
            if title and title not in seen_titles:
                seen_titles.add(title)
                unique_events.append(item)
        
        return unique_events[:5]  # 最多返回5条全球重大事件
        
    except Exception as e:
        logger.debug(f"Failed to get global major events: {e}")
        return []

def refresh_all(self, market: str, symbol: str, timeframe: str = "1D") -> Dict[str, Any]:
    """Pre-populate all data into DB for a given symbol. Call this before analysis."""
    import concurrent.futures
    results = {"market": market, "symbol": symbol, "items": {}}
    def _do_refresh():
        # Core data
        p = self.refresh_price(market, symbol)
        k = self.refresh_kline(market, symbol, timeframe)
        results["items"]["price"] = bool(p)
        results["items"]["kline"] = bool(k)
        # Crypto factors
        if market == "Crypto":
            cf = self.refresh_crypto_factors(symbol, p or {}, k or [])
            results["items"]["crypto_factors"] = bool(cf)
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as ex:
        ex.submit(_do_refresh)
        ex.submit(lambda: results["items"].update({"macro": bool(self.refresh_macro_data(market))}))
        ex.submit(lambda: results["items"].update({"news": bool(self.refresh_news(market, symbol).get("news"))}))
    logger.info(f"refresh_all completed for {market}:{symbol}: {results['items']}")
    return results

# 全局实例
_collector: Optional[MarketDataCollector] = None

def get_market_data_collector() -> MarketDataCollector:
    """获取市场数据采集器单例"""
    global _collector
    if _collector is None:
        _collector = MarketDataCollector()
    return _collector


def _attach_methods(cls):
    cls._get_macro_data = _get_macro_data
    cls.refresh_macro_data = refresh_macro_data
    cls._get_macro_data_raw = _get_macro_data_raw
    cls._get_news = _get_news
    cls.refresh_news = refresh_news
    cls._get_news_raw = _get_news_raw
    cls._get_news_from_search = _get_news_from_search
    cls._get_global_major_events = _get_global_major_events
    cls.refresh_all = refresh_all
