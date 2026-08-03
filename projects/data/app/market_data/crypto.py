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

def _get_crypto_info(self, symbol: str) -> Optional[Dict[str, Any]]:
    """加密货币信息 (固定描述为主)"""
    # 常见加密货币的描述
    crypto_info = {
        'BTC': {
            'name': 'Bitcoin',
            'description': '比特币，数字黄金，市值第一的加密货币，作为价值存储和避险资产',
            'category': 'Store of Value',
        },
        'ETH': {
            'name': 'Ethereum',
            'description': '以太坊，智能合约平台，DeFi和NFT生态的基础设施',
            'category': 'Smart Contract Platform',
        },
        'BNB': {
            'name': 'Binance Coin',
            'description': '币安币，全球最大交易所的平台代币',
            'category': 'Exchange Token',
        },
        'SOL': {
            'name': 'Solana',
            'description': '高性能公链，主打高TPS和低Gas费',
            'category': 'Smart Contract Platform',
        },
        'XRP': {
            'name': 'Ripple',
            'description': '瑞波币，专注跨境支付解决方案',
            'category': 'Payment',
        },
        'DOGE': {
            'name': 'Dogecoin',
            'description': '狗狗币，Meme币代表，社区驱动',
            'category': 'Meme',
        },
    }
    
    # 提取基础代币名
    base = symbol.split('/')[0] if '/' in symbol else symbol
    base = base.upper()
    
    if base in crypto_info:
        return crypto_info[base]
    
    return {
        'name': base,
        'description': f'{base} 是一种加密货币',
        'category': 'Unknown',
    }

def _get_crypto_factors(self, symbol: str, price_data: Dict[str, Any], kline_data: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Read crypto factors from DB cache."""
    base_symbol = self._normalize_crypto_base_symbol(symbol)
    if not base_symbol: return {}
    return db_cache_get(f"collector:crypto_factors:{base_symbol}") or {}

def refresh_crypto_factors(self, symbol: str, price_data: Dict[str, Any], kline_data: List[Dict[str, Any]]) -> Dict[str, Any]:
    base_symbol = self._normalize_crypto_base_symbol(symbol)
    if not base_symbol: return {}
    cache_key = f"collector:crypto_factors:{base_symbol}"
    raw = self._get_crypto_factors_raw(base_symbol, price_data, kline_data)
    if raw: db_cache_set(cache_key, raw, ttl=300)
    return raw

def _get_crypto_factors_raw(self, base_symbol: str, price_data: Dict[str, Any], kline_data: List[Dict[str, Any]]) -> Dict[str, Any]:

    market_structure = self._get_crypto_market_structure(base_symbol, price_data, kline_data)
    derivatives = self._get_crypto_derivatives_metrics(base_symbol)
    capital_flow = self._get_crypto_capital_flow(base_symbol)

    volume_24h = market_structure.get("volume_24h")
    volume_change_24h = market_structure.get("volume_change_24h")
    funding_rate = derivatives.get("funding_rate")
    oi_change = derivatives.get("open_interest_change_24h")
    long_short_ratio = derivatives.get("long_short_ratio")
    exchange_netflow = capital_flow.get("exchange_netflow")
    stablecoin_netflow = capital_flow.get("stablecoin_netflow")

    signals = {
        "derivatives_bias": self._derive_derivatives_bias(funding_rate, oi_change, long_short_ratio),
        "flow_bias": self._derive_flow_bias(exchange_netflow, stablecoin_netflow),
        "squeeze_risk": self._derive_squeeze_risk(funding_rate, long_short_ratio, oi_change),
        "volume_state": self._derive_volume_state(volume_change_24h),
    }

    summary = self._build_crypto_factor_summary(
        volume_change_24h=volume_change_24h,
        funding_rate=funding_rate,
        open_interest_change_24h=oi_change,
        exchange_netflow=exchange_netflow,
        stablecoin_netflow=stablecoin_netflow,
        signals=signals,
    )

    return {
        "symbol": base_symbol,
        "volume_24h": volume_24h,
        "volume_change_24h": volume_change_24h,
        "funding_rate": funding_rate,
        "open_interest": derivatives.get("open_interest"),
        "open_interest_change_24h": oi_change,
        "long_short_ratio": long_short_ratio,
        "exchange_netflow": exchange_netflow,
        "stablecoin_netflow": stablecoin_netflow,
        "signals": signals,
        "summary": summary,
        "sources": {
            "market_structure": market_structure.get("source"),
            "derivatives": derivatives.get("source"),
            "capital_flow": capital_flow.get("source"),
        }
    }

def _normalize_crypto_base_symbol(self, symbol: str) -> str:
    raw = str(symbol or "").strip().upper()
    if not raw:
        return ""
    if "/" in raw:
        raw = raw.split("/", 1)[0]
    if ":" in raw:
        raw = raw.split(":", 1)[0]
    raw = raw.replace("-USD", "").replace("-USDT", "")
    return raw

def _get_crypto_market_structure(self, symbol: str, price_data: Dict[str, Any], kline_data: List[Dict[str, Any]]) -> Dict[str, Any]:
    out = {
        "volume_24h": None,
        "volume_change_24h": None,
        "source": "price+kline",
    }
    try:
        quote_volume = self._safe_num(price_data.get("quoteVolume"))
        if quote_volume is not None:
            out["volume_24h"] = quote_volume
    except Exception:
        pass

    try:
        if len(kline_data) >= 2:
            latest_vol = self._safe_num(kline_data[-1].get("volume"), 0.0) or 0.0
            prev_vol = self._safe_num(kline_data[-2].get("volume"), 0.0) or 0.0
            if prev_vol > 0:
                out["volume_change_24h"] = ((latest_vol - prev_vol) / prev_vol) * 100.0
    except Exception:
        pass

    # CoinGecko 提供更稳定的 24h 成交额，用于补足 quoteVolume 缺失。
    cg_cache_key = f"coingecko|coin|{symbol}"
    cached = self._cache_get(cg_cache_key)
    coin = cached
    if coin is None:
        try:
            resp = requests.get(
                "https://api.coingecko.com/api/v3/coins/markets",
                params={
                    "vs_currency": "usd",
                    "symbols": symbol.lower(),
                    "price_change_percentage": "24h",
                },
                timeout=8,
            )
            resp.raise_for_status()
            data = resp.json() or []
            coin = data[0] if data and isinstance(data[0], dict) else {}
            self._cache_set(cg_cache_key, coin, 180)
        except Exception as e:
            logger.debug(f"CoinGecko volume fetch failed for {symbol}: {e}")
            coin = {}

    if isinstance(coin, dict):
        if out["volume_24h"] is None:
            out["volume_24h"] = self._safe_num(coin.get("total_volume"))
            if out["volume_24h"] is not None:
                out["source"] = "coingecko"
        if out["volume_change_24h"] is None:
            # CoinGecko 没有直接 volume change，这里用成交额/市值比粗略表征活跃度变化。
            market_cap = self._safe_num(coin.get("market_cap"))
            total_volume = self._safe_num(coin.get("total_volume"))
            if total_volume is not None and market_cap and market_cap > 0:
                out["volume_change_24h"] = (total_volume / market_cap) * 100.0
                out["source"] = "coingecko+proxy"
    return out

def _get_crypto_derivatives_metrics(self, symbol: str) -> Dict[str, Any]:
    result = {
        "funding_rate": None,
        "open_interest": None,
        "open_interest_change_24h": None,
        "long_short_ratio": None,
        "source": "",
    }

    payload = self._coinglass_get("/api/futures/fundingRate/exchange-list", {"symbol": symbol}, ttl_sec=90)
    latest = self._pick_latest_item(payload)
    result["funding_rate"] = self._pick_number(latest or payload, "oi_weighted_funding_rate", "funding_rate", "fundingRate")
    if result["funding_rate"] is not None:
        result["source"] = "coinglass"

    payload = self._coinglass_get("/api/futures/open-interest/exchange-list", {"symbol": symbol}, ttl_sec=90)
    latest = self._pick_latest_item(payload)
    result["open_interest"] = self._pick_number(
        latest or payload,
        "open_interest_usd",
        "openInterestUsd",
        "open_interest",
        "openInterest",
    )
    result["open_interest_change_24h"] = self._pick_number(
        latest or payload,
        "open_interest_change_percent_24h",
        "openInterestCh24h",
        "openInterestChangePercent24h",
        "open_interest_change_24h",
    )
    if result["open_interest"] is not None:
        result["source"] = "coinglass"

    payload = self._coinglass_get(
        "/api/futures/global-long-short-account-ratio/history",
        {"symbol": symbol, "interval": "1d", "limit": 1},
        ttl_sec=120,
    )
    latest = self._pick_latest_item(payload)
    result["long_short_ratio"] = self._pick_number(
        latest or payload,
        "long_short_ratio",
        "longShortRatio",
        "global_account_long_short_ratio",
    )
    if result["long_short_ratio"] is not None:
        result["source"] = "coinglass"

    # Binance 作为部分衍生品字段兜底。
    if result["funding_rate"] is None or result["open_interest"] is None or result["long_short_ratio"] is None:
        pair = f"{symbol}USDT"
        result = self._fill_crypto_derivatives_from_binance(pair, result)
    return result

def _fill_crypto_derivatives_from_binance(self, pair: str, result: Dict[str, Any]) -> Dict[str, Any]:
    cache_key = f"binance_derivatives|{pair}"
    cached = self._cache_get(cache_key)
    if isinstance(cached, dict):
        merged = dict(result)
        for k, v in cached.items():
            if merged.get(k) is None and v is not None:
                merged[k] = v
        if any(merged.get(k) is not None for k in ("funding_rate", "open_interest", "long_short_ratio")) and not merged.get("source"):
            merged["source"] = "binance_public"
        return merged

    fallback = {}
    try:
        funding_resp = requests.get(
            "https://fapi.binance.com/fapi/v1/fundingRate",
            params={"symbol": pair, "limit": 1},
            timeout=8,
        )
        funding_resp.raise_for_status()
        items = funding_resp.json() or []
        if items:
            fallback["funding_rate"] = self._safe_num(items[-1].get("fundingRate"))
    except Exception as e:
        logger.debug(f"Binance funding fallback failed for {pair}: {e}")

    try:
        oi_resp = requests.get(
            "https://fapi.binance.com/futures/data/openInterestHist",
            params={"symbol": pair, "period": "1d", "limit": 2},
            timeout=8,
        )
        oi_resp.raise_for_status()
        items = oi_resp.json() or []
        if items:
            latest = items[-1]
            fallback["open_interest"] = self._safe_num(latest.get("sumOpenInterestValue"))
            if len(items) >= 2:
                prev = self._safe_num(items[-2].get("sumOpenInterestValue"), 0.0) or 0.0
                curr = self._safe_num(latest.get("sumOpenInterestValue"), 0.0) or 0.0
                if prev > 0:
                    fallback["open_interest_change_24h"] = ((curr - prev) / prev) * 100.0
    except Exception as e:
        logger.debug(f"Binance open interest fallback failed for {pair}: {e}")

    try:
        ratio_resp = requests.get(
            "https://fapi.binance.com/futures/data/globalLongShortAccountRatio",
            params={"symbol": pair, "period": "1d", "limit": 1},
            timeout=8,
        )
        ratio_resp.raise_for_status()
        items = ratio_resp.json() or []
        if items:
            fallback["long_short_ratio"] = self._safe_num(items[-1].get("longShortRatio"))
    except Exception as e:
        logger.debug(f"Binance long/short fallback failed for {pair}: {e}")

    self._cache_set(cache_key, fallback, 120)
    merged = dict(result)
    for k, v in fallback.items():
        if merged.get(k) is None and v is not None:
            merged[k] = v
    if any(merged.get(k) is not None for k in ("funding_rate", "open_interest", "long_short_ratio")) and not merged.get("source"):
        merged["source"] = "binance_public"
    return merged

def _get_crypto_capital_flow(self, symbol: str) -> Dict[str, Any]:
    result = {
        "exchange_netflow": None,
        "stablecoin_netflow": None,
        "source": "",
    }

    payload = self._coinglass_get("/api/futures/coin/netflow", {"symbol": symbol}, ttl_sec=180)
    latest = self._pick_latest_item(payload)
    inflow = self._pick_number(latest or payload, "inflow", "inflowUsd", "inflow_usd")
    outflow = self._pick_number(latest or payload, "outflow", "outflowUsd", "outflow_usd")
    if inflow is not None and outflow is not None:
        result["exchange_netflow"] = inflow - outflow
        result["source"] = "coinglass"
    else:
        result["exchange_netflow"] = self._pick_number(latest or payload, "netflow", "netFlow", "net_flow")
        if result["exchange_netflow"] is not None:
            result["source"] = "coinglass"

    # CryptoQuant 稳定币净流先做可选增强；未配置时自然降级。
    payload = self._cryptoquant_get(
        "/v1/stablecoin/exchange-flows/netflow",
        {"exchange": "all_exchange", "symbol": "all", "window": "day", "limit": 1},
        ttl_sec=600,
    )
    latest = self._pick_latest_item(payload)
    result["stablecoin_netflow"] = self._pick_number(
        latest or payload,
        "netflow",
        "netFlow",
        "exchange_netflow_total",
        "value",
    )
    if result["stablecoin_netflow"] is not None:
        result["source"] = (result["source"] + "+cryptoquant").strip("+")

    return result

def _derive_derivatives_bias(self, funding_rate: Optional[float], oi_change: Optional[float], long_short_ratio: Optional[float]) -> str:
    score = 0
    if funding_rate is not None:
        if funding_rate > 0:
            score += 1
        elif funding_rate < 0:
            score -= 1
    if oi_change is not None:
        if oi_change > 3:
            score += 1
        elif oi_change < -3:
            score -= 1
    if long_short_ratio is not None:
        if long_short_ratio > 1.2:
            score += 1
        elif long_short_ratio < 0.85:
            score -= 1
    if score >= 2:
        return "bullish"
    if score <= -2:
        return "bearish"
    return "neutral"

def _derive_flow_bias(self, exchange_netflow: Optional[float], stablecoin_netflow: Optional[float]) -> str:
    score = 0
    if exchange_netflow is not None:
        # 净流出通常偏利多，净流入偏利空。
        if exchange_netflow < 0:
            score += 1
        elif exchange_netflow > 0:
            score -= 1
    if stablecoin_netflow is not None:
        if stablecoin_netflow > 0:
            score += 1
        elif stablecoin_netflow < 0:
            score -= 1
    if score >= 1:
        return "bullish"
    if score <= -1:
        return "bearish"
    return "neutral"

def _derive_squeeze_risk(self, funding_rate: Optional[float], long_short_ratio: Optional[float], oi_change: Optional[float]) -> str:
    hot_long = (
        funding_rate is not None and funding_rate > 0.03 and
        long_short_ratio is not None and long_short_ratio > 1.5 and
        oi_change is not None and oi_change > 8
    )
    hot_short = (
        funding_rate is not None and funding_rate < -0.03 and
        long_short_ratio is not None and long_short_ratio < 0.75 and
        oi_change is not None and oi_change > 8
    )
    if hot_long or hot_short:
        return "high"
    if (
        (funding_rate is not None and abs(funding_rate) > 0.015) or
        (long_short_ratio is not None and (long_short_ratio > 1.3 or long_short_ratio < 0.85))
    ):
        return "medium"
    return "low"

def _derive_volume_state(self, volume_change_24h: Optional[float]) -> str:
    if volume_change_24h is None:
        return "unknown"
    if volume_change_24h > 20:
        return "expanding"
    if volume_change_24h < -20:
        return "shrinking"
    return "stable"

def _build_crypto_factor_summary(
    self,
    *,
    volume_change_24h: Optional[float],
    funding_rate: Optional[float],
    open_interest_change_24h: Optional[float],
    exchange_netflow: Optional[float],
    stablecoin_netflow: Optional[float],
    signals: Dict[str, Any],
) -> str:
    parts: List[str] = []
    if open_interest_change_24h is not None:
        parts.append(f"OI {'上升' if open_interest_change_24h >= 0 else '回落'} {abs(open_interest_change_24h):.1f}%")
    if funding_rate is not None:
        parts.append(f"资金费率{'偏正' if funding_rate >= 0 else '偏负'}")
    if exchange_netflow is not None:
        parts.append("交易所净流出" if exchange_netflow < 0 else "交易所净流入")
    if stablecoin_netflow is not None:
        parts.append("稳定币净流入增强" if stablecoin_netflow > 0 else "稳定币净流出")
    if volume_change_24h is not None:
        parts.append(f"成交活跃度{'放大' if volume_change_24h > 0 else '回落'}")
    direction = signals.get("derivatives_bias", "neutral")
    flow = signals.get("flow_bias", "neutral")
    squeeze = signals.get("squeeze_risk", "low")
    outlook = "偏多" if direction == "bullish" or flow == "bullish" else ("偏空" if direction == "bearish" or flow == "bearish" else "中性")
    risk_text = {"high": "拥挤风险高", "medium": "拥挤度抬升", "low": "拥挤风险低"}.get(squeeze, "风险未知")
    base = "、".join(parts[:4]) if parts else "链上与衍生品数据有限"
    return f"{base}，整体{outlook}，{risk_text}"


def _attach_methods(cls):
    cls._get_crypto_info = _get_crypto_info
    cls._get_crypto_factors = _get_crypto_factors
    cls.refresh_crypto_factors = refresh_crypto_factors
    cls._get_crypto_factors_raw = _get_crypto_factors_raw
    cls._normalize_crypto_base_symbol = _normalize_crypto_base_symbol
    cls._get_crypto_market_structure = _get_crypto_market_structure
    cls._get_crypto_derivatives_metrics = _get_crypto_derivatives_metrics
    cls._fill_crypto_derivatives_from_binance = _fill_crypto_derivatives_from_binance
    cls._get_crypto_capital_flow = _get_crypto_capital_flow
    cls._derive_derivatives_bias = _derive_derivatives_bias
    cls._derive_flow_bias = _derive_flow_bias
    cls._derive_squeeze_risk = _derive_squeeze_risk
    cls._derive_volume_state = _derive_volume_state
    cls._build_crypto_factor_summary = _build_crypto_factor_summary
