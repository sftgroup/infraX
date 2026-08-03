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

def __init__(self):
    self.kline_service = KlineService()
    self._finnhub_client = None
    self._ak = None
    self._crypto_metric_cache: Dict[str, Dict[str, Any]] = {}
    self._init_clients()

def _init_clients(self):
    """初始化外部API客户端"""
    # Finnhub
    finnhub_key = APIKeys.FINNHUB_API_KEY
    if finnhub_key:
        try:
            import finnhub
            self._finnhub_client = finnhub.Client(api_key=finnhub_key)
        except Exception as e:
            logger.warning(f"Finnhub client init failed: {e}")
    
    # akshare (optional, for supplementary data)
    try:
        import akshare as ak
        self._ak = ak
    except ImportError:
        logger.info("akshare not installed")

def collect_all(
    self,
    market: str,
    symbol: str,
    timeframe: str = "1D",
    include_macro: bool = True,
    include_news: bool = True,
    timeout: int = 30
) -> Dict[str, Any]:
    """
    采集所有市场数据
    
    Args:
        market: 市场类型 (USStock, Crypto, Forex, Futures)
        symbol: 标的代码
        timeframe: K线周期
        include_macro: 是否包含宏观数据
        include_news: 是否包含新闻
        timeout: 总超时时间(秒)
        
    Returns:
        完整的市场数据字典
    """
    start_time = time.time()
    
    data = {
        "market": market,
        "symbol": symbol,
        "timeframe": timeframe,
        "collected_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        # 核心数据
        "price": None,
        "kline": None,
        "indicators": {},
        # 基本面
        "fundamental": {},
        "company": {},
        "crypto_factors": {},
        # 宏观
        "macro": {},
        # 情绪
        "news": [],
        "sentiment": {},
        # 元数据
        "_meta": {
            "success_items": [],
            "failed_items": [],
            "duration_ms": 0
        }
    }
    
    # === 阶段1: 核心数据 (并行获取) ===
    with ThreadPoolExecutor(max_workers=4) as executor:
        core_futures = {
            executor.submit(self.refresh_price, market, symbol): "price",
            executor.submit(self.refresh_kline, market, symbol, timeframe, 60): "kline",
        }
        
        # 如果需要基本面，也并行获取
        if market in ('USStock', 'CNStock', 'HKStock'):
            core_futures[executor.submit(self._get_fundamental, market, symbol)] = "fundamental"
            core_futures[executor.submit(self._get_company, market, symbol)] = "company"
        elif market == 'Crypto':
            # 加密货币的"基本面"是固定描述
            core_futures[executor.submit(self._get_crypto_info, symbol)] = "fundamental"
        
        try:
            for future in as_completed(core_futures, timeout=15):
                key = core_futures[future]
                try:
                    result = future.result(timeout=3)
                    if result:
                        data[key] = result
                        data["_meta"]["success_items"].append(key)
                    else:
                        data["_meta"]["failed_items"].append(key)
                except Exception as e:
                    logger.warning(f"Core data fetch failed ({key}): {e}")
                    data["_meta"]["failed_items"].append(key)
        except TimeoutError:
            logger.warning(f"Core data fetch timed out for {market}:{symbol}")
    
    # 计算技术指标 (本地计算，不需要外部API)
    if data.get("kline"):
        data["indicators"] = self._calculate_indicators(data["kline"])
        data["_meta"]["success_items"].append("indicators")

    # = Stage 1.5+2+3: parallel fetch (crypto_factors, macro, news are independent)
    
    def _fetch_crypto_factors():
        if market != 'Crypto':
            return ("crypto_factors", {})
        try:
            factors = self._get_crypto_factors(
                symbol=symbol, price_data=data.get("price") or {}, kline_data=data.get("kline") or []
            )
            if factors: data["_meta"]["success_items"].append("crypto_factors")
            else: data["_meta"]["failed_items"].append("crypto_factors")
            return ("crypto_factors", factors)
        except Exception as e:
            logger.warning(f"Crypto factor fetch failed for {symbol}: {e}")
            data["_meta"]["failed_items"].append("crypto_factors")
            return ("crypto_factors", {})

    def _fetch_macro():
        if not include_macro: return ("macro", {})
        try:
            macro_data = self._get_macro_data(market, timeout=10)
            if macro_data: data["_meta"]["success_items"].append("macro")
            return ("macro", macro_data)
        except Exception as e:
            logger.warning(f"Macro data fetch failed: {e}")
            data["_meta"]["failed_items"].append("macro")
            return ("macro", {})

    def _fetch_news():
        if not include_news: return ("news_result", {"news": [], "sentiment": {}})
        try:
            company_name = data.get("company", {}).get("name") if data.get("company") else None
            news_result = self._get_news(market, symbol, company_name, timeout=8)
            if news_result.get("news"): data["_meta"]["success_items"].append("news")
            return ("news_result", news_result)
        except Exception as e:
            logger.warning(f"News fetch failed: {e}")
            data["_meta"]["failed_items"].append("news")
            return ("news_result", {"news": [], "sentiment": {}})

    with ThreadPoolExecutor(max_workers=3) as parallel_executor:
        parallel_futures = [
            parallel_executor.submit(_fetch_crypto_factors),
            parallel_executor.submit(_fetch_macro),
            parallel_executor.submit(_fetch_news),
        ]
        for future in as_completed(parallel_futures, timeout=60):
            try:
                key, result = future.result(timeout=5)
                if key == "crypto_factors": data["crypto_factors"] = result
                elif key == "macro": data["macro"] = result
                elif key == "news_result":
                    data["news"] = result.get("news", [])
                    data["sentiment"] = result.get("sentiment", {})
            except Exception as e:
                logger.warning(f"Parallel fetch task failed: {e}")
    
    # 记录总耗时
    data["_meta"]["duration_ms"] = int((time.time() - start_time) * 1000)
    logger.info(f"Market data collection completed for {market}:{symbol} in {data['_meta']['duration_ms']}ms")
    logger.info(f"  Success: {data['_meta']['success_items']}")
    logger.info(f"  Failed: {data['_meta']['failed_items']}")

    # Persist collected data to long-term DB storage (best-effort, non-blocking)
    self._persist_collected_data(market, symbol, timeframe, data)

    return data

def _persist_collected_data(self, market: str, symbol: str, timeframe: str, data: Dict[str, Any]):
    """Persist all collected data types to qd_market_data (best-effort)."""
    persist_map = [
        ('indicators',      'indicators',       ''),
        ('crypto_factors',  'crypto_factors',   ''),
        ('macro',           'macro',            ''),
        ('news',            'news',             ''),
        ('sentiment',       'sentiment',        ''),
        ('fundamental',     'fundamental',      ''),
        ('company',         'company',          ''),
    ]
    for key, dtype, tf in persist_map:
        val = data.get(key)
        if val and (not isinstance(val, (list, dict)) or len(val) > 0):
            try:
                db_data_save(market, symbol, dtype, tf, val, source='collected')
            except Exception:
                pass  # best-effort, don't block analysis

# ==================== 核心数据获取 ====================


def _attach_methods(cls):
    cls.__init__ = __init__
    cls._init_clients = _init_clients
    cls.collect_all = collect_all
    cls._persist_collected_data = _persist_collected_data

def get_market_data_collector() -> MarketDataCollector:
    """获取市场数据采集器单例"""
    global _collector
    if _collector is None:
        _collector = MarketDataCollector()
    return _collector

