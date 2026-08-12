"""Chronos-Bolt — 单变量时序基础模型（快速点预测/概率基线，P2）。

Chronos-Bolt（amazon，T5 patch-based，零样本）：直接多步分位数预测，
比原版 Chronos 快 250×、省内存 20×，CPU 可推理（small 48M 参数）。

归属：ml-service 推理层。数据经 data_client 走 data-service /bars →
yfinance 回退（与 kronos 同款 _fetch_klines，符号别名自动处理）。

用途：对全部目标资产（BTC/ETH/SPY/QQQ）输出 30 日分位数预测 →
  - point（中位数路径）+ quantiles（0.1/0.5/0.9）
  - direction / prob_up（分位数插值近似）/ uncertainty（区间宽度）
作为树模型方向判断的"第二意见"（交叉验证，见共识分层）。

行为约定：
  - 未启用 / 依赖缺失 / 历史 K 线不足时返回 None（**不产生任何模拟数据**）。
  - 懒加载 + 失败置 flag 不重试；服务重启可重载。
"""
from __future__ import annotations

import logging
from typing import Any

import numpy as np

import config
from app.providers.base import ModelProvider
from app.providers.kronos import _fetch_klines, get_target_symbols

logger = logging.getLogger(__name__)


def _parse_quantiles() -> list[float]:
    """BOLT_QUANTILES="0.1,0.5,0.9" → [0.1, 0.5, 0.9]。"""
    out: list[float] = []
    for part in (config.BOLT_QUANTILES or "0.1,0.5,0.9").split(","):
        part = part.strip()
        if not part:
            continue
        try:
            out.append(float(part))
        except ValueError:
            pass
    return out or [0.1, 0.5, 0.9]


# ── 预测器单例（懒加载由基类统一管理） ─────────────────────

class BoltProvider(ModelProvider):
    """Chronos-Bolt pipeline provider（需求4 R4-1/R4-2）。

    device_kwargs 走默认 device_map=DEVICE（GPU 可用时自动用 GPU）。
    """

    model_key = "bolt"
    enabled_attr = "BOLT_ENABLED"

    def _do_load(self) -> Any:
        from chronos import ChronosBoltPipeline

        return ChronosBoltPipeline.from_pretrained(config.BOLT_MODEL, **self.device_kwargs())


# ── 纯函数统计（可单测） ───────────────────────────────────


def _prob_up_from_quantiles(q10_end: float, q50_end: float, q90_end: float, last_close: float) -> float:
    """由期末收益分位数近似 P(ret>0)（确定性插值，0.05~0.95）。

    - 0.1 分位期末仍 > 现价 → 0.95（大概率上行）
    - 0.9 分位期末仍 < 现价 → 0.05（大概率下行）
    - 否则 0 在 [q10, q90] 收益区间中的位置 t（即 P(ret<0)）→
      prob_up = 1 - (0.1 + t*0.8) = 0.9 - t*0.8 ∈ [0.1, 0.9]
    """
    if last_close <= 0:
        return 0.5
    if q10_end > last_close:
        return 0.95
    if q90_end < last_close:
        return 0.05
    r10 = q10_end / last_close - 1.0
    r90 = q90_end / last_close - 1.0
    if r90 <= r10:
        return 0.5
    t = min(1.0, max(0.0, (0.0 - r10) / (r90 - r10)))  # P(ret<0) 比例位置
    return round(0.9 - t * 0.8, 4)


def _uncertainty_level(interval_pct: float) -> str:
    """由 (q90-q10) 期末宽度相对现价的比例分档。"""
    if interval_pct < 0.08:
        return "low"
    if interval_pct < 0.20:
        return "moderate"
    return "high"


def _stats_from_paths(point: np.ndarray, q10: np.ndarray, q50: np.ndarray, q90: np.ndarray, last_close: float) -> dict[str, Any]:
    """由预测路径计算输出统计（纯函数）。

    point: 点预测 close 序列（末段）；q10/q50/q90: 分位 close 序列。
    """
    if last_close <= 0:
        return {}
    p_end = float(point[-1])
    q10_end = float(q10[-1])
    q50_end = float(q50[-1])
    q90_end = float(q90[-1])
    direction = "up" if p_end >= last_close else "down"
    interval = float(q90_end - q10_end)
    return {
        "direction": direction,
        "prob_up": _prob_up_from_quantiles(q10_end, q50_end, q90_end, last_close),
        "uncertainty": _uncertainty_level(interval / last_close),
        "point_forecast": [round(float(x), 6) for x in point],
        "quantiles": {
            "0.1": [round(float(x), 6) for x in q10],
            "0.5": [round(float(x), 6) for x in q50],
            "0.9": [round(float(x), 6) for x in q90],
        },
    }


# ── 主入口 ────────────────────────────────────────────────


def predict_symbol(symbol: str) -> dict[str, Any] | None:
    """Chronos-Bolt 单标的 30 日分位数预测；不可用/数据不足返回 None。"""
    pipeline = BoltProvider.get()
    if pipeline is None:
        return None

    klines = _fetch_klines(symbol)
    lookback = config.BOLT_CONTEXT
    if len(klines) < lookback:
        logger.warning("Chronos-Bolt: %s 历史K线不足（%d < %d）", symbol, len(klines), lookback)
        return None

    hist = klines[-lookback:]
    closes = np.asarray([float(b["close"]) for b in hist], dtype=np.float32)
    last_close = float(hist[-1]["close"])
    pred_len = config.BOLT_PRED_LEN

    import torch
    levels = _parse_quantiles()
    # chronos>=2.x: predict_quantiles(inputs, ...) → (quantiles, mean)
    # quantiles (1, pred_len, n_quantiles)；mean (1, pred_len)
    quantiles_t, point_t = pipeline.predict_quantiles(
        inputs=torch.tensor(closes, dtype=torch.float32),
        prediction_length=pred_len,
        quantile_levels=levels,
    )
    idx = {lv: i for i, lv in enumerate(levels)}
    q10 = quantiles_t[0, :, idx.get(0.1, 0)].numpy()
    q50 = quantiles_t[0, :, idx.get(0.5, 1)].numpy()
    q90 = quantiles_t[0, :, idx.get(0.9, 2)].numpy()
    point = point_t[0].numpy()

    stats = _stats_from_paths(point, q10, q50, q90, last_close)
    if not stats:
        return None
    stats.update({
        "symbol": symbol,
        "model": config.BOLT_MODEL.split("/")[-1],
        "context": lookback,
        "pred_len": pred_len,
        "last_close": round(last_close, 6),
    })
    return stats


def predict_all() -> list[dict[str, Any]]:
    """预测全部目标资产（逐项 fail-silent）。"""
    results: list[dict[str, Any]] = []
    for sym in get_target_symbols():
        try:
            pred = predict_symbol(sym)
            if pred:
                results.append(pred)
        except Exception:
            logger.debug("Chronos-Bolt predict failed for %s", sym, exc_info=True)
    return results
