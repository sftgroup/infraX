"""app/providers/kronos.py 纯函数单测（Kronos 波动率预测，ml-service）。

只测纯函数与禁用态行为，不触发 torch/网络：
  - _vol_level: 波动率档位阈值
  - _path_stats: 多路径 → 波动率/方向共识统计
  - predict_volatility: KRONOS_ENABLED 未设时必须返回 None（无模拟回退）
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ["KRONOS_ENABLED"] = "false"

import numpy as np  # noqa: E402

from app.providers import kronos  # noqa: E402


class TestVolLevel:
    def test_boundaries(self):
        assert kronos._vol_level(0.0) == "very_low"
        assert kronos._vol_level(0.24) == "very_low"
        assert kronos._vol_level(0.25) == "low"
        assert kronos._vol_level(0.40) == "moderate"
        assert kronos._vol_level(0.55) == "high"
        assert kronos._vol_level(0.70) == "very_high"
        assert kronos._vol_level(0.99) == "very_high"

    def test_mid_values(self):
        assert kronos._vol_level(0.1) == "very_low"
        assert kronos._vol_level(0.3) == "low"
        assert kronos._vol_level(0.5) == "moderate"
        assert kronos._vol_level(0.6) == "high"


class TestPathStats:
    def test_empty_paths(self):
        assert kronos._path_stats([], 100.0) == {}

    def test_non_positive_last_close(self):
        paths = [np.array([100.0, 105.0])]
        assert kronos._path_stats(paths, 0) == {}

    def test_convergent_low_vol_high_consensus(self):
        paths = [np.array([101.0, 103.0, 105.0]) for _ in range(5)]
        stats = kronos._path_stats(paths, last_close=100.0)
        assert stats["volatility_score"] < 0.1
        assert stats["volatility_level"] in ("very_low", "low")
        assert stats["direction_consensus"] > 0.95

    def test_divergent_high_vol(self):
        up = np.array([150.0, 190.0, 200.0])
        down = np.array([50.0, 55.0, 50.0])
        paths = [up, down, up, down]
        stats = kronos._path_stats(paths, last_close=100.0)
        assert stats["volatility_score"] > 0.5
        assert stats["volatility_level"] == "very_high"
        assert stats["direction_consensus"] < 0.2
        assert stats["uncertainty"] == "high"

    def test_half_up_half_down_no_consensus(self):
        paths = [np.array([110.0]) for _ in range(5)] + [np.array([90.0]) for _ in range(5)]
        stats = kronos._path_stats(paths, last_close=100.0)
        assert abs(stats["direction_consensus"]) < 0.05

    def test_all_up_full_consensus(self):
        paths = [np.array([102.0, 104.0]) for _ in range(4)]
        stats = kronos._path_stats(paths, last_close=100.0)
        assert stats["direction_consensus"] == 1.0

    def test_score_range(self):
        rng = np.random.default_rng(42)
        paths = [100.0 + rng.normal(0, scale, 30) for scale in (0.5, 5.0, 20.0) for _ in range(6)]
        for p in paths:
            s = kronos._path_stats([p], last_close=100.0)
            assert 0.0 <= s["volatility_score"] <= 1.0
            assert 0.0 <= s["direction_consensus"] <= 1.0


class TestDisabledBehavior:
    """KRONOS_ENABLED=false（默认）时：不加载模型、不产生任何模拟数据。"""

    def test_predict_volatility_none(self):
        assert kronos.predict_volatility("BTC") is None

    def test_predict_all_empty(self):
        assert kronos.predict_all_volatility() == []

    def test_predictor_not_loaded(self):
        assert kronos._load_predictor() is None
        assert kronos._predictor is None
