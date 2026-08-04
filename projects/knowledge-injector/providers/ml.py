"""Kronos-mini 波动率预测 — 预训练模型，无需微调。

⚠️ 占位实现（未接入真实模型前禁止作为生产预测使用）：
  - MODEL_ENABLED=False 时返回**随机模拟数据**，且每项带 simulated=True 标记；
    默认注入列表已移除 ml_predictions，避免模拟数据污染 RAG 知识图谱。
  - 部署真实模型：`pip install kronos-pytorch` 后置 MODEL_ENABLED=True 并实装
    KronosPredictor 调用（见 predict_volatility 内 TODO）。

Kronos-mini 在波动率预测任务上表现扎实（MAE 比基线低 9%），
但价格方向预测仅略高于随机（约 53%），因此本模块仅用于：
  - 波动率水平预测 + 趋势判断
  - 路径离散度 → 市场不确定性（uncertainty）指标

资源占用（CPU 推理）：
  - 内存：~300MB
  - 单次推理：~0.4 秒（120 步预测）
"""
from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger(__name__)

# ═══════════════════════════════════════════════
# 部署后改为 True
# ═══════════════════════════════════════════════
MODEL_ENABLED = False

# 目标资产
_TARGETS = ["BTC", "ETH", "SPY", "QQQ"]


def predict_volatility(symbol: str) -> dict[str, Any] | None:
    """预测资产波动率水平。

    返回:
        {
            "symbol": "BTC",
            "model": "Kronos-mini",
            "volatility_level": "high",      # very_low / low / moderate / high / very_high
            "volatility_score": 0.72,         # 0-1 归一化
            "direction_consensus": 0.53,      # 多路径一致性（0.5=随机, 1=完全一致）
            "uncertainty": "high",             # 市场不确定性（low / moderate / high）
        }

    部署后实现逻辑（占位当前返回模拟数据）：
        1. 从 yfinance 获取最近 512 根 K 线
        2. 用 KronosPredictor 生成多路径预测
        3. 路径离散度 → volatility_score
        4. 多路径一致性 → direction_consensus
    """
    if MODEL_ENABLED:
        # TODO: 实装 Kronos 调用
        # from kronos.model import KronosPredictor, KronosTokenizer
        # predictor = KronosPredictor.from_pretrained("NeoQuasar/Kronos-mini")
        # klines = _fetch_klines(symbol)
        # paths = predictor.predict(klines, num_samples=30)
        # ...
        pass

    # 占位：返回模拟数据（带 simulated=True 标记，严禁作为真实预测消费）
    import random
    logger.warning("Kronos MODEL_ENABLED=False：%s 返回模拟波动率数据（simulated=True）", symbol)
    levels = ("very_low", "low", "moderate", "high", "very_high")
    return {
        "symbol": symbol,
        "model": "Kronos-mini",
        "volatility_level": random.choice(levels),
        "volatility_score": round(random.uniform(0.1, 0.95), 2),
        "direction_consensus": round(random.uniform(0.4, 0.8), 2),
        "uncertainty": random.choice(("low", "moderate", "high")),
        "simulated": True,
    }


def predict_all_volatility() -> list[dict[str, Any]]:
    """预测所有目标资产的波动率。"""
    results = []
    for sym in _TARGETS:
        try:
            pred = predict_volatility(sym)
            if pred:
                results.append(pred)
        except Exception:
            logger.debug("ML volatility predict failed for %s", sym, exc_info=True)
    return results
