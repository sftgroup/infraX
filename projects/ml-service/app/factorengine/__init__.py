"""因子工厂内核（需求4 R4-4 / 需求5 R5-1 / 需求6 FF-1~FF-2）。

- factors：因子注册表（模板 + 固定因子，新因子零复制接入）
- engine：注册表驱动特征矩阵（tree_models.build_features 兼容）
- pool：factor_pool 候选展开（模板 × 参数网格 → 100+）
- eval：factor_eval（IC/ICIR/单调性/独立度）+ 选因
- job / jobs：挖掘任务 spec + 状态机（R5-1/R5-2，见对应模块）
"""
from app.factorengine.factors import (
    FACTOR_REGISTRY,
    TEMPLATE_FUNCS,
    all_keys,
    compute_factor,
    factor_needs,
    register_factor,
    register_template,
)
from app.factorengine.engine import (
    LEGACY_FEATURE_COLUMNS,
    build_feature_matrix,
    compute_factors,
)
from app.factorengine.pool import (
    FactorCandidate,
    expand_factor_pool,
    filter_pool,
)
from app.factorengine.eval import (
    FactorEvalResult,
    evaluate_factor,
    select_factors,
)

__all__ = [
    "FACTOR_REGISTRY", "TEMPLATE_FUNCS", "all_keys", "compute_factor",
    "factor_needs", "register_factor", "register_template",
    "LEGACY_FEATURE_COLUMNS", "build_feature_matrix", "compute_factors",
    "FactorCandidate", "expand_factor_pool", "filter_pool",
    "FactorEvalResult", "evaluate_factor", "select_factors",
]
