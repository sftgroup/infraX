"""Traditional finance heatmap providers — stocks / forex / commodities.

REQ-2 (2026-08-18): 热力图从 crypto-only 扩展到全市场。

数据源链（TD 额度保护设计）：
- **stocks**      : Finnhub quote（60 次/分钟免费，无限日额）→ yfinance（兜底）
- **fx**          : frankfurter(yf_alt，EUR 交叉盘) → yfinance → Tiingo → TwelveData（最后兜底）
- **commodities** : yfinance → Tiingo（金/银）→ TwelveData（最后兜底）

TwelveData 免费额度 800 credits/天，且已被 kline 外汇采集等核心链路占用，
因此热力图路径将 TD 作为**最后兜底**，避免挤占 kline 链路额度。

传统市场按日结算，24h 涨跌幅日内几乎不变 → 热力图缓存 TTL 取 3600s。
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, List

from app.utils.logger import get_logger
from app.data_providers import get_cached, set_cached, safe_float

logger = get_logger(__name__)

TRADFI_TTL = 3600  # 1h — 传统市场按日结算，无需高频刷新

# ── Stock universe（板块 ETF + 指数 + 核心大盘股，~50 只）───────────────
_INDEX_SYMBOLS = [
    ("SPY", "S&P 500"),
    ("QQQ", "Nasdaq 100"),
    ("DIA", "Dow Jones 30"),
    ("IWM", "Russell 2000"),
]

_SECTOR_ETFS = [
    ("XLK", "Technology"),
    ("XLV", "Health Care"),
    ("XLE", "Energy"),
    ("XLF", "Financials"),
    ("XLY", "Consumer Disc."),
    ("XLP", "Consumer Staples"),
    ("XLI", "Industrials"),
    ("XLB", "Materials"),
    ("XLU", "Utilities"),
    ("XLRE", "Real Estate"),
    ("XLC", "Comm. Services"),
]

_MEGA_CAPS = [
    ("AAPL", "Apple"), ("MSFT", "Microsoft"), ("NVDA", "NVIDIA"),
    ("GOOGL", "Alphabet"), ("AMZN", "Amazon"), ("META", "Meta"),
    ("TSLA", "Tesla"), ("BRK-B", "Berkshire Hathaway"), ("JPM", "JPMorgan"),
    ("V", "Visa"), ("AVGO", "Broadcom"), ("LLY", "Eli Lilly"),
    ("WMT", "Walmart"), ("XOM", "Exxon Mobil"), ("MA", "Mastercard"),
    ("UNH", "UnitedHealth"), ("PG", "Procter & Gamble"), ("ORCL", "Oracle"),
    ("HD", "Home Depot"), ("COST", "Costco"), ("JNJ", "Johnson & Johnson"),
    ("CVX", "Chevron"), ("BAC", "Bank of America"), ("KO", "Coca-Cola"),
    ("MRK", "Merck"), ("CRM", "Salesforce"), ("AMD", "AMD"),
    ("NFLX", "Netflix"), ("PEP", "PepsiCo"), ("ABBV", "AbbVie"),
    ("TMO", "Thermo Fisher"), ("WFC", "Wells Fargo"), ("CSCO", "Cisco"),
    ("ACN", "Accenture"), ("MCD", "McDonald's"), ("LIN", "Linde"),
    ("IBM", "IBM"), ("GE", "GE Aerospace"), ("CAT", "Caterpillar"),
    ("DIS", "Walt Disney"),
]

STOCK_SYMBOLS: List[Dict[str, str]] = [
    {"symbol": s, "name": n} for s, n in _INDEX_SYMBOLS + _SECTOR_ETFS + _MEGA_CAPS
]


# ── Stocks ───────────────────────────────────────────────────────────────

def _stock_cell(symbol: str, full_name: str, price: float, change: float) -> Dict[str, Any]:
    return {
        "name": symbol,
        "fullName": full_name,
        "value": round(safe_float(change), 2),
        "price": safe_float(price),
    }


def _fetch_stocks_finnhub() -> List[Dict[str, Any]]:
    """Finnhub quote — 主源（60 次/分钟免费）。串行 + 限速避免 429 挤爆共享 token。"""
    import time as _t
    from app.data_providers.finnhub import fetch_quote

    rows = []
    for item in STOCK_SYMBOLS:
        q = fetch_quote(item["symbol"])
        if q:
            rows.append(_stock_cell(item["symbol"], item["name"], q.get("last", 0), q.get("changePercent", 0)))
        _t.sleep(0.2)  # 55 symbols ≈ 55s，窗口内 < 60 次/分钟（含共享用量余量）
    if rows:
        logger.info("Fetched %d stocks heatmap via Finnhub", len(rows))
    return rows


def _fetch_stocks_yfinance() -> List[Dict[str, Any]]:
    """yfinance 批量兜底。"""
    rows = []
    try:
        import yfinance as yf
        tickers = yf.Tickers(" ".join(i["symbol"] for i in STOCK_SYMBOLS))
        for item in STOCK_SYMBOLS:
            try:
                tk = tickers.tickers.get(item["symbol"])
                if not tk:
                    continue
                hist = tk.history(period="2d")
                if len(hist) >= 2:
                    prev = hist["Close"].iloc[-2]
                    cur = hist["Close"].iloc[-1]
                    change = (cur - prev) / prev * 100
                elif len(hist) == 1:
                    cur = hist["Close"].iloc[-1]
                    change = 0.0
                else:
                    continue
                rows.append(_stock_cell(item["symbol"], item["name"], cur, change))
            except Exception as e:
                logger.debug("yfinance stock %s failed: %s", item["symbol"], e)
        if rows:
            logger.info("Fetched %d stocks heatmap via yfinance", len(rows))
    except Exception as e:
        logger.error("yfinance stocks batch failed: %s", e)
    return rows


def fetch_stocks_heatmap() -> List[Dict[str, Any]]:
    rows = _fetch_stocks_finnhub()
    if len(rows) < len(STOCK_SYMBOLS) // 2:
        fallback = _fetch_stocks_yfinance()
        if len(fallback) > len(rows):
            rows = fallback
    return rows


# ── Forex（复用 forex.py 三链，TD 置最后）───────────────────────────────

def fetch_fx_heatmap() -> List[Dict[str, Any]]:
    from app.data_providers.forex import FOREX_PAIRS
    from app.data_providers import forex as _forex

    result: List[Dict[str, Any]] = []
    for fetcher in (_forex._fetch_yf, _forex._fetch_tiingo, _forex._fetch_td):
        try:
            batch = fetcher(FOREX_PAIRS)
        except Exception as e:
            logger.debug("Forex heatmap fetcher %s failed: %s", fetcher.__name__, e)
            batch = []
        if batch:
            existing = {r["name"] for r in result}
            for r in batch:
                if r["symbol"] not in existing:
                    result.append({
                        "name": r["symbol"],
                        "fullName": r.get("name_en") or r.get("name") or r["symbol"],
                        "value": round(safe_float(r.get("change", 0)), 2),
                        "price": safe_float(r.get("price", 0)),
                    })
        if len(result) >= len(FOREX_PAIRS):
            break
    if not result:
        logger.warning("Forex heatmap all tiers failed, returning placeholders")
        for pair in FOREX_PAIRS:
            result.append({
                "name": pair["td"], "fullName": pair["name_en"],
                "value": 0.0, "price": 0.0,
            })
    return result


# ── Commodities（复用 commodities.py 三链，TD 置最后）───────────────────

def fetch_commodities_heatmap() -> List[Dict[str, Any]]:
    from app.data_providers.commodities import COMMODITIES
    from app.data_providers import commodities as _comm

    result: List[Dict[str, Any]] = []
    for fetcher in (_comm._fetch_yf, _comm._fetch_tiingo, _comm._fetch_td):
        try:
            batch = fetcher(COMMODITIES)
        except Exception as e:
            logger.debug("Commodities heatmap fetcher %s failed: %s", fetcher.__name__, e)
            batch = []
        if batch:
            existing = {r["name"] for r in result}
            for r in batch:
                if r["symbol"] not in existing:
                    result.append({
                        "name": r["symbol"],
                        "fullName": r.get("name_en") or r["symbol"],
                        "value": round(safe_float(r.get("change", 0)), 2),
                        "price": safe_float(r.get("price", 0)),
                    })
        if len(result) >= len(COMMODITIES):
            break
    if not result:
        logger.warning("Commodities heatmap all tiers failed, returning placeholders")
        for c in COMMODITIES:
            result.append({
                "name": c["yf"], "fullName": c["name_en"],
                "value": 0.0, "price": 0.0,
            })
    return result


# ── 汇总入口 ────────────────────────────────────────────────────────────

def fetch_tradfi_heatmap() -> Dict[str, List[Dict[str, Any]]]:
    """全市场（非 crypto）热力图。缓存 1h。返回 {stocks, fx, commodities}。"""
    cache_key = "tradfi_heatmap_all"
    cached = get_cached(cache_key)
    if cached:
        return cached

    with ThreadPoolExecutor(max_workers=3) as pool:
        fut_stocks = pool.submit(fetch_stocks_heatmap)
        fut_fx = pool.submit(fetch_fx_heatmap)
        fut_comm = pool.submit(fetch_commodities_heatmap)
        result = {
            "stocks": fut_stocks.result(),
            "fx": fut_fx.result(),
            "commodities": fut_comm.result(),
        }

    set_cached(cache_key, result, TRADFI_TTL)
    total = sum(len(v) for v in result.values())
    logger.info("TradFi heatmap generated: total=%d (stocks=%d fx=%d commodities=%d)",
                total, len(result["stocks"]), len(result["fx"]), len(result["commodities"]))
    return result
