"""BTC 转账流量采集（market_data._fetch_btc_transfers）单元测试（不依赖网络）。

覆盖：
  - mempool / height / avg_tx_24h 解析
  - 全部源失败返回 None（fail-silent）
  - _collect 接线：btc_transfers 落库（onchain provider）
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("DATA_CONFIG_PATH", "data_config.json")

import pytest  # noqa: E402

from app.collectors import market_data as md  # noqa: E402


class _FakeResp:
    def __init__(self, body, text=None):
        self._body = body
        self._text = str(body) if text is None else text

    def json(self):
        return self._body

    @property
    def text(self):
        return self._text


def _install_get(monkeypatch, routes):
    def fake_get(url, timeout=10, **kw):
        if url in routes:
            return routes[url]
        raise AssertionError(f"unexpected url: {url}")

    monkeypatch.setattr(md.requests, "get", fake_get)


def test_fetch_btc_transfers_success(monkeypatch):
    _install_get(monkeypatch, {
        "https://mempool.space/api/mempool": _FakeResp({"count": 42000, "vsize": 210_500_000}),
        "https://mempool.space/api/blocks/tip/height": _FakeResp("961073"),
        "https://mempool.space/api/v1/mining/blocks/recent": _FakeResp([
            {"tx_count": 100}, {"tx_count": 300},
        ]),
    })
    out = md._fetch_btc_transfers()
    assert out is not None
    assert out["mempool_txs"] == 42000
    assert out["mempool_vsize_mb"] == 210.5
    assert out["height"] == 961073
    assert out["avg_tx_24h"] == 200  # (100+300)/2


def test_fetch_btc_transfers_all_failed_returns_none(monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("boom")

    monkeypatch.setattr(md.requests, "get", boom)
    assert md._fetch_btc_transfers() is None


def test_fetch_btc_transfers_partial(monkeypatch):
    """部分源失败不阻塞其余。"""
    _install_get(monkeypatch, {
        "https://mempool.space/api/mempool": _FakeResp({"count": 42000, "vsize": 210_500_000}),
    })
    out = md._fetch_btc_transfers()
    assert out is not None
    assert out["mempool_txs"] == 42000
    assert "height" not in out  # tip/height 失败未 mock
    assert "avg_tx_24h" not in out


def test_collect_wires_btc_transfers(monkeypatch):
    """_collect 接线：transfers 非空 → onchain/btc_transfers 落库。"""
    saved = []
    monkeypatch.setattr(md, "save_snapshot",
                        lambda p, t, d, s="": saved.append((p, t, d)))
    # 其余 7 个源全部静默失败，避免触发网络/akshare/yfinance
    for name in (
        "_fetch_crypto_prices", "_fetch_global_indices", "_fetch_onchain",
        "_fetch_defi_tvl", "_fetch_volatility", "_fetch_macro_indicators",
        "_fetch_earnings",
    ):
        monkeypatch.setattr(md, name, lambda: None)
    monkeypatch.setattr(md, "_fetch_btc_transfers",
                        lambda: {"mempool_txs": 1, "height": 900000})

    md.SnapshotCollector()._collect()
    assert ("onchain", "btc_transfers") in [(p, t) for p, t, _ in saved]


def test_collect_skips_when_transfers_none(monkeypatch):
    """transfers 失败时不落库（fail-silent）。"""
    saved = []
    monkeypatch.setattr(md, "save_snapshot",
                        lambda p, t, d, s="": saved.append((p, t, d)))
    for name in (
        "_fetch_crypto_prices", "_fetch_global_indices", "_fetch_onchain",
        "_fetch_defi_tvl", "_fetch_volatility", "_fetch_macro_indicators",
        "_fetch_earnings", "_fetch_btc_transfers",
    ):
        monkeypatch.setattr(md, name, lambda: None)

    md.SnapshotCollector()._collect()
    assert not [1 for p, t, _ in saved if t == "btc_transfers"]
