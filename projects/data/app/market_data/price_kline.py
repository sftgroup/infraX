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

def _get_price(self, market: str, symbol: str) -> Optional[Dict[str, Any]]:
    """Read price from DB cache. Use refresh_price() to populate."""
    return db_cache_get(f"collector:price:{market}:{symbol}")

def refresh_price(self, market: str, symbol: str) -> Optional[Dict[str, Any]]:
    """Fetch price from API and store in DB. Returns the data or None."""
    cache_key = f"collector:price:{market}:{symbol}"
    raw = self._get_price_raw(market, symbol)
    if raw:
        db_cache_set(cache_key, raw, ttl=60)
        db_data_save(market, symbol, 'price', '', raw, source=raw.get('source', ''))
    return raw

def _get_price_raw(self, market: str, symbol: str) -> Optional[Dict[str, Any]]:
    try:
        price_data = self.kline_service.get_realtime_price(market, symbol, force_refresh=True)
        if price_data and price_data.get('price', 0) > 0:
            # 安全转换为 float，处理 None 值
            def safe_float(val, default=0.0):
                if val is None:
                    return default
                try:
                    return float(val)
                except (ValueError, TypeError):
                    return default
            
            price = safe_float(price_data.get('price'))
            return {
                "price": price,
                "change": safe_float(price_data.get('change')),
                "changePercent": safe_float(price_data.get('changePercent')),
                "high": safe_float(price_data.get('high'), price),
                "low": safe_float(price_data.get('low'), price),
                "open": safe_float(price_data.get('open'), price),
                "previousClose": safe_float(price_data.get('previousClose'), price),
                "source": price_data.get('source', 'unknown')
            }
    except Exception as e:
        logger.warning(f"Price fetch failed for {market}:{symbol}: {e}")
    
    # 如果 kline_service 失败，尝试从 K 线最后一根获取价格
    try:
        klines = DataSourceFactory.get_kline(market, symbol, "1D", 2)
        if klines and len(klines) > 0:
            latest = klines[-1]
            price = float(latest.get('close', 0))
            if price > 0:
                prev_close = float(klines[-2].get('close', price)) if len(klines) > 1 else price
                change = price - prev_close
                change_pct = (change / prev_close * 100) if prev_close > 0 else 0
                
                logger.info(f"Price fetched from K-line fallback for {market}:{symbol}: ${price}")
                return {
                    "price": price,
                    "change": round(change, 6),
                    "changePercent": round(change_pct, 2),
                    "high": float(latest.get('high', price)),
                    "low": float(latest.get('low', price)),
                    "open": float(latest.get('open', price)),
                    "previousClose": prev_close,
                    "source": "kline_fallback"
                }
    except Exception as e:
        logger.warning(f"K-line fallback price fetch also failed for {market}:{symbol}: {e}")
    
    return None

def _get_kline(
    self, market: str, symbol: str, timeframe: str, limit: int = 60
) -> Optional[List[Dict[str, Any]]]:
    """Read K-line from DB cache. Use refresh_kline() to populate."""
    return db_cache_get(f"collector:kline:{market}:{symbol}:{timeframe}:{limit}")

def refresh_kline(self, market: str, symbol: str, timeframe: str, limit: int = 60) -> Optional[List[Dict[str, Any]]]:
    cache_key = f"collector:kline:{market}:{symbol}:{timeframe}:{limit}"
    raw = self._get_kline_raw(market, symbol, timeframe, limit)
    if raw:
        db_cache_set(cache_key, raw, ttl=120)
        db_data_save(market, symbol, 'kline', timeframe, raw, source='api')
    return raw

def _get_kline_raw(
    self, market: str, symbol: str, timeframe: str, limit: int = 60
) -> Optional[List[Dict[str, Any]]]:
    try:
        klines = DataSourceFactory.get_kline(market, symbol, timeframe, limit)
        if klines and len(klines) > 0:
            return klines
    except Exception as e:
        logger.warning(f"Kline fetch failed for {market}:{symbol}: {e}")
    return None


def _attach_methods(cls):
    cls._get_price = _get_price
    cls.refresh_price = refresh_price
    cls._get_price_raw = _get_price_raw
    cls._get_kline = _get_kline
    cls.refresh_kline = refresh_kline
    cls._get_kline_raw = _get_kline_raw
