"""因子工厂内核（需求4 R4-4 / 需求5 R5-1~R5-4 / 需求6 FF-1~FF-4）。

- factors：因子注册表（模板 + 固定因子，新因子零复制接入）
- engine：注册表驱动特征矩阵（tree_models.build_features 兼容）
- pool：factor_pool 候选展开（模板 × 参数网格 → 100+）
- eval：factor_eval（IC/ICIR/单调性/独立度）+ 选因
- job：挖掘任务 spec（偏好 + 硬限制，冲突提示）
- jobs：状态机 + 持久化（SQLite 默认，可配 PG）+ 执行器 + 状态 API
- runner：挖掘执行链路（pool→eval→select→persist）
- catalog：因子目录（登记/状态/激活）+ /factors/current 数据源
- intent：LLM 自然语言 → spec（R5-4）
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
from app.factorengine.job import (
    FactorConstraints,
    FactorPreferences,
    JobSpec,
    build_spec,
)
from app.factorengine.jobs import (
    JobStatus,
    cancel_job,
    get_store,
    job_status,
    list_jobs,
    start_job,
)
from app.factorengine.catalog import get_catalog
from app.factorengine.intent import IntentError, parse_intent

__all__ = [
    "FACTOR_REGISTRY", "TEMPLATE_FUNCS", "all_keys", "compute_factor",
    "factor_needs", "register_factor", "register_template",
    "LEGACY_FEATURE_COLUMNS", "build_feature_matrix", "compute_factors",
    "FactorCandidate", "expand_factor_pool", "filter_pool",
    "FactorEvalResult", "evaluate_factor", "select_factors",
    "FactorConstraints", "FactorPreferences", "JobSpec", "build_spec",
    "JobStatus", "cancel_job", "get_store", "job_status", "list_jobs", "start_job",
    "get_catalog", "IntentError", "parse_intent",
]
