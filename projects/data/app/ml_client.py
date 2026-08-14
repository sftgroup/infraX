"""ml-service HTTP 客户端 — 拉取模型推理结果（只读，fail-silent）。

data-service 不再承载模型推理（LightGBM/FinBERT 已拆分到独立 ml-service），
collector 只做"拉取 → 落库"。未配置 ML_SERVICE_URL 或请求失败时返回 None，
不影响其他 collector。

ml-service 端点（见 ml-service/main.py）：
    GET  /ml/tree_predictions  → {"code":0, "data": {"generated_at","model","predictions"}}
    POST /ml/sentiment         → {"code":0, "data": 聚合情绪统计}
"""
from __future__ import annotations

import logging
import time

import requests

from app.config import ML_SERVICE_URL, ML_API_KEY

logger = logging.getLogger(__name__)

_TIMEOUT = 300  # tree 首次训练+全量预测可达分钟级；给足预算

# consensus 首次聚合触发 tree 训练判定 + Kronos 全量推理（可达 ~200s）；
# P2 三模型全量预测亦为分钟级；命中 ml-service TTL 缓存后秒回。给足首次预算。
_TIMEOUT_CONSENSUS = 600


def _headers() -> dict:
    return {"X-API-Key": ML_API_KEY} if ML_API_KEY else {}


def fetch_tree_predictions() -> dict | None:
    """拉取 ml-service LightGBM 方向预测 payload（或 None，fail-silent）。"""
    base = (ML_SERVICE_URL or "").strip().rstrip("/")
    if not base:
        return None
    try:
        resp = requests.get(f"{base}/ml/tree_predictions", headers=_headers(), timeout=_TIMEOUT)
        if resp.status_code != 200:
            logger.debug("ml-service /ml/tree_predictions → %s", resp.status_code)
            return None
        data = (resp.json() or {}).get("data")
        if not isinstance(data, dict) or not (data.get("predictions") or []):
            return None
        return data
    except requests.Timeout:
        logger.debug("ml-service tree_predictions timeout (%ss)", _TIMEOUT)
        return None
    except requests.RequestException as exc:
        logger.debug("ml-service tree_predictions request failed: %s", exc)
        return None
    except Exception as exc:
        logger.debug("ml-service tree_predictions parse failed: %s", exc)
        return None


def fetch_consensus() -> dict | None:
    """拉取 ml-service 跨模型共识 payload（/ml/consensus）。

    返回 {"generated_at", "signals", "n_symbols", "avg_consensus_score",
          "market_risk_flag", "n_divergence", "symbols"} 或 None（fail-silent）。
    """
    base = (ML_SERVICE_URL or "").strip().rstrip("/")
    if not base:
        return None
    try:
        resp = requests.get(f"{base}/ml/consensus", headers=_headers(), timeout=_TIMEOUT_CONSENSUS)
        if resp.status_code != 200:
            logger.debug("ml-service /ml/consensus → %s", resp.status_code)
            return None
        data = (resp.json() or {}).get("data")
        if not isinstance(data, dict) or not (data.get("symbols") or []):
            return None
        return data
    except requests.Timeout:
        logger.debug("ml-service consensus timeout (%ss)", _TIMEOUT)
        return None
    except requests.RequestException as exc:
        logger.debug("ml-service consensus request failed: %s", exc)
        return None


# 因子工厂激活列表 TTL 缓存（/factors/current 请求频繁，避免每请求打 ml-service）
_FF_CACHE: dict = {}
_FF_CACHE_TTL_S = 60


def fetch_factor_factory_activations() -> dict | None:
    """拉取 ml-service 因子工厂激活因子（/factors/current，FF-3.3）。

    返回 {"updated_at", "factors": [factor_key...]} 或 None（fail-silent）。
    60s TTL 缓存（激活列表变化低频）。data-service /factors/current 将其
    透传给下游（AItrader factor_client 无需改动即可感知新挖掘因子）。
    """
    global _FF_CACHE  # 函数内赋值 → 需显式 global，否则读取时 UnboundLocalError
    base = (ML_SERVICE_URL or "").strip().rstrip("/")
    if not base:
        return None
    now = time.time()
    if _FF_CACHE and now - _FF_CACHE.get("ts", 0) < _FF_CACHE_TTL_S:
        return _FF_CACHE.get("data")
    try:
        resp = requests.get(f"{base}/factors/current", headers=_headers(), timeout=10)
        if resp.status_code != 200:
            logger.debug("ml-service /factors/current → %s", resp.status_code)
            return None
        data = (resp.json() or {}).get("data")
        if not isinstance(data, dict) or not data.get("factors"):
            return None
        _FF_CACHE = {"ts": now, "data": {"updated_at": data.get("updated_at"), "factors": data["factors"]}}
        return _FF_CACHE["data"]
    except requests.RequestException as exc:
        logger.debug("ml-service /factors/current request failed: %s", exc)
        return None
    except Exception as exc:
        logger.debug("ml-service /factors/current parse failed: %s", exc)
        return None


def post_sentiment(articles: list[dict]) -> dict | None:
    """POST 新闻文章到 ml-service /ml/sentiment，返回聚合情绪统计（或 None）。"""
    base = (ML_SERVICE_URL or "").strip().rstrip("/")
    if not base or not articles:
        return None
    try:
        resp = requests.post(
            f"{base}/ml/sentiment",
            json={"articles": articles},
            headers=_headers(),
            timeout=_TIMEOUT,
        )
        if resp.status_code != 200:
            logger.debug("ml-service /ml/sentiment → %s", resp.status_code)
            return None
        data = (resp.json() or {}).get("data")
        return data if isinstance(data, dict) else None
    except requests.Timeout:
        logger.debug("ml-service sentiment timeout (%ss)", _TIMEOUT)
        return None
    except requests.RequestException as exc:
        logger.debug("ml-service sentiment request failed: %s", exc)
        return None
    except Exception as exc:
        logger.debug("ml-service sentiment parse failed: %s", exc)
        return None


# ── P2 时序模型（Bolt / Moirai / TimesFM） ─────────────────

_P2_ENDPOINTS = {
    "bolt": "/ml/bolt",
    "moirai": "/ml/moirai",
    "timesfm": "/ml/timesfm",
}


def _fetch_p2(kind: str) -> list[dict] | None:
    """拉取 ml-service P2 模型预测列表（[{symbol, direction, prob_up, ...}] 或 None）。

    端点返回 data: [{symbol, point_forecast, quantiles, direction, prob_up,
    uncertainty, ...}]；列表为空或解析失败返回 None（fail-silent）。
    """
    base = (ML_SERVICE_URL or "").strip().rstrip("/")
    path = _P2_ENDPOINTS.get(kind)
    if not base or not path:
        return None
    try:
        resp = requests.get(f"{base}{path}", headers=_headers(), timeout=_TIMEOUT_CONSENSUS)
        if resp.status_code != 200:
            logger.debug("ml-service %s → %s", path, resp.status_code)
            return None
        data = (resp.json() or {}).get("data")
        if not isinstance(data, list) or not data:
            return None
        return data
    except requests.Timeout:
        logger.debug("ml-service %s timeout (%ss)", path, _TIMEOUT_CONSENSUS)
        return None
    except requests.RequestException as exc:
        logger.debug("ml-service %s request failed: %s", path, exc)
        return None
    except Exception as exc:
        logger.debug("ml-service %s parse failed: %s", path, exc)
        return None


def fetch_bolt() -> list[dict] | None:
    """Chronos-Bolt 单变量概率预测列表（或 None，fail-silent）。"""
    return _fetch_p2("bolt")


def fetch_moirai() -> list[dict] | None:
    """Moirai 2.0 多变量联动预测列表（或 None，fail-silent）。"""
    return _fetch_p2("moirai")


def fetch_timesfm() -> list[dict] | None:
    """TimesFM 2.5 长上下文点预测列表（或 None，fail-silent）。"""
    return _fetch_p2("timesfm")
