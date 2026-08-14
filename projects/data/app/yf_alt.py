"""yfinance 替代层 — 多免费/带 key 源路由，规避 Yahoo 数据中心段限流。

背景：Yahoo Finance 对数据中心 IP 段整体限流（429 / YFRateLimitError，
已实测 8 台腾讯云机器全部限流，换本机 IP 无意义）。本模块提供不依赖
yfinance 的行情获取：

  - 股票 / ETF：Twelve Data（TWELVE_DATA_API_KEY，实测 AAPL 可用）
  - 外汇对：Twelve Data（EUR/USD 实测可用）→ frankfurter.app（ECB 参考汇率，
    任意基准对，免费无 key）

全部 fail-silent：任何源失败返回 None，调用方自行降级（最近快照等）。
"""
from __future__ import annotations

import logging
import os
from typing import Optional

import requests

logger = logging.getLogger(__name__)


def _td_key() -> str:
    return os.getenv("TWELVE_DATA_API_KEY", "")


def _twelve_data_close(symbol: str, timeout: int = 12) -> Optional[float]:
    """最新收盘价 via Twelve Data（股票/ETF/外汇；指数/商品 free 版 404）。"""
    if not _td_key():
        return None
    try:
        resp = requests.get(
            "https://api.twelvedata.com/time_series",
            params={"symbol": symbol, "interval": "1day", "outputsize": 1,
                    "apikey": _TD_KEY},
            timeout=timeout,
        )
        data = resp.json()
        values = data.get("values") or []
        if data.get("status") != "ok" or not values:
            return None
        return round(float(values[0]["close"]), 6)
    except Exception as exc:
        logger.warning("Twelve Data %s failed: %s", symbol, exc)
        return None


def _frankfurter_close(symbol: str, timeout: int = 12) -> Optional[float]:
    """外汇对最新参考汇率 via frankfurter（ECB，免费无 key）。symbol 形如 'USD/JPY'。"""
    try:
        base, _, quote = symbol.partition("/")
        if not quote:
            return None
        resp = requests.get(
            "https://api.frankfurter.app/latest",
            params={"from": base, "to": quote},
            timeout=timeout,
        )
        data = resp.json()
        rates = data.get("rates") or {}
        if rates and quote in rates:
            return round(float(rates[quote]), 6)
        return None
    except Exception as exc:
        logger.warning("frankfurter %s failed: %s", symbol, exc)
        return None


def get_latest_close(symbol: str, timeout: int = 12) -> Optional[float]:
    """按 symbol 类型路由到免费/带 key 源，返回最新收盘价（失败 None）。

    优先级：Twelve Data（股票/ETF/外汇）→ frankfurter（外汇对）。
    """
    if "/" in symbol:  # 外汇对
        close = _twelve_data_close(symbol, timeout)
        if close is None:
            close = _frankfurter_close(symbol, timeout)
        return close
    # 股票/ETF：Twelve Data（free 版支持常见美股/ETF）
    return _twelve_data_close(symbol, timeout)
