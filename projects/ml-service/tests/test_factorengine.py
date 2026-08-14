"""app/factorengine 纯函数单测（需求4 R4-4 / 需求5 R5-1 / 需求6 FF-1/FF-2）。

只测纯函数，不依赖网络 / SQLite：
  - factors: 模板 + 固定因子 compute_factor（含缺依赖列降级、未知 key）
  - engine: build_feature_matrix 列集合与 tree_models.build_features 一致（R4-4 回归）
  - pool: 候选池展开数量/渲染/过滤
  - eval: IC/ICIR/单调性评估 + select_factors 门槛/独立度去冗余/top-K
  - job: build_spec 默认值 + 偏好/硬限制冲突检测
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
import pytest  # noqa: E402

from app.factorengine import (  # noqa: E402
    LEGACY_FEATURE_COLUMNS,
    compute_factor,
    evaluate_factor,
    expand_factor_pool,
    filter_pool,
    select_factors,
    build_feature_matrix,
    build_spec,
    register_factor,
)
from app.factorengine.factors import TEMPLATE_FUNCS, FACTOR_REGISTRY  # noqa: E402


def _mk_df(n=220, close_base=100.0, with_indicators=True):
    """构造波动日线 DataFrame（index=DatetimeIndex，与 runner._kline_df 对齐）。"""
    rng = np.random.default_rng(7)
    ts = pd.date_range("2024-01-01", periods=n, freq="D")
    close = pd.Series(close_base * np.cumprod(1 + rng.normal(0, 0.02, n)), index=ts)
    df = pd.DataFrame(
        {
            "open": close * 0.999,
            "high": close * 1.01,
            "low": close * 0.99,
            "close": close,
            "volume": 1e6 + rng.normal(0, 1e5, n),
        },
        index=ts,
    )
    if with_indicators:
        df["rsi_14"] = 50 + rng.normal(0, 10, n)
        df["macd_hist"] = rng.normal(0, 1, n)
        df["bb_upper"] = close * 1.02
        df["bb_lower"] = close * 0.98
        df["atr_14"] = close * 0.01
        for w in (5, 10, 20):
            df[f"ma_{w}"] = close.rolling(w).mean()
    return df


# ── factors ────────────────────────────────────────────────


class TestFactors:
    def test_template_ret(self):
        df = _mk_df()
        s = compute_factor("ret_5", df)
        assert s is not None
        assert len(s) == len(df)
        assert s.iloc[5] is not np.nan

    def test_template_mom_and_ma_pct(self):
        df = _mk_df()
        mom = compute_factor("mom_5_20", df)
        assert mom is not None and len(mom) == len(df)
        ma = compute_factor("ma5_pct", df)
        assert ma is not None and len(ma) == len(df)

    def test_fixed_factor_needs_missing_column(self):
        # rsi_14 依赖列缺失 → 返回 None（与旧 build_features 不产出 NaN 列一致）
        df = _mk_df(with_indicators=False)
        assert compute_factor("rsi_14", df) is None

    def test_unknown_key_returns_none(self):
        assert compute_factor("not_a_factor_xyz", _mk_df()) is None

    def test_duplicate_register_raises(self):
        # 模板 key 不在注册表内（动态解析），注册真实固定因子后重复注册应抛错
        register_factor("_test_dup_key", "dup", "L0",
                        compute=lambda df: df["close"])
        with pytest.raises(ValueError):
            register_factor("_test_dup_key", "dup2", "L0")
        FACTOR_REGISTRY.pop("_test_dup_key", None)  # 清理，避免污染其他测试

    def test_template_registered(self):
        assert "ret" in TEMPLATE_FUNCS and "ma_pct" in TEMPLATE_FUNCS


# ── engine（R4-4 回归） ────────────────────────────────────


class TestEngine:
    def test_legacy_columns_preserved(self):
        df = _mk_df()
        m = build_feature_matrix(df)
        assert list(m.columns) == LEGACY_FEATURE_COLUMNS
        assert len(m) == len(df)

    def test_matches_tree_models_build_features(self):
        from app.analytics import tree_models as tm

        df = _mk_df()
        a = build_feature_matrix(df)
        b = tm.build_features(df)
        pd.testing.assert_frame_equal(a, b)

    def test_subset_keys(self):
        df = _mk_df()
        m = build_feature_matrix(df, keys=["ret_1", "vol_20"])
        assert list(m.columns) == ["ret_1", "vol_20"]


# ── pool ───────────────────────────────────────────────────


class TestPool:
    def test_expand_count_and_render(self):
        pool = expand_factor_pool()
        # 参数网格：ret 6 + vol 2 + mom 3 + ma_pct 5 + 固定 6 = 22
        assert len(pool) == 22
        keys = [c.key for c in pool]
        assert "ret_20" in keys and "ma20_pct" in keys and "rsi_14" in keys

    def test_filter_by_category(self):
        pool = filter_pool(categories=["L1"])
        assert pool and all(c.category == "L1" for c in pool)

    def test_filter_max_factors(self):
        pool = filter_pool(max_factors=5)
        assert len(pool) == 5


# ── eval ───────────────────────────────────────────────────


def _mk_panel(n_days=40, n_syms=30, seed=3, strength=0.5):
    """构造横截面面板：每天 n_syms 个标的（DatetimeIndex 允许重复日期）。

    每个标的有固定因子强度（跨天同值），未来收益与其正相关 →
    daily IC 稳定可算（ICIR 非 None）。
    """
    rng = np.random.default_rng(seed)
    dates = pd.date_range("2024-01-01", periods=n_days, freq="D")
    sym_factor = rng.normal(0, 1, n_syms)
    idx = pd.DatetimeIndex(np.repeat(dates.values, n_syms))
    f = pd.Series(np.tile(sym_factor, n_days), index=idx)
    r = pd.Series(f.values * strength + rng.normal(0, 0.15, n_syms * n_days), index=idx)
    return f, r


class TestEval:
    def test_evaluate_factor_ic(self):
        rng = np.random.default_rng(11)
        n = 200
        idx = pd.date_range("2024-01-01", periods=n, freq="D")
        f = pd.Series(rng.normal(0, 1, n), index=idx)
        r = pd.Series(f.values * 0.5 + rng.normal(0, 0.1, n), index=idx)  # 与因子正相关
        ev = evaluate_factor("f1", f, r)
        assert ev.ic is not None and ev.ic > 0.3
        assert ev.n_days >= 30

    def test_select_factors_ic_ir_threshold(self):
        evs = []
        series = {}
        # 门槛为 |IC|：强正/强负相关均入选；弱相关（≈0）被滤除
        for i, strength in enumerate((0.8, -0.6, 0.02, -0.02)):
            f, r = _mk_panel(seed=3 + i, strength=strength)
            evs.append(evaluate_factor(f"k{i}", f, r))
            series[f"k{i}"] = f
        selected = select_factors(evs, ic_thr=0.2, icir_thr=0.1, top_k=10,
                                  factor_series=series)
        keys = [e.key for e in selected]
        assert "k0" in keys and "k1" in keys   # 强正/强负相关（|IC|≥0.2）入选
        assert "k2" not in keys and "k3" not in keys  # 弱相关（|IC|<0.2）被门槛滤除

    def test_select_factors_independence_dedup(self):
        # 两个高相关因子（IC 相同强度）：只保留第一个，第二个 |corr|>0.7 → 去冗余
        f, r = _mk_panel(seed=5, strength=0.6)
        rng = np.random.default_rng(9)
        f2 = pd.Series(f.values + rng.normal(0, 0.001, len(f)), index=f.index)
        evs = [evaluate_factor("c0", f, r), evaluate_factor("c1", f2, r)]
        selected = select_factors(evs, ic_thr=0.3, icir_thr=0.1, top_k=10,
                                  independence_thr=0.7, factor_series={"c0": f, "c1": f2})
        assert len(selected) == 1  # c1 与 c0 |corr|>0.7 → 去冗余

    def test_spearman_mismatched_index_no_crash(self):
        # 回归：warmup 不同导致两因子行数/索引不同，_spearman 需 inner 对齐而非 IndexError
        from app.factorengine.eval import _spearman
        idx = pd.date_range("2024-01-01", periods=120, freq="D")
        rng = np.random.default_rng(3)
        f = pd.Series(rng.normal(0, 1, 120), index=idx)
        r = pd.Series(f.values * 0.5 + rng.normal(0, 0.1, 120), index=idx)
        assert _spearman(f, r) is not None  # 索引一致（同 evaluate 路径）
        # ret_60 vs ret_1：索引为子集关系（warmup 不同），inner 对齐后仍应可算
        short_r = r.iloc[60:]
        assert _spearman(f, short_r) is not None
        # 索引完全错开（无公共标签）→ None 而非异常
        other = pd.Series(rng.normal(0, 1, 50), index=pd.date_range("2025-01-01", periods=50, freq="D"))
        assert _spearman(f, other) is None


# ── job（R5-1） ────────────────────────────────────────────


class TestJobSpec:
    def test_defaults_conservative(self):
        spec, conflicts = build_spec()
        assert conflicts == []
        assert spec.preferences.market_types == ["any"]
        assert spec.constraints.min_icir == 0.3
        assert spec.constraints.max_factors == 20

    def test_conflict_detected(self):
        # horizon>30 与 max_runtime_min<30 冲突（长周期评估耗时长）
        spec, conflicts = build_spec(
            {"horizon": 60},
            {"max_runtime_min": 10},
        )
        assert conflicts, "应显式提示偏好/硬限制冲突"

    def test_invalid_enum_raises(self):
        with pytest.raises(Exception):
            build_spec({"timeframe": "4h"})  # 仅 1d/1h


class TestRunnerKline:
    """runner._kline_df：裸符号 /USDT 回退（修复：BTC 命中 BTC/USDT）。"""

    @staticmethod
    def _bars(n, ts0=1_700_000_000_000):
        step = 86_400_000
        return [{"ts": ts0 + i * step, "open": 100.0, "high": 102.0,
                 "low": 99.0, "close": 101.0, "volume": 1000.0} for i in range(n)]

    def test_exact_symbol_no_fallback(self, monkeypatch):
        import app.data_client as dc
        from app.factorengine import runner as runner_mod
        calls = []
        monkeypatch.setattr(dc, "fetch_bars",
                            lambda symbol, timeframe="1d", limit=500: calls.append(symbol) or self._bars(150))
        df = runner_mod._kline_df("SPY", "1d")
        assert calls == ["SPY"]
        assert df is not None and len(df) == 150

    def test_bare_symbol_falls_back_usdt(self, monkeypatch):
        import app.data_client as dc
        from app.factorengine import runner as runner_mod
        calls = []

        def fake(symbol, timeframe="1d", limit=500):
            calls.append(symbol)
            return self._bars(150) if symbol == "BTC/USDT" else []
        monkeypatch.setattr(dc, "fetch_bars", fake)
        df = runner_mod._kline_df("BTC", "1d")
        assert calls == ["BTC", "BTC/USDT"]
        assert df is not None and len(df) == 150

    def test_both_miss_returns_none(self, monkeypatch):
        import app.data_client as dc
        from app.factorengine import runner as runner_mod
        monkeypatch.setattr(dc, "fetch_bars", lambda symbol, timeframe="1d", limit=500: [])
        assert runner_mod._kline_df("BTC", "1d") is None
