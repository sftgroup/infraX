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


def _active_feature_keys() -> list[str]:
    """默认特征集合 = LEGACY 17 列 + catalog 激活因子（自动闭环 FF-4.3）。

    挖掘任务 passed 因子激活后自动进入模型特征；catalog 不可用时仅 LEGACY。
    compute_factor 不可算的 key（缺依赖列/未注册）由 compute_factors 静默跳过。
    """
    keys = list(LEGACY_FEATURE_COLUMNS)
    try:
        from app.factorengine.catalog import get_catalog

        for k in get_catalog().active_keys():
            if k not in keys:
                keys.append(k)
    except Exception:
        pass  # catalog 不可用 → 仅 LEGACY（fail-open，行为不变）
    return keys


def build_feature_matrix(df: pd.DataFrame, keys: Iterable[str] | None = None) -> pd.DataFrame:
    """注册表驱动的特征矩阵（与 df index 对齐）。

    keys 缺省 = LEGACY 17 列 + catalog 激活因子（自动闭环：新激活因子自动进特征）。
    技术指标列缺失时对应因子列缺失（不产出 NaN 列），与旧实现一致。
    """
    keys = list(keys) if keys is not None else _active_feature_keys()
    series = compute_factors(df, keys)
    if not series:
        return pd.DataFrame(index=df.index)
    return pd.DataFrame(series, index=df.index)[[k for k in keys if k in series]]
