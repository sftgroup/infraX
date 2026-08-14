"""因子公式 DSL 单测（FF-5：LLM 生成因子的受限求值器）。

覆盖：合法公式求值、与内置模板一致性、白名单拒绝、key 稳定性、
注册幂等、build_spec formulas 透传与冲突检测。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np
import pandas as pd
import pytest

from app.factorengine import dsl
from app.factorengine.factors import compute_factor, register_dsl_factor, dsl_key_for_formula
from app.factorengine.job import build_spec
from app.factorengine.pool import dsl_candidates, expand_factor_pool


def _df(n=400) -> pd.DataFrame:
    rng = np.random.default_rng(7)
    close = 100 * np.cumprod(1 + rng.normal(0.0005, 0.01, n))
    high = close * (1 + rng.uniform(0, 0.01, n))
    low = close * (1 - rng.uniform(0, 0.01, n))
    return pd.DataFrame(
        {"open": close, "high": high, "low": low, "close": close, "volume": rng.integers(1e6, 9e6, n)},
        index=pd.date_range("2024-01-01", periods=n, freq="D"),
    )


# ── 合法公式求值 ────────────────────────────────────────────

@pytest.mark.parametrize("formula", [
    "close.pct_change(20).rolling(60).std() / close",
    "(close - close.rolling(20).mean()) / close",
    "close.pct_change().ewm(span=20).mean() - close.pct_change().ewm(span=60).mean()",
    "(high - low) / close",
    "close.pct_change().rolling(60).std()",
    "close.pct_change().ewm(alpha=0.1).mean()",
    "close.shift(5) / close - 1",
    "close.diff(3)",
    "close.rank(pct=True)",
    "close.quantile(0.5) / close",
    "abs(close.pct_change())",
    "log(close) - log(close).rolling(20).mean()",
    "sign(close.pct_change()).rolling(10).mean()",
])
def test_valid_formula_eval(formula):
    df = _df()
    s = dsl.eval_formula(formula, df)
    assert isinstance(s, pd.Series)
    assert len(s) == len(df)
    assert pd.api.types.is_float_dtype(s)
    # validate 路径也必须接受（含 BinOp/UnaryOp/Compare 的公式，防白名单校验误拒）
    needs = dsl.validate_formula(formula)
    assert isinstance(needs, tuple) and len(needs) >= 1


def test_formula_matches_builtin_vol60():
    """DSL 波动率公式与内置 vol_60 模板完全一致。"""
    df = _df()
    a = dsl.eval_formula("close.pct_change().rolling(60).std()", df)
    b = compute_factor("vol_60", df)
    assert b is not None
    pd.testing.assert_series_equal(a, b.astype(float), check_names=False)


def test_formula_key_stable_and_deterministic():
    f1 = "close.pct_change(20).rolling(60).std() / close"
    assert dsl_key_for_formula(f1) == dsl_key_for_formula(f1)
    assert dsl_key_for_formula(f1) != dsl_key_for_formula("close.pct_change(21).rolling(60).std() / close")
    assert dsl_key_for_formula(f1).startswith("dsl_")


def test_register_dsl_factor_idempotent():
    f = "close.pct_change().rolling(30).std()"
    k1 = register_dsl_factor(f)
    k2 = register_dsl_factor(f)  # 幂等：同公式返回既有 key，不抛错
    assert k1 == k2
    df = _df()
    s = compute_factor(k1, df)
    assert s is not None and len(s) == len(df)


# ── 白名单拒绝（安全） ──────────────────────────────────────

@pytest.mark.parametrize("formula", [
    "__import__('os')",
    "os.system('ls')",
    "close.__class__",
    "close.to_numpy()",
    "close.cumsum()",                       # 白名单外方法
    "close.fillna('x')",                    # 字符串常量
    "close.rolling(close.size)",            # 动态窗口
    "close['x']",                           # subscript
    "close[::2]",
    "[1,2,3]",                              # 字面量集合
    "lambda x: x",                          # lambda
    "eval('1+1')",
    "close and 1",                          # 布尔组合禁止
    "close > 0 and close < 100",
    "close.pct_change(20) if close.size else 1",  # IfExp
])
def test_invalid_formula_rejected(formula):
    with pytest.raises(dsl.DslError):
        dsl.validate_formula(formula)
    with pytest.raises(dsl.DslError):
        dsl.eval_formula(formula, _df())


def test_unknown_column_rejected():
    # validate 不带列集合时只做语法/白名单校验；求值阶段列存在性兜底
    with pytest.raises(dsl.DslError):
        dsl.eval_formula("unknown_col.pct_change()", _df())
    with pytest.raises(dsl.DslError):
        dsl.validate_formula("unknown_col.pct_change()", set(_df().columns))


def test_negative_window_rejected_at_eval():
    # 参数值校验（负窗口/非法参数）在求值阶段拦截（validate 仅静态白名单）
    with pytest.raises(dsl.DslError):
        dsl.eval_formula("close.rolling(-1)", _df())
    with pytest.raises(dsl.DslError):
        dsl.eval_formula("close.rolling(0)", _df())
    with pytest.raises(dsl.DslError):
        dsl.eval_formula("close.ewm(span=-5).mean()", _df())


def test_result_must_be_series():
    # 常量表达式结果非序列 → 拒绝
    with pytest.raises(dsl.DslError):
        dsl.eval_formula("2 + 2", _df())


# ── pool / job 接线 ─────────────────────────────────────────

def test_dsl_candidates_skip_invalid():
    cands = dsl_candidates(["close.pct_change().rolling(20).std()", "__import__('os')", ""])
    keys = [c.key for c in cands]
    assert len(keys) == 1
    assert keys[0].startswith("dsl_")
    assert cands[0].category == "L5"


def test_pool_merge_dsl_first():
    cands = dsl_candidates(["close.pct_change().rolling(20).std()"])
    assert cands[0].key in [c.key for c in cands + expand_factor_pool()]


def test_dsl_candidates_survive_style_filter():
    """DSL 候选（L5）不被风格过滤掉（FF-5：LLM/用户显式指定的公式必须被评估）。"""
    from app.factorengine.job import build_spec
    from app.factorengine.runner import _candidate_keys

    spec, _ = build_spec(
        preferences={"factor_styles": ["momentum", "volatility"], "asset_pool": ["BTC"]},
        formulas=["close.pct_change().rolling(20).std()"],
    )
    keys = _candidate_keys(spec)
    dsl_keys = [k for k in keys if k.startswith("dsl_")]
    assert len(dsl_keys) == 1
    assert dsl_keys[0] == dsl_key_for_formula("close.pct_change().rolling(20).std()")


def test_build_spec_formulas():
    spec, conflicts = build_spec(
        preferences={"asset_pool": ["BTC"]},
        formulas=["close.pct_change().rolling(20).std()"],
    )
    assert not conflicts
    assert spec.formulas == ["close.pct_change().rolling(20).std()"]
    assert spec.preferences.asset_pool == ["BTC"]


def test_build_spec_formulas_too_many_conflict():
    formulas = [f"close.pct_change().rolling({20 + i}).std()" for i in range(21)]  # 21 > max_factors 20
    spec, conflicts = build_spec(formulas=formulas)
    assert any("formulas" in c for c in conflicts)
