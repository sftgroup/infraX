"""Cross-model consensus — 多模型信号共识聚合（确定性规则，无模拟回退）。

设计（见 docs/DATA_MODULE_RAG_PLAN.md §5）：
  - 事实层：tree_predictions / volatility / sentiment 原始信号独立入 RAG 图谱
  - 共识层：本模块在 ml-service（信号源头）用**确定性规则**聚合：
      consensus_score（方向一致度 0~1）/ divergence（方向分歧）/ risk_flag（风险分级）
    → 落 consensus 快照 → injector 文本化 → 注入 RAG（消费方直接引用）

规则（纯函数，可单测）：
  - 方向投票：tree（up=+1 / flat=0 / down=-1）× sentiment（positive=+1 / neutral=0 / negative=-1）
  - consensus_score = 同向投票数 / 有方向投票数（flat/neutral 不参与；仅单一方向信号时为 1.0）
  - divergence = tree 与 sentiment 反向（up↔negative 或 down↔positive）
  - risk_flag：Kronos 高波动 / 高不确定 + 负面情绪 + 分歧 → low / moderate / elevated
"""
from __future__ import annotations

import logging
import time
from typing import Any, Optional

import config
from app import data_client

logger = logging.getLogger(__name__)

# tree 方向 → 方向投票
_TREE_VOTE = {"up": 1.0, "down": -1.0, "flat": 0.0}
# Kronos 波动率档位（风险项）
_VOL_RISK_LEVELS = {"high", "very_high"}
# 风险分级（累计风险项 → 档位）
_RISK_FLAG = {0: "low", 1: "moderate", 2: "elevated"}
_RISK_RANK = {"low": 0, "moderate": 1, "elevated": 2}


def _sentiment_vote(score: float) -> float:
    """情绪分 → 方向投票（±1 / 0 中性）。"""
    if score > 0.1:
        return 1.0
    if score < -0.1:
        return -1.0
    return 0.0


def _kronos_by_symbol(volatility_results: list[dict]) -> dict[str, dict]:
    return {v.get("symbol"): v for v in (volatility_results or []) if v.get("symbol")}


def _tree_by_symbol(tree_payload: Optional[dict]) -> dict[str, dict]:
    preds = (tree_payload or {}).get("predictions") or []
    return {p.get("symbol"): p for p in preds if p.get("symbol")}


def aggregate(
    tree_payload: Optional[dict],
    volatility_results: Optional[list[dict]],
    sentiment: Optional[dict],
) -> Optional[dict]:
    """确定性规则聚合三路信号 → 共识 payload。

    参数:
        tree_payload:      tree_models.predict_payload() 返回（None 表示不可用）
        volatility_results: kronos.predict_all_volatility() 返回（[] 表示不可用）
        sentiment:         {"score": float, "ts": int}（None 表示不可用）

    返回:
        共识 dict 或 None（三路信号全部不可用）。
    """
    if not tree_payload and not volatility_results and not sentiment:
        return None

    tree_map = _tree_by_symbol(tree_payload)
    vol_map = _kronos_by_symbol(volatility_results)
    sentiment_score = (sentiment or {}).get("score")
    sentiment_vote = _sentiment_vote(sentiment_score) if isinstance(sentiment_score, (int, float)) else None

    symbols = sorted(set(tree_map) | set(vol_map))
    per_symbol: list[dict[str, Any]] = []
    consensus_scores: list[float] = []
    risk_levels: list[str] = []
    divergences = 0

    for sym in symbols:
        tree = tree_map.get(sym)
        vol = vol_map.get(sym)
        tree_vote = _TREE_VOTE.get((tree or {}).get("direction")) if tree else None

        # 方向投票：tree + sentiment（flat/neutral 不参与）
        votes = [v for v in (tree_vote, sentiment_vote) if v is not None and v != 0]
        if not votes:
            consensus = None  # 无方向信号（flat + 中性）
        elif len(votes) == 1:
            consensus = 1.0  # 单一方向信号，无分歧可判
        else:
            consensus = 1.0 if votes[0] * votes[1] > 0 else 0.0
        if votes:
            consensus_scores.append(consensus)
        divergence = bool(
            tree_vote and sentiment_vote and tree_vote * sentiment_vote < 0
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
        if divergence:
            risk += 1
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
        per_symbol.append(entry)

    if not per_symbol:
        return None

    avg = round(sum(consensus_scores) / len(consensus_scores), 4) if consensus_scores else None
    market_risk = max(risk_levels, key=lambda r: _RISK_RANK[r]) if risk_levels else "low"

    return {
        "generated_at": int(time.time() * 1000),
        "signals": {
            "tree": bool(tree_payload),
            "volatility": bool(volatility_results),
            "sentiment": sentiment_score is not None,
        },
        "n_symbols": len(per_symbol),
        "avg_consensus_score": avg,
        "market_risk_flag": market_risk,
        "n_divergence": divergences,
        "symbols": per_symbol,
    }


def build_consensus() -> Optional[dict]:
    """主入口：在 ml-service 内现拉三路信号（本地计算）→ 聚合。

    三路信号全部不可用时返回 None（fail-silent，无模拟数据）。
    """
    tree_payload = None
    volatility_results = None
    sentiment = None
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
    return aggregate(tree_payload, volatility_results, sentiment)
