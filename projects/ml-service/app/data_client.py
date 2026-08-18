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


def fetch_heatmap() -> dict | None:
    """拉取 data-service 全市场 heatmap（板块分组，GX-1 静态图数据源）。

    返回 {sector_key: [rows]}（topcap/layer1/layer2/defi/meme/ai/gaming/infra/
    other/stocks/fx/commodities）或 None（fail-silent）。
    """
    base = _base_url()
    if not base:
        return None
    try:
        resp = requests.get(
            f"{base}/snapshots",
            params={"type": "heatmap"},
            headers=_headers(),
            timeout=_TIMEOUT,
        )
        if resp.status_code != 200:
            logger.debug("data-service heatmap → %s", resp.status_code)
            return None
        data = resp.json()
        payload = (data.get("snapshots") or {}).get("heatmap")
        if not isinstance(payload, dict):
            return None
        # 单键信封解包（{"categories": {...}} → {...}）
        if len(payload) == 1:
            inner = next(iter(payload.values()))
            if isinstance(inner, dict) and inner:
                payload = inner
        if not any(isinstance(v, list) for v in payload.values()):
            return None
        return payload
    except requests.Timeout:
        logger.debug("data-service heatmap timeout (%ss)", _TIMEOUT)
        return None
    except requests.RequestException as exc:
        logger.debug("data-service heatmap request failed: %s", exc)
        return None
    except Exception as exc:
        logger.debug("data-service heatmap parse failed: %s", exc)
        return None


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


def fetch_moomoo_f10() -> dict | None:
    """拉取 data-service moomoo F10 扩展快照（GX-3.4.1/GX-3.5.2 数据面）。

    GET /snapshots?provider=moomoo_f10 → {"ts", "snapshots": {data_type: {symbol: {...}}}}：
      - mm_f10：          {symbol: {financials/analyst_consensus/valuation}}
      - mm_short_capital：{symbol: {short_interest/daily_short_volume/capital_flow}}
    外层单键信封（{"ts", "snapshots"}）经 .get("snapshots") 解包；失败返回 None（fail-silent）。
    """
    base = _base_url()
    if not base:
        return None
    try:
        resp = requests.get(
            f"{base}/snapshots",
            params={"provider": "moomoo_f10"},
            headers=_headers(),
            timeout=_TIMEOUT,
        )
        if resp.status_code != 200:
            logger.debug("data-service moomoo_f10 → %s", resp.status_code)
            return None
        payload = (resp.json().get("snapshots") or {})
        if not isinstance(payload, dict) or not payload:
            return None
        return payload
    except requests.Timeout:
        logger.debug("data-service moomoo_f10 timeout (%ss)", _TIMEOUT)
        return None
    except requests.RequestException as exc:
        logger.debug("data-service moomoo_f10 request failed: %s", exc)
        return None
    except Exception as exc:
        logger.debug("data-service moomoo_f10 parse failed: %s", exc)
        return None


def fetch_defi_tvl() -> list[dict] | None:
    """拉取 data-service 链上 DeFi TVL 快照（GX-3.5.4 数据面）。

    GET /snapshots?type=tvl → {"chains": [{chain, tvl, change_1d, change_7d}, ...]}
    （DeFiLlama，data-service 侧已解单键信封 → list）；失败返回 None（fail-silent）。
    """
    base = _base_url()
    if not base:
        return None
    try:
        resp = requests.get(
            f"{base}/snapshots",
            params={"type": "tvl"},
            headers=_headers(),
            timeout=_TIMEOUT,
        )
        if resp.status_code != 200:
            logger.debug("data-service tvl → %s", resp.status_code)
            return None
        payload = (resp.json().get("snapshots") or {}).get("tvl")
        # 防御：若仍未解包（{"chains": [...]}），这里补解一次
        if isinstance(payload, dict) and len(payload) == 1:
            inner = next(iter(payload.values()))
            if isinstance(inner, list):
                payload = inner
        if not isinstance(payload, list) or not payload:
            return None
        return payload
    except requests.Timeout:
        logger.debug("data-service tvl timeout (%ss)", _TIMEOUT)
        return None
    except requests.RequestException as exc:
        logger.debug("data-service tvl request failed: %s", exc)
        return None
    except Exception as exc:
        logger.debug("data-service tvl parse failed: %s", exc)
        return None


def fetch_crypto_derivatives(symbols: list[str]) -> dict | None:
    """拉取 data-service 衍生品资金费率/持仓/多空比（GX-3.5.3 数据面）。

    GET /factors/crypto-derivatives?symbols=BTC,ETH → {"factors": {sym: {...}}}
    （db_cache collector:crypto_factors:{sym}，Coinglass 主源 + Binance 兜底，
    ttl 300s）；失败返回 None（fail-silent）。
    """
    base = _base_url()
    if not base or not symbols:
        return None
    try:
        resp = requests.get(
            f"{base}/factors/crypto-derivatives",
            params={"symbols": ",".join(symbols)},
            headers=_headers(),
            timeout=_TIMEOUT,
        )
        if resp.status_code != 200:
            logger.debug("data-service /factors/crypto-derivatives → %s", resp.status_code)
            return None
        factors = (resp.json().get("factors") or {})
        return factors or None
    except requests.Timeout:
        logger.debug("data-service /factors/crypto-derivatives timeout (%ss)", _TIMEOUT)
        return None
    except requests.RequestException as exc:
        logger.debug("data-service /factors/crypto-derivatives request failed: %s", exc)
        return None
    except Exception as exc:
        logger.debug("data-service /factors/crypto-derivatives parse failed: %s", exc)
        return None
