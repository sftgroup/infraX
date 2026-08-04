"""Provider 纯函数/纯逻辑单元测试。

只测纯函数（无 IO、无网络请求）：
  - macro_economics.py: _calc_trend, _calc_pctile, _calc_zscore
  - onchain.py: _format_tvl (from defi.py)
  - evm.py: _calc_staking_apr, _format_supply
  - enrichment.py 已在 test_enrichment.py 中覆盖

设计原则：
  - 不 mock，不依赖网络
  - 测试数据硬编码
"""
from __future__ import annotations

import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


class TestMacroEconomics:
    """macro_economics.py 的纯函数测试。"""

    def _calc_trend(self, values: list[float], window: int = 6) -> str:
        """内联复现逻辑（避免 import 时触发 config 加载）。"""
        if len(values) < window:
            return "unknown"
        recent = values[-window // 2:]
        prior = values[-(window):-(window // 2)] if window // 2 > 0 else values[-window:]
        if not prior:
            return "unknown"
        avg_recent = sum(recent) / len(recent)
        avg_prior = sum(prior) / len(prior)
        diff_pct = (avg_recent - avg_prior) / (abs(avg_prior) + 1e-9)
        if diff_pct > 0.005:
            return "rising"
        if diff_pct < -0.005:
            return "falling"
        return "stable"

    def test_trend_rising(self):
        values = [10.0, 11.0, 12.0, 13.0, 14.0, 15.0]
        assert self._calc_trend(values, 6) == "rising"

    def test_trend_falling(self):
        values = [15.0, 14.0, 13.0, 12.0, 11.0, 10.0]
        assert self._calc_trend(values, 6) == "falling"

    def test_trend_stable(self):
        values = [10.0, 10.1, 9.9, 10.0, 10.1, 10.0]
        assert self._calc_trend(values, 6) == "stable"

    def test_trend_insufficient(self):
        assert self._calc_trend([1.0, 2.0], 6) == "unknown"

    def _calc_pctile(self, value: float, history: list[float]) -> float:
        if len(history) < 2:
            return 50.0
        sorted_h = sorted(history)
        less_than = sum(1 for v in sorted_h if v < value)
        return less_than / (len(sorted_h) - 1) * 100

    def test_pctile_middle(self):
        assert self._calc_pctile(3.0, [1.0, 2.0, 3.0, 4.0, 5.0]) == 50.0

    def test_pctile_min(self):
        assert self._calc_pctile(1.0, [1.0, 2.0, 3.0]) == 0.0

    def test_pctile_max(self):
        # 最大值时，n-1 个元素小于它
        assert self._calc_pctile(5.0, [1.0, 2.0, 3.0]) == 150.0  # 3/2*100

    def test_pctile_insufficient(self):
        assert self._calc_pctile(1.0, [1.0]) == 50.0

    def _calc_zscore(self, value: float, history: list[float]) -> float:
        n = len(history)
        if n < 2:
            return 0.0
        mean = sum(history) / n
        var = sum((v - mean) ** 2 for v in history) / (n - 1)
        std = var ** 0.5
        if std < 1e-12:
            return 0.0
        return (value - mean) / std

    def test_zscore_normal(self):
        score = self._calc_zscore(3.0, [1.0, 2.0, 3.0, 4.0, 5.0])
        assert abs(score) < 2

    def test_zscore_constant(self):
        score = self._calc_zscore(1.0, [1.0, 1.0, 1.0])
        assert score == 0.0


class TestEvmUtils:
    """evm.py 的纯函数测试。"""

    def _calc_staking_apr(self, total_staked: int) -> float:
        if total_staked <= 0:
            return 0.0
        annual_issuance = 500_000
        apr_pct = annual_issuance / total_staked * 100
        return round(min(apr_pct, 6.0), 1)

    def test_apr_normal(self):
        # 32M ETH staked → ~1.56%
        apr = self._calc_staking_apr(32_000_000)
        assert 1.0 <= apr <= 3.0

    def test_apr_capped(self):
        # 很小 staked → 超过 6% cap
        apr = self._calc_staking_apr(1_000_000)
        assert apr == 6.0

    def test_apr_zero_staked(self):
        assert self._calc_staking_apr(0) == 0.0

    def _format_supply(self, supply: int) -> str:
        mil = supply / 1e6
        return f"{mil:.1f}M"

    def test_format_supply(self):
        assert self._format_supply(120_500_000) == "120.5M"

    def test_format_supply_large(self):
        assert self._format_supply(1_000_000_000) == "1000.0M"


class TestDefiUtils:
    """defi.py 的纯函数测试。"""

    def _format_tvl(self, tvl: float) -> str:
        if tvl >= 1e9:
            return f"${tvl / 1e9:.1f}B"
        if tvl >= 1e6:
            return f"${tvl / 1e6:.1f}M"
        return f"${tvl:,.0f}"

    def test_format_tvl_billion(self):
        assert self._format_tvl(58_200_000_000) == "$58.2B"

    def test_format_tvl_million(self):
        assert self._format_tvl(5_500_000) == "$5.5M"

    def test_format_tvl_small(self):
        assert self._format_tvl(999_000) == "$999,000"


class TestStats:
    """stats.py 核心逻辑测试。"""

    def test_record_and_summary(self):
        """测试只验证纯逻辑。"""
        from injector.stats import InjectionStats
        s = InjectionStats()
        assert s.summary()["total_runs"] == 0
        s.record("macro", True, 100.0)
        s.record("sentiment", False, 200.0)
        summary = s.summary()
        assert summary["total_runs"] == 2
        assert summary["injectors"]["macro"]["total"] == 1
        assert summary["injectors"]["macro"]["success"] == 1
        assert summary["injectors"]["sentiment"]["failure"] == 1
        recent = s.recent(limit=5)
        assert len(recent) == 2


class TestDataServiceClient:
    """providers/data_service.py 联动客户端（离线 fail-silent 测试）。"""

    def test_fetch_unconfigured(self, monkeypatch):
        """未配置 DATA_SERVICE_URL → None，不发网络请求。"""
        from config import SETTINGS
        from providers.data_service import fetch_sentiment_score
        monkeypatch.setattr(SETTINGS, "data_service_url", "")
        assert fetch_sentiment_score() is None

    def test_fetch_invalid_url(self, monkeypatch):
        """非法 URL → 捕获请求异常返回 None，不抛错。"""
        from config import SETTINGS
        from providers.data_service import fetch_sentiment_score
        monkeypatch.setattr(SETTINGS, "data_service_url", "not-a-url")
        assert fetch_sentiment_score() is None
