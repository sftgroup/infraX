"""yfinance 调用辅助工具。

提供带随机延迟、指数退避重试的 yfinance 封装。
解决 Yahoo Finance 对服务器 IP 的限流问题。
"""
from __future__ import annotations

import logging
import random
import re
import time
from typing import Any

logger = logging.getLogger(__name__)

# ── 配置 ──────────────────────────────────────────────
_MIN_DELAY = 1.0       # 请求间最小延迟（秒）
_MAX_DELAY = 3.0       # 请求间最大延迟（秒）
_MAX_RETRIES = 3       # 最大重试次数（RI-3.1：429/5xx 指数退避 + jitter）
_BASE_BACKOFF = 1.0    # 退避基数（秒）：1s→2s→4s（含 jitter）

# ── 单例（共享 session，共用 cookie） ──────────────────

_yf_session: Any = None
_shared_ticker: Any = None
_last_request_time: float = 0.0


def _get_session():
    """延迟导入 yfinance，获取共享 session。"""
    global _yf_session
    if _yf_session is None:
        import yfinance as yf
        try:
            _yf_session = yf.utils.get_yf_session()
        except AttributeError:
            _yf_session = None
    return _yf_session


def _rate_limit_wait():
    """请求前等待随机延迟，避免触发限流。"""
    global _last_request_time
    elapsed = time.time() - _last_request_time
    min_wait = random.uniform(_MIN_DELAY, _MAX_DELAY)
    if elapsed < min_wait:
        time.sleep(min_wait - elapsed)
    _last_request_time = time.time()


def _is_rate_limit(exc: Exception) -> bool:
    """判断是否为 Yahoo 限流/服务端错误（RI-3.1：429 与 5xx 均触发退避重试）。"""
    msg = str(exc).lower()
    if "rate limit" in msg or "too many request" in msg or "429" in msg:
        return True
    # 5xx 服务端错误（临时故障）同样退避重试
    return bool(re.search(r"\b(500|502|503|504)\b", msg)) or "server error" in msg or "5xx" in msg


def _maybe_refresh():
    """如果全局 Ticker 实例需要刷新，清除缓存。"""
    global _shared_ticker
    # 每个文件新建自己的 Ticker——不共享以免混乱
    _shared_ticker = None


def safe_history(symbol: str, period: str = "5d") -> Any | None:
    """安全获取 yfinance 历史数据，带延迟和重试。

    返回 pandas DataFrame 或 None。
    """
    import yfinance as yf

    last_exc: Exception | None = None
    for attempt in range(_MAX_RETRIES + 1):
        if attempt > 0:
            # RI-3.1：指数退避 + jitter（1s→2s→4s × [0.6,1.4)），避免重试风暴
            backoff = _BASE_BACKOFF * (2 ** (attempt - 1)) * (0.6 + random.random() * 0.8)
            logger.debug("yf retry %d/%d for %s after %.0fs", attempt, _MAX_RETRIES, symbol, backoff)
            time.sleep(backoff)

        _rate_limit_wait()

        try:
            ticker = yf.Ticker(symbol)
            hist = ticker.history(period=period)
            if hist is not None and not hist.empty and len(hist) >= 1:
                return hist
            return None
        except Exception as exc:
            last_exc = exc
            if _is_rate_limit(exc):
                logger.debug("yf rate limited for %s, attempt %d", symbol, attempt)
                continue
            # 非限流错误不重试
            logger.debug("yf fetch failed for %s: %s", symbol, exc)
            return None

    logger.debug("yf all retries exhausted for %s: %s", symbol, last_exc)
    return None
