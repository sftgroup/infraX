"""EVM 链上数据源。

获取 ETH 总供应量、燃烧量、质押数据。
- Etherscan API: 需要 ETHERSCAN_API_KEY（未设置时跳过）
- beaconcha.in API: 免费，无需 Key
- ultrasound.money: 免费，无需 Key

失败返回 None，不影响其他数据。
"""
from __future__ import annotations

import json
import logging
from typing import Any

import requests

from config import rotate_key

logger = logging.getLogger(__name__)

# ─── ETH 供应量 ──────────────────────────────────────


def fetch_eth_supply() -> dict[str, Any] | None:
    """Fetch ETH total supply from Etherscan.

    Returns:
        {"total_supply": 120_500_000, "burned_since_eip1559": 4_200_000, ...}
    """
    api_key = rotate_key("ETHERSCAN_API_KEY")
    if not api_key:
        return None

    try:
        resp = requests.get(
            "https://api.etherscan.io/api",
            params={
                "module": "stats",
                "action": "ethsupply",
                "apikey": api_key,
            },
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()
        total_supply = int(data.get("result", 0))
    except Exception:
        logger.debug("ETH supply fetch failed (Etherscan)", exc_info=True)
        return None

    # 同时获取 EIP-1559 以来的燃烧量
    burned = _fetch_burned_eth()
    # 预估流通量 = 总供应 - 燃烧
    circulating = total_supply - (burned or 0)

    result = {
        "total_supply": total_supply,
        "supply_label": _format_supply(total_supply),
        "burned": burned,
        "burned_label": _format_supply(burned) if burned else None,
        "circulating": circulating,
        "circulating_label": _format_supply(circulating),
    }

    logger.info(
        "ETH supply: total=%s, burned=%s, circulating=%s",
        result["supply_label"], result.get("burned_label", "N/A"), result["circulating_label"],
    )
    return result


def _fetch_burned_eth() -> int | None:
    """Fetch ETH burned since EIP-1559 via Etherscan stats."""
    api_key = rotate_key("ETHERSCAN_API_KEY")
    if not api_key:
        return None

    try:
        resp = requests.get(
            "https://api.etherscan.io/api",
            params={
                "module": "stats",
                "action": "ethburnt",
                "apikey": api_key,
            },
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()
        return int(data.get("result", {}).get("burntFees", 0)) if isinstance(data.get("result"), dict) else int(data.get("result", 0))
    except Exception:
        logger.debug("ETH burned fetch failed (Etherscan)", exc_info=True)
        return None


def _format_supply(supply: int) -> str:
    """格式化供应量为易读文本。"""
    mil = supply / 1e6
    return f"{mil:.1f}M"


# ─── ETH 质押数据 ─────────────────────────────────────


def fetch_eth_staking() -> dict[str, Any] | None:
    """Fetch ETH staking data from beaconcha.in.

    Free API, no key required.

    Returns:
        {"total_staked": 34_500_000, "stakers": 1_050_000, "apr": 3.5, ...}
    """
    try:
        resp = requests.get(
            "https://beaconcha.in/api/v1/epoch/latest",
            timeout=10,
        )
        resp.raise_for_status()
        epoch_data = resp.json()
        # 从 Epoch 数据中提取验证者数
        validators_count = epoch_data.get("data", {}).get("validatorscount", 0)
        if not validators_count:
            validators_count = epoch_data.get("data", {}).get("validatorscount", 0)
    except Exception:
        logger.debug("beaconcha.in epoch fetch failed", exc_info=True)
        return None

    try:
        # 获取总质押量
        stats_resp = requests.get(
            "https://beaconcha.in/api/v1/validator/stats",
            timeout=10,
            headers={"User-Agent": "AItrader/1.0"},
        )
        stats_resp.raise_for_status()
        stats = stats_resp.json()
        typed_validators = stats.get("data", [])
    except Exception:
        typed_validators = []

    active_validators = 0
    for v in typed_validators[:10]:
        status = v.get("status", "")
        if status == "active_ongoing":
            active_validators += 1

    # 总验证者数
    total_validators = validators_count or active_validators or 0
    total_staked = total_validators * 32  # 每个验证者 32 ETH

    # Approx APR
    apr = _calc_staking_apr(total_staked)

    result = {
        "validators": total_validators,
        "total_staked": total_staked,
        "staked_label": _format_supply(total_staked),
        "apr": apr,
    }
    logger.info(
        "ETH staking: %.1fM ETH staked, %d validators, APR %.1f%%",
        total_staked / 1e6, total_validators, apr,
    )
    return result


def _calc_staking_apr(total_staked: int) -> float:
    """估算当前 ETH 质押 APR。

    基于年化发行量约 0.5M ETH / 总质押量。
    当质押量 > 32M 时 APR 约 3.0-3.5%。
    """
    if total_staked <= 0:
        return 0.0
    # 简化模型: 年发行约 500K ETH
    annual_issuance = 500_000
    apr_pct = annual_issuance / total_staked * 100
    return round(min(apr_pct, 6.0), 1)  # cap at 6%


# ─── 总入口 ──────────────────────────────────────────


def fetch_evm_overview() -> dict[str, Any]:
    """获取所有 EVM 链上数据的汇总。

    返回:
        {
            "eth_supply": {...},
            "eth_staking": {...},
        }
    """
    results: dict[str, Any] = {}
    try:
        supply = fetch_eth_supply()
        if supply:
            results["eth_supply"] = supply
    except Exception:
        logger.debug("fetch_eth_supply failed", exc_info=True)

    try:
        staking = fetch_eth_staking()
        if staking:
            results["eth_staking"] = staking
    except Exception:
        logger.debug("fetch_eth_staking failed", exc_info=True)

    if results:
        logger.info("Fetched EVM overview with %d sections", len(results))
    return results
