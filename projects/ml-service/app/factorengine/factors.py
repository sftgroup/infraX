"""因子注册表（需求4 R4-4 / 需求6 FF-1）。

把 tree_models.build_features 的硬编码派生特征收敛为注册表驱动：
- 模板因子（ret_{n} / vol_{n} / mom_{f}_{s} / ma{n}_pct）：注册模板函数 + key 参数解析
- 固定因子（rsi_14 / macd_hist_pct / bb_pos / bb_width / atr_pct / high_low_range）：
  注册 compute 纯函数
新因子接入 = 注册一个模板/固定 compute（零复制，FF-1.2 验收）。

类别（对齐需求文档 L0-L6 分层）：
  L0 动量/反转（ret/mom）    L1 波动率（vol）
  L2 趋势/价格位置（ma_pct）  L3 量价（预留）
  L4 技术指标（rsi/macd/bb/atr）
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Callable

import numpy as np
import pandas as pd

# ── 数据结构 ────────────────────────────────────────────────

# 模板实例 key 解析：模板名 → key 正则 + 参数提取
#   模板 "ret"：key `ret_{n}`            → {"n": int}
#   模板 "vol"：key `vol_{n}`            → {"n": int}
#   模板 "mom"：key `mom_{f}_{s}`        → {"f": int, "s": int}
#   模板 "ma_pct"：key `ma{n}_pct`       → {"n": int}
_TEMPLATE_PATTERNS: dict[str, tuple[str, list[str]]] = {
    "ret": (r"^ret_(\d+)$", ["n"]),
    "vol": (r"^vol_(\d+)$", ["n"]),
    "mom": (r"^mom_(\d+)_(\d+)$", ["f", "s"]),
    "ma_pct": (r"^ma(\d+)_pct$", ["n"]),
}

# 模板函数：compute(df, **params) -> pd.Series（与 df index 对齐）
TEMPLATE_FUNCS: dict[str, Callable[..., pd.Series]] = {}


def register_template(name: str, fn: Callable[..., pd.Series]) -> None:
    """注册模板因子（如 ret：`def _ret(df, n): return df["close"].pct_change(n)`）。"""
    if name in TEMPLATE_FUNCS:
        raise ValueError(f"template already registered: {name}")
    TEMPLATE_FUNCS[name] = fn


@dataclass
class FactorDef:
    key: str
    name: str
    category: str                       # L0..L4
    needs: tuple[str, ...] = ()         # df 必需列（close 恒需，不列出）
    compute: Callable[..., pd.Series] | None = None   # 固定因子
    template: str | None = None         # 模板实例的模板名
    params: dict[str, Any] = field(default_factory=dict)


FACTOR_REGISTRY: dict[str, FactorDef] = {}


def register_factor(key: str, name: str, category: str, needs: tuple[str, ...] = (),
                    compute: Callable[..., pd.Series] | None = None,
                    template: str | None = None, params: dict[str, Any] | None = None) -> None:
    """注册固定因子或模板实例（key 唯一；重复注册抛错防静默覆盖）。"""
    if key in FACTOR_REGISTRY:
        raise ValueError(f"factor already registered: {key}")
    FACTOR_REGISTRY[key] = FactorDef(
        key=key, name=name, category=category, needs=needs,
        compute=compute, template=template, params=params or {},
    )


def _parse_template_key(key: str) -> tuple[str, dict[str, Any]] | None:
    """把模板实例 key 解析回 (模板名, 参数)；非模板 key 返回 None。"""
    for tpl, (pattern, names) in _TEMPLATE_PATTERNS.items():
        m = re.match(pattern, key)
        if m:
            return tpl, {n: int(v) for n, v in zip(names, m.groups())}
    return None


def factor_needs(key: str) -> tuple[str, ...]:
    """因子所需列（供评估/文档展示；模板依赖列返回空，由模板函数内部检查）。"""
    if key in FACTOR_REGISTRY:
        return FACTOR_REGISTRY[key].needs
    return ()


# ── 内置模板（对齐 tree_models.build_features 派生逻辑） ──

def _ret(df: pd.DataFrame, n: int) -> pd.Series:
    return df["close"].astype(float).pct_change(n)


def _vol(df: pd.DataFrame, n: int) -> pd.Series:
    return df["close"].astype(float).pct_change().rolling(n).std()


def _mom(df: pd.DataFrame, f: int, s: int) -> pd.Series:
    close = df["close"].astype(float)
    return close.pct_change(f) - close.pct_change(s)


def _ma_pct(df: pd.DataFrame, n: int) -> pd.Series:
    close = df["close"].astype(float)
    col = f"ma_{n}"
    if col not in df.columns:
        return pd.Series(np.nan, index=df.index)
    return (close - df[col].astype(float)) / close


register_template("ret", _ret)
register_template("vol", _vol)
register_template("mom", _mom)
register_template("ma_pct", _ma_pct)
# 模板依赖列由模板函数内部检查（如 _ma_pct 检查 df 是否含 ma_{n}），
# 注册表不预声明；needs 检查统一走 compute_factor 的注册表/模板分支。


# ── 内置固定因子（对齐 tree_models.build_features） ──────

def _rsi_14(df: pd.DataFrame) -> pd.Series:
    return df["rsi_14"].astype(float)


def _macd_hist_pct(df: pd.DataFrame) -> pd.Series:
    return df["macd_hist"].astype(float) / df["close"].astype(float)


def _bb_pos(df: pd.DataFrame) -> pd.Series:
    close = df["close"].astype(float)
    bbw = df["bb_upper"].astype(float) - df["bb_lower"].astype(float)
    return (close - df["bb_lower"].astype(float)) / bbw.replace(0, np.nan)


def _bb_width(df: pd.DataFrame) -> pd.Series:
    close = df["close"].astype(float)
    bbw = df["bb_upper"].astype(float) - df["bb_lower"].astype(float)
    return bbw / close


def _atr_pct(df: pd.DataFrame) -> pd.Series:
    return df["atr_14"].astype(float) / df["close"].astype(float)


def _high_low_range(df: pd.DataFrame) -> pd.Series:
    close = df["close"].astype(float)
    return (df["high"].astype(float) - df["low"].astype(float)) / close


register_factor("rsi_14", "RSI(14)", "L4", needs=("rsi_14",), compute=_rsi_14)
register_factor("macd_hist_pct", "MACD 直方图占比", "L4", needs=("macd_hist",), compute=_macd_hist_pct)
register_factor("bb_pos", "布林带位置", "L4", needs=("bb_upper", "bb_lower"), compute=_bb_pos)
register_factor("bb_width", "布林带宽度", "L4", needs=("bb_upper", "bb_lower"), compute=_bb_width)
register_factor("atr_pct", "ATR 占比", "L4", needs=("atr_14",), compute=_atr_pct)
register_factor("high_low_range", "高低振幅", "L1", needs=("high", "low"), compute=_high_low_range)


# ── DSL 公式因子（FF-5：LLM 生成的新因子，类别 L5） ────────

def dsl_key_for_formula(formula: str) -> str:
    """公式 → 稳定因子 key（同公式同 key，天然去重）。"""
    from app.factorengine import dsl

    return dsl.formula_key(formula)


def register_dsl_factor(formula: str, available_cols: set[str] | None = None) -> str:
    """注册 LLM 生成的 DSL 公式因子；返回因子 key。

    同公式幂等（已注册直接返回既有 key）；公式非法抛 ValueError。
    available_cols 非空时校验列存在性（服务启动已知数据列时可提前拦截）。
    """
    from app.factorengine import dsl

    key = dsl_key_for_formula(formula)
    if key in FACTOR_REGISTRY:
        return key
    try:
        needs = dsl.validate_formula(formula, available_cols)
    except dsl.DslError as exc:
        raise ValueError(f"DSL 公式非法: {exc}") from exc

    def _compute(df: pd.DataFrame, _f: str = formula) -> pd.Series:
        try:
            return dsl.eval_formula(_f, df)
        except dsl.DslError:
            # 运行时缺列/求值失败 → NaN 序列（与 _ma_pct 缺列行为一致，dropna 后自然过滤）
            return pd.Series(np.nan, index=df.index)

    register_factor(key, f"dsl {formula[:44]}", "L5", needs=needs, compute=_compute)
    return key


# ── 便捷查询 ────────────────────────────────────────────────

def is_template_key(key: str) -> bool:
    return _parse_template_key(key) is not None


def all_keys() -> list[str]:
    """全部已注册 key（固定 + 模板声明示例）。"""
    return sorted(FACTOR_REGISTRY)


def compute_factor(key: str, df: pd.DataFrame) -> pd.Series | None:
    """计算单个因子；df 缺依赖列时返回 None（与 build_features 现状一致：
    技术指标列缺失 → 不产出该因子列）。"""
    if key not in FACTOR_REGISTRY:
        parsed = _parse_template_key(key)
        if parsed is None:
            return None
        tpl, params = parsed
        fn = TEMPLATE_FUNCS.get(tpl)
        if fn is None:
            return None
        return fn(df, **params)
    fd = FACTOR_REGISTRY[key]
    if any(c not in df.columns for c in fd.needs):
        return None
    return fd.compute(df)  # type: ignore[misc]
