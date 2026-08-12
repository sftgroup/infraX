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
from typing import Any

import numpy as np

import config
from app.providers import chronos_bolt as bolt
from app.providers.base import ModelProvider
from app.providers.kronos import _fetch_klines, get_target_symbols

logger = logging.getLogger(__name__)


# ── 模型单例（懒加载由基类统一管理） ───────────────────────

class MoiraiProvider(ModelProvider):
    """Moirai2Module provider（需求4 R4-1/R4-2）。

    uni2ts 2.x 的 Moirai2Module 走 PyTorchModelHubMixin（参数 map_location，
    非 device_map），故覆写 device_kwargs；Moirai2Forecast 预测 wrapper 按
    target_dim 在 predict_all 中构造（资产数动态）。
    """

    model_key = "moirai"
    enabled_attr = "MOIRAI_ENABLED"

    def device_kwargs(self) -> dict[str, Any]:
        return {"map_location": config.DEVICE}

    def _do_load(self) -> Any:
        from uni2ts.model.moirai2 import Moirai2Module

        module = Moirai2Module.from_pretrained(config.MOIRAI_MODEL, **self.device_kwargs())
        module.eval()
        return module


# ── 主入口 ────────────────────────────────────────────────


def predict_all() -> list[dict[str, Any]]:
    """全部目标资产一批喂入（多变量联动）→ 各资产分位数预测。

    任一资产数据不足时降级为「仅可用资产」；全部不足返回 []。
    """
    module = MoiraiProvider.get()
    if module is None:
        return []

    lookback = config.MOIRAI_CONTEXT
    target_symbols = get_target_symbols()
    closes_map: dict[str, np.ndarray] = {}
    last_close_map: dict[str, float] = {}
    for sym in target_symbols:
        klines = _fetch_klines(sym)
        if len(klines) < lookback:
            logger.warning("Moirai2: %s 历史K线不足（%d < %d）", sym, len(klines), lookback)
            continue
        # 多取 8 根：uni2ts 2.0.0 在输入长度==context_length 时触发空 pad bug
        # （np.full((0,1), value) 广播失败），多喂走 slice 分支规避
        hist = klines[-(lookback + 8):]
        closes_map[sym] = np.asarray([float(b["close"]) for b in hist], dtype=np.float32)
        last_close_map[sym] = float(hist[-1]["close"])
    if not closes_map:
        return []

    order = [s for s in target_symbols if s in closes_map]
    # 多变量输入要求各资产序列等长：统一截断到最短长度
    # （data-service 各符号回填深度不一，np.stack 会因长度不一致抛
    #   "all input arrays must have the same shape"）
    min_len = min(len(v) for v in closes_map.values())
    if min_len < lookback:
        logger.warning("Moirai2: min bars %d < lookback %d", min_len, lookback)
        return []
    for sym in order:
        if len(closes_map[sym]) != min_len:
            closes_map[sym] = closes_map[sym][-min_len:]
    # uni2ts 2.0.0 空 pad bug：输入长度 == context_length 时
    # np.full((0,1), value) 广播失败（could not broadcast ... (0,1)）。
    # 统一截断后 min_len 可能恰等于 lookback → 让 context_length 严格
    # 小于输入长度，走 slice 分支规避。
    context_len = lookback if min_len > lookback else max(1, min_len - 1)
    # (past_time, tgt) —— 与 Moirai2Forecast.predict 输入约定一致
    past_target = np.stack([closes_map[s] for s in order], axis=1)

    from uni2ts.model.moirai2 import Moirai2Forecast

    fc_model = Moirai2Forecast(
        module=module,
        prediction_length=config.MOIRAI_PRED_LEN,
        target_dim=len(order),
        feat_dynamic_real_dim=0,
        past_feat_dynamic_real_dim=0,
        context_length=context_len,
    )
    preds = fc_model.predict(past_target=[past_target])  # (1, n_q, pred_len, tgt)

    q_levels = list(module.quantile_levels)
    idx = {
        0.1: q_levels.index(0.1) if 0.1 in q_levels else 0,
        0.5: q_levels.index(0.5) if 0.5 in q_levels else len(q_levels) // 2,
        0.9: q_levels.index(0.9) if 0.9 in q_levels else len(q_levels) - 1,
    }
    pred_len = config.MOIRAI_PRED_LEN
    results: list[dict[str, Any]] = []
    for i, sym in enumerate(order):
        q10 = np.asarray(preds[0, idx[0.1], :, i])
        q50 = np.asarray(preds[0, idx[0.5], :, i])
        q90 = np.asarray(preds[0, idx[0.9], :, i])
        if len(q10) < pred_len:  # 尾部补齐（罕见）
            q10 = np.pad(q10, (0, pred_len - len(q10)))
            q50 = np.pad(q50, (0, pred_len - len(q50)))
            q90 = np.pad(q90, (0, pred_len - len(q90)))
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
