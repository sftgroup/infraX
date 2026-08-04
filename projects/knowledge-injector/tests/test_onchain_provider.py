"""onchain provider（BTC 转账流量/巨鲸大额转账）单元测试（mock requests，不依赖网络）。

覆盖：
  - fetch_btc_transfers 三路数据解析（mempool/height/avg_tx_24h）
  - 巨鲸大额转账识别（out/in 方向、金额、24h 窗口过滤）
  - 全部失败返回 None（fail-silent）
"""
from __future__ import annotations

import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest  # noqa: E402

from providers import onchain as oc  # noqa: E402


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

    monkeypatch.setattr(oc.requests, "get", fake_get)


def _base_routes():
    routes = {
        f"{oc._MEMPOOL_SPACE}/mempool": _FakeResp({"count": 42000, "vsize": 210_500_000}),
        f"{oc._MEMPOOL_SPACE}/blocks/tip/height": _FakeResp("961073"),
        f"{oc._MEMPOOL_SPACE}/v1/mining/blocks/recent": _FakeResp([
            {"tx_count": 100}, {"tx_count": 300},
        ]),
    }
    for addr in oc._WHALE_ADDRESSES.values():
        routes[f"{oc._MEMPOOL_SPACE}/address/{addr}/txs"] = _FakeResp([])
    return routes


def test_fetch_btc_transfers_full(monkeypatch):
    _install_get(monkeypatch, _base_routes())
    out = oc.fetch_btc_transfers()
    assert out is not None
    assert out["mempool_txs"] == 42000
    assert out["mempool_vsize_mb"] == 210.5
    assert out["height"] == 961073
    assert out["avg_tx_24h"] == 200
    assert out["block_time"] is None  # recent[0] 无 timestamp 字段


def test_fetch_btc_transfers_fail_silent(monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("boom")

    monkeypatch.setattr(oc.requests, "get", boom)
    assert oc.fetch_btc_transfers() is None


def test_whale_movement_out_detected(monkeypatch):
    addr = list(oc._WHALE_ADDRESSES.values())[0]
    name = list(oc._WHALE_ADDRESSES.keys())[0]
    now = int(__import__("time").time())
    tx = {
        "txid": "a" * 64,
        "status": {"confirmed": True, "block_time": now - 3600},
        "vin": [{"prevout": {"scriptpubkey_address": addr, "value": 500_000_000_00}}],  # 500 BTC
        "vout": [{"scriptpubkey_address": "1Someone", "value": 490_000_000_00}],
    }
    _install_get(monkeypatch, {
        f"{oc._MEMPOOL_SPACE}/address/{addr}/txs": _FakeResp([tx]),
    })
    mvs = oc._fetch_whale_movements()
    assert mvs and mvs[0]["name"] == name
    assert mvs[0]["direction"] == "out"
    assert mvs[0]["amount_btc"] == 500.0
    assert len(mvs[0]["txid"]) == 16  # 截断


def test_whale_movement_in_detected(monkeypatch):
    addr = list(oc._WHALE_ADDRESSES.values())[0]
    now = int(__import__("time").time())
    tx = {
        "txid": "b" * 64,
        "status": {"confirmed": True, "block_time": now - 1800},
        "vin": [],
        "vout": [{"scriptpubkey_address": addr, "value": 150_000_000_00}],  # 150 BTC
    }
    _install_get(monkeypatch, {
        f"{oc._MEMPOOL_SPACE}/address/{addr}/txs": _FakeResp([tx]),
    })
    mvs = oc._fetch_whale_movements()
    assert mvs and mvs[0]["direction"] == "in"
    assert mvs[0]["amount_btc"] == 150.0


def test_whale_movement_window_filtered(monkeypatch):
    """24h 窗口外（>24h）的交易不识别。"""
    addr = list(oc._WHALE_ADDRESSES.values())[0]
    now = int(__import__("time").time())
    old = {"txid": "c" * 64, "status": {"confirmed": True, "block_time": now - 3 * 86400},
           "vin": [], "vout": [{"scriptpubkey_address": addr, "value": 500_000_000_00}]}
    unconfirmed = {"txid": "d" * 64, "status": {"confirmed": False},
                   "vin": [], "vout": [{"scriptpubkey_address": addr, "value": 500_000_000_00}]}
    _install_get(monkeypatch, {
        f"{oc._MEMPOOL_SPACE}/address/{addr}/txs": _FakeResp([old, unconfirmed]),
    })
    assert oc._fetch_whale_movements() == []
