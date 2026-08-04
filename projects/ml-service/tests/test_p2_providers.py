"""P2 时序基础模型纯函数单测（bolt / moirai / timesfm，ml-service）。

只测纯函数统计与禁用态，不加载真实模型 / 不联网：
  - bolt._prob_up_from_quantiles / _uncertainty_level / _stats_from_paths
  - bolt._parse_quantiles（配置解析）
  - 三 provider 的 _load_pipeline/_load_model 在禁用态返回 None（fail-silent）
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# 全部 P2 开关默认关闭（模块加载前设置）
os.environ["BOLT_ENABLED"] = "false"
os.environ["MOIRAI_ENABLED"] = "false"
os.environ["TIMESFM_ENABLED"] = "false"

import numpy as np  # noqa: E402

from app.providers import chronos_bolt as bolt  # noqa: E402
from app.providers import moirai2, timesfm25  # noqa: E402


# ── prob_up 插值规则 ─────────────────────────────────────

class TestProbUp:
    def test_q10_above_price(self):
        assert bolt._prob_up_from_quantiles(105.0, 110.0, 120.0, 100.0) == 0.95

    def test_q90_below_price(self):
        assert bolt._prob_up_from_quantiles(80.0, 85.0, 90.0, 100.0) == 0.05

    def test_midpoint_linear_interp(self):
        # 收益区间 [q10=-5%, q90=+5%] 对称 → 0 位于中点 → 0.5
        v = bolt._prob_up_from_quantiles(95.0, 100.0, 105.0, 100.0)
        assert abs(v - 0.5) < 0.001

    def test_bad_price_returns_50(self):
        assert bolt._prob_up_from_quantiles(1.0, 2.0, 3.0, 0.0) == 0.5


# ── 不确定性分档 ─────────────────────────────────────────

class TestUncertainty:
    def test_bands(self):
        assert bolt._uncertainty_level(0.05) == "low"
        assert bolt._uncertainty_level(0.12) == "moderate"
        assert bolt._uncertainty_level(0.30) == "high"


# ── stats 输出结构 ────────────────────────────────────────

class TestStatsFromPaths:
    def test_up_direction_and_structure(self):
        point = np.array([100.0, 101.0, 103.0])
        q10 = np.array([98.0, 99.0, 99.0])
        q50 = point
        q90 = np.array([102.0, 104.0, 107.0])
        stats = bolt._stats_from_paths(point, q10, q50, q90, 100.0)
        assert stats["direction"] == "up"
        assert stats["prob_up"] > 0.5
        assert len(stats["point_forecast"]) == 3
        assert set(stats["quantiles"]) == {"0.1", "0.5", "0.9"}
        assert stats["uncertainty"] in ("low", "moderate", "high")

    def test_down_direction(self):
        point = np.array([100.0, 99.0, 97.0])
        q10 = np.array([96.0, 95.0, 93.0])
        q50 = point
        q90 = np.array([101.0, 100.0, 99.0])
        stats = bolt._stats_from_paths(point, q10, q50, q90, 100.0)
        assert stats["direction"] == "down"
        assert stats["prob_up"] < 0.5


# ── 配置解析 ──────────────────────────────────────────────

class TestParseQuantiles:
    def test_default(self):
        assert bolt._parse_quantiles() == [0.1, 0.5, 0.9]

    def test_custom(self, monkeypatch):
        import config
        monkeypatch.setattr(config, "BOLT_QUANTILES", "0.2,0.5,0.8")
        assert bolt._parse_quantiles() == [0.2, 0.5, 0.8]

    def test_garbage_ignored(self, monkeypatch):
        import config
        monkeypatch.setattr(config, "BOLT_QUANTILES", "0.1,,abc,0.9")
        assert bolt._parse_quantiles() == [0.1, 0.9]


# ── 禁用态 fail-silent ───────────────────────────────────

class TestDisabled:
    def test_bolt_load_none(self):
        assert bolt._load_pipeline() is None
        assert bolt.predict_all() == []

    def test_moirai_load_none(self):
        assert moirai2._load_model() is None
        assert moirai2.predict_all() == []

    def test_timesfm_load_none(self):
        assert timesfm25._load_model() is None
        assert timesfm25.predict_all() == []
