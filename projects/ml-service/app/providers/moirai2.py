"""Moirai 2.0 — 多变量时序基础模型（跨资产联动预测，P2）。

Moirai 2.0（Salesforce，decoder-only，quantile 输出，零样本）：
当前 GIFT-Eval 榜首（MASE），small 版仅 7M 参数，CPU 可推理。

归属：ml-service 推理层。数据经 data_client 走 data-service /bars →
yfinance 回退（与 kronos 同款 _fetch_klines）。

用途：把全部目标资产（BTC/ETH/SPY/QQQ）作为多个 variate **一批喂入**，
模型同时学习/利用跨序列联动关系，输出各资产未来分位数路径 →
  - point（0.5 分位）+ quantiles（0.1/0.5/0.9）
  - direction / prob_up / uncertainty（与 bolt 同款统计）

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

_forecast_model: Any = None
_model_lock = threading.Lock()
_model_failed = False


def _load_model():
    """懒加载 Moirai2Forecast（需 MOIRAI_ENABLED + uni2ts）。"""
    global _forecast_model, _model_failed
    if _forecast_model is not None or _model_failed:
        return _forecast_model
    if not config.MOIRAI_ENABLED:
        return None
    with _model_lock:
        if _forecast_model is not None or _model_failed:
            return _forecast_model
        try:
            from uni2ts.model.moirai2 import Moirai2Forecast, Moirai2Module

            module = Moirai2Module.from_pretrained(
                config.MOIRAI_MODEL, device_map="cpu"
            )
            _forecast_model = Moirai2Forecast(
                module=module,
                prediction_length=config.MOIRAI_PRED_LEN,
                context_length=config.MOIRAI_CONTEXT,
                patch_size=config.MOIRAI_PATCH_SIZE,
                num_samples=1,  # quantile 直接预测，不需采样
            )
            logger.info("Moirai2 model loaded: %s", config.MOIRAI_MODEL)
        except Exception as exc:
            _model_failed = True
            logger.warning("Moirai2 加载失败（真实预测未启用）: %s", exc)
    return _forecast_model


# ── 主入口 ────────────────────────────────────────────────


def predict_all() -> list[dict[str, Any]]:
    """全部目标资产一批喂入（多变量联动）→ 各资产分位数预测。

    任一资产数据不足时降级为「仅可用资产」；全部不足返回 []。
    """
    model = _load_model()
    if model is None:
        return []

    lookback = config.MOIRAI_CONTEXT
    hist_map: dict[str, list[dict]] = {}
    closes_map: dict[str, np.ndarray] = {}
    last_close_map: dict[str, float] = {}
    for sym in _TARGETS:
        klines = _fetch_klines(sym)
        if len(klines) < lookback:
            logger.warning("Moirai2: %s 历史K线不足（%d < %d）", sym, len(klines), lookback)
            continue
        hist = klines[-lookback:]
        hist_map[sym] = hist
        closes_map[sym] = np.asarray([float(b["close"]) for b in hist], dtype=np.float32)
        last_close_map[sym] = float(hist[-1]["close"])
    if not closes_map:
        return []

    # 多变量输入：(variate, time)
    order = [s for s in _TARGETS if s in closes_map]
    past_target = np.stack([closes_map[s] for s in order], axis=0)

    # Moirai2Forecast 输入须带 batch 维（[batch, variate, time]）
    forecasts = model(past_target=[past_target])  # list[gluonts Forecast]
    if not forecasts:
        return []

    results: list[dict[str, Any]] = []
    pred_len = config.MOIRAI_PRED_LEN
    for i, sym in enumerate(order):
        fc = forecasts[0]
        q10 = np.asarray(fc.quantile(0.1))[i] if fc.quantile(0.1) is not None else np.full(pred_len, np.nan)
        q50 = np.asarray(fc.quantile(0.5))[i]
        q90 = np.asarray(fc.quantile(0.9))[i] if fc.quantile(0.9) is not None else np.full(pred_len, np.nan)
        # gluonts quantile 返回 (variate, pred_len)？降维后取该 variate
        last_close = last_close_map[sym]
        stats = bolt._stats_from_paths(q50, q10, q50, q90, last_close)
        if not stats:
            continue
        stats.update({
            "symbol": sym,
            "model": config.MOIRAI_MODEL.split("/")[-1],
            "context": lookback,
            "pred_len": pred_len,
            "last_close": round(last_close, 6),
            "linked_symbols": [s for s in order if s != sym],
        })
        results.append(stats)
    return results
