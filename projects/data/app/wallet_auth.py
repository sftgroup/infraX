"""钱包签名鉴权（B-11-3）：EIP-191 personal_sign 恢复地址，对齐 waas 契约。

waas middleware/auth.ts 同款流程：
  message = "InfraX auth: <timestamp>"
  headers: x-wallet-address / x-wallet-signature / x-wallet-timestamp
  TTL 24h；验证通过 → 返回恢复出的地址（小写）。
"""

from __future__ import annotations

import time

from app.utils.logger import get_logger

logger = get_logger(__name__)

SESSION_TTL_MS = 24 * 60 * 60 * 1000


def verify_wallet_signature(headers: dict, max_timestamp_skew_ms: int = SESSION_TTL_MS) -> str | None:
    """校验钱包签名。成功返回钱包地址（小写），失败返回 None。"""
    address = (headers.get("x-wallet-address") or "").strip().lower()
    signature = (headers.get("x-wallet-signature") or "").strip()
    timestamp = (headers.get("x-wallet-timestamp") or "").strip()
    if not address or len(address) < 42 or not signature or not timestamp:
        return None
    try:
        ts = int(timestamp)
    except (TypeError, ValueError):
        return None
    if abs(time.time() * 1000 - ts) > max_timestamp_skew_ms:
        return None
    try:
        from eth_account.messages import encode_defunct
        from eth_account import Account
        message = encode_defunct(text=f"InfraX auth: {timestamp}")
        recovered = Account.recover_message(message, signature=signature).lower()
    except Exception as e:  # pragma: no cover
        logger.warning("wallet signature recovery failed: %s", e)
        return None
    return recovered if recovered == address else None
