"""Market data collector — periodic fetch of all external data sources.

All "what to collect" is driven by data_config.json.
Free sources work without any API key.
Key-required sources are skipped if key is not configured.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from pathlib import Path
from typing import Optional

import requests

from app.factors import save_snapshot
from app.config import APIKeys
from app.collectors.urls import (
    COINGECKO_SIMPLE_PRICE_URL, BLOCKCHAIN_INFO_DIFFICULTY_URL,
    BLOCKCHAIN_INFO_LATEST_BLOCK_URL, DEFILLAMA_CHAINS_URL,
    FRED_OBSERVATIONS_URL, FINNHUB_EARNINGS_URL,
    COLLECTOR_HTTP_TIMEOUT, COLLECTOR_HTTP_TIMEOUT_SHORT,
)

logger = logging.getLogger(__name__)

COLLECT_INTERVAL = int(os.getenv("MARKET_COLLECT_INTERVAL_SEC", "600"))

# ── Config loader ────────────────────────────────────────

_CONFIG_PATH = os.getenv("DATA_CONFIG_PATH", "data_config.json")


def _load_config() -> dict:
    path = Path(_CONFIG_PATH)
    if not path.exists():
        logger.warning("Config not found: %s, using empty config", _CONFIG_PATH)
        return {}
    try:
        return json.loads(path.read_text())
    except Exception:
        logger.warning("Config parse error: %s", _CONFIG_PATH)
        return {}


def _get_config() -> dict:
    """Lazy-load config (cached after first read)."""
    if not hasattr(_get_config, "_cache"):
        _get_config._cache = _load_config()
    return _get_config._cache


# ══════════════════════════════════════════════════════════
#  Fetchers — all driven by data_config.json
# ══════════════════════════════════════════════════════════

def _fetch_crypto_prices() -> Optional[list[dict]]:
    cfg = _get_config().get("crypto", {})
    ids = cfg.get("coingecko_ids", {})
    if not ids:
        return None
    try:
        resp = requests.get(
            COINGECKO_SIMPLE_PRICE_URL,
            params={
                "ids": ",".join(ids.keys()),
                "vs_currencies": "usd",
                "include_24hr_change": "true",
                "include_market_cap": "true",
            },
            timeout=COLLECTOR_HTTP_TIMEOUT,
        )
        if resp.status_code != 200:
            logger.warning("Crypto price fetch failed: status=%d", resp.status_code)
            return None
        data = resp.json()
        return [
            {
                "symbol": name,
                "cg_id": cg_id,
                "price": data.get(cg_id, {}).get("usd"),
                "change_24h": data.get(cg_id, {}).get("usd_24h_change"),
                "market_cap": data.get(cg_id, {}).get("usd_market_cap"),
            }
            for cg_id, name in ids.items()
        ]
    except Exception as exc:
        logger.warning("Crypto price fetch failed: %s", exc)
    return None


# 新浪美股指数代码映射（yfinance 代码 → akshare 新浪代码；新浪仅支持美国指数）
_SINA_INDEX_MAP = {
    "^GSPC": ".INX",
    "^IXIC": ".IXIC",
    "^DJI": ".DJI",
    "^NDX": ".NDX",
}


def _fetch_global_indices() -> Optional[list[dict]]:
    cfg = _get_config().get("indices", {})
    symbols = cfg.get("symbols", [])
    if not symbols:
        return None
    results = []
    try:
        for entry in symbols:
            sym = entry.get("symbol", "")
            if not sym:
                continue
            sina_code = _SINA_INDEX_MAP.get(sym)
            try:
                if sina_code:
                    # 新浪日线（绕过 Yahoo 限流）
                    import akshare as ak
                    df = ak.index_us_stock_sina(symbol=sina_code)
                    if df is None or df.empty:
                        logger.debug("Sina index fetch empty %s (%s)", sym, sina_code)
                        continue
                    results.append({
                        "symbol": sym,
                        "name": entry.get("name", sym),
                        "region": entry.get("region", ""),
                        "price": round(float(df["close"].iloc[-1]), 2),
                        "change_pct": round(float(df["close"].pct_change().iloc[-1] * 100), 2),
                    })
                    continue
                # 非美国指数 → yfinance 兜底
                import yfinance as yf
                t = yf.Ticker(sym)
                h = t.history(period="5d")
                if not h.empty:
                    results.append({
                        "symbol": sym,
                        "name": entry.get("name", sym),
                        "region": entry.get("region", ""),
                        "price": round(float(h["Close"].iloc[-1]), 2),
                        "change_pct": round(float(h["Close"].pct_change().iloc[-1] * 100), 2),
                    })
            except Exception as exc:
                logger.debug("Index fetch failed %s: %s", sym, exc)
        return results if results else None
    except Exception as exc:
        logger.warning("Global indices fetch failed: %s", exc)
    return None


def _fetch_onchain() -> Optional[dict]:
    cfg = _get_config().get("onchain", {})
    if not cfg:
        return None
    result = {}
    try:
        if cfg.get("btc_difficulty"):
            r = requests.get(BLOCKCHAIN_INFO_DIFFICULTY_URL, timeout=COLLECTOR_HTTP_TIMEOUT_SHORT)
            if r.status_code == 200:
                result["difficulty"] = float(r.text.strip())
        if cfg.get("btc_height"):
            r = requests.get(BLOCKCHAIN_INFO_LATEST_BLOCK_URL, timeout=COLLECTOR_HTTP_TIMEOUT_SHORT)
            if r.status_code == 200:
                result["height"] = r.json().get("height")
        return result if result else None
    except Exception as exc:
        logger.warning("On-chain fetch failed: %s", exc)
    return None


def _fetch_defi_tvl() -> Optional[list[dict]]:
    cfg = _get_config().get("defi", {})
    top_n = cfg.get("top_chains", 0)
    if top_n <= 0:
        return None
    try:
        resp = requests.get(DEFILLAMA_CHAINS_URL, timeout=COLLECTOR_HTTP_TIMEOUT)
        if resp.status_code != 200:
            logger.warning("DeFi TVL fetch failed: status=%d", resp.status_code)
            return None
        chains = resp.json()
        top = sorted(chains, key=lambda c: c.get("tvl", 0), reverse=True)[:top_n]
        return [
            {
                "chain": c.get("name", c.get("gecko_id", "?")),
                "tvl": c.get("tvl"),
                "change_1d": c.get("change_1d"),
                "change_7d": c.get("change_7d"),
            }
            for c in top
        ]
    except Exception as exc:
        logger.warning("DeFi TVL fetch failed: %s", exc)
    return None


def _fetch_volatility() -> Optional[dict]:
    cfg = _get_config().get("volatility", {})
    symbols = cfg.get("symbols", [])
    if not symbols:
        return None
    try:
        import yfinance as yf
        result = {}
        for entry in symbols:
            sym, key = entry.get("symbol"), entry.get("key")
            if not sym or not key:
                continue
            try:
                t = yf.Ticker(sym)
                h = t.history(period="5d")
                if not h.empty:
                    result[key] = round(float(h["Close"].iloc[-1]), 2)
            except Exception as exc:
                logger.debug("Volatility fetch failed %s: %s", sym, exc)
        return result if result else None
    except Exception as exc:
        logger.warning("Volatility fetch failed: %s", exc)
    return None


def _fetch_macro_indicators() -> Optional[dict]:
    api_key = APIKeys.rotate("FRED_API_KEY")
    if not api_key:
        return None
    cfg = _get_config().get("macro", {})
    series = cfg.get("fred_series", {})
    if not series:
        return None
    try:
        results = {}
        for series_id, name in series.items():
            try:
                resp = requests.get(
                    FRED_OBSERVATIONS_URL,
                    params={
                        "series_id": series_id, "api_key": api_key,
                        "file_type": "json", "sort_order": "desc", "limit": 2,
                    },
                    timeout=COLLECTOR_HTTP_TIMEOUT_SHORT,
                )
                if resp.status_code != 200:
                    continue
                obs = resp.json().get("observations", [])
                if obs:
                    results[name] = {
                        "value": float(obs[0]["value"]) if obs[0].get("value") != "." else None,
                        "date": obs[0]["date"],
                    }
            except Exception:
                continue
        return results if results else None
    except Exception:
        logger.debug("Macro fetch failed", exc_info=True)
    return None


def _fetch_earnings() -> Optional[list[dict]]:
    api_key = APIKeys.rotate("FINNHUB_API_KEY")
    if not api_key:
        return None
    cfg = _get_config().get("earnings", {})
    tickers = cfg.get("tickers", [])
    if not tickers:
        return None
    try:
        results = []
        for t in tickers[:10]:  # rate-limit safe
            try:
                resp = requests.get(
                    FINNHUB_EARNINGS_URL,
                    params={"symbol": t, "token": api_key},
                    timeout=COLLECTOR_HTTP_TIMEOUT_SHORT,
                )
                if resp.status_code != 200:
                    continue
                data = resp.json()
                if data and isinstance(data, list) and len(data) > 0:
                    latest = data[0]
                    results.append({
                        "ticker": t,
                        "period": latest.get("period"),
                        "actual": latest.get("actual"),
                        "estimate": latest.get("estimate"),
                        "surprise": latest.get("surprise"),
                    })
            except Exception:
                continue
        return results if results else None
    except Exception as exc:
        logger.warning("Earnings fetch failed: %s", exc)
    return None


# ══════════════════════════════════════════════════════════
#  Collector
# ══════════════════════════════════════════════════════════

class SnapshotCollector:
    """Periodically fetch all external market data → raw_snapshots."""

    def __init__(self):
        self._running = False
        self._thread: Optional[threading.Thread] = None

    def start(self):
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._loop, daemon=True, name="snapshot-collector")
        self._thread.start()
        logger.info("SnapshotCollector started (interval=%ds, config=%s)", COLLECT_INTERVAL, _CONFIG_PATH)

    def stop(self):
        self._running = False

    def _loop(self):
        while self._running:
            try:
                self._collect()
            except Exception:
                logger.warning("Market collector cycle failed", exc_info=True)
            time.sleep(COLLECT_INTERVAL)

    def _collect(self):
        count = 0

        crypto = _fetch_crypto_prices()
        if crypto:
            save_snapshot("market", "crypto_prices", {"prices": crypto})
            count += 1

        indices = _fetch_global_indices()
        if indices:
            save_snapshot("market", "indices", {"indices": indices})
            count += 1

        onchain = _fetch_onchain()
        if onchain:
            save_snapshot("onchain", "btc_difficulty", onchain)
            count += 1

        tvl = _fetch_defi_tvl()
        if tvl:
            save_snapshot("defi", "tvl", {"chains": tvl})
            count += 1

        vol = _fetch_volatility()
        if vol:
            save_snapshot("volatility", "volatility", vol)
            count += 1

        macro = _fetch_macro_indicators()
        if macro:
            save_snapshot("macro", "us_indicators", macro)
            count += 1

        earnings = _fetch_earnings()
        if earnings:
            save_snapshot("fundamental", "earnings", {"earnings": earnings})
            count += 1

        if count:
            logger.info("SnapshotCollector: saved %d snapshot(s)", count)
        else:
            logger.warning("SnapshotCollector: cycle produced 0 snapshots — all 7 sources failed")
