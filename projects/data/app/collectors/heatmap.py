"""Crypto heatmap collector — periodic fetch → raw_snapshots.

Data source: CoinGecko (free, no API key).
Config: reads "heatmap" section from data_config.json.
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

logger = logging.getLogger(__name__)

_COINGECKO_BASE = os.getenv(
    "COINGECKO_BASE_URL", "https://api.coingecko.com/api/v3"
)
_CONFIG_PATH = os.getenv("DATA_CONFIG_PATH", "data_config.json")


def _load_config() -> dict:
    path = Path(_CONFIG_PATH)
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text())
    except Exception:
        return {}


def _get_heatmap_config() -> dict:
    if not hasattr(_get_heatmap_config, "_cache"):
        _get_heatmap_config._cache = _load_config().get("heatmap", {})
    return _get_heatmap_config._cache


# ── Category definitions ───────────────────────────────────

_CATEGORIES = {
    "topcap": ["bitcoin", "ethereum", "binancecoin", "ripple", "solana", "cardano",
               "dogecoin", "polkadot", "avalanche-2", "polygon-ecosystem-token",
               "tron", "chainlink", "uniswap", "litecoin", "stellar",
               "cosmos", "monero", "ethereum-classic", "cronos", "filecoin",
               "vechain", "near", "algorand", "the-graph", "injective-protocol",
               "hedera-hashgraph", "fantom", "elrond-erd-2", "aave", "tezos"],
    "layer1": ["solana", "avalanche-2", "near", "algorand", "injective-protocol",
               "aptos", "sui", "sei-network", "osmosis", "celo"],
    "layer2": ["polygon-ecosystem-token", "arbitrum", "optimism", "immutable-x",
               "mantle", "skale", "zksync", "starknet", "linea-eth", "mode"],
    "defi": ["uniswap", "aave", "maker", "compound-governance-token",
             "lido-dao", "curve-dao-token", "pancakeswap-token",
             "sushi", "1inch", "yearn-finance"],
    "meme": ["dogecoin", "shiba-inu", "pepe", "bonk", "floki",
             "dogwifcoin", "mog-coin", "popcat", "brett", "cat-in-a-dogs-world"],
    "ai": ["render-token", "bittensor", "fetch-ai", "singularitynet",
           "oasis-network", "akash-network", "aios", "worldcoin-wld",
           "numerai", "cortex"],
    "gaming": ["immutable-x", "gala", "axie-infinity", "the-sandbox",
               "decentraland", "enjincoin", "illuvium", "pixels",
               "myria", "beam-2"],
    "infra": ["chainlink", "the-graph", "helium", "arweave",
              "livepeer", "pyth-network", "band-protocol", "orai",
              "streamr", "ethernity-chain"],
}


def _fetch_heatmap(max_per: int = 30) -> Optional[dict]:
    """Fetch crypto heatmap data from CoinGecko."""
    try:
        all_ids = []
        for ids in _CATEGORIES.values():
            all_ids.extend(ids)
        all_ids = list(set(all_ids))

        resp = requests.get(
            f"{_COINGECKO_BASE}/coins/markets",
            params={
                "vs_currency": "usd",
                "ids": ",".join(all_ids),
                "order": "market_cap_desc",
                "per_page": 250,
                "page": 1,
                "sparkline": "false",
                "price_change_percentage": "24h",
            },
            timeout=15,
        )
        if resp.status_code != 200:
            logger.warning("Heatmap fetch failed: status=%d base=%s", resp.status_code, _COINGECKO_BASE)
            return None

        coins = resp.json()
        price_map = {}
        for c in coins:
            price_map[c["id"]] = {
                "symbol": (c.get("symbol") or "").upper(),
                "name": c.get("name", c["id"]),
                "price": c.get("current_price"),
                "change_24h": c.get("price_change_percentage_24h"),
                "market_cap": c.get("market_cap"),
                "image": c.get("image", ""),
            }

        result = {}
        for category, ids in _CATEGORIES.items():
            tickers = []
            for cg_id in ids[:max_per]:
                if cg_id in price_map:
                    tickers.append(price_map[cg_id])
            result[category] = tickers

        return result
    except Exception as exc:
        logger.warning("Heatmap fetch failed: %s", exc)
        return None


class HeatmapCollector:
    """Periodically fetch crypto heatmap → raw_snapshots."""

    def __init__(self):
        self._running = False
        self._thread: Optional[threading.Thread] = None

    def start(self):
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._loop, daemon=True, name="heatmap-collector")
        self._thread.start()
        cfg = _get_heatmap_config()
        interval = cfg.get("interval_sec", 600)
        logger.info("HeatmapCollector started (interval=%ds)", interval)

    def stop(self):
        self._running = False

    def _loop(self):
        cfg = _get_heatmap_config()
        interval = cfg.get("interval_sec", 600)
        while self._running:
            try:
                self._collect(cfg)
            except Exception:
                logger.warning("HeatmapCollector cycle failed", exc_info=True)
            time.sleep(interval)

    def _collect(self, cfg: dict):
        max_per = cfg.get("max_per_category", 30)
        data = _fetch_heatmap(max_per)
        if data:
            save_snapshot("market", "heatmap", {"categories": data})
            count = sum(len(v) for v in data.values())
            logger.info("HeatmapCollector: saved %d tokens across %d categories",
                         count, len(data))
