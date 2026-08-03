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

def _cache_get(self, key: str) -> Optional[Any]:
    item = self._crypto_metric_cache.get(key)
    if not item:
        return None
    if float(item.get("expires_at") or 0) <= time.time():
        self._crypto_metric_cache.pop(key, None)
        return None
    return item.get("value")

def _cache_set(self, key: str, value: Any, ttl_sec: int) -> Any:
    self._crypto_metric_cache[key] = {
        "value": value,
        "expires_at": time.time() + max(1, int(ttl_sec or 60)),
    }
    return value

def _coinglass_get(self, path: str, params: Dict[str, Any], ttl_sec: int = 120) -> Optional[Dict[str, Any]]:
    api_key = (APIKeys.COINGLASS_API_KEY or "").strip()
    if not api_key:
        return None

    clean_params = {k: v for k, v in (params or {}).items() if v not in (None, "", [])}
    cache_key = f"coinglass|{path}|{tuple(sorted(clean_params.items()))}"
    cached = self._cache_get(cache_key)
    if cached is not None:
        return cached

    try:
        resp = requests.get(
            f"https://open-api-v4.coinglass.com{path}",
            params=clean_params,
            headers={"CG-API-KEY": api_key},
            timeout=8,
        )
        resp.raise_for_status()
        payload = resp.json() or {}
        return self._cache_set(cache_key, payload, ttl_sec)
    except Exception as e:
        logger.debug(f"Coinglass request failed {path}: {e}")
        return None

def _cryptoquant_get(self, path: str, params: Dict[str, Any], ttl_sec: int = 300) -> Optional[Dict[str, Any]]:
    api_key = (APIKeys.CRYPTOQUANT_API_KEY or "").strip()
    if not api_key:
        return None

    clean_params = {k: v for k, v in (params or {}).items() if v not in (None, "", [])}
    cache_key = f"cryptoquant|{path}|{tuple(sorted(clean_params.items()))}"
    cached = self._cache_get(cache_key)
    if cached is not None:
        return cached

    try:
        resp = requests.get(
            f"https://api.cryptoquant.com{path}",
            params=clean_params,
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=8,
        )
        resp.raise_for_status()
        payload = resp.json() or {}
        return self._cache_set(cache_key, payload, ttl_sec)
    except Exception as e:
        logger.debug(f"CryptoQuant request failed {path}: {e}")
        return None

def _extract_latest_items(self, payload: Any) -> List[Dict[str, Any]]:
    if isinstance(payload, list):
        return [x for x in payload if isinstance(x, dict)]
    if isinstance(payload, dict):
        for key in ("data", "result", "items", "list"):
            val = payload.get(key)
            if isinstance(val, list):
                return [x for x in val if isinstance(x, dict)]
            if isinstance(val, dict):
                nested = self._extract_latest_items(val)
                if nested:
                    return nested
    return []

def _pick_latest_item(self, payload: Any) -> Dict[str, Any]:
    items = self._extract_latest_items(payload)
    if items:
        return items[-1]
    if isinstance(payload, dict):
        return payload
    return {}

def _safe_num(self, value: Any, default: Optional[float] = None) -> Optional[float]:
    if value is None or value == "":
        return default
    try:
        return float(str(value).replace(",", ""))
    except Exception:
        return default

def _pick_number(self, payload: Any, *keys: str, default: Optional[float] = None) -> Optional[float]:
    if isinstance(payload, dict):
        for key in keys:
            if key in payload:
                val = self._safe_num(payload.get(key), None)
                if val is not None:
                    return val
        for val in payload.values():
            found = self._pick_number(val, *keys, default=None)
            if found is not None:
                return found
    elif isinstance(payload, list):
        for item in payload:
            found = self._pick_number(item, *keys, default=None)
            if found is not None:
                return found
    return default


def _attach_methods(cls):
    cls._cache_get = _cache_get
    cls._cache_set = _cache_set
    cls._coinglass_get = _coinglass_get
    cls._cryptoquant_get = _cryptoquant_get
    cls._extract_latest_items = _extract_latest_items
    cls._pick_latest_item = _pick_latest_item
    cls._safe_num = _safe_num
    cls._pick_number = _pick_number
