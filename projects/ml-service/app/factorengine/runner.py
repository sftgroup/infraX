"""因子挖掘执行链路（需求6 FF-2.1~2.4 / 需求5 R5-1.3~1.4）。

run_mine(spec)：
  1. 标的池：asset_pool 白名单 或 data-service /symbols 动态拉取
  2. 候选因子：factor_pool 展开 → 偏好过滤（风格类别/黑白名单/数量上限）
  3. 面板构建：每标的 K 线 → factor values + future_ret（h 日收益）堆叠
  4. 评估：IC（Spearman）/ ICIR（逐日）/ 单调性
  5. 选因：IC/ICIR 门槛 + 独立度去冗余 → top-K（factor_eval.select_factors）
  6. 产出：合格因子列表（写 factor_results + catalog 候选，供 FF-3 登记）
"""
from __future__ import annotations

import logging
from typing import Any, Callable, Optional

import numpy as np
import pandas as pd

import config
from app import data_client
from app.factorengine.eval import evaluate_factor, select_factors
from app.factorengine.factors import compute_factor
from app.factorengine.pool import expand_factor_pool, filter_pool
from app.factorengine.job import JobSpec

logger = logging.getLogger(__name__)

ProgressCb = Callable[[str], bool]  # 阶段回调：返回 False 表示应终止（超时/取消）


def _fetch_symbols(spec: JobSpec) -> list[str]:
    """标的池：asset_pool 白名单优先；否则 data-service /symbols 动态拉取。"""
    if spec.preferences.asset_pool:
        return spec.preferences.asset_pool[:spec.constraints.max_targets]
    try:
        syms = data_client.fetch_symbols(
            timeframe=spec.preferences.timeframe,
            min_bars=max(120, config.FACTOR_EVAL_BARS // 2),
        )
        if syms:
            return syms[:spec.constraints.max_targets]
    except Exception as exc:
        logger.warning("fetch_symbols failed: %s", exc)
    return ["BTC", "ETH", "SPY", "QQQ"]


def _kline_df(symbol: str, timeframe: str) -> Optional[pd.DataFrame]:
    """拉取 K 线并转 DataFrame（index=DatetimeIndex ts）。"""
    rows = data_client.fetch_bars(symbol, timeframe=timeframe, limit=config.FACTOR_EVAL_BARS + 90)
    if not rows:
        return None
    df = pd.DataFrame(rows)
    df["ts"] = pd.to_datetime(df["ts"], unit="ms")
    df = df.set_index("ts").sort_index()
    return df[["open", "high", "low", "close", "volume"]]


def _candidate_keys(spec: JobSpec) -> list[str]:
    """候选因子：pool 展开 → 偏好/限制过滤。"""
    pool = expand_factor_pool()
    # 偏好：风格类别过滤（momentum→L0，volatility→L1，trend→L2，mean_reversion→L0/L4）
    styles = spec.preferences.factor_styles
    if "any" not in styles:
        cat_map = {"momentum": "L0", "volatility": "L1", "trend": "L2",
                   "mean_reversion": "L0", }
        cats = {cat_map[s] for s in styles if s in cat_map}
        if "mean_reversion" in styles:
            cats.add("L4")
        pool = [c for c in pool if c.category in cats]
    # 硬限制：黑白名单 + 数量上限
    cons = spec.constraints
    if cons.whitelist_keys:
        pool = [c for c in pool if c.key in cons.whitelist_keys]
    pool = [c for c in pool if c.key not in cons.blacklist_keys]
    return [c.key for c in pool][: cons.max_factors]


def run_mine(spec: JobSpec,
             progress: ProgressCb | None = None) -> Optional[dict[str, Any]]:
    """执行一次挖掘；progress 返回 False（超时/取消）时终止并返回 None。"""
    timeframe = spec.preferences.timeframe
    horizon = spec.preferences.horizon
    targets = _fetch_symbols(spec)
    if not targets:
        logger.warning("mine: 无可用标的池")
        return None

    if progress and not progress("pool"):
        return None
    keys = _candidate_keys(spec)
    if not keys:
        logger.warning("mine: 候选因子为空（偏好/限制过滤后）")
        return None
    logger.info("mine: pool=%d factors targets=%d", len(keys), len(targets))

    # 预拉 K 线（每标的一次，供全部因子复用）
    kline_map: dict[str, Optional[pd.DataFrame]] = {}
    for sym in targets:
        kline_map[sym] = _kline_df(sym, timeframe)
    usable = {s for s, df in kline_map.items() if df is not None and len(df) > 120}
    if not usable:
        logger.warning("mine: 无标的 K 线达标")
        return None

    if progress and not progress("eval"):
        return None
    factor_series: dict[str, pd.Series] = {}
    evaluations = []
    for key in keys:
        parts: list[pd.DataFrame] = []
        for sym in usable:
            df = kline_map[sym]
            if df is None:
                continue
            f = compute_factor(key, df)
            if f is None:
                continue
            close = df["close"].astype(float)
            future_ret = close.shift(-horizon) / close - 1.0
            panel = pd.concat([f.rename("f"), future_ret.rename("r")], axis=1).dropna()
            if len(panel) >= 30:
                parts.append(panel)
        if not parts:
            continue
        allp = pd.concat(parts)
        if len(allp) < 30:
            continue
        ev = evaluate_factor(key, allp["f"], allp["r"])
        ev.detail["n_targets"] = len(usable)
        factor_series[key] = allp["f"]
        evaluations.append(ev)

    if progress and not progress("select"):
        return None
    selected = select_factors(
        evaluations,
        ic_thr=spec.constraints.min_ic,
        icir_thr=spec.constraints.min_icir,
        independence_thr=spec.constraints.max_independence,
        top_k=spec.constraints.max_factors,
        factor_series=factor_series,
    )

    if progress and not progress("persist"):
        return None
    results = []
    for ev in evaluations:
        results.append({
            "factor_key": ev.key,
            "ic": ev.ic, "icir": ev.icir, "ic_std": ev.ic_std,
            "monotonicity": ev.monotonicity, "independence": ev.independence,
            "passed": ev.passed,
            "detail": {"n_targets": ev.detail.get("n_targets", 0), "n_days": ev.n_days},
        })
    stats = {
        "n_targets": len(usable),
        "n_candidates": len(keys),
        "n_evaluated": len(evaluations),
        "n_passed": len(selected),
        "timeframe": timeframe,
        "horizon": horizon,
    }
    logger.info("mine: %s evaluated=%d passed=%d",
                spec.preferences.asset_pool or "dynamic",
                len(evaluations), len(selected))
    return {"results": results, "selected": [r["factor_key"] for r in results if r["passed"]],
            "stats": stats}
