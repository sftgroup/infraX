"""graph 因子候选与 IC/ICIR 评估（GX-2.4）。

graph 图因子（gf_*）是"全市场横截面因子"：每个 symbol 每日一个值，来自
graph_engine 的全图计算（非单标的 K 线可算）。因此评估不走 runner 的
compute_factor 逐标的链路，而是：
  - 历史：graph_history 每日快照（横截面值，GX-2.4.2）
  - 未来收益：data-service /bars 各标的 close → t+horizon 收益
  - 评估：eval.evaluate_factor / select_factors（门槛对齐 FF）

接入点：
  - graph_candidates()：18 个 gf_* 候选（category="graph"）
  - evaluate_graph_factors()：挖掘作业合并评估（jobs._run_wrapper 调用）
  - health_check_graph_factor()：衰退淘汰（FF-4.4）graph 分支
"""
from __future__ import annotations

import logging
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any

import pandas as pd

import config
from app import data_client
from app.factorengine.eval import evaluate_factor, select_factors
from app.factorengine.graph_history import load_graph_history
from app.factorengine.pool import FactorCandidate

logger = logging.getLogger(__name__)

# 18 个图因子（与 graph_engine.GRAPH_FACTOR_CATALOG / data-service _GRAPH_FACTORS 对齐）
GRAPH_FACTOR_KEYS: list[str] = [
    "gf_degree", "gf_betweenness", "gf_pagerank", "gf_community", "gf_structural_hole",
    "gf_neighbor_mom", "gf_neighbor_vol", "gf_sector_mom", "gf_cc_spillover", "gf_community_mom",
] + [f"gf_node2vec_{i}" for i in range(1, 9)]

_BARS_WORKERS = 8


def graph_candidates() -> list[FactorCandidate]:
    """graph 因子候选（category="graph"，供 FF 挖掘增量注入）。"""
    return [
        FactorCandidate(key=k, template="graph_factor", params={"factor_id": k}, category="graph")
        for k in GRAPH_FACTOR_KEYS
    ]


def _fetch_close(symbol: str) -> pd.Series | None:
    """拉取日线 close（DatetimeIndex → close），crypto 裸对补 /USDT 回退。"""
    limit = config.FACTOR_EVAL_BARS + 90
    rows = data_client.fetch_bars(symbol, timeframe="1d", limit=limit)
    if not rows and "/" not in symbol:
        rows = data_client.fetch_bars(f"{symbol}/USDT", timeframe="1d", limit=limit)
    if not rows:
        return None
    df = pd.DataFrame(rows)
    df["ts"] = pd.to_datetime(df["ts"], unit="ms")
    return df.set_index("ts")["close"].astype(float).sort_index()


def _future_ret_panel(symbols: list[str], horizon: int) -> pd.DataFrame:
    """各标的未来 horizon 日收益面板：MultiIndex(symbol, date) → ret（dropna）。"""
    closes: dict[str, pd.Series] = {}
    with ThreadPoolExecutor(max_workers=_BARS_WORKERS) as ex:
        futs = {ex.submit(_fetch_close, s): s for s in symbols}
        for fu in as_completed(futs):
            s = fu.result()
            if s is not None and len(s) > 1:
                closes[futs[fu]] = s
    if not closes:
        return pd.DataFrame()
    parts = []
    for sym, close in closes.items():
        r = (close.shift(-horizon) / close - 1.0).dropna()
        if len(r) < 2:
            continue
        df = pd.DataFrame({"ret": r}).reset_index()
        df["symbol"] = sym
        parts.append(df.set_index(["symbol", "ts"])["ret"])
    if not parts:
        return pd.DataFrame()
    return pd.concat(parts)


def _build_panel(hist: pd.DataFrame, horizon: int,
                 min_days: int) -> tuple[pd.DataFrame, pd.DataFrame]:
    """从历史快照构建评估面板：pivot（symbol,date × factor_key）+ 未来收益面板。

    返回 (piv, ret_panel)；历史不足（标的 <3）返回空 DataFrame。
    """
    hist = hist.copy()
    hist["date"] = pd.to_datetime(hist["ts"], unit="ms").dt.normalize()
    cnt = hist.groupby("symbol")["date"].nunique()
    syms = [s for s in cnt.index if int(cnt[s]) >= min_days]
    if len(syms) < 3:
        return pd.DataFrame(), pd.DataFrame()
    piv = (hist[hist["symbol"].isin(syms)]
           .pivot_table(index=["symbol", "date"], columns="factor_key", values="value"))
    ret = _future_ret_panel(syms, horizon)
    return piv, ret


def evaluate_graph_factors(horizon: int = 5,
                           min_days: int | None = None) -> list[dict[str, Any]]:
    """评估 graph 因子（GX-2.4.3）：横截面 IC/ICIR。

    历史不足（<min_days 天）或标的 <3 时返回 []（不报错，日志提示）。
    返回结果 dict 对齐 runner.run_mine 的 results 结构（含 passed/source=graph）。
    """
    min_days = min_days or config.FACTOR_MINER_GRAPH_MIN_DAYS
    hist = load_graph_history(days=config.FACTOR_MINER_GRAPH_DAYS)
    if hist is None or hist.empty:
        logger.info("graph factor eval skipped: 历史为空")
        return []
    piv, ret = _build_panel(hist, horizon, min_days)
    if piv.empty or ret.empty:
        logger.info("graph factor eval skipped: 历史/收益数据不足")
        return []

    keys = [k for k in GRAPH_FACTOR_KEYS if k in piv.columns]
    if not keys:
        logger.info("graph factor eval skipped: 无 gf_* 历史列")
        return []
    evaluations = []
    series: dict[str, pd.Series] = {}
    for key in keys:
        f = piv[key].dropna()
        if len(f) < max(min_days, 30):
            continue
        panel = pd.DataFrame({"f": f})
        panel["r"] = ret.reindex(panel.index)
        panel = panel.dropna()
        if len(panel) < max(min_days, 30):
            continue
        ev = evaluate_factor(key, panel["f"], panel["r"])
        ev.detail["n_targets"] = int(piv.index.get_level_values("symbol").nunique())
        series[key] = panel["f"]
        evaluations.append(ev)
    if not evaluations:
        return []

    selected = select_factors(
        evaluations,
        ic_thr=config.FACTOR_MINER_SCHEDULE_MIN_IC,
        icir_thr=config.FACTOR_MINER_SCHEDULE_MIN_ICIR,
        independence_thr=0.7,
        top_k=10,
        factor_series=series,
    )
    results = []
    for ev in evaluations:
        results.append({
            "factor_key": ev.key,
            "ic": ev.ic, "icir": ev.icir, "ic_std": ev.ic_std,
            "monotonicity": ev.monotonicity, "independence": ev.independence,
            "passed": ev.passed,
            "detail": {"n_targets": ev.detail.get("n_targets", 0), "n_days": ev.n_days,
                       "source": "graph"},
        })
    logger.info("graph factor eval: evaluated=%d passed=%d (horizon=%d)",
                len(evaluations), len(selected), horizon)
    return results


def health_check_graph_factor(e: dict[str, Any]) -> bool:
    """衰退淘汰（GX-2.4.5）：单 graph 因子用 graph_history 重评估。

    低于 FF-4.4 停用阈值（DEACTIVATE_IC/DEACTIVATE_ICIR）→ 停用并记录原因。
    历史不足/无收益数据 → 跳过（返回 False，不误停用）。
    """
    horizon = int((e.get("params") or {}).get("horizon") or 1)
    hist = load_graph_history(days=config.FACTOR_MINER_GRAPH_DAYS)
    if hist is None or hist.empty:
        return False
    piv, ret = _build_panel(hist, horizon, config.FACTOR_MINER_GRAPH_MIN_DAYS)
    key = e["factor_key"]
    if piv.empty or ret.empty or key not in piv.columns:
        return False
    f = piv[key].dropna()
    panel = pd.DataFrame({"f": f})
    panel["r"] = ret.reindex(panel.index)
    panel = panel.dropna()
    if len(panel) < 30:
        return False
    ev = evaluate_factor(key, panel["f"], panel["r"])
    decayed = (ev.ic is None or abs(ev.ic or 0) < config.FACTOR_MINER_DEACTIVATE_IC
               or ev.icir is None or abs(ev.icir or 0) < config.FACTOR_MINER_DEACTIVATE_ICIR)
    if not decayed:
        return False

    from app.factorengine.catalog import get_catalog
    store = get_catalog()
    store.set_status(key, "inactive")
    cur = store.get(key) or e
    cur["description"] = (f"{cur.get('description') or ''} "
                          f"[FF-4.4 graph decayed: |IC|={abs(ev.ic or 0):.4f} "
                          f"|ICIR|={abs(ev.icir or 0):.4f} deactivated]").strip()
    cur["updated_at"] = int(time.time() * 1000)
    store.upsert(cur)
    logger.info("graph factor decayed deactivated: %s |IC|=%.4f |ICIR|=%.4f",
                key, abs(ev.ic or 0), abs(ev.icir or 0))
    return True
