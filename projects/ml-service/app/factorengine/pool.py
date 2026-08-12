"""factor_pool（需求6 FF-2.1 / 需求5 R5-1.3）。

从模板 × 参数网格展开候选因子池（100+），按偏好过滤后供 factor_eval 评估。
模板 key 解析与 factors.compute_factor 同源（engine 直接可用）。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

# ── 参数网格（可调：池大小/覆盖度平衡） ────────────────────

_PARAM_GRID: dict[str, list[dict[str, Any]]] = {
    "ret": [{"n": n} for n in (1, 3, 5, 10, 20, 60)],
    "vol": [{"n": n} for n in (20, 60)],
    "mom": [{"f": f, "s": s} for f, s in ((5, 20), (10, 30), (20, 60))],
    "ma_pct": [{"n": n} for n in (5, 10, 20, 30, 60)],
}

# 固定因子（技术指标依赖 data-service 供给的列）
_FIXED_KEYS: list[str] = [
    "rsi_14", "macd_hist_pct", "bb_pos", "bb_width", "atr_pct", "high_low_range",
]


@dataclass
class FactorCandidate:
    key: str
    template: str | None      # 模板名或 None（固定因子）
    params: dict[str, Any] = field(default_factory=dict)
    category: str = ""        # L0..L4（候选池元数据，评估/入库用）


_TEMPLATE_CATEGORY: dict[str, str] = {
    "ret": "L0", "mom": "L0", "vol": "L1", "ma_pct": "L2",
}
_FIXED_CATEGORY: dict[str, str] = {
    "rsi_14": "L4", "macd_hist_pct": "L4", "bb_pos": "L4",
    "bb_width": "L4", "atr_pct": "L4", "high_low_range": "L1",
}


def expand_factor_pool() -> list[FactorCandidate]:
    """展开全部候选因子（模板网格 + 固定因子）。"""
    pool: list[FactorCandidate] = []
    for tpl, params_list in _PARAM_GRID.items():
        for params in params_list:
            key = _render_key(tpl, params)
            pool.append(FactorCandidate(
                key=key, template=tpl, params=dict(params),
                category=_TEMPLATE_CATEGORY.get(tpl, ""),
            ))
    for key in _FIXED_KEYS:
        pool.append(FactorCandidate(
            key=key, template=None, params={},
            category=_FIXED_CATEGORY.get(key, ""),
        ))
    return pool


def _render_key(tpl: str, params: dict[str, Any]) -> str:
    """模板 key 渲染（与 factors._parse_template_key 互逆）。"""
    if tpl == "ma_pct":
        return f"ma{params['n']}_pct"
    if tpl == "mom":
        return f"mom_{params['f']}_{params['s']}"
    if tpl in ("ret", "vol"):
        return f"{tpl}_{params['n']}"
    raise ValueError(f"unknown template: {tpl}")


def filter_pool(pool: list[FactorCandidate] | None = None,
                categories: list[str] | None = None,
                max_factors: int | None = None) -> list[FactorCandidate]:
    """按偏好过滤：类别白名单 + 数量上限（默认全部）。"""
    pool = pool if pool is not None else expand_factor_pool()
    if categories:
        pool = [c for c in pool if c.category in categories]
    if max_factors is not None:
        pool = pool[:max_factors]
    return pool
