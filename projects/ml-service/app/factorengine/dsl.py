"""因子公式 DSL（需求6 FF-5：LLM 生成因子的受限求值器）。

设计目标：LLM 生成 → 新因子公式（超越内置 4 模板），同时保证：
  - 安全：AST 白名单（只允许 df 现有列 + pandas 向量化方法 + numpy 白名单函数），
    禁止任意代码执行 / 下标 / 字面量集合 / 属性链，天然防注入与 DoS。
  - 可控：无慢代码（白名单全是 pandas 向量化算子，杜绝嵌套循环 O(n²)）。
  - 可复算：公式字符串即因子定义，可存 catalog、可追溯、可复算。

语法示例（列名 = df 现有列，方法 = 白名单）：
  close.pct_change(20).rolling(60).std() / close
  (close - close.rolling(20).mean()) / close
  close.pct_change().ewm(span=20).mean() - close.pct_change().ewm(span=60).mean()
  (high - low) / close
"""
from __future__ import annotations

import ast
import hashlib
import logging
import threading
from typing import Any, Optional

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)


class DslError(Exception):
    """公式非法（语法/白名单/参数错误）。"""


# ── 白名单 ─────────────────────────────────────────────────

# pandas Series 向量化方法（含 rolling/ewm 返回对象上可用的同名方法）
_ALLOWED_METHODS: frozenset[str] = frozenset({
    "abs", "pct_change", "diff", "shift", "std", "mean", "max", "min",
    "sum", "prod", "skew", "kurt", "rank", "quantile", "fillna", "clip",
    "rolling", "ewm",
})

# numpy 白名单函数（单/双参，均向量化）
_NP_FUNCS: dict[str, Any] = {
    "abs": np.abs, "log": np.log, "exp": np.exp, "sqrt": np.sqrt,
    "sign": np.sign, "maximum": np.maximum, "minimum": np.minimum,
}

_MAX_DEPTH = 64  # 表达式深度护栏（防深度嵌套 DoS）
_MAX_FORMULA_LEN = 512


# ── 编译缓存 ────────────────────────────────────────────────

_CACHE: dict[str, tuple[ast.Expression, tuple[str, ...]]] = {}
_CACHE_LOCK = threading.Lock()


def _parse_cached(formula: str) -> tuple[ast.Expression, tuple[str, ...]]:
    """解析并缓存：返回 (AST, 列依赖)；非法抛 DslError。"""
    if len(formula) > _MAX_FORMULA_LEN:
        raise DslError(f"公式过长（>{_MAX_FORMULA_LEN}）")
    with _CACHE_LOCK:
        hit = _CACHE.get(formula)
    if hit is not None:
        return hit
    try:
        tree = ast.parse(formula, mode="eval")
    except SyntaxError as exc:
        raise DslError(f"公式语法错误: {exc}") from exc
    needs = _extract_needs(tree)
    if _depth(tree) > _MAX_DEPTH:
        raise DslError(f"公式嵌套过深（>{_MAX_DEPTH}）")
    with _CACHE_LOCK:
        _CACHE[formula] = (tree, needs)
    return tree, needs


def _depth(node: ast.AST) -> int:
    if not hasattr(node, "children") and not list(ast.iter_child_nodes(node)):
        return 1
    return 1 + max((_depth(c) for c in ast.iter_child_nodes(node)), default=0)


def _extract_needs(tree: ast.AST) -> tuple[str, ...]:
    """收集公式引用的列名（Name 节点，去重保序）。

    仅收集作为值使用的列（close/high/...）；numpy 函数名（abs/log/...）不是列。
    """
    cols: list[str] = []

    class _V(ast.NodeVisitor):
        def visit_Call(self, node: ast.Call) -> None:
            # 函数名（func 为 Name，如 abs/log）不收集；方法调用（Attribute）的
            # value 部分（如 close.pct_change() 的 close）递归收集
            if not isinstance(node.func, ast.Name):
                self.visit(node.func)
            for a in node.args:
                self.visit(a)
            for kw in node.keywords:
                self.visit(kw.value)

        def visit_Name(self, node: ast.Name) -> None:
            if node.id not in cols:
                cols.append(node.id)

    _V().visit(tree)
    return tuple(cols)


# ── 白名单校验（静态，仅列存在性外其余全量拒绝） ─────────────

def _check_node(node: ast.AST, available: set[str] | None) -> None:
    """递归白名单校验（不执行）；available=None 时跳过列存在性检查。"""
    t = type(node)
    if t is ast.Expression:
        _check_node(node.body, available)
        return
    if t is ast.Constant:
        if node.value is None or isinstance(node.value, (bool, int, float)):
            return
        raise DslError(f"非法常量: {node.value!r}（仅数字/None/布尔）")
    if t is ast.Name:
        if available is not None and node.id not in available:
            raise DslError(f"未知列: {node.id}（可用列: {sorted(available)[:12]}）")
        return
    if t is ast.BinOp:
        # 运算符节点（op）不是表达式，只检查左右操作数
        _check_node(node.left, available)
        _check_node(node.right, available)
        return
    if t is ast.UnaryOp:
        _check_node(node.operand, available)
        return
    if t is ast.Compare:
        _check_node(node.left, available)
        for c in node.comparators:
            _check_node(c, available)
        return
    if t is ast.BoolOp:
        raise DslError("禁止布尔组合（and/or，因子公式无此需求，攻击面最小化）")
    if t is ast.Call:
        func = node.func
        if isinstance(func, ast.Name):
            if func.id not in _NP_FUNCS:
                raise DslError(f"禁止函数: {func.id}()（白名单: {sorted(_NP_FUNCS)}）")
            if len(node.args) > 2:
                raise DslError(f"{func.id}() 至多 2 个参数")
            if node.keywords:
                raise DslError("numpy 函数不支持关键字参数")
            for a in node.args:
                _check_node(a, available)
            return
        if isinstance(func, ast.Attribute):
            if func.attr not in _ALLOWED_METHODS:
                raise DslError(f"禁止方法: {func.attr}（白名单见 dsl.py）")
            _check_node(func.value, available)
            for a in node.args:
                _check_node(a, available)
            for kw in node.keywords:
                _check_node(kw.value, available)
            return
        raise DslError("仅支持白名单函数/方法调用")
    if t is ast.Attribute:
        raise DslError(f"禁止裸属性访问: {ast.unparse(node)[:60]}")
    raise DslError(f"不支持的表达式节点: {t.__name__}")


# ── 求值 ───────────────────────────────────────────────────

def _int_literal(node: ast.AST, name: str, min_v: int, default: Optional[int] = None) -> Optional[int]:
    """正整数字面量参数（rolling 窗口等）；非字面量拒绝。"""
    if node is None:
        return default
    if isinstance(node, ast.Constant) and isinstance(node.value, int) \
            and not isinstance(node.value, bool):
        if node.value < min_v:
            raise DslError(f"{name} 需 ≥{min_v}（got {node.value}）")
        return node.value
    raise DslError(f"{name} 必须为正整数字面量（防动态窗口）")


def _float_literal(node: ast.AST, name: str) -> float:
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)) \
            and not isinstance(node.value, bool):
        return float(node.value)
    raise DslError(f"{name} 必须为数字字面量")


def _call_method(method: str, obj: Any, node: ast.Call, df: pd.DataFrame) -> Any:
    """白名单方法调用（含 rolling/ewm 构造与参数校验）。"""
    if method == "rolling":
        if not node.args:
            raise DslError("rolling() 缺少 window 参数")
        w = _int_literal(node.args[0], "window", 1)
        kwargs: dict[str, Any] = {}
        for kw in node.keywords:
            if kw.arg == "min_periods":
                kwargs["min_periods"] = _int_literal(kw.value, "min_periods", 1)
            else:
                raise DslError(f"rolling 不支持参数 {kw.arg}")
        return obj.rolling(window=w, **kwargs)
    if method == "ewm":
        kwargs = {}
        if node.args:
            raise DslError("ewm() 需关键字参数（span=/halflife=/alpha=）")
        for kw in node.keywords:
            if kw.arg in ("span", "halflife"):
                kwargs[kw.arg] = _int_literal(kw.value, kw.arg, 1)
            elif kw.arg == "alpha":
                v = _float_literal(kw.value, "alpha")
                if not (0 < v <= 1):
                    raise DslError("alpha 需在 (0,1]")
                kwargs["alpha"] = v
            elif kw.arg == "min_periods":
                kwargs["min_periods"] = _int_literal(kw.value, "min_periods", 1)
            else:
                raise DslError(f"ewm 不支持参数 {kw.arg}")
        if not kwargs:
            raise DslError("ewm() 需至少一个参数（span/halflife/alpha）")
        return obj.ewm(**kwargs)
    if method == "pct_change":
        periods = _int_literal(node.args[0], "periods", 1) if node.args else 1
        return obj.pct_change(periods=periods)
    if method == "shift":
        periods = _int_literal(node.args[0], "periods", 1) if node.args else 1
        return obj.shift(periods=periods)
    if method == "diff":
        periods = _int_literal(node.args[0], "periods", 1) if node.args else 1
        return obj.diff(periods=periods)
    if method == "quantile":
        if not node.args:
            raise DslError("quantile() 缺少 q 参数")
        q = _float_literal(node.args[0], "q")
        if not (0 <= q <= 1):
            raise DslError("quantile 的 q 需在 [0,1]")
        return obj.quantile(q)
    if method == "rank":
        pct = False
        if node.args:
            if isinstance(node.args[0], ast.Constant) and isinstance(node.args[0].value, bool):
                pct = node.args[0].value
            else:
                raise DslError("rank() 参数需为布尔字面量")
        return obj.rank(pct=pct)
    if method == "fillna":
        if not node.args:
            raise DslError("fillna() 缺少 value")
        return obj.fillna(_float_literal(node.args[0], "value"))
    if method == "clip":
        lower = upper = None
        for kw in node.keywords:
            if kw.arg == "lower":
                lower = _float_literal(kw.value, "lower")
            elif kw.arg == "upper":
                upper = _float_literal(kw.value, "upper")
            else:
                raise DslError(f"clip 不支持参数 {kw.arg}")
        if node.args:
            raise DslError("clip() 需关键字参数（lower=/upper=）")
        return obj.clip(lower=lower, upper=upper)
    # 无参/白名单内方法（std/mean/max/min/sum/prod/skew/kurt/abs）
    if node.args or node.keywords:
        if method == "std" and len(node.args) <= 1 and not node.keywords:
            ddof = _int_literal(node.args[0], "ddof", 0)
            return obj.std(ddof=ddof)
        raise DslError(f"{method}() 不支持参数")
    return getattr(obj, method)()


def _eval(node: ast.AST, df: pd.DataFrame, depth: int = 0) -> Any:
    if depth > _MAX_DEPTH:
        raise DslError("表达式嵌套过深")
    t = type(node)
    if t is ast.Expression:
        return _eval(node.body, df, depth)
    if t is ast.Constant:
        return node.value
    if t is ast.Name:
        return df[node.id]
    if t is ast.BinOp:
        left = _eval(node.left, df, depth + 1)
        right = _eval(node.right, df, depth + 1)
        op = type(node.op)
        if op is ast.Add:
            return left + right
        if op is ast.Sub:
            return left - right
        if op is ast.Mult:
            return left * right
        if op is ast.Div:
            return left / right
        if op is ast.FloorDiv:
            return left // right
        if op is ast.Mod:
            return left % right
        if op is ast.Pow:
            return left ** right
        if op is ast.BitAnd:
            return left & right
        if op is ast.BitOr:
            return left | right
        if op is ast.BitXor:
            return left ^ right
        raise DslError(f"禁止运算符: {op.__name__}")
    if t is ast.UnaryOp:
        v = _eval(node.operand, df, depth + 1)
        if type(node.op) is ast.USub:
            return -v
        if type(node.op) is ast.UAdd:
            return +v
        if type(node.op) is ast.Not:
            return ~v
        if type(node.op) is ast.Invert:
            return ~v
        raise DslError(f"禁止一元运算: {type(node.op).__name__}")
    if t is ast.Compare:
        left = _eval(node.left, df, depth + 1)
        out = None
        for op, comp in zip(node.ops, node.comparators):
            right = _eval(comp, df, depth + 1)
            op_t = type(op)
            if op_t is ast.Gt:
                cur = left > right
            elif op_t is ast.GtE:
                cur = left >= right
            elif op_t is ast.Lt:
                cur = left < right
            elif op_t is ast.LtE:
                cur = left <= right
            elif op_t is ast.Eq:
                cur = left == right
            elif op_t is ast.NotEq:
                cur = left != right
            else:
                raise DslError(f"禁止比较: {op_t.__name__}")
            out = cur if out is None else (out & cur)
            left = right
        return out
    if t is ast.Call:
        func = node.func
        if isinstance(func, ast.Name):
            fn = _NP_FUNCS.get(func.id)
            if fn is None:
                raise DslError(f"禁止函数: {func.id}()")
            args = [_eval(a, df, depth + 1) for a in node.args]
            return fn(*args)
        if isinstance(func, ast.Attribute):
            if func.attr not in _ALLOWED_METHODS:
                raise DslError(f"禁止方法: {func.attr}")
            obj = _eval(func.value, df, depth + 1)
            return _call_method(func.attr, obj, node, df)
        raise DslError("仅支持白名单函数/方法调用")
    raise DslError(f"不支持的表达式节点: {t.__name__}")


# ── 公开 API ───────────────────────────────────────────────

def formula_key(formula: str) -> str:
    """公式 → 稳定因子 key（同公式同 key，天然去重）。"""
    return "dsl_" + hashlib.sha1(formula.encode("utf-8")).hexdigest()[:8]


def validate_formula(formula: str, available_cols: set[str] | None = None) -> tuple[str, ...]:
    """校验公式并返回列依赖；非法抛 DslError。"""
    tree, needs = _parse_cached(formula)
    _check_node(tree, available_cols)
    return needs


def eval_formula(formula: str, df: pd.DataFrame) -> pd.Series:
    """求值公式 → pd.Series（index 与 df 对齐）。"""
    tree, needs = _parse_cached(formula)
    for col in needs:
        if col not in df.columns:
            raise DslError(f"缺失列: {col}（用于公式 {formula}）")
    out = _eval(tree, df)
    if not isinstance(out, pd.Series):
        raise DslError(f"公式结果非序列: {type(out).__name__}（{formula}）")
    return out.astype(float)
