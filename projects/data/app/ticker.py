"""TickerProvider — 实时报价（DS-7，B 端 data-service）。

契约（见 AITRADER_DATA_SERVICE_REQ.md DS-7）：
  GET /ticker?symbol=BTC/USDT&market_type=spot|swap&exchange_id=binance&market=...

统一返回（对齐 AItrader KlineService.get_realtime_price 字段）：
  {symbol, price, change, changePercent, high, low, open, previousClose, ts}

数据源（fail-silent 回退链）：
  - crypto   → ccxt fetch_ticker（binance，spot / swap）
  - usstock / forex / futures → yfinance fast_info（Yahoo 限流时回退 kline 最新 1d bar）
  - cnstock / hkstock → 腾讯实时行情（qt.gtimg.cn，免费无 key）
  - 兜底：kline 表最新 1d bar（previousClose 取倒数第二根）

短 TTL 内存缓存（TICKER_CACHE_TTL_SEC，默认 10s，催办单建议 5-30s）。
实时源全部失败且无 kline 兜底时返回 None（fail-silent，无模拟数据）。
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
from pathlib import Path
from typing import Optional

import ccxt
import requests

from app.config import KL_EXCHANGE, DATA_CONFIG_PATH
from app.storage import get_db

logger = logging.getLogger(__name__)

# ── 短 TTL 缓存（5-30s 建议区间，取 10s） ─────────────────────
_CACHE_TTL_SEC = int(os.getenv("TICKER_CACHE_TTL_SEC", "10"))
_cache: dict[str, tuple[float, Optional[dict]]] = {}
_cache_lock = threading.Lock()

_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
       "AppleWebKit/537.36 Chrome/124.0 Safari/537.36")

# ccxt 交易所实例（懒加载，复用连接池）
_exchange: Optional[ccxt.Exchange] = None
_exchange_lock = threading.Lock()

# multi_kline 配置缓存（market → 符号列表，用于符号反查 market）
_multi_config: Optional[dict] = None


def _load_multi_config() -> dict:
    """Lazy-load multi_kline 配置（市场 → 符号反查表）。"""
    global _multi_config
    if _multi_config is None:
        try:
            cfg = json.loads(Path(DATA_CONFIG_PATH).read_text())
            _multi_config = cfg.get("multi_kline") or {}
        except Exception:
            _multi_config = {}
    return _multi_config


# ── 符号 / 市场解析 ──────────────────────────────────────────

_MARKET_KEY = {
    "us_stocks": "usstock", "forex": "forex", "futures": "futures",
    "cn_stocks": "cnstock", "hk_stocks": "hkstock",
}


def infer_market(symbol: str) -> Optional[str]:
    """符号 → 市场推断（显式 market 缺失时兜底）。

    优先级：multi_kline 配置反查 → 符号特征。
    """
    cfg = _load_multi_config()
    for cfg_key, market in _MARKET_KEY.items():
        for item in (cfg.get(cfg_key) or {}).get("symbols", []):
            if item.get("symbol") == symbol:
                return market
    s = symbol.upper().strip()
    if s.endswith("=X"):
        return "forex"
    if s.endswith("=F"):
        return "futures"
    if "/" in symbol:
        # 6 字母 3+3 货币对（EUR/USD、GBP/USD）→ 外汇；否则 crypto
        base, quote = symbol.split("/", 1)
        if ":" in quote:
            quote = quote.split(":")[0]
        if len(base) == 3 and len(quote) == 3 and base.isalpha() and quote.isalpha():
            return "forex"
        return "crypto"
    if s.isdigit():
        # A股 6 位（6→沪 0/3→深）；港股 5 位（0 开头）
        if len(s) == 5:
            return "hkstock"
        if len(s) == 6:
            return "cnstock"
    if s.isalpha():
        return "usstock"
    return None


def _swap_symbol(symbol: str) -> str:
    """crypto 交易对 → ccxt swap 符号（base/quote:quote），已是 :quote 则原样返回。"""
    if ":" in symbol:
        return symbol
    if "/" in symbol:
        base, quote = symbol.split("/", 1)
        if ":" in quote:
            return symbol
        return f"{base}/{quote}:{quote}"
    return symbol


def _normalize_forex_symbol(symbol: str) -> str:
    """外汇符号规范化：EUR/USD / EURUSD → yfinance 形式 EURUSD=X。

    采集存储键与 yfinance/Twelve Data 均用 ``EURUSD=X``（B 端反馈：
    /ticker?symbol=EUR/USD 曾 404——infer_market 无法识别斜杠形式）。
    """
    s = symbol.strip().upper()
    if s.endswith("=X"):
        return symbol.strip()
    if "/" in s:
        base, quote = s.split("/", 1)
        if ":" in quote:
            quote = quote.split(":")[0]
        if len(base) == 3 and len(quote) == 3 and base.isalpha() and quote.isalpha():
            return f"{base}{quote}=X"
    if len(s) == 6 and s.isalpha():
        return f"{s[:3]}{s[3:]}=" + "X"
    return symbol.strip()


def _cn_prefix(symbol: str) -> str:
    """A股代码 → 交易所前缀（6→sh，0/3→sz）。"""
    if symbol.startswith("6"):
        return "sh"
    if symbol.startswith(("0", "3")):
        return "sz"
    return "sh"


def _float(v) -> Optional[float]:
    try:
        f = float(v)
        return None if f != f else f  # NaN → None
    except (TypeError, ValueError):
        return None


# ── 数据源 ──────────────────────────────────────────────────

def _get_exchange(exchange_id: Optional[str] = None) -> Optional[ccxt.Exchange]:
    """懒加载 ccxt 交易所（默认 binance）。"""
    global _exchange
    name = (exchange_id or KL_EXCHANGE).strip().lower()
    if _exchange is None or name != getattr(_exchange, "id", ""):
        with _exchange_lock:
            if _exchange is None or name != getattr(_exchange, "id", ""):
                try:
                    _exchange = getattr(ccxt, name)({
                        "enableRateLimit": True,
                        "options": {"defaultType": "spot"},
                    })
                    logger.info("TickerProvider: ccxt.%s initialized", name)
                except Exception as exc:
                    logger.warning("TickerProvider: ccxt.%s init failed: %s", name, exc)
                    return None
    return _exchange


def _fetch_crypto(symbol: str, market_type: str, exchange_id: Optional[str]) -> Optional[dict]:
    """ccxt 实时行情（spot / swap）。"""
    ex = _get_exchange(exchange_id)
    if ex is None:
        return None
    ccxt_sym = _swap_symbol(symbol) if market_type == "swap" else symbol
    try:
        t = ex.fetch_ticker(ccxt_sym)
    except Exception as exc:
        logger.debug("ccxt ticker failed %s: %s", ccxt_sym, exc)
        return None
    price = _float(t.get("last") or t.get("close") or t.get("bid"))
    if price is None:
        return None
    prev_close = _kline_prev_close(symbol)
    change = _float(t.get("change"))
    change_pct = _float(t.get("percentage"))
    if change is None and prev_close is not None:
        change = round(price - prev_close, 8)
    if change_pct is None and prev_close:
        change_pct = round((price - prev_close) / prev_close * 100, 4)
    return {
        "symbol": symbol,
        "price": price,
        "change": change,
        "changePercent": change_pct,
        "high": _float(t.get("high")),
        "low": _float(t.get("low")),
        "open": _float(t.get("open")),
        "previousClose": prev_close,
        "ts": int(t.get("timestamp") or time.time() * 1000),
    }


def _fetch_yfinance(symbol: str) -> Optional[dict]:
    """yfinance fast_info 实时行情（美股/外汇/期货）。限流失败返回 None。"""
    try:
        import yfinance as yf
        t = yf.Ticker(symbol)
        fi = t.fast_info
        price = _float(fi.get("last_price"))
        if price is None:
            return None
        prev_close = _float(fi.get("previous_close"))
        change = _float(fi.get("day_change"))
        change_pct = _float(fi.get("day_change_percent"))
        if change is None and prev_close:
            change = round(price - prev_close, 8)
        if change_pct is None and prev_close:
            change_pct = round((price - prev_close) / prev_close * 100, 4)
        return {
            "symbol": symbol,
            "price": price,
            "change": change,
            "changePercent": change_pct,
            "high": _float(fi.get("day_high")),
            "low": _float(fi.get("day_low")),
            "open": _float(fi.get("open")),
            "previousClose": prev_close,
            "ts": int(time.time() * 1000),
        }
    except Exception as exc:
        logger.debug("yfinance ticker failed %s: %s", symbol, exc)
        return None


def _fetch_twelve_data(symbol: str, market: str) -> Optional[dict]:
    """Twelve Data quote 实时报价（备用源，Yahoo 限流/反爬时兜底）。

    覆盖 usstock / forex；依赖 TWELVE_DATA_API_KEY（admin/config 可热配）。
    yfinance 用 ``EURUSD=X``，Twelve Data 用 ``EUR/USD``。
    """
    try:
        from app.config import APIKeys
        key = APIKeys.rotate("TWELVE_DATA_API_KEY")
        if not key:
            return None
        if market == "forex":
            td_symbol = symbol.upper().replace("=X", "").replace("=", "")
            if len(td_symbol) != 6:
                return None
            td_symbol = f"{td_symbol[:3]}/{td_symbol[3:]}"
        else:
            td_symbol = symbol
        resp = requests.get(
            "https://api.twelvedata.com/quote",
            params={"symbol": td_symbol, "apikey": key},
            timeout=10,
        )
        if resp.status_code != 200:
            return None
        d = resp.json() or {}
        price = _float(d.get("close"))
        if price is None:
            return None
        prev_close = _float(d.get("previous_close"))
        change = _float(d.get("change"))
        change_pct = _float(d.get("percent_change"))
        if change is None and prev_close:
            change = round(price - prev_close, 8)
        if change_pct is None and prev_close:
            change_pct = round((price - prev_close) / prev_close * 100, 4)
        return {
            "symbol": symbol,
            "price": price,
            "change": change,
            "changePercent": change_pct,
            "high": _float(d.get("high")),
            "low": _float(d.get("low")),
            "open": _float(d.get("open")),
            "previousClose": prev_close,
            "ts": int(time.time() * 1000),
        }
    except Exception as exc:
        logger.debug("twelve data ticker failed %s: %s", symbol, exc)
        return None


def _fetch_tencent(symbol: str, market: str) -> Optional[dict]:
    """腾讯实时行情（qt.gtimg.cn）— A股/港股/美股，免费无 key。"""
    try:
        if market == "hkstock":
            prefix = "hk"
        elif market == "usstock":
            prefix = "us"  # 美股（如 usSPY / usAAPL），免费源，Yahoo 限流时兜底
        else:
            prefix = _cn_prefix(symbol)
        code = f"{prefix}{symbol.upper() if market == 'usstock' else symbol}"
        resp = requests.get(
            f"https://qt.gtimg.cn/q={code}",
            headers={"User-Agent": _UA},
            timeout=8,
        )
        if resp.status_code != 200:
            return None
        text = resp.content.decode("gbk", errors="ignore")
        payload = text.split("=", 1)[1].strip().strip(';"')
        fields = payload.split("~")
        if len(fields) < 35:
            return None
        price = _float(fields[3])
        prev_close = _float(fields[4])
        if price is None:
            return None
        open_p = _float(fields[5])
        high = _float(fields[33])
        low = _float(fields[34])
        change = _float(fields[31])
        change_pct = _float(fields[32])
        if change is None and prev_close:
            change = round(price - prev_close, 4)
        if change_pct is None and prev_close:
            change_pct = round((price - prev_close) / prev_close * 100, 2)
        ts_str = fields[30]
        ts = None
        if ts_str:
            try:
                from datetime import datetime as _dt
                for fmt in ("%Y%m%d%H%M%S", "%Y-%m-%d %H:%M:%S"):
                    try:
                        ts = int(_dt.strptime(ts_str, fmt).timestamp() * 1000)
                        break
                    except ValueError:
                        continue
            except Exception:
                ts = None
        return {
            "symbol": symbol,
            "price": price,
            "change": change,
            "changePercent": change_pct,
            "high": high,
            "low": low,
            "open": open_p,
            "previousClose": prev_close,
            "ts": ts or int(time.time() * 1000),
        }
    except Exception as exc:
        logger.debug("tencent ticker failed %s: %s", symbol, exc)
        return None


def _kline_prev_close(symbol: str) -> Optional[float]:
    """kline 1d 倒数第二根 close（作为 previousClose 兜底）。"""
    try:
        db = get_db()
        rows = db.execute(
            "SELECT close FROM kline WHERE symbol=? AND timeframe='1d' ORDER BY ts DESC LIMIT 2",
            (symbol,),
        ).fetchall()
        if len(rows) >= 2 and rows[1]["close"] is not None:
            return float(rows[1]["close"])
    except Exception:
        pass
    return None


def _kline_fallback(symbol: str) -> Optional[dict]:
    """kline 表最新 1d bar 兜底报价（实时源不可用时的降级）。"""
    try:
        db = get_db()
        rows = db.execute(
            "SELECT ts, open, high, low, close FROM kline "
            "WHERE symbol=? AND timeframe='1d' ORDER BY ts DESC LIMIT 2",
            (symbol,),
        ).fetchall()
        if not rows or rows[0]["close"] is None:
            return None
        last = rows[0]
        prev_close = float(rows[1]["close"]) if len(rows) >= 2 and rows[1]["close"] is not None else None
        close = float(last["close"])
        change = round(close - prev_close, 8) if prev_close else None
        change_pct = round((close - prev_close) / prev_close * 100, 4) if prev_close else None
        return {
            "symbol": symbol,
            "price": close,
            "change": change,
            "changePercent": change_pct,
            "high": _float(last["high"]),
            "low": _float(last["low"]),
            "open": _float(last["open"]),
            "previousClose": prev_close,
            "ts": int(last["ts"]),
        }
    except Exception as exc:
        logger.debug("kline ticker fallback failed %s: %s", symbol, exc)
        return None


# ── 主入口 ──────────────────────────────────────────────────

def get_ticker(
    symbol: str,
    market_type: str = "spot",
    exchange_id: Optional[str] = None,
    market: Optional[str] = None,
) -> Optional[dict]:
    """实时报价（带短 TTL 缓存）；全部失败返回 None（fail-silent）。"""
    if not symbol or not symbol.strip():
        return None
    symbol = symbol.strip()
    market_type = (market_type or "spot").lower()
    if market_type not in ("spot", "swap"):
        return None
    mkt = (market or "").lower() or infer_market(symbol)
    if mkt is None:
        return None

    cache_key = f"{mkt}:{market_type}:{symbol}"
    with _cache_lock:
        hit = _cache.get(cache_key)
        if hit and (time.time() - hit[0]) < _CACHE_TTL_SEC:
            return hit[1]

    result: Optional[dict] = None
    if mkt == "crypto":
        result = _fetch_crypto(symbol, market_type, exchange_id)
    elif mkt in ("usstock", "forex", "futures"):
        # 外汇符号规范化（EUR/USD → EURUSD=X，yfinance 形式）
        quote_symbol = _normalize_forex_symbol(symbol) if mkt == "forex" else symbol
        result = _fetch_yfinance(quote_symbol)
        if result is None and mkt == "usstock":
            # Yahoo 限流/反爬 → 腾讯美股实时（免费无 key）
            result = _fetch_tencent(symbol, "usstock")
        if result is None and mkt == "forex":
            # Twelve Data 备用（免费 tier 限流 8/min，尽力而为）
            result = _fetch_twelve_data(quote_symbol, mkt)
    elif mkt in ("cnstock", "hkstock"):
        result = _fetch_tencent(symbol, mkt)
    if result is None:
        # 兜底用规范化的存储键（外汇 EUR/USD → EURUSD=X），避免 404
        result = _kline_fallback(quote_symbol if mkt == "forex" else symbol)

    with _cache_lock:
        _cache[cache_key] = (time.time(), result)
    return result
