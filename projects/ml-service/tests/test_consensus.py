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


def _p2_result(symbol="BTC", prob_up=0.9, direction="up", uncertainty="moderate"):
    return [{
        "symbol": symbol, "direction": direction, "prob_up": prob_up,
        "uncertainty": uncertainty, "point_forecast": [1.0],
    }]


# ── 规则边界 ─────────────────────────────────────────────

class TestAggregateRules:
    def test_tree_sentiment_same_direction(self):
        p = cs.aggregate(_tree_payload(direction="up"), _vol_results(), _sentiment(0.6))
        assert p is not None
        assert p["symbols"][0]["consensus_score"] == 1.0
        assert p["symbols"][0]["divergence"] is False

    def test_tree_sentiment_opposite_direction(self):
        # 2 票各半 → 主导方向占比 1/2 = 0.5；存在 up+down → divergence
        p = cs.aggregate(_tree_payload(direction="up"), _vol_results(), _sentiment(-0.6))
        assert p["symbols"][0]["consensus_score"] == 0.5
        assert p["symbols"][0]["divergence"] is True

    def test_flat_does_not_vote(self):
        # flat/中性不参与方向投票 → 无方向信号 → consensus None
        p = cs.aggregate(_tree_payload(direction="flat"), _vol_results(), _sentiment(0.0))
        assert p["symbols"][0]["consensus_score"] is None
        assert p["symbols"][0]["divergence"] is False

    def test_tree_only_single_signal(self):
        p = cs.aggregate(_tree_payload(direction="up"), _vol_results(), None)
        assert p["signals"] == {
            "tree": True, "volatility": True, "sentiment": False,
            "bolt": False, "moirai": False, "timesfm": False,
        }
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


# ── P2 信号整合 ─────────────────────────────────────────

class TestP2Consensus:
    def test_p2_vote_threshold(self):
        # prob_up 置信方向才投票；中间置信不投
        assert cs._p2_vote({"prob_up": 0.95}) == 1.0
        assert cs._p2_vote({"prob_up": 0.40}) == -1.0
        assert cs._p2_vote({"prob_up": 0.52}) is None
        assert cs._p2_vote({}) is None

    def test_bolt_same_direction_as_tree(self):
        p = cs.aggregate(_tree_payload(direction="up"), _vol_results(), _sentiment(0.6),
                         bolt_results=_p2_result(prob_up=0.9, direction="up"))
        s = p["symbols"][0]
        assert s["consensus_score"] == 1.0  # 3 票全 up
        assert s["divergence"] is False
        assert s["bolt_direction"] == "up"
        assert p["signals"]["bolt"] is True

    def test_bolt_opposes_tree(self):
        # tree up + sentiment up + bolt down → 2/3 主导 → 0.6667，分歧
        p = cs.aggregate(_tree_payload(direction="up"), _vol_results(), _sentiment(0.6),
                         bolt_results=_p2_result(prob_up=0.1, direction="down"))
        s = p["symbols"][0]
        assert s["consensus_score"] == round(2 / 3, 4)
        assert s["divergence"] is True
        assert p["n_divergence"] == 1

    def test_multi_vote_consensus_ratio(self):
        # 中性情绪不投票：tree up + bolt up + timesfm down = 3 票 → 主导 2/3
        p = cs.aggregate(_tree_payload(direction="up"), _vol_results(), _sentiment(0.0),
                         bolt_results=_p2_result(prob_up=0.9, direction="up"),
                         timesfm_results=_p2_result(prob_up=0.2, direction="down"))
        assert p["symbols"][0]["consensus_score"] == round(2 / 3, 4)

    def test_low_confidence_p2_does_not_vote(self):
        # P2 低置信不投票 → 仅 tree 一票 → 1.0
        p = cs.aggregate(_tree_payload(direction="up"), _vol_results(), None,
                         bolt_results=_p2_result(prob_up=0.52, direction="down"))
        assert p["symbols"][0]["consensus_score"] == 1.0
        assert p["symbols"][0]["divergence"] is False

    def test_p2_only_signal(self):
        # 仅 bolt 有方向票 → 1.0
        p = cs.aggregate(None, [], None, bolt_results=_p2_result(prob_up=0.8, direction="up"))
        assert p is not None
        assert p["symbols"][0]["consensus_score"] == 1.0

    def test_p2_uncertainty_adds_risk(self):
        # 无风险项基础 + bolt high uncertainty → moderate（1 项）
        p = cs.aggregate(_tree_payload(direction="up"), _vol_results(level="low"), _sentiment(0.0),
                         bolt_results=_p2_result(prob_up=0.9, uncertainty="high"))
        assert p["symbols"][0]["risk_flag"] == "moderate"

    def test_p2_missing_keeps_old_behavior(self):
        # 不传 P2 参数 → 与 M3 行为一致（2 票反向 0.5 / 无分歧标记不变化）
        p = cs.aggregate(_tree_payload(direction="up"), _vol_results(), _sentiment(-0.6))
        assert p["symbols"][0]["consensus_score"] == 0.5
        assert p["symbols"][0]["divergence"] is True


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
        import app.providers.chronos_bolt as bolt
        import app.providers.moirai2 as moirai
        import app.providers.timesfm25 as timesfm
        monkeypatch.setattr(tm, "predict_payload", _fail)
        monkeypatch.setattr(kr, "predict_all_volatility", _fail)
        monkeypatch.setattr(cs.data_client, "fetch_sentiment_score", _fail)
        monkeypatch.setattr(bolt, "predict_all", _fail)
        monkeypatch.setattr(moirai, "predict_all", _fail)
        monkeypatch.setattr(timesfm, "predict_all", _fail)
        assert cs.build_consensus() is None

    def test_cache_returns_without_recompute(self, monkeypatch):
        called = {"n": 0}

        def _boom():
            called["n"] += 1
            raise AssertionError("不应触发信号拉取（命中缓存）")

        import app.analytics.tree_models as tm
        import app.providers.kronos as kr
        import app.providers.chronos_bolt as bolt
        import app.providers.moirai2 as moirai
        import app.providers.timesfm25 as timesfm
        monkeypatch.setattr(tm, "predict_payload", _boom)
        monkeypatch.setattr(kr, "predict_all_volatility", _boom)
        monkeypatch.setattr(cs.data_client, "fetch_sentiment_score", _boom)
        monkeypatch.setattr(bolt, "predict_all", _boom)
        monkeypatch.setattr(moirai, "predict_all", _boom)
        monkeypatch.setattr(timesfm, "predict_all", _boom)
        cs._set_cache({"generated_at": 1, "cached": True, "symbols": [{"symbol": "T"}]})
        assert cs.build_consensus()["cached"] is True
        assert called["n"] == 0
        cs._set_cache(None)  # 清缓存（None 不覆盖）
        cs._cache = None
        cs._cache_at_ms = 0
