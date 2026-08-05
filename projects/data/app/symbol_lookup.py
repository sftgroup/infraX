"""在线符号搜索（DS-11 全市场覆盖）— 非 crypto 市场的 symbol lookup。

供 /symbols/search 与 /symbol/resolve 使用：种子匹配失败时在线解析，
覆盖 美股 / 外汇 / 期货 / A股 / 港股。

数据源（fail-silent 回退链）：
  - usstock → Finnhub /api/v1/search（主）→ Twelve Data /symbol_search（备）
  - forex / futures → Twelve Data /symbol_search（type 过滤）
  - cnstock / hkstock → AkShare 全量代码表（24h 缓存，本地模糊匹配）
                      → Twelve Data /symbol_search（备）
  - 全部末端回退 None（调用方走本地种子）

设计：TTL 缓存按 keyword（在线搜索请求省着用，Twelve Data free tier
限 8 req/min）；AkShare 全量表 24h 缓存避免重复拉全市场。
"""
from __future__ import annotations

import logging
import os
import threading
import time

import requests

logger = logging.getLogger(__name__)

# Twelve Data free tier: 8 requests/min —— 在线搜索缓存 TTL（秒）
_TD_TTL_SEC = int(os.getenv("SYMBOL_LOOKUP_TD_TTL", "300"))
_AK_TTL_SEC = int(os.getenv("SYMBOL_LOOKUP_AK_TTL", "86400"))  # 24h 全量代码表

# 市场 → 允许的 Twelve Data 结果 type
_TD_TYPE_FILTER = {
    "usstock": ("Common Stock", "ETF", "REIT"),
    "forex": ("Currency", "Currency Pair", "Forex"),
    "futures": ("Future", "Futures", "Commodity"),
    "cnstock": ("Common Stock", "ETF", "Index"),
    "hkstock": ("Common Stock", "ETF", "Index"),
}

_TD_TWELVE_BASE = "https://api.twelvedata.com/symbol_search"
_TD_LIMIT = 30

# (market → (api_key 用途), 统一由 APIKeys.rotate 取 key)
_ak_lock = threading.Lock()
_ak_cache: dict[str, tuple[float, list[dict]]] = {}

_td_lock = threading.Lock()
_td_cache: dict[str, tuple[float, list[dict]]] = {}


def _twelve_key() -> str:
    from app.config import APIKeys
    return APIKeys.rotate("TWELVE_DATA_API_KEY") or ""


def _ak_stock_table(market: str) -> list[dict]:
    """AkShare 全量代码表（CN/HK），24h 缓存。返回 [{symbol, name, market}]。"""
    now = time.time()
    with _ak_lock:
        cached = _ak_cache.get(market)
        if cached and now - cached[0] < _ak_TTL_SEC:
            return cached[1]
    try:
        import akshare as ak  # type: ignore

        if market == "cnstock":
            df = ak.stock_zh_a_spot_em()  # 全 A 股实时行情
            rows = []
            for _, r in df.iterrows():
                code = str(r["代码"]).zfill(6)
                rows.append({"symbol": code, "name": str(r["名称"]), "market": "cnstock"})
        else:  # hkstock
            df = ak.stock_hk_spot_em()
            rows = []
            for _, r in df.iterrows():
                code = str(r["代码"]).zfill(5)
                rows.append({"symbol": code, "name": str(r["名称"]), "market": "hkstock"})
        if rows:
            with _ak_lock:
                _ak_cache[market] = (now, rows)
            logger.info("AkShare %s symbol table loaded: %d rows", market, len(rows))
            return rows
    except Exception as e:
        logger.warning("AkShare %s symbol table failed: %s", market, e)
    return []


def _ak_search(market: str, keyword: str) -> list[dict]:
    """AkShare 全量表本地模糊匹配（symbol / name）。"""
    kw = (keyword or "").strip().lower()
    out = []
    for item in _ak_stock_table(market):
        if kw and kw not in item["symbol"] and kw not in item["name"].lower():
            continue
        out.append(item)
        if len(out) >= 20:
            break
    return out


def _twelve_search(market: str, keyword: str) -> list[dict]:
    """Twelve Data /symbol_search。返回 [{symbol, name, market}]。"""
    key = _twelve_key()
    if not key:
        return []
    cache_key = f"{market}:{keyword.strip().lower()}"
    now = time.time()
    with _td_lock:
        cached = _td_cache.get(cache_key)
        if cached and now - cached[0] < _TD_TTL_SEC:
            return cached[1]
    try:
        resp = requests.get(
            _TD_TWELVE_BASE,
            params={"symbol": keyword, "apikey": key},
            timeout=10,
        )
        data = resp.json()
        if data.get("status") != "ok":
            logger.debug("TwelveData symbol_search %s failed: %s", keyword, data.get("message"))
            return []
        allowed = _TD_TYPE_FILTER.get(market, ())
        out = []
        for item in data.get("data") or []:
            typ = (item.get("type") or "").strip()
            if allowed and typ and not any(t.lower() in typ.lower() for t in allowed):
                continue
            out.append({
                "symbol": item.get("symbol"),
                "name": item.get("name") or item.get("symbol"),
                "market": market,
            })
            if len(out) >= _TD_LIMIT:
                break
        if out:
            with _td_lock:
                _td_cache[cache_key] = (now, out)
        return out
    except Exception as e:
        logger.debug("TwelveData symbol_search %s error: %s", keyword, e)
        return []


def _finnhub_search(keyword: str) -> list[dict]:
    """Finnhub /api/v1/search（美股主源）。返回 [{symbol, name, market}]。

    Finnhub search 是全市场搜索（含 .SS/.SZ/.HK/.L 等非美后缀），
    只保留纯美股格式（字母 + 可选 -/.，如 AAPL / BRK-B / BF.B）。
    """
    from app.data_providers.finnhub import _finnhub_get
    import re
    _US_TICKER_RE = re.compile(r"^[A-Za-z]+(?:[.\-][A-Za-z]+)*$")
    data = _finnhub_get("search", {"q": keyword})
    if not data:
        return []
    out = []
    for item in data.get("result") or []:
        sym = item.get("symbol") or ""
        if not _US_TICKER_RE.match(sym):
            continue
        out.append({
            "symbol": sym,
            "name": item.get("description") or sym,
            "market": "usstock",
        })
        if len(out) >= _TD_LIMIT:
            break
    return out


def lookup_symbols(market: str, keyword: str, limit: int = 20) -> list[dict]:
    """非 crypto 市场在线符号搜索。

    Args:
        market: usstock | forex | futures | cnstock | hkstock
        keyword: 模糊关键字
        limit: 最大返回条数
    Returns:
        [{symbol, name, market}, ...]（fail-silent：无结果返回空列表）
    """
    kw = (keyword or "").strip()
    if not kw:
        return []
    try:
        if market == "usstock":
            results = _finnhub_search(kw) or _twelve_search(market, kw)
        elif market == "cnstock" or market == "hkstock":
            results = _ak_search(market, kw) or _twelve_search(market, kw)
        else:  # forex / futures
            results = _twelve_search(market, kw)
        return results[:limit]
    except Exception as e:
        logger.warning("symbol lookup %s failed: %s", market, e)
        return []
