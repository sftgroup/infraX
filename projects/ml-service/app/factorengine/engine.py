"""因子引擎（需求4 R4-4 / 需求6 FF-1）。

注册表驱动的特征矩阵构建：compute_factor + build_feature_matrix。
tree_models.build_features 改为调用本模块（输出列与旧硬编码完全一致，
行为不变回归）。
"""
from __future__ import annotations

from typing import Iterable

import pandas as pd

from app.factorengine.factors import compute_factor

# 旧 build_features 的全部输出列（注册表驱动的默认集合，顺序与旧实现一致）
LEGACY_FEATURE_COLUMNS: list[str] = [
    "ret_1", "ret_3", "ret_5", "ret_10", "ret_20",
    "vol_20", "vol_60", "mom_5_20",
    "rsi_14", "macd_hist_pct", "bb_pos", "bb_width", "atr_pct",
    "ma5_pct", "ma10_pct", "ma20_pct", "high_low_range",
]


def compute_factors(df: pd.DataFrame, keys: Iterable[str]) -> dict[str, pd.Series]:
    """批量计算因子（缺依赖列的因子静默跳过，与旧 build_features 行为一致）。"""
    out: dict[str, pd.Series] = {}
    for key in keys:
        s = compute_factor(key, df)
        if s is not None:
            out[key] = s
    return out


def build_feature_matrix(df: pd.DataFrame, keys: Iterable[str] | None = None) -> pd.DataFrame:
    """注册表驱动的特征矩阵（与 df index 对齐）。

    keys 缺省 = LEGACY_FEATURE_COLUMNS（旧 17 列，回归兼容）。
    技术指标列缺失时对应因子列缺失（不产出 NaN 列），与旧实现一致。
    """
    keys = list(keys) if keys is not None else LEGACY_FEATURE_COLUMNS
    series = compute_factors(df, keys)
    if not series:
        return pd.DataFrame(index=df.index)
    return pd.DataFrame(series, index=df.index)[[k for k in keys if k in series]]
