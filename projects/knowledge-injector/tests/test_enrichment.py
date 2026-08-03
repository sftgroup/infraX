"""enrichment.py 因子算子单元测试。

纯函数，无 IO，独立可测。
"""
from __future__ import annotations

import sys
import os

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from injector.enrichment import (
    ts_mean, ts_std, ts_slope, ts_delta, ts_rank,
    ts_zscore, ts_quantile, ts_corr, ts_decay_linear,
    rsi, atr,
    price_percentile, ath_distance, z_score,
)


class TestRollingStats:
    def test_ts_mean(self):
        arr = np.array([1.0, 2.0, 3.0, 4.0, 5.0])
        result = ts_mean(arr, 3)
        assert np.isnan(result[0])
        assert np.isnan(result[1])
        assert result[2] == 2.0  # mean(1,2,3)
        assert result[4] == 4.0  # mean(3,4,5)

    def test_ts_std(self):
        arr = np.array([1.0, 1.0, 1.0, 1.0, 1.0])
        result = ts_std(arr, 3)
        assert result[4] == 0.0

    def test_ts_slope(self):
        arr = np.array([1.0, 2.0, 3.0, 4.0, 5.0])
        result = ts_slope(arr, 3)
        assert not np.isnan(result[2])
        assert result[4] > 0  # uptrend

    def test_ts_delta(self):
        arr = np.array([1.0, 2.0, 4.0, 7.0, 11.0])
        result = ts_delta(arr, 1)
        assert np.isnan(result[0])
        assert result[1] == 1.0
        assert result[4] == 4.0


class TestRSI:
    def test_rsi_values(self):
        # 先平稳后有趋势
        arr = np.array([50.0] * 5 + list(np.arange(50.0, 70.0)))  # 5 flat + 20 rising
        result = rsi(arr, 14)
        # 最后的值应该是高RSI（上升趋势）
        last_valid = result[~np.isnan(result)]
        assert len(last_valid) > 0
        assert last_valid[-1] > 50  # uptrend → above 50

    def test_rsi_oversold(self):
        # 持续下降 → RSI 低
        arr = np.arange(40.0, 20.0, -1.0)
        result = rsi(arr, 14)
        assert not np.isnan(result[-1])


class TestATR:
    def test_atr_constant(self):
        high = np.full(20, 105.0)
        low = np.full(20, 95.0)
        close = np.full(20, 100.0)
        result = atr(high, low, close, 14)
        assert not np.isnan(result[-1])
        assert result[-1] > 0


class TestScalarFunctions:
    def test_price_percentile(self):
        price = 50.0
        history = np.array([10.0, 20.0, 30.0, 40.0, 50.0, 60.0])
        result = price_percentile(price, history)
        # 小于 50 的有 4 个元素，排除自己后分母为 5 → 0.8
        assert result == 0.8

    def test_ath_distance(self):
        result = ath_distance(80.0, np.array([50.0, 100.0]))
        assert result < 0  # 80 < 100 ATH

    def test_z_score(self):
        result = z_score(3.0, np.array([1.0, 2.0, 3.0, 4.0, 5.0]))
        assert abs(result) < 2
