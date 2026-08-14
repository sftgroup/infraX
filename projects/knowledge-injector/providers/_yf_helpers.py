"""yfinance 调用辅助工具。

提供带随机延迟、指数退避重试的 yfinance 封装。
解决 Yahoo Finance 对服务器 IP 的限流问题。

RI-4.4：读取 EGRESS_PROXIES（JSON，格式同 collector）出口代理池，
yfinance 请求按 round-robin 轮换出口 IP；代理健康探测失败自动回直连。
"""
from __future__ import annotations

import json
import logging
import os
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

# ── Egress 代理池（RI-4.4：出口 IP 轮换） ─────────────
_EGRESS_PROXIES: list[dict] = []
_EGRESS_HEALTHY: list[bool] = []
_EGRESS_RR = 0
_EGRESS_LAST_PROBE = 0.0
_EGRESS_PROBE_INTERVAL = 30.0
_EGRESS_PROBE_URL = "https://api.ipify.org"
_EGRESS_PROBE_TIMEOUT = 10


def _load_egress_proxies() -> None:
    """EGRESS_PROXIES JSON → 代理池（默认空=直连；非法 JSON 同样直连）。"""
    global _EGRESS_PROXIES, _EGRESS_HEALTHY
    try:
        raw = os.environ.get("EGRESS_PROXIES", "[]")
        arr = json.loads(raw)
        _EGRESS_PROXIES = arr if isinstance(arr, list) else []
    except Exception:
        _EGRESS_PROXIES = []
    _EGRESS_HEALTHY = [True] * len(_EGRESS_PROXIES)
    if _EGRESS_PROXIES:
        logger.info("egress proxy pool loaded: %s",
                    ", ".join(f"{p.get('host')}:{p.get('port')}" for p in _EGRESS_PROXIES))


def _egress_url(p: dict) -> str | None:
    host, port = p.get("host"), p.get("port")
    if not host or not port:
        return None
    auth = p.get("auth") or ""
    return f"http://{auth}@{host}:{port}" if auth else f"http://{host}:{port}"


def _egress_probe() -> None:
    """30s 间隔健康探测；失败标记 unhealthy（后续轮换跳过，自动回直连）。"""
    global _EGRESS_LAST_PROBE
    if time.time() - _EGRESS_LAST_PROBE < _EGRESS_PROBE_INTERVAL:
        return
    _EGRESS_LAST_PROBE = time.time()
    import requests  # yfinance 依赖，已存在
    for i, p in enumerate(_EGRESS_PROXIES):
        u = _egress_url(p)
        if not u:
            continue
        try:
            requests.get(_EGRESS_PROBE_URL, proxies={"http": u, "https": u},
                         timeout=_EGRESS_PROBE_TIMEOUT)
            if not _EGRESS_HEALTHY[i]:
                logger.info("egress proxy %s healthy again", u)
            _EGRESS_HEALTHY[i] = True
        except Exception as exc:
            if _EGRESS_HEALTHY[i]:
                logger.warning("egress proxy %s unhealthy (%s) — fall back direct", u, exc)
            _EGRESS_HEALTHY[i] = False


def _get_yf_proxy() -> dict | None:
    """round-robin 返回健康代理的 requests proxies dict；无 → None（直连）。"""
    global _EGRESS_RR
    if not _EGRESS_PROXIES:
        return None
    _egress_probe()
    for i in range(len(_EGRESS_PROXIES)):
        idx = (_EGRESS_RR + i) % len(_EGRESS_PROXIES)
        if _EGRESS_HEALTHY[idx]:
            u = _egress_url(_EGRESS_PROXIES[idx])
            if u:
                _EGRESS_RR = (idx + 1) % len(_EGRESS_PROXIES)
                return {"http": u, "https": u}
    return None  # 全部不健康 → 直连（fail-silent）


_load_egress_proxies()

# ── 单例（共享 session，共用 cookie） ──────────────────

_yf_session: Any = None
_shared_ticker: Any = None
_last_request_time: float = 0.0


def _get_session():
    """延迟获取共享 session（requests.Session，代理由调用方更新 proxies）。

    yfinance 1.5.2 无 utils.get_yf_session；传入自定义 session 时 yfinance
    内部会补 UA header（YfData._session.headers）。
    """
    global _yf_session
    if _yf_session is None:
        import requests
        _yf_session = requests.Session()
        _yf_session.headers["User-Agent"] = (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/122.0 Safari/537.36"
        )
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
            # RI-4.4: 出口 IP 轮换 — yfinance 每次请求前会用
            # YfConfig.network.proxy 覆盖 session.proxies（data.py _make_request），
            # 因此必须设置 yfinance 原生配置入口，而非直接改 session.proxies。
            from yfinance.config import YfConfig
            proxy = _get_yf_proxy()
            YfConfig.network.proxy = proxy["https"] if proxy else None
            sess = _get_session()
            ticker = yf.Ticker(symbol, session=sess) if sess is not None else yf.Ticker(symbol)
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
