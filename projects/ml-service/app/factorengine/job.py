"""挖掘任务 spec（需求5 R5-1.1 / R5-1.2）。

preferences（偏好，可缺省）+ constraints（硬限制，默认保守且不可被偏好覆盖）。
未指定项取保守默认；偏好与硬限制冲突时返回冲突提示（不静默截断）。

对齐需求文档：
- preferences：市场类型 / 因子风格 / 投资风格 / 资产池 / 周期
- constraints：因子数量上限 / 资源预算（耗时）/ 标的数 / IC / ICIR≥0.3 /
  独立度 / 单调性 / 黑白名单
"""
from __future__ import annotations

import json
import time
import uuid
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field, model_validator

MarketType = Literal["crypto", "us_stock", "hk_stock", "any"]
FactorStyle = Literal["momentum", "volatility", "trend", "mean_reversion", "any"]
InvestmentStyle = Literal["value", "growth", "momentum", "balanced", "any"]
Timeframe = Literal["1d", "1h"]


class FactorPreferences(BaseModel):
    """偏好（可选；未指定用默认，受硬限制约束）。"""

    market_types: list[MarketType] = ["any"]
    factor_styles: list[FactorStyle] = ["any"]
    investment_style: InvestmentStyle = "balanced"
    asset_pool: list[str] = Field(default_factory=list, description="标的白名单；空=从 data-service /symbols 动态拉取")
    timeframe: Timeframe = "1d"
    horizon: int = Field(default=7, ge=1, le=90, description="预测周期（日）")


class FactorConstraints(BaseModel):
    """硬限制（默认保守值；偏好不可覆盖）。"""

    max_factors: int = Field(default=20, ge=1, le=500)
    max_runtime_min: int = Field(default=60, ge=1, le=720)
    max_targets: int = Field(default=50, ge=1, le=500)
    min_ic: float = Field(default=0.0, ge=-1.0, le=1.0)
    min_icir: float = Field(default=0.3, ge=0.0, le=10.0)
    max_independence: float = Field(default=0.7, ge=0.0, le=1.0, description="与已选因子最大 |corr|")
    require_monotonicity: bool = False
    blacklist_keys: list[str] = Field(default_factory=list)
    whitelist_keys: list[str] = Field(default_factory=list, description="空=不限；非空=仅允许这些因子")


class JobSpec(BaseModel):
    """规范化 job spec（内核唯一输入；LLM/用户仅产出 preferences+constraints）。"""

    preferences: FactorPreferences = FactorPreferences()
    constraints: FactorConstraints = FactorConstraints()
    formulas: list[str] = Field(
        default_factory=list,
        description="LLM/用户指定的 DSL 公式候选（FF-5，与内置池合并评估；非法公式跳过）",
    )

    @model_validator(mode="after")
    def _validate_conflicts(self) -> "JobSpec":
        """偏好 vs 硬限制冲突检测（硬限制优先，冲突显式提示）。"""
        prefs, cons = self.preferences, self.constraints
        issues: list[str] = []
        if prefs.horizon > 30 and cons.max_runtime_min < 30:
            issues.append("horizon>30 与 max_runtime_min<30 冲突（长周期评估耗时长）")
        if cons.whitelist_keys and len(cons.whitelist_keys) > cons.max_factors:
            issues.append("whitelist_keys 数量超过 max_factors")
        if len(self.formulas) > cons.max_factors:
            issues.append(f"formulas 数量({len(self.formulas)})超过 max_factors({cons.max_factors})")
        if issues:
            self._conflict_issues = issues  # type: ignore[attr-defined]
        return self

    @property
    def conflicts(self) -> list[str]:
        return list(getattr(self, "_conflict_issues", []))


def build_spec(preferences: dict[str, Any] | None = None,
               constraints: dict[str, Any] | None = None,
               formulas: list[str] | None = None) -> tuple[JobSpec, list[str]]:
    """生成 job spec（偏好+限制+DSL 公式 → 结构化；冲突显式返回提示）。"""
    prefs = FactorPreferences(**(preferences or {}))
    cons = FactorConstraints(**(constraints or {}))
    spec = JobSpec(preferences=prefs, constraints=cons, formulas=formulas or [])
    return spec, spec.conflicts


def spec_to_dict(spec: JobSpec) -> dict[str, Any]:
    return spec.model_dump()


def new_job_id() -> str:
    return f"ff_{time.strftime('%Y%m%d')}_{uuid.uuid4().hex[:12]}"


def now_ms() -> int:
    return int(time.time() * 1000)
