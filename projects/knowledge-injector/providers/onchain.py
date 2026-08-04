"""BTC 链上数据源。

获取 BTC 挖矿难度、最新区块高度等数据。
通过 blockchain.info 免费 API，无需 API Key。

失败返回 None。
"""
from __future__ import annotations

import logging
import time
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


# ─── BTC 转账流量 / 巨鲸大额转账 ─────────────────────────

_MEMPOOL_SPACE = "https://mempool.space/api"

# 大额转账阈值（BTC）
_WHALE_TX_THRESHOLD_BTC = 100.0
# 监控窗口：最近 24 小时
_WHALE_TX_WINDOW_SEC = 24 * 3600


def fetch_btc_transfers() -> dict[str, Any] | None:
    """Fetch BTC transfer flow indicators + whale large transfers.

    数据源 mempool.space 免费 API（无需 Key）：
      - /api/mempool                → 未确认交易数与 mempool 深度
      - /api/blocks/tip/height      → 最新区块高度
      - /api/v1/mining/blocks/recent → 近 15 区块（含每区块 tx_count）
      - /api/address/:addr/txs      → 已知巨鲸地址最近交易（识别 ≥100 BTC 大额转账）

    Returns:
        {
          "height": 961073,
          "mempool_txs": 42000,
          "mempool_vsize_mb": 210.5,
          "avg_tx_24h": 380000,
          "whale_movements": [
              {"name": "Binance Cold", "direction": "out", "amount_btc": 1250.0,
               "txid": "...", "time": 1785870000}, ...
          ],
        }
    """
    result: dict[str, Any] = {}

    # 1. mempool 深度（未确认交易）
    try:
        m = requests.get(f"{_MEMPOOL_SPACE}/mempool", timeout=10).json()
        result["mempool_txs"] = int(m.get("count", 0))
        result["mempool_vsize_mb"] = round(m.get("vsize", 0) / 1e6, 1)
    except Exception:
        logger.debug("mempool depth fetch failed", exc_info=True)

    # 2. 最新高度
    try:
        result["height"] = int(requests.get(
            f"{_MEMPOOL_SPACE}/blocks/tip/height", timeout=10
        ).text.strip())
    except Exception:
        logger.debug("mempool tip height fetch failed", exc_info=True)

    # 3. 近 15 区块 tx 数 → 近 24h 平均交易量
    try:
        blocks = requests.get(
            f"{_MEMPOOL_SPACE}/v1/mining/blocks/recent", timeout=10
        ).json()
        if isinstance(blocks, list):
            tx_counts = [b.get("tx_count", 0) for b in blocks if b.get("tx_count")]
            if tx_counts:
                result["avg_tx_24h"] = int(sum(tx_counts) / len(tx_counts))
            if blocks:
                result["block_time"] = blocks[0].get("timestamp")
    except Exception:
        logger.debug("mempool recent blocks fetch failed", exc_info=True)

    # 4. 巨鲸地址大额转账（最近 24h，≥100 BTC）
    movements = _fetch_whale_movements()
    if movements:
        result["whale_movements"] = movements

    if not result:
        return None
    logger.info(
        "BTC transfers: height=%s, mempool=%s, movements=%d",
        result.get("height", "?"), result.get("mempool_txs", "?"), len(movements),
    )
    return result


def _fetch_whale_movements() -> list[dict[str, Any]]:
    """扫描已知巨鲸地址最近交易，识别 ≥100 BTC 的大额转账。"""
    movements: list[dict[str, Any]] = []
    now = int(time.time())
    cutoff = now - _WHALE_TX_WINDOW_SEC

    for name, address in _WHALE_ADDRESSES.items():
        try:
            txs = requests.get(
                f"{_MEMPOOL_SPACE}/address/{address}/txs", timeout=10
            ).json()
            if not isinstance(txs, list):
                continue
            for tx in txs:
                status = tx.get("status", {}) or {}
                if not status.get("confirmed"):
                    continue
                block_time = status.get("block_time", 0)
                if block_time < cutoff:
                    continue
                txid = tx.get("txid", "")
                # 转出：该地址作为输入（prevout 地址匹配）
                out_btc = sum(
                    v.get("prevout", {}).get("value", 0)
                    for v in tx.get("vin", [])
                    if v.get("prevout", {}).get("scriptpubkey_address") == address
                ) / 1e8
                # 转入：该地址作为输出
                in_btc = sum(
                    v.get("value", 0)
                    for v in tx.get("vout", [])
                    if v.get("scriptpubkey_address") == address
                ) / 1e8
                if out_btc >= _WHALE_TX_THRESHOLD_BTC:
                    movements.append({
                        "name": name,
                        "direction": "out",
                        "amount_btc": round(out_btc, 1),
                        "txid": txid[:16],
                        "time": block_time,
                    })
                elif in_btc >= _WHALE_TX_THRESHOLD_BTC:
                    movements.append({
                        "name": name,
                        "direction": "in",
                        "amount_btc": round(in_btc, 1),
                        "txid": txid[:16],
                        "time": block_time,
                    })
        except Exception:
            logger.debug("Whale movements fetch failed for %s", name, exc_info=True)

    return movements
