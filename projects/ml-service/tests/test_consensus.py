"""app/analytics/consensus.py 纯函数单测（跨模型共识，ml-service）。

只测聚合规则与 fail-silent，不依赖模型 / 网络：
  - aggregate: consensus_score / divergence / risk_flag 规则边界
  - aggregate: 信号缺失（tree / volatility / sentiment 各自缺席）
  - build_consensus: 三路信号全部失败返回 None（monkeypatch）
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ["TREE_ML_ENABLED"] = "false"  # 测试环境默认禁用（模块加载前设置）

from app.analytics import consensus as cs  # noqa: E402


# ── fixture ──────────────────────────────────────────────

def _tree_payload(direction="up", prob_up=0.7, opportunity=80, symbol="BTC"):
    return {
        "generated_at": 1,
        "model": {"name": "lightgbm-direction"},
        "predictions": [{
            "symbol": symbol, "direction": direction,
            "prob_up": prob_up, "prob_flat": 0.2, "prob_down": 0.1,
            "opportunity_score": opportunity, "volatility_level": "moderate",
        }],
    }


def _vol_results(level="high", uncertainty="low", symbol="BTC"):
    return [{
        "symbol": symbol, "volatility_score": 0.72,
        "volatility_level": level, "direction_consensus": 0.55,
        "uncertainty": uncertainty,
    }]


def _sentiment(score=-0.45):
    return {"score": score, "ts": 1}


# ── 规则边界 ─────────────────────────────────────────────

class TestAggregateRules:
    def test_tree_sentiment_same_direction(self):
        p = cs.aggregate(_tree_payload(direction="up"), _vol_results(), _sentiment(0.6))
        assert p is not None
        assert p["symbols"][0]["consensus_score"] == 1.0
        assert p["symbols"][0]["divergence"] is False

    def test_tree_sentiment_opposite_direction(self):
        p = cs.aggregate(_tree_payload(direction="up"), _vol_results(), _sentiment(-0.6))
        assert p["symbols"][0]["consensus_score"] == 0.0
        assert p["symbols"][0]["divergence"] is True

    def test_flat_does_not_vote(self):
        # flat/中性不参与方向投票 → 无方向信号 → consensus None
        p = cs.aggregate(_tree_payload(direction="flat"), _vol_results(), _sentiment(0.0))
        assert p["symbols"][0]["consensus_score"] is None
        assert p["symbols"][0]["divergence"] is False

    def test_tree_only_single_signal(self):
        p = cs.aggregate(_tree_payload(direction="up"), _vol_results(), None)
        assert p["signals"] == {"tree": True, "volatility": True, "sentiment": False}
        assert p["symbols"][0]["consensus_score"] == 1.0

    def test_risk_flag_accumulation(self):
        # 高波动 + 高不确定 + 负面情绪 + 分歧 = 4 项风险 → elevated
        p = cs.aggregate(_tree_payload(direction="up"), _vol_results(uncertainty="high"), _sentiment(-0.6))
        assert p["symbols"][0]["risk_flag"] == "elevated"

    def test_risk_flag_low(self):
        # 低波动 + 中性情绪 + 无分歧 → low
        p = cs.aggregate(_tree_payload(direction="up"), _vol_results(level="low"), _sentiment(0.0))
        assert p["symbols"][0]["risk_flag"] == "low"

    def test_market_aggregate(self):
        p = cs.aggregate(
            _tree_payload(direction="up", symbol="BTC"),
            _vol_results(symbol="ETH"),
            _sentiment(-0.6),
        )
        # ETH 无 tree、无 sentiment 方向 → 无方向信号；BTC 分歧
        assert p["n_symbols"] == 2
        assert p["n_divergence"] == 1
        assert p["market_risk_flag"] in ("low", "moderate", "elevated")

    def test_symbol_normalization_aligns_tree_kronos(self):
        # tree 用交易所对格式（BTC/USDT），Kronos 用裸代号（BTC）→ 应合并为同一标的
        p = cs.aggregate(
            _tree_payload(direction="up", symbol="BTC/USDT"),
            _vol_results(level="high", symbol="BTC"),
            _sentiment(0.5),
        )
        assert p["n_symbols"] == 1
        assert p["symbols"][0]["symbol"] == "BTC"
        assert p["symbols"][0]["consensus_score"] == 1.0


# ── fail-silent ──────────────────────────────────────────

class TestFailSilent:
    def test_all_signals_missing_returns_none(self):
        assert cs.aggregate(None, None, None) is None

    def test_empty_volatility_with_tree_only(self):
        p = cs.aggregate(_tree_payload(), [], None)
        assert p is not None
        assert p["signals"]["volatility"] is False


# ── build_consensus 主入口 ───────────────────────────────

class TestBuildConsensus:
    def test_all_fail_returns_none(self, monkeypatch):
        def _fail():
            raise RuntimeError("unavailable")

        import app.analytics.tree_models as tm
        import app.providers.kronos as kr
        monkeypatch.setattr(tm, "predict_payload", _fail)
        monkeypatch.setattr(kr, "predict_all_volatility", _fail)
        monkeypatch.setattr(cs.data_client, "fetch_sentiment_score", _fail)
        assert cs.build_consensus() is None
