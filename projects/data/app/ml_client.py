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

from app.config import ML_SERVICE_URL, ML_API_KEY, RAGSERVICER_BASE_URL, RAGSERVICER_SERVICE_KEY

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
_FF_VALUES_CACHE: dict = {}
_FF_VALUES_CACHE_TTL_S = 60


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


def fetch_factor_factory_values(symbols: list[str]) -> dict | None:
    """拉取 ml-service 激活因子当前值（/factors/values，FF-3.4）。

    返回 {"updated_at", "values": {symbol: {factor_key: value}}} 或 None（fail-silent）。
    60s TTL 缓存，**按 symbols 集合键控**（不同请求的标的池不同，值必须对应）。
    data-service /factors/current 将其并入 ml_factory.values，客户端免复算公式。
    """
    global _FF_VALUES_CACHE  # 函数内赋值 → 需显式 global
    base = (ML_SERVICE_URL or "").strip().rstrip("/")
    if not base or not symbols:
        return None
    cache_key = ",".join(sorted(symbols))
    now = time.time()
    if (_FF_VALUES_CACHE.get("key") == cache_key
            and now - _FF_VALUES_CACHE.get("ts", 0) < _FF_VALUES_CACHE_TTL_S):
        return _FF_VALUES_CACHE.get("data")
    try:
        resp = requests.get(f"{base}/factors/values",
                            params={"symbols": ",".join(symbols)},
                            headers=_headers(), timeout=30)
        if resp.status_code != 200:
            logger.debug("ml-service /factors/values → %s", resp.status_code)
            return None
        data = (resp.json() or {}).get("data")
        if not isinstance(data, dict) or not data.get("values"):
            return None
        _FF_VALUES_CACHE = {"key": cache_key, "ts": now, "data": data}
        return data
    except requests.RequestException as exc:
        logger.debug("ml-service /factors/values request failed: %s", exc)
        return None
    except Exception as exc:
        logger.debug("ml-service /factors/values parse failed: %s", exc)
        return None


# GX-1.5: 图谱因子（ml-service graph 引擎，60s TTL，fail-silent）
_GRAPH_FACTORS_CACHE: dict = {}
_GRAPH_FACTORS_CACHE_TTL_S = 60
_GRAPH_CATALOG_CACHE: dict = {}
_GRAPH_CATALOG_CACHE_TTL_S = 60
_GRAPH_EDGES_CACHE: dict = {}
_GRAPH_EDGES_CACHE_TTL_S = 300


def fetch_graph_factors(symbols: list[str]) -> dict | None:
    """拉取 ml-service 图谱因子当前值（/ml/graph_factors，GX-1.5）。

    返回 {"updated_at", "values": {symbol: {factor_key: value}}} 或 None（fail-silent）。
    60s TTL 缓存，**按 symbols 集合键控**（不同请求的标的池不同，值必须对应）。
    data-service /factors/current 将其透传为 response["graph"]。
    """
    global _GRAPH_FACTORS_CACHE  # 函数内赋值 → 需显式 global
    base = (ML_SERVICE_URL or "").strip().rstrip("/")
    if not base or not symbols:
        return None
    cache_key = ",".join(sorted(symbols))
    now = time.time()
    if (_GRAPH_FACTORS_CACHE.get("key") == cache_key
            and now - _GRAPH_FACTORS_CACHE.get("ts", 0) < _GRAPH_FACTORS_CACHE_TTL_S):
        return _GRAPH_FACTORS_CACHE.get("data")
    try:
        resp = requests.get(f"{base}/ml/graph_factors",
                            params={"symbols": ",".join(symbols)},
                            headers=_headers(), timeout=30)
        if resp.status_code != 200:
            logger.debug("ml-service /ml/graph_factors → %s", resp.status_code)
            return None
        data = (resp.json() or {}).get("data")
        if not isinstance(data, dict) or not data.get("values"):
            return None
        _GRAPH_FACTORS_CACHE = {"key": cache_key, "ts": now, "data": data}
        return data
    except requests.RequestException as exc:
        logger.debug("ml-service /ml/graph_factors request failed: %s", exc)
        return None
    except Exception as exc:
        logger.debug("ml-service /ml/graph_factors parse failed: %s", exc)
        return None


def fetch_graph_catalog() -> list | None:
    """拉取 ml-service 图谱因子目录（/ml/graph/catalog，GX-1.5）。

    返回 [{id, name, category, type, range, description, unit}, ...] 或 None（fail-silent）。
    60s TTL 缓存（catalog 低频变化）。data-service /factors/current 将其并入
    response["graph"]["catalog"]，客户端免维护图谱因子清单。
    """
    global _GRAPH_CATALOG_CACHE  # 函数内赋值 → 需显式 global
    base = (ML_SERVICE_URL or "").strip().rstrip("/")
    if not base:
        return None
    now = time.time()
    if _GRAPH_CATALOG_CACHE and now - _GRAPH_CATALOG_CACHE.get("ts", 0) < _GRAPH_CATALOG_CACHE_TTL_S:
        return _GRAPH_CATALOG_CACHE.get("data")
    try:
        resp = requests.get(f"{base}/ml/graph/catalog", headers=_headers(), timeout=10)
        if resp.status_code != 200:
            logger.debug("ml-service /ml/graph/catalog → %s", resp.status_code)
            return None
        data = (resp.json() or {}).get("data")
        if not isinstance(data, list) or not data:
            return None
        _GRAPH_CATALOG_CACHE = {"ts": now, "data": data}
        return data
    except requests.RequestException as exc:
        logger.debug("ml-service /ml/graph/catalog request failed: %s", exc)
        return None
    except Exception as exc:
        logger.debug("ml-service /ml/graph/catalog parse failed: %s", exc)
        return None


def fetch_graph_edges(symbols: list[str] | None = None, limit: int = 300) -> dict | None:
    """拉取 ml-service 相关性图边表（/ml/graph/edges，REQ-G1）。

    返回 {"updated_at", "window", "min_abs_corr", "nodes": [...], "edges": [...]}
    或 None（fail-silent）。300s TTL 缓存，**按 symbols 集合键控**。
    data-service /factors/graph/edges 将其透传给 B 端（AIHunter 图谱展示）。
    """
    global _GRAPH_EDGES_CACHE  # 函数内赋值 → 需显式 global
    base = (ML_SERVICE_URL or "").strip().rstrip("/")
    if not base:
        return None
    cache_key = ",".join(sorted(symbols)) if symbols else "_all"
    now = time.time()
    if (_GRAPH_EDGES_CACHE.get("key") == cache_key
            and now - _GRAPH_EDGES_CACHE.get("ts", 0) < _GRAPH_EDGES_CACHE_TTL_S):
        return _GRAPH_EDGES_CACHE.get("data")
    try:
        params: dict = {"limit": limit}
        if symbols:
            params["symbols"] = ",".join(symbols)
        resp = requests.get(f"{base}/ml/graph/edges",
                            params=params, headers=_headers(), timeout=30)
        if resp.status_code != 200:
            logger.debug("ml-service /ml/graph/edges → %s", resp.status_code)
            return None
        data = (resp.json() or {}).get("data")
        if not isinstance(data, dict) or not data.get("edges"):
            return None
        _GRAPH_EDGES_CACHE = {"key": cache_key, "ts": now, "data": data}
        return data
    except requests.RequestException as exc:
        logger.debug("ml-service /ml/graph/edges request failed: %s", exc)
        return None
    except Exception as exc:
        logger.debug("ml-service /ml/graph/edges parse failed: %s", exc)
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


# ── RAGservicer 语义图谱因子（GF-3 统一入口，60s TTL，fail-silent）──
# B 端统一走 data-service /factors/graph（dx_* key）；data-service 内部以
# ragservicer 服务 key 逐 symbol 调用 ragservicer /api/v1/factors/graph，
# B 端无需再持有 ragservicer key（双轨收敛为单入口单 key）。
_RAG_GRAPH_FACTORS_CACHE: dict = {}
_RAG_GRAPH_FACTORS_CACHE_TTL_S = 60


def fetch_rag_graph_factors(symbols: list[str]) -> dict | None:
    """拉取 ragservicer 语义图谱因子（/api/v1/factors/graph，GF-3）。

    ragservicer 端点单 symbol 查询，这里逐 symbol 并行组装为
    {"updated_at", "values": {symbol: {factor_key: value}}} 或 None（fail-silent）。
    60s TTL 缓存，按 symbols 集合键控。data-service /factors/graph 透传。
    """
    global _RAG_GRAPH_FACTORS_CACHE  # 函数内赋值 → 需显式 global
    base = (RAGSERVICER_BASE_URL or "").strip().rstrip("/")
    if not base or not RAGSERVICER_SERVICE_KEY or not symbols:
        return None
    cache_key = ",".join(sorted(symbols))
    now = time.time()
    if (_RAG_GRAPH_FACTORS_CACHE.get("key") == cache_key
            and now - _RAG_GRAPH_FACTORS_CACHE.get("ts", 0) < _RAG_GRAPH_FACTORS_CACHE_TTL_S):
        return _RAG_GRAPH_FACTORS_CACHE.get("data")
    try:
        headers = {"Authorization": f"Bearer {RAGSERVICER_SERVICE_KEY}"}
        values: dict = {}
        updated_at = 0
        for sym in symbols:
            try:
                resp = requests.get(
                    f"{base}/api/v1/factors/graph",
                    params={"symbol": sym},
                    headers=headers, timeout=15,
                )
                if resp.status_code != 200:
                    logger.debug("ragservicer /factors/graph %s → %s", sym, resp.status_code)
                    continue
                payload = (resp.json() or {}).get("data")
                if not isinstance(payload, dict):
                    continue
                # 数值因子（剔除 top_entities/events 等附加结构），与 catalog 对齐
                values[sym] = {k: v for k, v in payload.items()
                               if isinstance(v, (int, float)) and k not in ("ts", "updated_at")}
                if payload.get("ts"):
                    updated_at = max(updated_at, int(payload["ts"]))
            except requests.RequestException as exc:
                logger.debug("ragservicer /factors/graph %s request failed: %s", sym, exc)
            except Exception as exc:
                logger.debug("ragservicer /factors/graph %s parse failed: %s", sym, exc)
        if not values:
            return None
        data = {"updated_at": updated_at, "values": values}
        _RAG_GRAPH_FACTORS_CACHE = {"key": cache_key, "ts": now, "data": data}
        return data
    except Exception as exc:
        logger.debug("ragservicer graph factors failed: %s", exc)
        return None


_RAG_GRAPH_CATALOG_CACHE: dict = {}
_RAG_GRAPH_CATALOG_CACHE_TTL_S = 300


def fetch_rag_graph_catalog() -> list | None:
    """拉取 ragservicer 图谱因子目录（/api/v1/factors/catalog，GF-4）。

    返回 [{id, name, category, type, range, description, unit}, ...] 或 None（fail-silent）。
    300s TTL 缓存（catalog 低频变化）。data-service /factors/graph 并入 meta。
    """
    global _RAG_GRAPH_CATALOG_CACHE  # 函数内赋值 → 需显式 global
    base = (RAGSERVICER_BASE_URL or "").strip().rstrip("/")
    if not base or not RAGSERVICER_SERVICE_KEY:
        return None
    now = time.time()
    if _RAG_GRAPH_CATALOG_CACHE and now - _RAG_GRAPH_CATALOG_CACHE.get("ts", 0) < _RAG_GRAPH_CATALOG_CACHE_TTL_S:
        return _RAG_GRAPH_CATALOG_CACHE.get("data")
    try:
        resp = requests.get(
            f"{base}/api/v1/factors/catalog",
            headers={"Authorization": f"Bearer {RAGSERVICER_SERVICE_KEY}"},
            timeout=10,
        )
        if resp.status_code != 200:
            logger.debug("ragservicer /factors/catalog → %s", resp.status_code)
            return None
        data = (resp.json() or {}).get("data", {}).get("factors")
        if not isinstance(data, list) or not data:
            return None
        _RAG_GRAPH_CATALOG_CACHE = {"ts": now, "data": data}
        return data
    except requests.RequestException as exc:
        logger.debug("ragservicer /factors/catalog request failed: %s", exc)
        return None
    except Exception as exc:
        logger.debug("ragservicer /factors/catalog parse failed: %s", exc)
        return None
