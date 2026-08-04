"""app/analytics/tree_models.py 纯函数单测（LightGBM 方向预测，ml-service）。

只测纯函数与禁用态行为，不依赖 lightgbm / 网络 / SQLite：
  - build_features: 特征列构造（含技术指标缺失时的降级）
  - make_labels: up/flat/down 分界 + 尾部 NaN
  - opportunity_score / volatility_level: 边界
  - train_models / predict_payload: 禁用态返回 None（无模拟数据）
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ["TREE_ML_ENABLED"] = "false"  # 测试环境默认禁用（模块加载前设置）

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
import pytest  # noqa: E402

from app.analytics import tree_models as tm  # noqa: E402


def _mk_df(n=200, close_base=100.0, with_indicators=True):
    """构造递增/波动的日线 DataFrame（ts 毫秒，升序）。"""
    rng = np.random.default_rng(42)
    ts = list(range(1_700_000_000_000, 1_700_000_000_000 + n * 86_400_000, 86_400_000))
    close = close_base * np.cumprod(1 + rng.normal(0, 0.02, n))
    df = pd.DataFrame(
        {
            "ts": ts,
            "open": close * 0.999,
            "high": close * 1.01,
            "low": close * 0.99,
            "close": close,
            "volume": 1e6 + rng.normal(0, 1e5, n),
        }
    )
    if with_indicators:
        df["rsi_14"] = 50 + rng.normal(0, 10, n)
        df["macd_hist"] = rng.normal(0, 1, n)
        df["bb_upper"] = close * 1.02
        df["bb_middle"] = close
        df["bb_lower"] = close * 0.98
        df["atr_14"] = close * 0.02
        df["ma_5"] = close
        df["ma_10"] = close
        df["ma_20"] = close
    return df


class TestBuildFeatures:
    def test_has_expected_columns(self):
        df = _mk_df()
        feat = tm.build_features(df)
        for col in ("ret_1", "ret_3", "ret_5", "ret_10", "ret_20",
                    "vol_20", "vol_60", "mom_5_20", "rsi_14",
                    "macd_hist_pct", "bb_pos", "bb_width", "atr_pct",
                    "ma5_pct", "ma10_pct", "ma20_pct", "high_low_range"):
            assert col in feat.columns
        assert len(feat) == len(df)

    def test_missing_indicators_degrades(self):
        df = _mk_df(with_indicators=False)
        feat = tm.build_features(df)
        for col in ("ret_1", "ret_5", "vol_20", "mom_5_20", "high_low_range"):
            assert col in feat.columns
        assert "rsi_14" not in feat.columns

    def test_ret_warmup_nan(self):
        df = _mk_df()
        feat = tm.build_features(df)
        assert np.isnan(feat["ret_20"].iloc[10])
        assert not np.isnan(feat["ret_20"].iloc[-1])


class TestMakeLabels:
    def test_up_down_flat(self):
        n = 30
        close = pd.Series(np.linspace(100, 100, n))
        close.iloc[-15:] += 5
        df = pd.DataFrame({"close": close})
        labels = tm.make_labels(df, horizon=7, up_thr=0.01)
        assert (labels.iloc[:8] == 1.0).all()
        assert (labels.iloc[8:15] == 2.0).all()
        assert labels.iloc[-7:].isna().all()

    def test_values_are_binary(self):
        df = _mk_df()
        labels = tm.make_labels(df).dropna()
        assert set(labels.unique()) <= {0, 1, 2}


class TestOpportunityScore:
    def test_boundaries(self):
        assert tm.opportunity_score(1.0, 0.0) == 100
        assert tm.opportunity_score(0.0, 1.0) == 0
        assert tm.opportunity_score(0.5, 0.5) == 50

    def test_round(self):
        assert tm.opportunity_score(0.6, 0.4) == 60


class TestVolatilityLevel:
    def test_bands(self):
        assert tm.volatility_level(0.10) == "low"
        assert tm.volatility_level(0.59) == "low"
        assert tm.volatility_level(0.60) == "moderate"
        assert tm.volatility_level(0.74) == "moderate"
        assert tm.volatility_level(0.75) == "high"
        assert tm.volatility_level(0.89) == "high"
        assert tm.volatility_level(0.90) == "very_high"
        assert tm.volatility_level(0.99) == "very_high"


class TestDisabledBehavior:
    def test_train_returns_none(self):
        assert tm.train_models() is None

    def test_predict_returns_none(self):
        assert tm.predict_all() is None

    def test_payload_returns_none(self):
        assert tm.predict_payload() is None

    def test_enabled_flag(self):
        assert tm._enabled() is False

    def test_unknown_family_not_enabled(self):
        assert tm._enabled("nope") is False


def _synthetic_xy(n=400):
    """构造带方向标签的合成特征（供训练冒烟测试，不依赖网络）。"""
    rng = np.random.default_rng(7)
    df = _mk_df(n=n)
    feats = tm.build_features(df)
    labels = tm.make_labels(df).dropna()
    labels.name = "direction"
    Xy = pd.concat([feats, labels], axis=1).dropna(subset=["direction"])
    mid = int(len(Xy) * 0.8)
    Xy_tr, Xy_va = Xy.iloc[:mid], Xy.iloc[mid:]
    return Xy_tr.drop(columns=["direction"]), Xy_tr["direction"], Xy_va.drop(columns=["direction"]), Xy_va["direction"]


class TestFitFamily:
    """三家族在同一合成数据上训练冒烟（真实训练，验证对照基线可用）。"""

    def test_lightgbm(self):
        Xt, yt, Xv, yv = _synthetic_xy()
        model, acc = tm._fit_family("lightgbm", Xt, yt, Xv, yv)
        assert hasattr(model, "predict_proba")
        assert 0.0 <= acc <= 1.0

    def test_xgboost(self):
        pytest.importorskip("xgboost")
        Xt, yt, Xv, yv = _synthetic_xy()
        model, acc = tm._fit_family("xgboost", Xt, yt, Xv, yv)
        assert hasattr(model, "predict_proba")
        assert 0.0 <= acc <= 1.0

    def test_random_forest(self):
        Xt, yt, Xv, yv = _synthetic_xy()
        model, acc = tm._fit_family("random_forest", Xt, yt, Xv, yv)
        assert hasattr(model, "predict_proba")
        assert 0.0 <= acc <= 1.0


class TestPrimaryFamily:
    def test_lightgbm_first_when_enabled(self, monkeypatch):
        monkeypatch.setattr(tm, "_enabled", lambda f="lightgbm": f == "lightgbm")
        assert tm._primary_family() == "lightgbm"

    def test_falls_back_to_xgboost(self, monkeypatch):
        monkeypatch.setattr(tm, "_enabled", lambda f="lightgbm": f in ("xgboost", "random_forest"))
        assert tm._primary_family() == "xgboost"

    def test_none_when_all_disabled(self, monkeypatch):
        monkeypatch.setattr(tm, "_enabled", lambda f="lightgbm": False)
        assert tm._primary_family() is None


class TestPayloadFamilies:
    """predict_payload 包含启用的对比家族（lightgbm 主模型兼容原结构）。"""

    def _fake_predict(self, family="lightgbm"):
        return [{"symbol": "AAPL", "direction": "up", "prob_up": 0.7,
                 "prob_flat": 0.2, "prob_down": 0.1,
                 "opportunity_score": 80, "volatility_level": "moderate"}]

    def test_no_families_when_only_lightgbm(self, monkeypatch):
        monkeypatch.setattr(tm, "_primary_family", lambda: "lightgbm")
        monkeypatch.setattr(tm, "_enabled", lambda f="lightgbm": f == "lightgbm")
        monkeypatch.setattr(tm, "predict_all", self._fake_predict)
        monkeypatch.setattr(tm, "_load_meta", lambda f="lightgbm": {"n_samples": 100, "val_accuracy": 0.5})
        payload = tm.predict_payload()
        assert payload["model"]["name"] == "lightgbm-direction"
        assert payload["predictions"]
        assert "families" not in payload

    def test_includes_xgboost_family(self, monkeypatch):
        monkeypatch.setattr(tm, "_primary_family", lambda: "lightgbm")
        monkeypatch.setattr(tm, "_enabled", lambda f="lightgbm": f in ("lightgbm", "xgboost"))
        monkeypatch.setattr(tm, "predict_all", self._fake_predict)
        monkeypatch.setattr(tm, "_load_meta", lambda f="lightgbm": {"n_samples": 100, "val_accuracy": 0.5})
        payload = tm.predict_payload()
        assert "families" in payload
        assert payload["families"]["xgboost"]["model"]["name"] == "xgboost-direction"
        assert payload["families"]["xgboost"]["predictions"][0]["symbol"] == "AAPL"

    def test_xgboost_primary_when_lightgbm_disabled(self, monkeypatch):
        monkeypatch.setattr(tm, "_primary_family", lambda: "xgboost")
        monkeypatch.setattr(tm, "_enabled", lambda f="lightgbm": f in ("xgboost", "random_forest"))
        monkeypatch.setattr(tm, "predict_all", self._fake_predict)
        monkeypatch.setattr(tm, "_load_meta", lambda f="lightgbm": {"n_samples": 100, "val_accuracy": 0.5})
        payload = tm.predict_payload()
        assert payload["model"]["name"] == "xgboost-direction"
