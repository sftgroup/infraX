"""TimesFM 2.5 — 长上下文时序基础模型（16K 历史点预测 + 置信区间，P2）。

TimesFM 2.5（Google，decoder-only，零样本）：200M 参数，支持 16K
上下文、连续分位数预测（calibrated prediction intervals）。本服务取
200m-pytorch 版（~800MB 权重，CPU 可推理）。

归属：ml-service 推理层。数据经 data_client 走 data-service /bars →
yfinance 回退（与 kronos 同款 _fetch_klines）。

用途：对全部目标资产（BTC/ETH/SPY/QQQ）输出 30 日点预测 + 分位区间 →
  - point（点预测）+ q_min/q_max（分位区间包络）
  - direction（点预测方向）/ prob_up（区间插值近似）/ uncertainty（区间宽度）
长历史（最多 TIMESFM_CONTEXT 根）补充短视窗模型（树模型 7 日）看不到的周期。

行为约定：
  - 未启用 / 依赖缺失 / 历史 K 线不足时返回 None（**不产生任何模拟数据**）。
  - 懒加载 + 失败置 flag 不重试；服务重启可重载。
"""
from __future__ import annotations

import logging
import threading
from typing import Any

import numpy as np

import config
from app.providers import chronos_bolt as bolt
from app.providers.kronos import _fetch_klines, _TARGETS

logger = logging.getLogger(__name__)


# ── 模型单例（懒加载） ─────────────────────────────────────

_model: Any = None
_model_lock = threading.Lock()
_model_failed = False


def _load_model():
    """懒加载 TimesFM 2.5（需 TIMESFM_ENABLED + timesfm[torch]）。"""
    global _model, _model_failed
    if _model is not None or _model_failed:
        return _model
    if not config.TIMESFM_ENABLED:
        return None
    with _model_lock:
        if _model is not None or _model_failed:
            return _model
        try:
            import torch
            import timesfm

            torch.set_float32_matmul_precision("high")
            m = timesfm.TimesFM_2p5_200M_torch.from_pretrained(config.TIMESFM_MODEL)
            m.compile(timesfm.ForecastConfig(
                max_context=config.TIMESFM_CONTEXT,
                max_horizon=config.TIMESFM_PRED_LEN,
                normalize_inputs=True,
                use_continuous_quantile_head=True,
                force_flip_invariance=True,
                fix_quantile_crossing=True,
            ))
            _model = m
            logger.info("TimesFM 2.5 model loaded: %s", config.TIMESFM_MODEL)
        except Exception as exc:
            _model_failed = True
            logger.warning("TimesFM 2.5 加载失败（真实预测未启用）: %s", exc)
    return _model


# ── 主入口 ────────────────────────────────────────────────


def predict_symbol(symbol: str) -> dict[str, Any] | None:
    """TimesFM 单标的点预测 + 分位区间；不可用/数据不足返回 None。"""
    model = _load_model()
    if model is None:
        return None

    klines = _fetch_klines(symbol)
    lookback = config.TIMESFM_CONTEXT
    if len(klines) < lookback:
        logger.warning("TimesFM: %s 历史K线不足（%d < %d）", symbol, len(klines), lookback)
        return None

    hist = klines[-lookback:]
    closes = np.asarray([float(b["close"]) for b in hist], dtype=np.float32)
    last_close = float(hist[-1]["close"])
    pred_len = config.TIMESFM_PRED_LEN

    point_forecast, quantile_forecast = model.forecast(
        horizon=pred_len, inputs=[closes]
    )
    # point: (1, pred_len)；quantile: (1, pred_len, n_quantiles)
    point = np.asarray(point_forecast)[0]
    q = np.asarray(quantile_forecast)[0]  # (pred_len, n_quantiles)
    q_min = q[:, 0]
    q_max = q[:, -1]
    # 分位区间可能不跨中位 → 用 point 近似 q50（区间包络仍独立）
    q50 = point

    stats = bolt._stats_from_paths(q50, q_min, q50, q_max, last_close)
    if not stats:
        return None
    stats["quantiles"] = {"min": [round(float(x), 6) for x in q_min],
                          "max": [round(float(x), 6) for x in q_max]}
    stats.update({
        "symbol": symbol,
        "model": config.TIMESFM_MODEL.split("/")[-1],
        "context": lookback,
        "pred_len": pred_len,
        "last_close": round(last_close, 6),
    })
    return stats


def predict_all() -> list[dict[str, Any]]:
    """预测全部目标资产（逐项 fail-silent）。"""
    results: list[dict[str, Any]] = []
    for sym in _TARGETS:
        try:
            pred = predict_symbol(sym)
            if pred:
                results.append(pred)
        except Exception:
            logger.debug("TimesFM predict failed for %s", sym, exc_info=True)
    return results
