"""全局市场快照（DS-10）单元测试（不依赖网络）。

覆盖：
  - _compute_market_overview 多市场聚合结构（up/down/flat 分布）
  - 归一化：price<=0 跳过、字段名兼容
  - 全部 fetch 失败返回 None（fail-silent）
  - commodities / forex_pairs / market_overview 落库（save_snapshot）
  - 单源抛异常不影响其他
  - 30min 节流（慢速数据不重复打上游）
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("DATA_CONFIG_PATH", "data_config.json")

import pytest  # noqa: E402

from app.collectors import global_market as gm  # noqa: E402


# ─── 聚合测试 ─────────────────────────────────────────────

def _install_fetch(monkeypatch, name, items):
    """把 fake fetch 挂到 data_providers 模块上（collector 延迟 import 路径）。"""
    import app.data_providers.commodities as commodities
    import app.data_providers.crypto as crypto
    import app.data_providers.forex as forex
    import app.data_providers.indices as indices

    mapping = {
        "crypto": (crypto, "fetch_crypto_prices"),
        "commodities": (commodities, "fetch_commodities"),
        "forex": (forex, "fetch_forex_pairs"),
        "indices": (indices, "fetch_stock_indices"),
    }
    mod, fn = mapping[name]
    monkeypatch.setattr(mod, fn, lambda _n=name, _i=items: _i)


def test_market_overview_aggregation(monkeypatch):
    _install_fetch(monkeypatch, "crypto", [
        {"symbol": "BTC", "price": 60000, "change_24h": 2.5},
        {"symbol": "ETH", "price": 3000, "change_24h": -1.0},
        {"symbol": "SOL", "price": 150, "change_24h": 0.0},
        {"symbol": "DEAD", "price": 0, "change_24h": 5.0},  # 无效价跳过
    ])
    _install_fetch(monkeypatch, "commodities", [
        {"symbol": "GC=F", "price": 2300, "change": 0.5},
        {"symbol": "CL=F", "price": 78, "change": -1.2},
    ])
    _install_fetch(monkeypatch, "forex", [
        {"symbol": "EUR/USD", "price": 1.08, "change": 0.1},
    ])
    _install_fetch(monkeypatch, "indices", [
        {"symbol": "^GSPC", "price": 5400, "change": 0.8},
    ])

    ov = gm._compute_market_overview()
    assert ov is not None
    s = ov["summary"]
    assert s == {"up": 4, "down": 2, "flat": 1, "total": 7}  # SOL flat、DEAD 跳过
    assert set(ov["sections"].keys()) == {"crypto", "commodities", "forex", "indices"}
    # crypto 归一化字段
    btc = ov["sections"]["crypto"][0]
    assert btc["symbol"] == "BTC" and btc["change_pct"] == 2.5 and btc["up"] is True
    # 无有效价条目已剔除
    syms = {x["symbol"] for x in ov["sections"]["crypto"]}
    assert "DEAD" not in syms


def test_market_overview_all_failed_returns_none(monkeypatch):
    for name in ("crypto", "commodities", "forex", "indices"):
        def _boom(*a, **k):
            raise RuntimeError("boom")

        import app.data_providers.commodities as commodities
        import app.data_providers.crypto as crypto
        import app.data_providers.forex as forex
        import app.data_providers.indices as indices
        mod = {"crypto": crypto, "commodities": commodities,
               "forex": forex, "indices": indices}[name]
        fn = {"crypto": "fetch_crypto_prices", "commodities": "fetch_commodities",
              "forex": "fetch_forex_pairs", "indices": "fetch_stock_indices"}[name]
        monkeypatch.setattr(mod, fn, _boom)
    assert gm._compute_market_overview() is None


def test_market_overview_partial_failure(monkeypatch):
    import app.data_providers.commodities as commodities
    import app.data_providers.crypto as crypto

    def _boom(*a, **k):
        raise RuntimeError("boom")

    monkeypatch.setattr(crypto, "fetch_crypto_prices", _boom)
    _install_fetch(monkeypatch, "commodities", [
        {"symbol": "GC=F", "price": 2300, "change": 0.5},
    ])
    ov = gm._compute_market_overview()
    assert ov is not None  # crypto 失败不影响 commodities
    assert "commodities" in ov["sections"] and "crypto" not in ov["sections"]


# ─── 落库测试 ─────────────────────────────────────────────

def test_collect_commodities_saves(monkeypatch):
    import app.data_providers.commodities as commodities
    monkeypatch.setattr(commodities, "fetch_commodities",
                        lambda: [{"symbol": "GC=F", "price": 2300, "change": 0.5}])
    saved = []
    monkeypatch.setattr(gm, "save_snapshot",
                        lambda p, t, d, s="": saved.append((p, t, d)))
    gm.GlobalMarketCollector()._collect_commodities()
    assert saved and saved[0][0] == "global_market" and saved[0][1] == "commodities"
    assert saved[0][2]["items"][0]["symbol"] == "GC=F"


def test_collect_commodities_empty_skips(monkeypatch):
    import app.data_providers.commodities as commodities
    monkeypatch.setattr(commodities, "fetch_commodities", lambda: [])
    saved = []
    monkeypatch.setattr(gm, "save_snapshot", lambda *a, **k: saved.append(a))
    gm.GlobalMarketCollector()._collect_commodities()
    assert saved == []


def test_collect_commodities_placeholder_skips(monkeypatch):
    """全占位（price=0）不落库，避免假数据进快照。"""
    import app.data_providers.commodities as commodities
    monkeypatch.setattr(commodities, "fetch_commodities", lambda: [
        {"symbol": "GC=F", "price": 0, "change": 0, "unit": "USD"},
        {"symbol": "CL=F", "price": 0, "change": 0, "unit": "USD"},
    ])
    saved = []
    monkeypatch.setattr(gm, "save_snapshot", lambda *a, **k: saved.append(a))
    gm.GlobalMarketCollector()._collect_commodities()
    assert saved == []


def test_collect_commodities_partial_valid_saved(monkeypatch):
    """部分真实数据：只落库有效价条目。"""
    import app.data_providers.commodities as commodities
    monkeypatch.setattr(commodities, "fetch_commodities", lambda: [
        {"symbol": "GC=F", "price": 0, "change": 0},
        {"symbol": "CL=F", "price": 78.5, "change": -1.2},
    ])
    saved = []
    monkeypatch.setattr(gm, "save_snapshot",
                        lambda p, t, d, s="": saved.append((p, t, d)))
    gm.GlobalMarketCollector()._collect_commodities()
    assert len(saved) == 1
    assert saved[0][2]["items"] == [
        {"symbol": "CL=F", "price": 78.5, "change": -1.2}
    ]


def test_collect_forex_saves(monkeypatch):
    import app.data_providers.forex as forex
    monkeypatch.setattr(forex, "fetch_forex_pairs",
                        lambda: [{"symbol": "EUR/USD", "price": 1.08, "change": 0.1}])
    saved = []
    monkeypatch.setattr(gm, "save_snapshot",
                        lambda p, t, d, s="": saved.append((p, t, d)))
    gm.GlobalMarketCollector()._collect_forex()
    assert saved and saved[0][1] == "forex_pairs"


def test_collect_overview_saves(monkeypatch):
    import app.data_providers.crypto as crypto
    monkeypatch.setattr(crypto, "fetch_crypto_prices",
                        lambda: [{"symbol": "BTC", "price": 60000, "change_24h": 2.5}])
    saved = []
    monkeypatch.setattr(gm, "save_snapshot",
                        lambda p, t, d, s="": saved.append((p, t, d)))
    gm.GlobalMarketCollector()._collect_overview()
    assert saved and saved[0][1] == "market_overview"
    assert saved[0][2]["summary"]["up"] == 1


# ─── 30min 节流 ───────────────────────────────────────────

def test_slow_data_throttled(monkeypatch):
    c = gm.GlobalMarketCollector()
    calls = {"commodities": 0, "forex": 0, "overview": 0}

    def _cc():
        calls["commodities"] += 1

    def _cf():
        calls["forex"] += 1

    def _co():
        calls["overview"] += 1

    monkeypatch.setattr(c, "_collect_commodities", _cc)
    monkeypatch.setattr(c, "_collect_forex", _cf)
    monkeypatch.setattr(c, "_collect_overview", _co)

    monkeypatch.setattr(gm, "GLOBAL_MARKET_COLLECT_ENABLED", True)
    c._pull_and_save()  # 首次：慢速 + 概览
    assert calls == {"commodities": 1, "forex": 1, "overview": 1}

    c._pull_and_save()  # 30min 内：只跑概览
    assert calls == {"commodities": 1, "forex": 1, "overview": 2}


def test_disabled_collector_skips(monkeypatch):
    c = gm.GlobalMarketCollector()
    called = []

    def _cc():
        called.append("cc")

    monkeypatch.setattr(c, "_collect_commodities", _cc)
    monkeypatch.setattr(gm, "GLOBAL_MARKET_COLLECT_ENABLED", False)
    c._pull_and_save()
    assert called == []
