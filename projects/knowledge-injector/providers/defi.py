"""DeFi TVL 数据源。

从 DeFiLlama 获取各链 TVL 数据。
免费 API，无需 API Key。

失败返回空列表。
"""
from __future__ import annotations

import logging
from typing import Any

import requests

logger = logging.getLogger(__name__)

# 关注的链（可按需扩展）
_KEY_CHAINS: list[str] = [
    "Ethereum",
    "Solana",
    "BNB Chain",
    "Arbitrum",
    "Base",
    "Polygon",
    "Avalanche",
    "Sui",
    "Optimism",
]


def fetch_chain_tvl() -> list[dict[str, Any]]:
    """Fetch TVL data for major chains from DeFiLlama.

    免费 API，无需 Key，无需认证。

    Returns:
        [
            {"chain": "Ethereum", "tvl": 58.2e9, "change_24h": -1.5, ...},
            ...
        ]
    """
    try:
        resp = requests.get(
            "https://api.llama.fi/v2/chains",
            timeout=15,
        )
        resp.raise_for_status()
        all_chains: list[dict] = resp.json()
    except Exception:
        logger.debug("DeFiLlama chain TVL fetch failed", exc_info=True)
        return []

    results: list[dict[str, Any]] = []
    for chain_data in all_chains:
        name: str = chain_data.get("name", "") or ""
        if name not in _KEY_CHAINS:
            continue

        tvl = chain_data.get("tvl", chain_data.get("currentTvl", 0))
        if isinstance(tvl, (int, float)) and tvl > 0:
            results.append({
                "chain": name,
                "tvl": round(tvl, 1),
                "tvl_label": _format_tvl(tvl),
                "change_24h": chain_data.get("change_1d", 0),
                "change_7d": chain_data.get("change_7d", None),
                "dominance": chain_data.get("dominance", None),
            })

    # 按 TVL 降序
    results.sort(key=lambda x: x["tvl"], reverse=True)
    if results:
        logger.info("Fetched TVL for %d chains", len(results))
    return results


def _format_tvl(tvl: float) -> str:
    """格式化 TVL 为易读文本。"""
    if tvl >= 1e9:
        return f"${tvl / 1e9:.1f}B"
    if tvl >= 1e6:
        return f"${tvl / 1e6:.1f}M"
    return f"${tvl:,.0f}"
