"""Cross-model consensus — 多模型信号共识聚合（确定性规则，无模拟回退）。

设计（见 docs/DATA_MODULE_RAG_PLAN.md §5）：
  - 事实层：tree_predictions / volatility / sentiment / bolt / moirai / timesfm
    原始信号独立入 RAG 图谱
  - 共识层：本模块在 ml-service（信号源头）用**确定性规则**聚合：
      consensus_score（方向一致度 0~1）/ divergence（方向分歧）/ risk_flag（风险分级）
    → 落 consensus 快照 → injector 文本化 → 注入 RAG（消费方直接引用）

规则（纯函数，可单测）：
  - 方向投票：tree（up=+1 / flat=0 / down=-1）× sentiment（positive=+1 / neutral=0 / negative=-1）
    × P2 时序模型（bolt / moirai / timesfm，prob_up≥0.55 才投 +1、≤0.45 才投 -1，
    中间置信不足不投票——作为"第二意见"交叉验证）
  - consensus_score = 主导方向票数 / 有方向投票数（单信号=1.0；N 票反向各半=0.5）
  - divergence = 方向票集中同时存在 up 与 down（跨模型方向分歧）
  - risk_flag：Kronos 高波动 / 高不确定 + 负面情绪 + 分歧 + P2 高不确定
    → low / moderate / elevated
"""
from __future__ import annotations

import logging
import os
import time
from typing import Any, Optional

import config
from app import data_client

logger = logging.getLogger(__name__)

# tree 方向 → 方向投票
_TREE_VOTE = {"up": 1.0, "down": -1.0, "flat": 0.0}
# P2 时序模型方向投票置信阈值：prob_up 偏离 0.5 达阈值才投方向票
_P2_PROB_THR = 0.55
# Kronos 波动率档位（风险项）
_VOL_RISK_LEVELS = {"high", "very_high"}
# 风险分级（累计风险项 → 档位）
_RISK_FLAG = {0: "low", 1: "moderate", 2: "elevated"}
_RISK_RANK = {"low": 0, "moderate": 1, "elevated": 2}

# P2 信号源（provider → 结果键名，与 build_consensus 拉取顺序一致）
_P2_SOURCES = ("bolt", "moirai", "timesfm")


def _sentiment_vote(score: float) -> float:
    """情绪分 → 方向投票（±1 / 0 中性）。"""
    if score > 0.1:
        return 1.0
    if score < -0.1:
        return -1.0
    return 0.0


def _p2_vote(pred: Optional[dict]) -> Optional[float]:
    """P2 时序模型方向投票：仅 prob_up 置信方向投 +1/-1，不足阈值返回 None。"""
    prob_up = (pred or {}).get("prob_up")
    if not isinstance(prob_up, (int, float)):
        return None
    if prob_up >= _P2_PROB_THR:
        return 1.0
    if prob_up <= 1 - _P2_PROB_THR:
        return -1.0
    return None


# ── 结果缓存（TTL） ────────────────────────────────────
# 共识聚合会触发 tree 训练判定 + Kronos 全量推理（~200s），
# 不能每次调用都重算。缓存 TTL 内直接返回上次结果；
# data-service collector 30min 拉一次，缓存 25min 保证错峰。
_CACHE_TTL_MS = int(os.getenv("CONSENSUS_CACHE_TTL_SEC", "1500")) * 1000
_cache: Optional[dict] = None
_cache_at_ms = 0


def _cached() -> Optional[dict]:
    global _cache, _cache_at_ms
    if _cache is not None and (time.time() * 1000 - _cache_at_ms) < _CACHE_TTL_MS:
        return _cache
    return None


def _set_cache(payload: Optional[dict]) -> None:
    global _cache, _cache_at_ms
    if payload is None:
        return
    _cache = payload
    _cache_at_ms = int(time.time() * 1000)


def _normalize_symbol(symbol: str) -> str:
    """符号归一化：data-service crypto 用交易所对格式（BTC/USDT），
    Kronos 用裸代号（BTC）。对齐时去掉 /XXX 交易对后缀。"""
    if not symbol:
        return symbol
    return symbol.split("/")[0].strip()


def _kronos_by_symbol(volatility_results: list[dict]) -> dict[str, dict]:
    return {_normalize_symbol(v.get("symbol")): v for v in (volatility_results or []) if v.get("symbol")}


def _tree_by_symbol(tree_payload: Optional[dict]) -> dict[str, dict]:
    preds = (tree_payload or {}).get("predictions") or []
    return {_normalize_symbol(p.get("symbol")): p for p in preds if p.get("symbol")}


def _p2_by_symbol(results: Optional[list[dict]]) -> dict[str, dict]:
    return {_normalize_symbol(v.get("symbol")): v for v in (results or []) if v.get("symbol")}


def _macro_bias(macro_features: Optional[dict]) -> str:
    """宏观环境偏置标签（确定性规则）：risk-off / risk-on / dollar-strength / neutral。"""
    mkt = (macro_features or {}).get("market") or {}
    vix = mkt.get("vix")
    dxy = mkt.get("dxy")
    if vix is not None and vix > 25:
        return "risk-off"
    if vix is not None and vix < 15:
        return "risk-on"
    if dxy is not None and dxy > 104:
        return "dollar-strength"
    return "neutral"


def _macro_risk_penalty(macro_features: Optional[dict]) -> int:
    """宏观环境风险加分（0/1/2）：VIX 高企 + 货币紧缩（Fed 加息 + CPI 上行）。"""
    if not macro_features:
        return 0
    mkt = macro_features.get("market") or {}
    series = macro_features.get("series") or {}
    penalty = 0
    if isinstance(mkt.get("vix"), (int, float)) and mkt["vix"] > 25:
        penalty += 1
    ff_trend = (series.get("Fed Funds Rate") or {}).get("trend")
    cpi_trend = (series.get("CPI") or {}).get("trend")
    if ff_trend == "rising" and cpi_trend == "rising":
        penalty += 1
    return min(penalty, 2)


def aggregate(
    tree_payload: Optional[dict],
    volatility_results: Optional[list[dict]],
    sentiment: Optional[dict],
    bolt_results: Optional[list[dict]] = None,
    moirai_results: Optional[list[dict]] = None,
    timesfm_results: Optional[list[dict]] = None,
    macro_features: Optional[dict] = None,
) -> Optional[dict]:
    """确定性规则聚合六路信号 → 共识 payload。

    参数:
        tree_payload:      tree_models.predict_payload() 返回（None 表示不可用）
        volatility_results: kronos.predict_all_volatility() 返回（[] 表示不可用）
        sentiment:         {"score": float, "ts": int}（None 表示不可用）
        bolt_results:      chronos_bolt.predict_all() 返回（None/[] 表示不可用）
        moirai_results:    moirai2.predict_all() 返回
        timesfm_results:   timesfm25.predict_all() 返回
        macro_features:    macro_features.compute_macro_features() 返回
                          （宏观环境增强：风险修正 + macro_bias + macro_context）

    返回:
        共识 dict 或 None（全部信号不可用）。
    """
    p2_results = {
        "bolt": bolt_results,
        "moirai": moirai_results,
        "timesfm": timesfm_results,
    }
    if not any([tree_payload, volatility_results, sentiment, *p2_results.values()]):
        return None

    tree_map = _tree_by_symbol(tree_payload)
    vol_map = _kronos_by_symbol(volatility_results)
    p2_maps = {name: _p2_by_symbol(results) for name, results in p2_results.items()}
    sentiment_score = (sentiment or {}).get("score")
    sentiment_vote = _sentiment_vote(sentiment_score) if isinstance(sentiment_score, (int, float)) else None
    macro_penalty = _macro_risk_penalty(macro_features)

    symbols = sorted(set(tree_map) | set(vol_map) | set().union(*(p2_maps.values())))
    per_symbol: list[dict[str, Any]] = []
    consensus_scores: list[float] = []
    risk_levels: list[str] = []
    divergences = 0

    for sym in symbols:
        tree = tree_map.get(sym)
        vol = vol_map.get(sym)
        tree_vote = _TREE_VOTE.get((tree or {}).get("direction")) if tree else None

        # 方向投票：tree + sentiment + P2 三模型（flat/中性/低置信不参与）
        votes = [v for v in (
            tree_vote,
            sentiment_vote,
            _p2_vote(p2_maps["bolt"].get(sym)),
            _p2_vote(p2_maps["moirai"].get(sym)),
            _p2_vote(p2_maps["timesfm"].get(sym)),
        ) if v is not None and v != 0]
        if not votes:
            consensus = None  # 无方向信号（flat + 中性 + P2 全部低置信）
        elif len(votes) == 1:
            consensus = 1.0  # 单一方向信号，无分歧可判
        else:
            ups = sum(1 for v in votes if v > 0)
            consensus = max(ups, len(votes) - ups) / len(votes)  # 主导方向占比
        if votes:
            consensus_scores.append(consensus)
        divergence = bool(
            votes and any(v > 0 for v in votes) and any(v < 0 for v in votes)
        )
        if divergence:
            divergences += 1

        # 风险项累计
        risk = 0
        vol_level = (vol or {}).get("volatility_level")
        if vol_level in _VOL_RISK_LEVELS:
            risk += 1
        if (vol or {}).get("uncertainty") == "high":
            risk += 1
        if sentiment_score is not None and sentiment_score < -0.1:
            risk += 1
        if any((p2_maps[name].get(sym) or {}).get("uncertainty") == "high" for name in _P2_SOURCES):
            risk += 1
        if divergence:
            risk += 1
        risk += macro_penalty  # 宏观环境风险修正（VIX 高企 / 货币紧缩）
        risk_flag = _RISK_FLAG.get(min(risk, 2), "low")
        risk_levels.append(risk_flag)

        entry: dict[str, Any] = {
            "symbol": sym,
            "consensus_score": round(consensus, 4) if consensus is not None else None,
            "divergence": divergence,
            "risk_flag": risk_flag,
        }
        if tree:
            entry["tree_direction"] = tree.get("direction")
            entry["tree_prob_up"] = tree.get("prob_up")
            entry["opportunity_score"] = tree.get("opportunity_score")
        if vol:
            entry["kronos_volatility_level"] = vol.get("volatility_level")
            entry["kronos_uncertainty"] = vol.get("uncertainty")
        if sentiment_score is not None:
            entry["sentiment_score"] = round(sentiment_score, 4)
        for name in _P2_SOURCES:
            pred = p2_maps[name].get(sym)
            if pred:
                entry[f"{name}_direction"] = pred.get("direction")
                entry[f"{name}_prob_up"] = pred.get("prob_up")
                entry[f"{name}_uncertainty"] = pred.get("uncertainty")
        per_symbol.append(entry)

    if not per_symbol:
        return None

    avg = round(sum(consensus_scores) / len(consensus_scores), 4) if consensus_scores else None
    market_risk = max(risk_levels, key=lambda r: _RISK_RANK[r]) if risk_levels else "low"

    payload: dict[str, Any] = {
        "generated_at": int(time.time() * 1000),
        "signals": {
            "tree": bool(tree_payload),
            "volatility": bool(volatility_results),
            "sentiment": sentiment_score is not None,
            "bolt": bool(bolt_results),
            "moirai": bool(moirai_results),
            "timesfm": bool(timesfm_results),
        },
        "n_symbols": len(per_symbol),
        "avg_consensus_score": avg,
        "market_risk_flag": market_risk,
        "n_divergence": divergences,
        "symbols": per_symbol,
    }
    if macro_features:
        payload["macro_bias"] = _macro_bias(macro_features)
        payload["macro_context"] = macro_features
    return payload


def build_consensus() -> Optional[dict]:
    """主入口：在 ml-service 内现拉六路信号（本地计算）→ 聚合。

    TTL 缓存（默认 25min）内直接返回上次结果，避免每次调用都触发
    Kronos 全量推理（~60s）与 P2 模型推理（Bolt/Moirai 秒级、
    TimesFM 首次 ~70s）。全部信号不可用时返回 None（fail-silent，
    无模拟数据）。
    """
    cached = _cached()
    if cached is not None:
        return cached
    tree_payload = None
    volatility_results = None
    sentiment = None
    bolt_results = None
    moirai_results = None
    timesfm_results = None
    try:
        from app.analytics import tree_models
        tree_payload = tree_models.predict_payload()
    except Exception as exc:
        logger.debug("consensus tree signal unavailable: %s", exc)
    try:
        from app.providers import kronos
        volatility_results = kronos.predict_all_volatility()
    except Exception as exc:
        logger.debug("consensus volatility signal unavailable: %s", exc)
    try:
        sentiment = data_client.fetch_sentiment_score()
    except Exception as exc:
        logger.debug("consensus sentiment signal unavailable: %s", exc)
    try:
        from app.providers import chronos_bolt
        bolt_results = chronos_bolt.predict_all()
    except Exception as exc:
        logger.debug("consensus bolt signal unavailable: %s", exc)
    try:
        from app.providers import moirai2
        moirai_results = moirai2.predict_all()
    except Exception as exc:
        logger.debug("consensus moirai signal unavailable: %s", exc)
    try:
        from app.providers import timesfm25
        timesfm_results = timesfm25.predict_all()
    except Exception as exc:
        logger.debug("consensus timesfm signal unavailable: %s", exc)
    macro_features = None
    try:
        from app import macro_features as mf
        macro_features = mf.compute_macro_features()
    except Exception as exc:
        logger.debug("consensus macro features unavailable: %s", exc)
    payload = aggregate(
        tree_payload, volatility_results, sentiment,
        bolt_results, moirai_results, timesfm_results,
        macro_features=macro_features,
    )
    _set_cache(payload)
    return payload
