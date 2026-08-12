"""factor_eval（需求6 FF-2.2~2.4 / 需求5 R5-1.4）。

因子评估：IC / ICIR / 分位单调性 / 与已选因子独立度。
- IC：横截面因子值与未来收益的秩相关（Spearman，逐日）
- ICIR：IC 时序均值 / 标准差（因子稳定性）
- 单调性：按因子分位分组的未来收益均值单调性（Q10-Q1 价差方向一致）
- 独立度：与已选因子 |Spearman| 阈值过滤（去冗余）
"""
from __future__ import annotations

import warnings
from dataclasses import dataclass, field
from typing import Any

import numpy as np
import pandas as pd


@dataclass
class FactorEvalResult:
    key: str
    ic: float | None            # 全期平均 IC（Spearman）
    icir: float | None          # IC 均值 / IC 标准差
    ic_std: float | None
    monotonicity: float | None  # Q10 平均收益 - Q1 平均收益（>0 单调向上）
    independence: float | None  # 与已选因子最大 |corr|
    n_days: int = 0
    passed: bool = False        # 是否达标（IC/ICIR/独立度门槛）
    detail: dict[str, Any] = field(default_factory=dict)


def _spearman(a: pd.Series, b: pd.Series) -> float | None:
    mask = a.notna() & b.notna()
    if mask.sum() < 3:
        return None
    x = a[mask].rank()
    y = b[mask].rank()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        return float(np.corrcoef(x, y)[0, 1])


def evaluate_factor(key: str, factor_series: pd.Series,
                    future_ret: pd.Series) -> FactorEvalResult:
    """评估单因子（对齐后的横截面/时序）。

    factor_series / future_ret：按时间对齐的序列（同日 t 的因子值 vs
    t+horizon 收益）。逐日 IC 由 daily IC 序列得到 ICIR。
    """
    df = pd.concat(
        [factor_series.rename("f"), future_ret.rename("r")], axis=1
    ).dropna()
    if len(df) < 30:
        return FactorEvalResult(key=key, ic=None, icir=None, ic_std=None,
                                monotonicity=None, independence=None)

    ic = _spearman(df["f"], df["r"])
    # 逐日 IC（按日分组 → ICIR）
    daily = {}
    if isinstance(df.index, pd.DatetimeIndex):
        for day, g in df.groupby(df.index.normalize()):
            v = _spearman(g["f"], g["r"])
            if v is not None:
                daily[day] = v
    ic_series = pd.Series(daily, dtype=float)
    icir = None
    ic_std = None
    if len(ic_series) >= 3 and ic_series.std() > 0:
        ic_std = float(ic_series.std())
        icir = float(ic_series.mean() / ic_series.std())

    # 分位单调性：按因子分位分组 → 组内未来收益均值
    monotonicity = None
    if df["f"].nunique() >= 10:
        try:
            q = pd.qcut(df["f"].rank(method="first"), 10, labels=False) + 1
            means = df.groupby(q)["r"].mean()
            monotonicity = float(means.iloc[-1] - means.iloc[0])
        except ValueError:
            pass

    return FactorEvalResult(
        key=key, ic=round(ic, 4) if ic is not None else None,
        icir=round(icir, 4) if icir is not None else None,
        ic_std=round(ic_std, 4) if ic_std is not None else None,
        monotonicity=round(monotonicity, 6) if monotonicity is not None else None,
        independence=None, n_days=len(df),
    )


def select_factors(evaluations: list[FactorEvalResult],
                   selected: list[FactorEvalResult] | None = None,
                   ic_thr: float = 0.03, icir_thr: float = 0.3,
                   independence_thr: float = 0.7,
                   top_k: int = 10,
                   factor_series: dict[str, pd.Series] | None = None) -> list[FactorEvalResult]:
    """选因：IC/ICIR 门槛 → 独立度去冗余 → top-K（FF-2.3）。

    selected：已选因子（独立度参照）；factor_series：候选因子原始序列
    （key → Series），提供时独立度实时计算，否则用 detail["corr_map"]。
    返回按 IC 降序的达标列表（passed=True）。
    """
    candidates = [e for e in evaluations
                  if e.ic is not None and abs(e.ic) >= ic_thr]
    if icir_thr is not None:
        candidates = [e for e in candidates
                      if e.icir is not None and abs(e.icir) >= icir_thr]
    candidates.sort(key=lambda e: -abs(e.ic or 0.0))

    selected = selected or []
    out: list[FactorEvalResult] = []
    for e in candidates:
        max_abs = 0.0
        for s in selected:
            c = _pairwise_corr(e, s)
            if c is None and factor_series:
                if e.key in factor_series and s.key in factor_series:
                    c = _spearman(factor_series[e.key], factor_series[s.key])
            if c is not None:
                max_abs = max(max_abs, abs(c))
        e.independence = round(max_abs, 4) if max_abs else None
        if independence_thr is not None and max_abs > independence_thr:
            continue
        e.passed = True
        out.append(e)
        selected.append(e)
        if len(out) >= top_k:
            break
    return out


def _pairwise_corr(a: FactorEvalResult, b: FactorEvalResult) -> float | None:
    """两因子相关系数：评估阶段已缓存于 detail["corr_map"] 时直接取用。"""
    return (a.detail.get("corr_map") or {}).get(b.key)
