"""Opportunity scanner collector — cross-asset momentum scan → raw_snapshots.

Ports the legacy ``data_providers/opportunities.py`` (+ the crypto / forex
price fetchers it depended on) into the data-service collector architecture.
The removed ``app.data_providers`` package is not referenced:

  - crypto  → existing CCXT-based ``CryptoDataSource`` (DataSourceFactory)
  - forex   → inlined Three-Tier fetcher (Twelve Data → yfinance → Tiingo)
  - stocks  → DataSourceFactory + free Yahoo chart / Stooq / urlopen fallbacks

Each cycle fetches crypto / US / CN / HK stock / forex quotes, runs lightweight
momentum analysis, and writes one ``opportunities`` snapshot (provider=
"opportunities", data_type="opportunities") that keeps both the derived signals
and the raw market rows so /snapshots can serve either.

Design: fail-silent background thread (no API key required for basic usage).
"""

from __future__ import annotations

import logging
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

import requests

from app import config as app_config
from app.factors import save_snapshot
from app.utils.logger import get_logger

logger = get_logger(__name__)

COLLECT_INTERVAL = int(os.getenv("OPPORTUNITY_COLLECT_INTERVAL_SEC", "1800"))  # 30 min


# ── Helpers ──────────────────────────────────────────────────

def safe_float(value: Any, default: float = 0.0) -> float:
    """Coerce ``value`` to float; ``None``/non-numeric/NaN → ``default``."""
    try:
        if value is None:
            return default
        number = float(value)
    except (TypeError, ValueError):
        return default
    return number if number == number else default


# ── Crypto prices (CCXT via existing data source) ─────────────

_CRYPTO_SYMBOLS = [
    "BTC/USDT", "ETH/USDT", "BNB/USDT", "SOL/USDT", "XRP/USDT",
    "ADA/USDT", "DOGE/USDT", "AVAX/USDT", "DOT/USDT", "POL/USDT",
    "LINK/USDT", "LTC/USDT", "UNI/USDT", "ATOM/USDT", "XLM/USDT",
]


def fetch_crypto_prices() -> List[Dict[str, Any]]:
    """Top crypto prices via CCXT (existing CryptoDataSource)."""
    try:
        from app.data_sources import DataSourceFactory
        source = DataSourceFactory.get_source("Crypto")
        result: List[Dict[str, Any]] = []
        for symbol in _CRYPTO_SYMBOLS:
            try:
                ticker = source.get_ticker(symbol) or {}
                last = safe_float(ticker.get("last") or ticker.get("close"))
                if last <= 0:
                    continue
                base = symbol.split("/")[0]
                result.append({
                    "symbol": base,
                    "name": base,
                    "price": round(last, 4),
                    "change_24h": safe_float(ticker.get("percentage")),
                    "change_7d": 0.0,
                    "volume_24h": safe_float(ticker.get("quoteVolume")),
                    "category": "crypto",
                })
            except Exception as e:
                logger.debug("Crypto ticker %s failed: %s", symbol, e)
        if result:
            logger.info("Fetched %d crypto prices via CCXT", len(result))
        return result
    except Exception as e:
        logger.debug("Crypto price fetch failed: %s", e)
        return []


# ── Forex pairs (Three-Tier, inlined from legacy forex.py) ────

_FOREX_PAIRS = [
    {"td": "EUR/USD", "yf": "EURUSD=X", "tiingo": "eurusd", "name_cn": "欧元/美元", "name_en": "EUR/USD", "base": "EUR", "quote": "USD"},
    {"td": "GBP/USD", "yf": "GBPUSD=X", "tiingo": "gbpusd", "name_cn": "英镑/美元", "name_en": "GBP/USD", "base": "GBP", "quote": "USD"},
    {"td": "USD/JPY", "yf": "USDJPY=X", "tiingo": "usdjpy", "name_cn": "美元/日元", "name_en": "USD/JPY", "base": "USD", "quote": "JPY"},
    {"td": "USD/CNH", "yf": "USDCNH=X", "tiingo": "usdcnh", "name_cn": "美元/离岸人民币", "name_en": "USD/CNH", "base": "USD", "quote": "CNH"},
    {"td": "AUD/USD", "yf": "AUDUSD=X", "tiingo": "audusd", "name_cn": "澳元/美元", "name_en": "AUD/USD", "base": "AUD", "quote": "USD"},
    {"td": "USD/CAD", "yf": "USDCAD=X", "tiingo": "usdcad", "name_cn": "美元/加元", "name_en": "USD/CAD", "base": "USD", "quote": "CAD"},
    {"td": "USD/CHF", "yf": "USDCHF=X", "tiingo": "usdchf", "name_cn": "美元/瑞郎", "name_en": "USD/CHF", "base": "USD", "quote": "CHF"},
    {"td": "NZD/USD", "yf": "NZDUSD=X", "tiingo": "nzdusd", "name_cn": "纽元/美元", "name_en": "NZD/USD", "base": "NZD", "quote": "USD"},
    {"td": "EUR/GBP", "yf": "EURGBP=X", "tiingo": "eurgbp", "name_cn": "欧元/英镑", "name_en": "EUR/GBP", "base": "EUR", "quote": "GBP"},
    {"td": "EUR/JPY", "yf": "EURJPY=X", "tiingo": "eurjpy", "name_cn": "欧元/日元", "name_en": "EUR/JPY", "base": "EUR", "quote": "JPY"},
    {"td": "GBP/JPY", "yf": "GBPJPY=X", "tiingo": "gbpjpy", "name_cn": "英镑/日元", "name_en": "GBP/JPY", "base": "GBP", "quote": "JPY"},
    {"td": "USD/HKD", "yf": "USDHKD=X", "tiingo": "usdhkd", "name_cn": "美元/港币", "name_en": "USD/HKD", "base": "USD", "quote": "HKD"},
]


def _forex_row(pair: dict, price: float, change: float) -> Dict[str, Any]:
    return {
        "symbol": pair["td"],
        "name": pair["td"],
        "name_cn": pair["name_cn"],
        "name_en": pair["name_en"],
        "price": round(price, 5),
        "change": round(change, 2),
        "base": pair["base"],
        "quote": pair["quote"],
        "category": "forex",
    }


def _fetch_forex_twelve_data(pairs: list) -> List[Dict[str, Any]]:
    """Tier 1: Twelve Data quote API."""
    api_key = (app_config.TWELVE_DATA_API_KEY or "").strip()
    if not api_key:
        return []
    result: List[Dict[str, Any]] = []
    for pair in pairs:
        try:
            resp = requests.get("https://api.twelvedata.com/quote", params={
                "symbol": pair["td"], "apikey": api_key,
            }, timeout=10)
            data = resp.json()
            if data.get("status") == "error" or not data.get("close"):
                continue
            current = float(data.get("close") or 0)
            prev = float(data.get("previous_close") or 0)
            change = ((current - prev) / prev * 100) if prev else 0
            result.append(_forex_row(pair, current, change))
        except Exception as e:
            logger.debug("TwelveData forex quote %s failed: %s", pair["td"], e)
    if result:
        logger.info("Fetched %d forex pairs via Twelve Data", len(result))
    return result


def _fetch_forex_yfinance(pairs: list) -> List[Dict[str, Any]]:
    """Tier 2: yfinance batch."""
    try:
        import yfinance as yf
        symbols = [p["yf"] for p in pairs]
        tickers = yf.Tickers(" ".join(symbols))
        result: List[Dict[str, Any]] = []
        for pair in pairs:
            try:
                ticker = tickers.tickers.get(pair["yf"])
                if not ticker:
                    continue
                hist = ticker.history(period="2d")
                if len(hist) >= 2:
                    prev_close = hist["Close"].iloc[-2]
                    current = hist["Close"].iloc[-1]
                    change = ((current - prev_close) / prev_close) * 100
                elif len(hist) == 1:
                    current = hist["Close"].iloc[-1]
                    change = 0
                else:
                    continue
                result.append(_forex_row(pair, current, change))
            except Exception as e:
                logger.debug("yfinance forex %s failed: %s", pair["yf"], e)
        return result
    except Exception as e:
        logger.debug("yfinance forex batch failed: %s", e)
        return []


def _fetch_forex_tiingo(pairs: list) -> List[Dict[str, Any]]:
    """Tier 3: Tiingo FX (requires key)."""
    api_key = (app_config.TIINGO_API_KEY or "").strip()
    if not api_key:
        return []
    base_url = (app_config.TiingoConfig.BASE_URL or "https://api.tiingo.com/tiingo").rstrip("/")
    result: List[Dict[str, Any]] = []
    for pair in pairs:
        tiingo_sym = pair.get("tiingo")
        if not tiingo_sym:
            continue
        try:
            resp = requests.get(f"{base_url}/fx/{tiingo_sym}/prices", params={
                "startDate": (datetime.now() - timedelta(days=3)).strftime("%Y-%m-%d"),
                "endDate": datetime.now().strftime("%Y-%m-%d"),
                "resampleFreq": "1day",
                "token": api_key,
            }, timeout=10)
            if resp.status_code != 200:
                continue
            data = resp.json()
            if not data or len(data) < 1:
                continue
            current = float(data[-1].get("close", 0) or 0)
            prev = float(data[-2].get("close", 0) or 0) if len(data) >= 2 else 0
            change = ((current - prev) / prev * 100) if prev else 0
            if current > 0:
                result.append(_forex_row(pair, current, change))
        except Exception as e:
            logger.debug("Tiingo forex %s failed: %s", tiingo_sym, e)
    if result:
        logger.info("Fetched %d forex pairs via Tiingo", len(result))
    return result


def fetch_forex_pairs() -> List[Dict[str, Any]]:
    """Fetch major forex pairs. Priority: Twelve Data → yfinance → Tiingo."""
    pairs = _FOREX_PAIRS
    result: List[Dict[str, Any]] = []
    for fetcher in (_fetch_forex_twelve_data, _fetch_forex_yfinance, _fetch_forex_tiingo):
        try:
            batch = fetcher(pairs)
        except Exception as e:
            logger.debug("Forex fetcher %s failed: %s", getattr(fetcher, "__name__", "?"), e)
            batch = []
        existing = {r["symbol"] for r in result}
        for row in batch:
            if row["symbol"] not in existing:
                result.append(row)
        if len(result) >= len(pairs) // 2:
            break
    return result


# ── Stock quotes (Yahoo chart / Stooq / urlopen fallbacks) ────

def _fetch_yahoo_chart_quote(symbol: str) -> Optional[Dict[str, Any]]:
    """US spot quote via Yahoo chart API — lighter than yfinance batch calls."""
    sym = (symbol or "").strip().upper()
    if not sym:
        return None
    try:
        resp = requests.get(
            f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}",
            params={"interval": "1d", "range": "5d"},
            headers={"User-Agent": "Mozilla/5.0 (compatible; AItrader/1.0)"},
            timeout=10,
        )
        resp.raise_for_status()
        result = (resp.json().get("chart") or {}).get("result") or []
        if not result:
            return None
        meta = result[0].get("meta") or {}
        price = safe_float(meta.get("regularMarketPrice") or meta.get("previousClose"))
        prev = safe_float(meta.get("chartPreviousClose") or meta.get("previousClose") or price)
        if price <= 0:
            return None
        change_pct = ((price - prev) / prev * 100.0) if prev > 0 else 0.0
        return {"last": price, "changePercent": round(change_pct, 2), "previousClose": prev}
    except Exception as e:
        logger.debug("Yahoo chart quote failed for %s: %s", sym, e)
        return None


def _fetch_stooq_us_quote(symbol: str) -> Optional[Dict[str, Any]]:
    """US spot quote via Stooq (works when Yahoo/yfinance are blocked)."""
    sym = f"{(symbol or '').strip().lower()}.us"
    if not sym or sym == ".us":
        return None
    try:
        resp = requests.get(
            "https://stooq.com/q/l/",
            params={"s": sym, "f": "sd2t2ohlcv", "h": "", "e": "csv"},
            headers={"User-Agent": "Mozilla/5.0 (compatible; AItrader/1.0)"},
            timeout=8,
        )
        resp.raise_for_status()
        lines = [ln for ln in resp.text.strip().splitlines() if ln and not ln.startswith("Symbol")]
        if not lines:
            return None
        parts = lines[-1].split(",")
        if len(parts) < 7:
            return None
        open_px = safe_float(parts[3])
        close_px = safe_float(parts[6])
        if close_px <= 0:
            return None
        base = open_px if open_px > 0 else close_px
        change_pct = ((close_px - open_px) / base * 100.0) if base > 0 else 0.0
        return {"last": close_px, "changePercent": round(change_pct, 2)}
    except Exception as e:
        logger.debug("Stooq quote failed for %s: %s", symbol, e)
        return None


def _fetch_yahoo_urlopen_quote(symbol: str) -> Optional[Dict[str, Any]]:
    """US spot quote via Yahoo chart API using urlopen (bypasses requests)."""
    import json
    from urllib.request import Request, urlopen

    sym = (symbol or "").strip().upper()
    if not sym:
        return None
    try:
        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{sym}?interval=1d&range=5d"
        req = Request(url, headers={
            "User-Agent": "Mozilla/5.0 (compatible; AItrader/1.0)",
            "Accept": "application/json",
        })
        with urlopen(req, timeout=12) as resp:
            body = json.loads(resp.read().decode())
        result = (body.get("chart") or {}).get("result") or []
        if not result:
            return None
        meta = result[0].get("meta") or {}
        price = safe_float(meta.get("regularMarketPrice") or meta.get("previousClose"))
        prev = safe_float(meta.get("chartPreviousClose") or meta.get("previousClose") or price)
        if price <= 0:
            return None
        change_pct = ((price - prev) / prev * 100.0) if prev > 0 else 0.0
        return {"last": price, "changePercent": round(change_pct, 2), "previousClose": prev}
    except Exception as e:
        logger.debug("Yahoo urlopen quote failed for %s: %s", sym, e)
        return None


def _fetch_single_local_stock_quote(market: str, item: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Fetch one US/CN/HK stock quote row."""
    from app.data_sources import DataSourceFactory
    from app.symbol_name import resolve_symbol_name

    m = str(market or "").strip()
    symbol = str((item or {}).get("symbol") or "").strip()
    if not symbol:
        return None

    last = 0.0
    change_pct = 0.0
    if m == "USStock":
        # Tier 1: DataSourceFactory (USStock source does Finnhub → yfinance)
        source = DataSourceFactory.get_source(m)
        ticker = source.get_ticker(symbol) or {}
        last = safe_float(ticker.get("last") or ticker.get("close") or ticker.get("price"))
        change_pct = ticker.get("changePercent")
        if change_pct is None:
            prev_close = safe_float(ticker.get("previousClose"))
            change_pct = ((last - prev_close) / prev_close * 100.0) if prev_close > 0 else 0.0
        # Fallback 2: Yahoo chart (free, but rate-limited → stagger)
        if last <= 0:
            yahoo = _fetch_yahoo_chart_quote(symbol)
            if yahoo:
                last = safe_float(yahoo.get("last"))
                change_pct = safe_float(yahoo.get("changePercent"))
        if last <= 0:
            time.sleep(0.4)
        # Fallback 3: Stooq (free, no auth)
        if last <= 0:
            stooq = _fetch_stooq_us_quote(symbol)
            if stooq:
                last = safe_float(stooq.get("last"))
                change_pct = safe_float(stooq.get("changePercent"))
        if last <= 0:
            time.sleep(0.4)
        # Fallback 4: Yahoo chart via urlopen
        if last <= 0:
            yahoo2 = _fetch_yahoo_urlopen_quote(symbol)
            if yahoo2:
                last = safe_float(yahoo2.get("last"))
                change_pct = safe_float(yahoo2.get("changePercent"))
    else:
        source = DataSourceFactory.get_source(m)
        ticker = source.get_ticker(symbol) or {}
        last = safe_float(ticker.get("last") or ticker.get("close") or ticker.get("price"))
        change_pct = ticker.get("changePercent")
        if change_pct is None:
            prev_close = safe_float(ticker.get("previousClose"))
            change_pct = ((last - prev_close) / prev_close * 100.0) if prev_close > 0 else 0.0

    if last <= 0:
        return None
    return {
        "symbol": symbol,
        "name": (item.get("name") or resolve_symbol_name(m, symbol) or symbol).strip(),
        "price": round(last, 4 if m != "USStock" else 2),
        "change": round(safe_float(change_pct), 2),
        "market": m,
    }


_FALLBACK_SYMBOLS = {
    "USStock": [
        {"symbol": "AAPL", "name": "Apple"}, {"symbol": "MSFT", "name": "Microsoft"},
        {"symbol": "GOOGL", "name": "Alphabet"}, {"symbol": "AMZN", "name": "Amazon"},
        {"symbol": "TSLA", "name": "Tesla"}, {"symbol": "NVDA", "name": "NVIDIA"},
        {"symbol": "META", "name": "Meta"}, {"symbol": "NFLX", "name": "Netflix"},
        {"symbol": "AMD", "name": "AMD"}, {"symbol": "CRM", "name": "Salesforce"},
        {"symbol": "COIN", "name": "Coinbase"}, {"symbol": "JPM", "name": "JPMorgan"},
        {"symbol": "V", "name": "Visa"}, {"symbol": "INTC", "name": "Intel"},
        {"symbol": "PLTR", "name": "Palantir"}, {"symbol": "ORCL", "name": "Oracle"},
        {"symbol": "QCOM", "name": "Qualcomm"},
    ],
    "CNStock": [
        {"symbol": "600519", "name": "贵州茅台"}, {"symbol": "000001", "name": "平安银行"},
        {"symbol": "300750", "name": "宁德时代"}, {"symbol": "601318", "name": "中国平安"},
        {"symbol": "600036", "name": "招商银行"}, {"symbol": "002594", "name": "比亚迪"},
        {"symbol": "600276", "name": "恒瑞医药"}, {"symbol": "601899", "name": "紫金矿业"},
        {"symbol": "000858", "name": "五粮液"}, {"symbol": "000333", "name": "美的集团"},
        {"symbol": "600900", "name": "长江电力"}, {"symbol": "601398", "name": "工商银行"},
        {"symbol": "600030", "name": "中信证券"}, {"symbol": "300059", "name": "东方财富"},
        {"symbol": "603259", "name": "药明康德"}, {"symbol": "002475", "name": "立讯精密"},
        {"symbol": "600887", "name": "伊利股份"}, {"symbol": "000568", "name": "泸州老窖"},
        {"symbol": "601012", "name": "隆基绿能"}, {"symbol": "002415", "name": "海康威视"},
    ],
    "HKStock": [
        {"symbol": "00700", "name": "腾讯控股"}, {"symbol": "09988", "name": "阿里巴巴-W"},
        {"symbol": "03690", "name": "美团-W"}, {"symbol": "01810", "name": "小米集团-W"},
        {"symbol": "01299", "name": "友邦保险"}, {"symbol": "00939", "name": "建设银行"},
        {"symbol": "02318", "name": "中国平安"}, {"symbol": "09618", "name": "京东集团-SW"},
        {"symbol": "09888", "name": "百度集团-SW"}, {"symbol": "01024", "name": "快手-W"},
        {"symbol": "02015", "name": "理想汽车-W"}, {"symbol": "09868", "name": "小鹏汽车-W"},
        {"symbol": "00388", "name": "香港交易所"}, {"symbol": "02269", "name": "药明生物"},
        {"symbol": "00005", "name": "汇丰控股"}, {"symbol": "01398", "name": "工商银行"},
        {"symbol": "00883", "name": "中国海洋石油"},
    ],
}


def fetch_local_stock_opportunity_prices(market: str, limit: int = 15) -> List[Dict[str, Any]]:
    """Fetch US/CN/HK stock prices for opportunity scanning."""
    m = str(market or "").strip()
    if m not in ("CNStock", "HKStock", "USStock"):
        return []

    try:
        from app.data.market_symbols_seed import get_hot_symbols

        symbols = get_hot_symbols(m, limit=max(int(limit or 15), 1)) or []
        fallback = _FALLBACK_SYMBOLS.get(m, [])
        seen: set = set()
        merged: List[Dict[str, Any]] = []
        for item in list(symbols) + list(fallback):
            sym = str((item or {}).get("symbol") or "").strip()
            if not sym or sym in seen:
                continue
            seen.add(sym)
            merged.append(item)
        # Pull a few extra symbols so partial upstream failures still yield `limit` rows.
        fetch_count = max(int(limit or 15), 1) + 4
        items = merged[:fetch_count]
        if not items:
            return []

        result: List[Dict[str, Any]] = []
        if len(items) > 1:
            workers = min(3, len(items))  # small pool to avoid Yahoo 429 rate limits
            with ThreadPoolExecutor(max_workers=workers) as pool:
                futures = [pool.submit(_fetch_single_local_stock_quote, m, item) for item in items]
                for fut in as_completed(futures):
                    try:
                        row = fut.result()
                        if row:
                            result.append(row)
                    except Exception as e:
                        logger.debug("Parallel stock quote failed for %s: %s", m, e)
            return result[:max(int(limit or 15), 1)]

        for item in items:
            try:
                row = _fetch_single_local_stock_quote(m, item)
                if row:
                    result.append(row)
            except Exception as e:
                logger.debug("Failed to fetch %s opportunity price %s: %s", m, item.get("symbol"), e)
        return result[:max(int(limit or 15), 1)]
    except Exception as e:
        logger.debug("Failed to fetch %s opportunity prices: %s", m, e)
        return []


# ── Opportunity analysers (ported from legacy opportunities.py) ─

def analyze_opportunities_crypto(opportunities: list, crypto_data: list) -> None:
    """Scan crypto market for trading opportunities."""
    for coin in (crypto_data or [])[:20]:
        change = safe_float(coin.get("change_24h", 0))
        change_7d = safe_float(coin.get("change_7d", 0))
        symbol = coin.get("symbol", "")
        name = coin.get("name", "")
        price = safe_float(coin.get("price", 0))

        signal = strength = reason = None
        impact = "neutral"

        if change > 15:
            signal, strength = "overbought", "strong"
            reason = f"24h涨幅{change:.1f}%，7日涨幅{change_7d:.1f}%，短期超买风险"
            impact = "bearish"
        elif change > 5:
            signal, strength = "bullish_momentum", "medium"
            reason = f"24h涨幅{change:.1f}%，上涨动能强劲"
            impact = "bullish"
        elif change < -15:
            signal, strength = "oversold", "strong"
            reason = f"24h跌幅{abs(change):.1f}%，可能超卖反弹"
            impact = "bullish"
        elif change < -5:
            signal, strength = "bearish_momentum", "medium"
            reason = f"24h跌幅{abs(change):.1f}%，下跌趋势明显"
            impact = "bearish"

        if signal:
            opportunities.append({
                "symbol": symbol, "name": name, "price": price,
                "change_24h": change, "change_7d": change_7d,
                "signal": signal, "strength": strength, "reason": reason,
                "impact": impact, "market": "Crypto", "timestamp": int(time.time()),
            })


def analyze_opportunities_stocks(opportunities: list, stock_data: list) -> None:
    """Scan US stocks for trading opportunities."""
    for stock in (stock_data or []):
        change = safe_float(stock.get("change", 0))
        symbol, name, price = stock.get("symbol", ""), stock.get("name", ""), safe_float(stock.get("price", 0))

        signal = strength = reason = None
        impact = "neutral"

        if change > 5:
            signal, strength = "overbought", "strong"
            reason = f"日涨幅{change:.1f}%，短期涨幅较大，注意回调风险"; impact = "bearish"
        elif change > 2:
            signal, strength = "bullish_momentum", "medium"
            reason = f"日涨幅{change:.1f}%，上涨动能强劲"; impact = "bullish"
        elif change < -5:
            signal, strength = "oversold", "strong"
            reason = f"日跌幅{abs(change):.1f}%，可能超卖反弹"; impact = "bullish"
        elif change < -2:
            signal, strength = "bearish_momentum", "medium"
            reason = f"日跌幅{abs(change):.1f}%，下跌趋势明显"; impact = "bearish"

        if signal:
            opportunities.append({
                "symbol": symbol, "name": name, "price": price,
                "change_24h": change, "signal": signal, "strength": strength,
                "reason": reason, "impact": impact, "market": "USStock",
                "timestamp": int(time.time()),
            })


def analyze_opportunities_local_stocks(opportunities: list, stock_data: list, market: str) -> None:
    """Scan CN/HK stocks for trading opportunities."""
    m = str(market or "").strip()
    if m not in ("CNStock", "HKStock"):
        return

    if m == "CNStock":
        strong_th, medium_th, mild_th = 5.0, 2.0, 1.0
    else:
        strong_th, medium_th, mild_th = 4.0, 1.5, 0.8
    market_cn = "A股" if m == "CNStock" else "港股"

    for stock in (stock_data or []):
        change = safe_float(stock.get("change", 0))
        symbol, name, price = stock.get("symbol", ""), stock.get("name", ""), safe_float(stock.get("price", 0))
        abs_change = abs(change)

        signal = strength = reason = None
        impact = "neutral"

        if change > strong_th:
            signal, strength = "overbought", "strong"
            reason = f"{market_cn}日涨幅{change:.1f}%，短期涨幅较大，注意回调风险"; impact = "bearish"
        elif change > medium_th:
            signal, strength = "bullish_momentum", "medium"
            reason = f"{market_cn}日涨幅{change:.1f}%，上涨动能较强"; impact = "bullish"
        elif change > mild_th:
            signal, strength = "bullish_momentum", "weak"
            reason = f"{market_cn}日涨幅{change:.1f}%，温和上涨"; impact = "bullish"
        elif change < -strong_th:
            signal, strength = "oversold", "strong"
            reason = f"{market_cn}日跌幅{abs_change:.1f}%，可能超卖反弹"; impact = "bullish"
        elif change < -medium_th:
            signal, strength = "bearish_momentum", "medium"
            reason = f"{market_cn}日跌幅{abs_change:.1f}%，下跌趋势明显"; impact = "bearish"
        elif change < -mild_th:
            signal, strength = "bearish_momentum", "weak"
            reason = f"{market_cn}日跌幅{abs_change:.1f}%，温和下跌"; impact = "bearish"
        elif abs_change <= mild_th:
            signal, strength = "consolidation", "weak"
            reason = f"{market_cn}{name}窄幅震荡({change:+.1f}%)，等待方向选择"; impact = "neutral"

        if signal:
            opportunities.append({
                "symbol": symbol, "name": name, "price": price,
                "change_24h": change, "signal": signal, "strength": strength,
                "reason": reason, "impact": impact, "market": m,
                "timestamp": int(time.time()),
            })


def analyze_opportunities_forex(opportunities: list, forex_data: list) -> None:
    """Scan forex pairs for trading opportunities."""
    for pair in (forex_data or []):
        change = safe_float(pair.get("change", 0))
        symbol = pair.get("symbol", pair.get("name", ""))
        name = pair.get("name_cn", pair.get("name", ""))
        price = safe_float(pair.get("price", 0))

        signal = strength = reason = None
        impact = "neutral"

        if change > 1.5:
            signal, strength = "overbought", "strong"
            reason = f"日涨幅{change:.2f}%，汇率波动剧烈，注意回调"; impact = "bearish"
        elif change > 0.5:
            signal, strength = "bullish_momentum", "medium"
            reason = f"日涨幅{change:.2f}%，上涨动能较强"; impact = "bullish"
        elif change < -1.5:
            signal, strength = "oversold", "strong"
            reason = f"日跌幅{abs(change):.2f}%，汇率波动剧烈，可能反弹"; impact = "bullish"
        elif change < -0.5:
            signal, strength = "bearish_momentum", "medium"
            reason = f"日跌幅{abs(change):.2f}%，下跌趋势明显"; impact = "bearish"

        if signal:
            opportunities.append({
                "symbol": symbol, "name": name, "price": price,
                "change_24h": change, "signal": signal, "strength": strength,
                "reason": reason, "impact": impact, "market": "Forex",
                "timestamp": int(time.time()),
            })


# ── Collector ──────────────────────────────────────────────────

class OpportunityCollector:
    """Periodically scan all markets for momentum opportunities → raw_snapshots."""

    def __init__(self):
        self._running = False
        self._thread: Optional[threading.Thread] = None

    def start(self):
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._loop, daemon=True, name="opportunity-collector")
        self._thread.start()
        logger.info("OpportunityCollector started (interval=%ds)", COLLECT_INTERVAL)

    def stop(self):
        self._running = False

    def _loop(self):
        while self._running:
            try:
                self._collect()
            except Exception:
                logger.warning("Opportunity collector cycle failed", exc_info=True)
            time.sleep(COLLECT_INTERVAL)

    def _collect(self):
        markets: Dict[str, Any] = {}
        opportunities: List[Dict[str, Any]] = []

        # Crypto
        crypto = fetch_crypto_prices()
        if crypto:
            markets["crypto"] = crypto
            analyze_opportunities_crypto(opportunities, crypto)

        # Stocks (US / CN / HK)
        for market in ("USStock", "CNStock", "HKStock"):
            stocks = fetch_local_stock_opportunity_prices(market, limit=15)
            if stocks:
                markets[market] = stocks
                if market == "USStock":
                    analyze_opportunities_stocks(opportunities, stocks)
                else:
                    analyze_opportunities_local_stocks(opportunities, stocks, market)

        # Forex
        forex = fetch_forex_pairs()
        if forex:
            markets["forex"] = forex
            analyze_opportunities_forex(opportunities, forex)

        snapshot = {
            "opportunities": opportunities,
            "markets": markets,
            "count": len(opportunities),
            "fetched_at": int(time.time()),
        }
        save_snapshot("opportunities", "opportunities", snapshot)
        logger.info(
            "OpportunityCollector: %d opportunity(ies) across %s",
            len(opportunities), ", ".join(markets.keys()) or "no markets",
        )
