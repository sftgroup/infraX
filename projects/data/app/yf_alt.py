"""yfinance 替代层 — 多免费/带 key 源路由，规避 Yahoo 数据中心段限流。

背景：Yahoo Finance 对数据中心 IP 段整体限流（429 / YFRateLimitError，
已实测 8 台腾讯云机器全部限流，换本机 IP 无意义）。本模块提供不依赖
yfinance 的行情获取：

  - 股票 / ETF：Twelve Data（TWELVE_DATA_API_KEY，实测 AAPL 可用）
  - 外汇对：frankfurter.app（ECB 参考汇率，免费无 key，无配额限制）→
    Twelve Data 兜底

能力：
  - get_latest_close(symbol)：最新收盘价
  - get_history(symbol, interval, days, ...)：K 线历史 → pandas DataFrame
    （DatetimeIndex + Open/High/Low/Close/Volume，与 yfinance 兼容）

全部 fail-silent：任何源失败返回 None，调用方自行降级（最近快照等）。
"""
from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta
from typing import Optional

import pandas as pd
import requests

logger = logging.getLogger(__name__)

# yfinance interval → Twelve Data interval
_YF_INTERVAL_TO_TD = {
    "1m": "1min", "3m": "1min", "5m": "5min", "15m": "15min", "30m": "30min",
    "1h": "1h", "4h": "4h", "1d": "1day", "1wk": "1week", "1mo": "1month",
}


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
                    "apikey": _td_key()},
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


def _twelve_data_history(
    symbol: str, interval: str, days: int = 30,
    start_ts: Optional[float] = None, end_ts: Optional[float] = None,
    timeout: int = 15,
) -> Optional[pd.DataFrame]:
    """美股/ETF K 线历史 via Twelve Data time_series → yfinance 兼容 DataFrame。"""
    if not _td_key():
        return None
    td_interval = _YF_INTERVAL_TO_TD.get(str(interval).lower())
    if not td_interval:
        logger.warning("Twelve Data history %s: unsupported interval %r", symbol, interval)
        return None
    try:
        params = {"symbol": symbol, "interval": td_interval,
                  "outputsize": max(1, int(days)), "apikey": _td_key()}
        if start_ts:
            params["start_date"] = datetime.fromtimestamp(float(start_ts)).strftime("%Y-%m-%d")
        if end_ts:
            params["end_date"] = datetime.fromtimestamp(float(end_ts)).strftime("%Y-%m-%d")
        resp = requests.get("https://api.twelvedata.com/time_series",
                            params=params, timeout=timeout)
        data = resp.json()
        values = data.get("values") or []
        if data.get("status") != "ok" or not values:
            return None
        rows = [{
            "ts": pd.Timestamp(v["datetime"]),
            "Open": float(v["open"]), "High": float(v["high"]),
            "Low": float(v["low"]), "Close": float(v["close"]),
            "Volume": float(v.get("volume") or 0),
        } for v in values]
        rows.sort(key=lambda r: r["ts"])
        df = pd.DataFrame(rows).set_index("ts")
        df.index.name = "Date"
        return df
    except Exception as exc:
        logger.warning("Twelve Data history %s failed: %s", symbol, exc)
        return None


def _frankfurter_history(
    symbol: str, days: int = 30,
    start_ts: Optional[float] = None, end_ts: Optional[float] = None,
    timeout: int = 15,
) -> Optional[pd.DataFrame]:
    """外汇对日线历史 via frankfurter（ECB；仅日线，无实时分时）。"""
    base, _, quote = symbol.partition("/")
    if not quote:
        return None
    try:
        end = datetime.fromtimestamp(float(end_ts)) if end_ts else datetime.now()
        start = datetime.fromtimestamp(float(start_ts)) if start_ts else end - timedelta(days=max(1, int(days)))
        resp = requests.get(
            f"https://api.frankfurter.app/{start.strftime('%Y-%m-%d')}..{end.strftime('%Y-%m-%d')}",
            params={"from": base, "to": quote}, timeout=timeout,
        )
        data = resp.json()
        rates = data.get("rates") or {}
        rows = []
        for date_str in sorted(rates):
            m = rates[date_str]
            if quote in m:
                val = float(m[quote])
                rows.append({"ts": pd.Timestamp(date_str), "Open": val, "High": val,
                             "Low": val, "Close": val, "Volume": 0.0})
        if not rows:
            return None
        df = pd.DataFrame(rows).set_index("ts")
        df.index.name = "Date"
        return df
    except Exception as exc:
        logger.warning("frankfurter history %s failed: %s", symbol, exc)
        return None


def to_fx_pair(symbol: str) -> str:
    """yfinance 外汇形态（EURUSD=X / EURUSD）→ 替代源形态（EUR/USD）。非外汇返回 ""。"""
    s = str(symbol).upper()
    if s.endswith("=X"):
        s = s[:-2]
    if "/" in s:
        return s
    if len(s) == 6 and s.isalpha():
        return f"{s[:3]}/{s[3:]}"
    return ""


def get_latest_close(symbol: str, timeout: int = 12) -> Optional[float]:
    """按 symbol 类型路由到免费/带 key 源，返回最新收盘价（失败 None）。

    外汇对：frankfurter 优先（免费无配额）→ Twelve Data 兜底；
    股票/ETF：Twelve Data（free 版支持常见美股/ETF）。
    """
    if "/" in symbol:  # 外汇对
        close = _frankfurter_close(symbol, timeout)
        if close is None:
            close = _twelve_data_close(symbol, timeout)
        return close
    return _twelve_data_close(symbol, timeout)


def get_history(
    symbol: str, interval: str = "1d", days: int = 30,
    start_ts: Optional[float] = None, end_ts: Optional[float] = None,
    timeout: int = 15,
) -> Optional[pd.DataFrame]:
    """K 线历史 → yfinance 兼容 DataFrame（DatetimeIndex + OHLCV），失败 None。

    interval 兼容 yfinance 风格（1m/5m/15m/30m/1h/4h/1d/1wk/1mo）。
    美股/ETF → Twelve Data；外汇对（含 / 的 symbol）→ frankfurter（仅日线，
    非日线 interval 返回 None）。
    """
    if "/" in symbol:  # 外汇对
        if str(interval).lower() not in ("1d", "1day"):
            return None
        return _frankfurter_history(symbol, days=days, start_ts=start_ts,
                                    end_ts=end_ts, timeout=timeout)
    return _twelve_data_history(symbol, interval, days=days, start_ts=start_ts,
                                end_ts=end_ts, timeout=timeout)
