"""Crypto-focused heatmap data aggregator.

Traditional finance sources (Yahoo, Finnhub, Stooq, CNBC) are unreliable without
API keys.  CoinGecko / CoinCap are free, globally accessible, and work without
authentication — so the heatmap is now **crypto-only**, divided into logical
market sectors.

Sector token mappings are maintained here as a single source of truth.
New tokens can be added by editing ``CRYPTO_SECTORS``.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, List

from app.utils.logger import get_logger
from app.data_providers import get_cached, set_cached, safe_float
from app.data_providers.crypto import (
    fetch_crypto_heatmap_coingecko,
    fetch_crypto_heatmap_coincap,
    fetch_crypto_prices,
)

logger = get_logger(__name__)

HEATMAP_CELL_COUNT = 30  # per-category cap

# ── Crypto sector definitions ────────────────────────────────────────────
# symbol → category mapping. Tokens not listed here go into "Other".
CRYPTO_SECTORS: Dict[str, str] = {}

# Layer-1 / Smart Contract Platforms
for _sym in ("ETH", "SOL", "AVAX", "DOT", "NEAR", "APT", "SUI", "SEI",
             "INJ", "FTM", "ATOM", "ADA", "TRX", "TON", "ALGO", "EGLD",
             "ICP", "HBAR", "FLOW", "XTZ", "ROSE", "CKB", "MINA"):
    CRYPTO_SECTORS[_sym] = "Layer1"

# Layer-2 / Scaling
for _sym in ("MATIC", "POL", "ARB", "OP", "IMX", "STRK", "MANTA",
             "METIS", "BOBA", "LRC", "SKL", "CELO"):
    CRYPTO_SECTORS[_sym] = "Layer2"

# DeFi
for _sym in ("UNI", "AAVE", "MKR", "COMP", "CRV", "SNX", "SUSHI",
             "LDO", "RUNE", "GMX", "PENDLE", "DYDX", "CAKE", "1INCH",
             "BAL", "YFI", "CVX", "FXS", "RAY", "JUP", "ENA"):
    CRYPTO_SECTORS[_sym] = "DeFi"

# Meme
for _sym in ("DOGE", "SHIB", "PEPE", "WIF", "BONK", "FLOKI",
             "MEME", "BOME", "TURBO", "MOG", "BRETT", "POPCAT"):
    CRYPTO_SECTORS[_sym] = "Meme"

# AI / Big Data
for _sym in ("FET", "RNDR", "AGIX", "OCEAN", "TAO", "WLD", "AKT",
             "AI", "NMR", "CTXC", "MDT", "PHB", "ARKM", "NOS"):
    CRYPTO_SECTORS[_sym] = "AI"

# Gaming / Metaverse
for _sym in ("SAND", "MANA", "AXS", "GALA", "ENJ", "ILV", "YGG",
             "MAGIC", "PIXEL", "PRIME", "BIGTIME", "APE", "GMT"):
    CRYPTO_SECTORS[_sym] = "Gaming"

# Infrastructure / Oracles / Storage
for _sym in ("LINK", "FIL", "AR", "GRT", "ANKR", "BAND", "API3",
             "PYTH", "UMA", "TRB", "HNT", "IOTX", "LPT"):
    CRYPTO_SECTORS[_sym] = "Infra"

# Stablecoins (excluded from heatmap — no price movement)
STABLECOINS = {"USDT", "USDC", "DAI", "BUSD", "TUSD", "FRAX", "USDD", "FDUSD"}


# ── Data fetchers ────────────────────────────────────────────────────────

def _fetch_all_crypto() -> List[Dict[str, Any]]:
    """Fetch all crypto data (up to 100 tokens) from free sources."""
    cache_key = "crypto_all_heatmap"
    cached = get_cached(cache_key)
    if cached and len(cached) >= 50:
        return cached

    # Try CoinGecko first (free, 30 req/min)
    try:
        data = fetch_crypto_heatmap_coingecko()
        if data and len(data) >= 20:
            set_cached(cache_key, data, 600)  # 10 min TTL
            return data
    except Exception as e:
        logger.debug("CoinGecko heatmap all failed: %s", e)

    # Fall back to CoinCap
    try:
        data = fetch_crypto_heatmap_coincap()
        if data and len(data) >= 20:
            set_cached(cache_key, data, 600)
            return data
    except Exception as e:
        logger.debug("CoinCap heatmap all failed: %s", e)

    # Last resort: existing cached data or basic prices
    cached = get_cached("crypto_heatmap") or get_cached("crypto_prices") or []
    if cached:
        return cached

    data = fetch_crypto_prices(fast=True)
    if data:
        set_cached(cache_key, data, 600)
    return data or []


def _build_sector_heatmap(sector_name: str, all_coins: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Build heatmap rows for a single crypto sector."""
    rows = []
    for coin in all_coins:
        sym = str(coin.get("symbol", "")).upper()
        if sym in STABLECOINS:
            continue
        if CRYPTO_SECTORS.get(sym) != sector_name:
            continue
        rows.append({
            "name": sym,
            "fullName": coin.get("name", sym),
            "value": coin.get("change_24h", 0),
            "marketCap": coin.get("market_cap", 0),
            "volume": coin.get("volume_24h", 0),
            "price": coin.get("price", 0),
            "image": coin.get("image", ""),
        })
    # Sort by market cap descending so big players appear first
    rows.sort(key=lambda r: safe_float(r.get("marketCap", 0)), reverse=True)
    return rows[:HEATMAP_CELL_COUNT]


def _build_other_heatmap(all_coins: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """All tokens not assigned to any sector."""
    rows = []
    for coin in all_coins:
        sym = str(coin.get("symbol", "")).upper()
        if sym in STABLECOINS:
            continue
        if CRYPTO_SECTORS.get(sym):
            continue
        rows.append({
            "name": sym,
            "fullName": coin.get("name", sym),
            "value": coin.get("change_24h", 0),
            "marketCap": coin.get("market_cap", 0),
            "volume": coin.get("volume_24h", 0),
            "price": coin.get("price", 0),
            "image": coin.get("image", ""),
        })
    rows.sort(key=lambda r: safe_float(r.get("marketCap", 0)), reverse=True)
    return rows[:HEATMAP_CELL_COUNT]


def _build_topcap_heatmap(all_coins: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Top 30 by market cap, excluding stablecoins."""
    rows = []
    for coin in all_coins:
        sym = str(coin.get("symbol", "")).upper()
        if sym in STABLECOINS:
            continue
        rows.append({
            "name": sym,
            "fullName": coin.get("name", sym),
            "value": coin.get("change_24h", 0),
            "marketCap": coin.get("market_cap", 0),
            "volume": coin.get("volume_24h", 0),
            "price": coin.get("price", 0),
            "image": coin.get("image", ""),
        })
    rows.sort(key=lambda r: safe_float(r.get("marketCap", 0)), reverse=True)
    return rows[:30]


# ── Main entry ───────────────────────────────────────────────────────────

def generate_heatmap_data() -> Dict[str, Any]:
    """Generate crypto-only heatmap broken down by market sector.

    Returns dict with keys:
        topcap, layer1, layer2, defi, meme, ai, gaming, infra, other
    Each value is a list of {name, fullName, value, price, marketCap, volume, image}.
    """
    all_coins = _fetch_all_crypto()

    sector_names = ["Layer1", "Layer2", "DeFi", "Meme", "AI", "Gaming", "Infra"]

    with ThreadPoolExecutor(max_workers=8) as pool:
        fut_topcap = pool.submit(_build_topcap_heatmap, all_coins)
        fut_sectors = {
            name: pool.submit(_build_sector_heatmap, name, all_coins)
            for name in sector_names
        }
        fut_other = pool.submit(_build_other_heatmap, all_coins)

        result: Dict[str, Any] = {
            "topcap": fut_topcap.result(),
        }
        for name in sector_names:
            result[name.lower()] = fut_sectors[name].result()
        result["other"] = fut_other.result()

    total = sum(len(v) for v in result.values())
    logger.info(
        "Crypto heatmap generated: total=%d coins across %d sectors",
        total, len(result),
    )
    return result
