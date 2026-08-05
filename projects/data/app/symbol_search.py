"""符号搜索（DS-9）— 关键字模糊搜索，返回候选交易对列表。

契约（见 AITRADER_DATA_SERVICE_REQ.md DS-9）：
  GET /symbols/search?keyword=btc&market=crypto&limit=20

数据源（fail-silent 回退链，TTL 缓存对标单体 4 小时）：
  - crypto   → ccxt binance（spot）+ binanceusdm（swap）load_markets，
               只保留 quote=USDT 且 active=true；拉取失败回退种子数据（仅 spot）
  - usstock / forex / futures → market_symbols_seed 本地种子（无法全量拉取）

响应统一格式：
  {symbol, market, market_type, exchange, active}
"""
from __future__ import annotations

import logging
import os
import threading
import time
from typing import Any, Optional

import ccxt

from app.data.market_symbols_seed import (
    CRYPTO_SYMBOLS,
    FOREX_SYMBOLS,
    FUTURES_SYMBOLS,
    STOCK_SYMBOLS,
    CN_STOCK_SYMBOLS,
    HK_STOCK_SYMBOLS,
)

logger = logging.getLogger(__name__)

# 对标单体 4 小时缓存（可用 SYMBOL_SEARCH_CACHE_TTL 覆盖）
_CACHE_TTL_SEC = int(os.getenv("SYMBOL_SEARCH_CACHE_TTL", "14400"))
_QUOTE = "USDT"

# market → 种子回退（symbol, name）
_SEED_FALLBACK: dict[str, list[tuple[str, str]]] = {
    "crypto": CRYPTO_SYMBOLS,
    "usstock": STOCK_SYMBOLS,
    "forex": FOREX_SYMBOLS,
    "futures": FUTURES_SYMBOLS,
    "cnstock": CN_STOCK_SYMBOLS,
    "hkstock": HK_STOCK_SYMBOLS,
}

# ccxt 全量市场缓存（crypto）
_crypto_markets: Optional[list[dict]] = None
_crypto_fetched_at: float = 0.0
_lock = threading.Lock()

# 交易所组合（id, market_type, options）——与 resolve_crypto_venue 支持的主流所一致
_CRYPTO_EXCHANGES = (
    ("binance", "spot", {}),
    ("binanceusdm", "swap", {}),
    ("okx", "spot", {}),
    ("okx", "swap", {"defaultType": "swap"}),
    ("bybit", "spot", {}),
    ("bybit", "swap", {"defaultType": "linear"}),
)


def _seed_markets(market: str) -> list[dict]:
    """种子数据 → 统一格式（仅 spot 语义，无交易所概念）。"""
    out = []
    for sym, _name in _SEED_FALLBACK.get(market, []):
        out.append({
            "symbol": sym,
            "market": market,
            "market_type": "spot",
            "exchange": "",
            "active": True,
        })
    return out


def _load_crypto_markets() -> Optional[list[dict]]:
    """ccxt 拉取 binance spot + swap 全量市场（4h TTL 缓存，线程安全）。

    失败/超时返回 None（调用方回退种子数据）。每个交易所一次 exchangeInfo
    REST 请求，成功后缓存 _CACHE_TTL_SEC 秒。
    """
    global _crypto_markets, _crypto_fetched_at
    now = time.time()
    if _crypto_markets is not None and now - _crypto_fetched_at < _CACHE_TTL_SEC:
        return _crypto_markets
    with _lock:
        # 双检（避免并发重复拉取）
        if _crypto_markets is not None and time.time() - _crypto_fetched_at < _CACHE_TTL_SEC:
            return _crypto_markets
        out: list[dict] = []
        for ccxt_id, mtype, opts in _CRYPTO_EXCHANGES:
            try:
                kwargs = {"enableRateLimit": True, "timeout": 15000, **opts}
                ex = getattr(ccxt, ccxt_id)(kwargs)
                markets = ex.load_markets()
                exchange = "binance" if ccxt_id.startswith("binance") else ccxt_id
                for sym, m in markets.items():
                    if not m.get("active") or m.get("quote") != _QUOTE:
                        continue
                    # spot 市场偶发混入 `:USDT` 合约格式符号（如 BTC/USDT:USDT），剔除
                    if mtype == "spot" and ":" in sym:
                        continue
                    out.append({
                        "symbol": sym,
                        "market": "crypto",
                        "market_type": mtype,
                        "exchange": exchange,
                        "active": True,
                    })
            except Exception as exc:
                logger.warning("symbol search load %s/%s failed: %s", ccxt_id, mtype, exc)
        if not out:
            return None
        _crypto_markets = out
        _crypto_fetched_at = time.time()
        return out


def search_symbols(keyword: str, market: str = "crypto", limit: int = 20) -> list[dict]:
    """关键字模糊搜索符号候选列表。

    参数:
        keyword: 模糊关键字（如 "btc"、"eth/"），空串返回前 limit 个
        market:  crypto | usstock | forex | futures（默认 crypto）
        limit:   返回条数（调用方已限制 ≤100）
    返回:
        [{symbol, market, market_type, exchange, active}, ...]
    """
    kw = (keyword or "").strip().lower()

    if market == "crypto":
        markets = _load_crypto_markets()
        if not markets:
            markets = _seed_markets("crypto")
        results = []
        for m in markets:
            if kw and kw not in m["symbol"].lower():
                continue
            results.append(m)
            if len(results) >= limit:
                break
        return results

    # 非 crypto：在线 lookup（种子 → Finnhub/TwelveData/AkShare），symbol+name 均可匹配
    online = []
    if market in ("usstock", "forex", "futures", "cnstock", "hkstock"):
        from app.symbol_lookup import lookup_symbols
        online = lookup_symbols(market, kw, limit=limit)

    results = []
    # 在线结果优先（更全）；不足部分用种子补齐
    seen = set()
    for m in online:
        key = m["symbol"]
        if key in seen:
            continue
        seen.add(key)
        results.append({
            "symbol": key,
            "market": market,
            "market_type": "spot",
            "exchange": "",
            "active": True,
            "name": m.get("name", ""),
        })
        if len(results) >= limit:
            return results

    for sym, name in _SEED_FALLBACK.get(market, []):
        if sym in seen:
            continue
        if kw and kw not in sym.lower() and kw not in name.lower():
            continue
        results.append({
            "symbol": sym,
            "market": market,
            "market_type": "spot",
            "exchange": "",
            "active": True,
            "name": name,
        })
        if len(results) >= limit:
            break
    return results


def resolve_symbol(symbol: str, market: str = "crypto") -> Optional[str]:
    """单符号 → 标准交易对（DS-4）。解析失败返回 None（路由层 404）。

    契约（AITRADER_DATA_SERVICE_REQ.md DS-4）：
        GET /symbol/resolve?symbol=BTC → {"query": "BTC", "resolved": "BTCUSDT"}

    解析规则：
      - 输入已含分隔符（BTC/USDT、BTC/USDT:USDT）→ 去分隔符规范化
        （binance 风格：BTC/USDT → BTCUSDT）
      - 纯 base（BTC）→ crypto 符号表中匹配 quote=USDT 的候选，优先
        binance spot（fallback seed）；非 crypto 走种子精确匹配（原样直通）
      - 全市场覆盖范围（美股/外汇/期货/A股/港股）待 DS-11 决策；
        本期 crypto 精确解析 + 非 crypto 种子直通
    """
    sym = (symbol or "").strip()
    if not sym:
        return None

    # 已含分隔符：规范化（binance 风格）
    if ":" in sym:
        # swap 合约：base/quote:quote → base+quote（BTC/USDT:USDT → BTCUSDT）
        parts = sym.split(":")
        return parts[0].split("/")[0] + parts[-1]
    if "/" in sym:
        return sym.replace("/", "")

    if market == "crypto":
        markets = _load_crypto_markets()
        if not markets:
            markets = _seed_markets("crypto")
        base = sym.lower()
        cands = [m for m in markets if m["symbol"].lower().startswith(base + "/")]
        if not cands:
            return None

        def _rank(m: dict) -> tuple:
            return (0 if m["exchange"] == "binance" else 1,
                    0 if m["market_type"] == "spot" else 1)

        best = min(cands, key=_rank)
        return best["symbol"].replace("/", "")

    # 非 crypto：种子精确匹配（大小写不敏感）→ 在线 lookup（symbol/name 匹配）
    low = sym.lower()
    for s, _name in _SEED_FALLBACK.get(market, []):
        if s.lower() == low:
            return s
    if market in ("usstock", "forex", "futures", "cnstock", "hkstock"):
        from app.symbol_lookup import lookup_symbols
        for m in lookup_symbols(market, sym, limit=20):
            s = (m.get("symbol") or "")
            name = (m.get("name") or "").lower()
            if s.lower() == low or name == low or low in s.lower() or low in name:
                return s
    return None


def get_hot_symbols(market: str = "crypto", limit: int = 10) -> list[dict]:
    """热门符号（种子前 N），供前端默认列表使用。"""
    if market == "crypto":
        markets = _load_crypto_markets()
        if markets:
            return markets[:limit]
    return _seed_markets(market)[:limit]
