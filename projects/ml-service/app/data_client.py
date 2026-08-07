"""data-service HTTP 客户端 — 拉取 K 线与符号清单（只读）。

ml-service 不直连 SQLite，统一走 data-service HTTP 端点：
    GET /bars?symbol=&timeframe=&limit=  → {"bars": [...]}
    GET /symbols?timeframe=&min_bars=    → {"symbols": [...]}

fail-silent：未配置 DATA_SERVICE_URL 或请求失败返回空/None，不抛异常。
"""
from __future__ import annotations

import logging

import requests

import config

logger = logging.getLogger(__name__)

_TIMEOUT = 15


def _base_url() -> str:
    return (config.DATA_SERVICE_URL or "").strip().rstrip("/")


def _headers() -> dict:
    return {"X-API-Key": config.DATA_API_KEY} if config.DATA_API_KEY else {}


def fetch_bars(symbol: str, timeframe: str = "1d", limit: int = 500) -> list[dict]:
    """拉取某 symbol 日线（升序），返回 [{ts, open, high, low, close, volume, ...指标}]。

    失败/无数据返回 []（fail-silent）。
    """
    base = _base_url()
    if not base:
        return []
    try:
        resp = requests.get(
            f"{base}/bars",
            params={"symbol": symbol, "timeframe": timeframe, "limit": limit},
            headers=_headers(),
            timeout=_TIMEOUT,
        )
        if resp.status_code != 200:
            logger.debug("data-service /bars %s → %s", symbol, resp.status_code)
            return []
        bars = (resp.json().get("bars") or [])
        if not bars:
            return []
        bars.sort(key=lambda b: b["ts"])
        return bars
    except requests.Timeout:
        logger.debug("data-service /bars %s timeout (%ss)", symbol, _TIMEOUT)
        return []
    except requests.RequestException as exc:
        logger.debug("data-service /bars %s request failed: %s", symbol, exc)
        return []
    except Exception as exc:
        logger.debug("data-service /bars %s parse failed: %s", symbol, exc)
        return []


def fetch_sentiment_score() -> dict | None:
    """拉取 data-service 最新市场情绪分。

    回退链：finbert_sentiment（FinBERT 真实分类）→ sentiment_score
    （market-rule 情绪快照 {"value": [-1,1]}）。两者均为 [-1,1]。
    返回 {"score": float, "ts": int} 或 None（未配置/失败/无快照）。
    """
    for data_type, score_field in (("finbert_sentiment", "sentiment_score"), ("sentiment_score", "value")):
        score, ts = _fetch_snapshot_score(data_type, score_field)
        if score is not None:
            return {"score": score, "ts": ts}
    return None


def _fetch_snapshot_score(data_type: str, score_field: str) -> tuple[float | None, int]:
    """拉单个 data-service 快照中的数值字段（fail-silent）。"""
    base = _base_url()
    if not base:
        return None, 0
    try:
        resp = requests.get(
            f"{base}/snapshots",
            params={"type": data_type},
            headers=_headers(),
            timeout=_TIMEOUT,
        )
        if resp.status_code != 200:
            logger.debug("data-service %s → %s", data_type, resp.status_code)
            return None, 0
        data = resp.json()
        raw = (data.get("snapshots") or {}).get(data_type)
        if isinstance(raw, dict):
            value = raw.get(score_field)
        else:
            value = raw
        if not isinstance(value, (int, float)):
            return None, data.get("ts", 0)
        return float(value), data.get("ts", 0)
    except requests.Timeout:
        logger.debug("data-service %s timeout (%ss)", data_type, _TIMEOUT)
        return None, 0
    except requests.RequestException as exc:
        logger.debug("data-service %s request failed: %s", data_type, exc)
        return None, 0
    except Exception as exc:
        logger.debug("data-service %s parse failed: %s", data_type, exc)
        return None, 0


def fetch_symbols(timeframe: str = "1d", min_bars: int = 120) -> list[str]:
    """拉取 data-service 中满足最少 bar 数的 symbol 列表（升序）。

    失败返回 []（fail-silent）。
    """
    base = _base_url()
    if not base:
        return []
    try:
        resp = requests.get(
            f"{base}/symbols",
            params={"timeframe": timeframe, "min_bars": min_bars},
            headers=_headers(),
            timeout=_TIMEOUT,
        )
        if resp.status_code != 200:
            logger.debug("data-service /symbols → %s", resp.status_code)
            return []
        symbols = (resp.json().get("symbols") or [])
        return [s for s in symbols if isinstance(s, str) and s]
    except requests.Timeout:
        logger.debug("data-service /symbols timeout (%ss)", _TIMEOUT)
        return []
    except requests.RequestException as exc:
        logger.debug("data-service /symbols request failed: %s", exc)
        return []
    except Exception as exc:
        logger.debug("data-service /symbols parse failed: %s", exc)
        return []


def fetch_snapshot_factor(data_type: str, field: str) -> dict | None:
    """拉取 data-service 最新快照中的单个数值因子（如 vix/dxy/us10y）。

    返回 {"value": float, "ts": int} 或 None（未配置/失败/无快照）。
    快照单键值 {value: ...} 或 {us10y: ...} 均可。
    """
    score, ts = _fetch_snapshot_score(data_type, field)
    if score is None:
        return None
    return {"value": score, "ts": ts}


def fetch_macro_history() -> dict | None:
    """拉取 data-service FRED 宏观历史（/macro/history，1 年观测值序列）。

    返回 {"ts": int, "series": {name: [{"date", "value"}, ...]}} 或 None。
    """
    base = _base_url()
    if not base:
        return None
    try:
        resp = requests.get(
            f"{base}/macro/history",
            params={"limit": 50000},
            headers=_headers(),
            timeout=_TIMEOUT,
        )
        if resp.status_code != 200:
            logger.debug("data-service /macro/history → %s", resp.status_code)
            return None
        data = resp.json()
        series = (data or {}).get("series")
        if not isinstance(series, dict) or not series:
            return None
        return {"ts": int((data or {}).get("ts", 0) or 0), "series": series}
    except requests.Timeout:
        logger.debug("data-service /macro/history timeout (%ss)", _TIMEOUT)
        return None
    except requests.RequestException as exc:
        logger.debug("data-service /macro/history request failed: %s", exc)
        return None
    except Exception as exc:
        logger.debug("data-service /macro/history parse failed: %s", exc)
        return None
