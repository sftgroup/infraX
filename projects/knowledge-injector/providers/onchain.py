"""BTC 链上数据源。

获取 BTC 挖矿难度、最新区块高度等数据。
通过 blockchain.info 免费 API，无需 API Key。

失败返回 None。
"""
from __future__ import annotations

import logging
from typing import Any

import requests

logger = logging.getLogger(__name__)


def fetch_btc_difficulty() -> dict[str, Any] | None:
    """Fetch BTC mining difficulty and latest block height.

    Sources:
        - difficulty: https://blockchain.info/q/getdifficulty
        - latest block: https://blockchain.info/latestblock

    Returns:
        {"difficulty": 110453872256843.5, "height": 882451}
    """
    try:
        resp = requests.get(
            "https://blockchain.info/q/getdifficulty",
            timeout=10,
        )
        resp.raise_for_status()
        difficulty = float(resp.text.strip())
    except Exception:
        logger.debug("BTC difficulty fetch failed", exc_info=True)
        return None

    try:
        block_resp = requests.get(
            "https://blockchain.info/latestblock",
            timeout=10,
        )
        block_resp.raise_for_status()
        block_data = block_resp.json()
        height = int(block_data.get("height", 0))
    except Exception:
        logger.debug("BTC latest block fetch failed", exc_info=True)
        height = 0

    logger.info("BTC difficulty: %.1fT, height: %d", difficulty / 1e12, height)
    return {
        "difficulty": difficulty,
        "difficulty_t": round(difficulty / 1e12, 2),
        "height": height,
    }


# 已知巨鲸地址（公开知名地址，用于余额变化监控）
_WHALE_ADDRESSES: dict[str, str] = {
    "MicroStrategy": "1P5ZEDWTKTFGxQjZphgWPQUpe554WKDfHQ",
    "Binance Cold": "34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo",
    "Bitfinex Cold": "3M219KR5vEneNb47ewrPfWZ2Hef9yEBc8w",
    # 其他公开地址可在 P2 阶段扩展
}


def fetch_whale_balances() -> list[dict[str, Any]]:
    """Fetch known whale BTC balances.

    使用 blockchain.info 公开 API，无需 Key。
    每地址一次 HTTP 请求。

    Returns:
        [
            {"name": "MicroStrategy", "balance_btc": 226331, "address": "1P5Z..."},
            ...
        ]
    """
    results: list[dict[str, Any]] = []
    for name, address in _WHALE_ADDRESSES.items():
        try:
            resp = requests.get(
                f"https://blockchain.info/q/addressbalance/{address}",
                timeout=10,
            )
            resp.raise_for_status()
            balance_satoshi = int(resp.text.strip())
            balance_btc = balance_satoshi / 1e8
            results.append({
                "name": name,
                "address": address[:8],
                "balance_btc": round(balance_btc, 1),
            })
        except Exception:
            logger.debug("Whale balance fetch failed for %s", name, exc_info=True)
    if results:
        logger.info("Fetched %d whale balances", len(results))
    return results
