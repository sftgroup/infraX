"""符号搜索（DS-9）单元测试（不依赖网络）。

覆盖：
  - crypto 关键字搜索命中 spot/swap 双市场（monkeypatch ccxt 全量列表）
  - limit 生效
  - ccxt 拉取失败回退种子（fail-silent）
  - usstock / forex / futures 种子搜索
  - 空 keyword 返回前 N 个
  - 无效 market 返回空
  - get_hot_symbols
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("DATA_CONFIG_PATH", "data_config.json")

import pytest  # noqa: E402

from app import symbol_search  # noqa: E402


def _mk(sym, mtype="spot", active=True):
    return {
        "symbol": sym,
        "market": "crypto",
        "market_type": mtype,
        "exchange": "binance",
        "active": active,
    }


_FAKE_MARKETS = [
    _mk("BTC/USDT", "spot"),
    _mk("BTC/USDT:USDT", "swap"),
    _mk("BTCB/USDT", "spot"),
    _mk("BTCB/USDT:USDT", "swap"),
    _mk("WBTC/USDT", "spot"),
    _mk("TBTC/USDT", "spot"),
    _mk("1000BTCT/USDT", "spot"),
    _mk("ETH/USDT", "spot"),
    _mk("ETH/USDT:USDT", "swap"),
    _mk("SOL/USDT", "spot"),
]


@pytest.fixture(autouse=True)
def _reset_cache():
    symbol_search._crypto_markets = None
    symbol_search._crypto_fetched_at = 0.0
    yield
    symbol_search._crypto_markets = None
    symbol_search._crypto_fetched_at = 0.0


def test_crypto_btc_hits_spot_and_swap(monkeypatch):
    monkeypatch.setattr(symbol_search, "_load_crypto_markets", lambda: _FAKE_MARKETS)
    results = symbol_search.search_symbols("btc", "crypto", 100)
    syms = [r["symbol"] for r in results]
    assert "BTC/USDT" in syms and "BTC/USDT:USDT" in syms
    assert len(syms) >= 5  # 含 btc 子串的多对
    for r in results:
        assert r["active"] is True
        assert r["market"] == "crypto"
    # 双市场区分正确
    swap = [r for r in results if r["symbol"] == "BTC/USDT:USDT"]
    spot = [r for r in results if r["symbol"] == "BTC/USDT"]
    assert swap and swap[0]["market_type"] == "swap"
    assert spot and spot[0]["market_type"] == "spot"


def test_limit_applies(monkeypatch):
    monkeypatch.setattr(symbol_search, "_load_crypto_markets", lambda: _FAKE_MARKETS)
    results = symbol_search.search_symbols("btc", "crypto", 2)
    assert len(results) == 2


def test_ccxt_failure_falls_back_to_seed(monkeypatch):
    monkeypatch.setattr(symbol_search, "_load_crypto_markets", lambda: None)
    results = symbol_search.search_symbols("btc", "crypto", 100)
    assert results == [
        {"symbol": "BTC/USDT", "market": "crypto", "market_type": "spot",
         "exchange": "", "active": True}
    ]


def test_empty_keyword_returns_first_n(monkeypatch):
    monkeypatch.setattr(symbol_search, "_load_crypto_markets", lambda: _FAKE_MARKETS)
    results = symbol_search.search_symbols("", "crypto", 3)
    assert [r["symbol"] for r in results] == [
        "BTC/USDT", "BTC/USDT:USDT", "BTCB/USDT"
    ]


def test_usstock_seed_search():
    results = symbol_search.search_symbols("aapl", "usstock", 20)
    assert results and results[0]["symbol"] == "AAPL"


def test_forex_seed_search():
    results = symbol_search.search_symbols("eur", "forex", 20)
    syms = {r["symbol"] for r in results}
    assert "EUR/USD" in syms and "EUR/GBP" in syms


def test_futures_seed_search():
    results = symbol_search.search_symbols("gold", "futures", 20)
    assert results and results[0]["symbol"] == "GC=F"


def test_invalid_market_returns_empty():
    assert symbol_search.search_symbols("btc", "nonsense", 20) == []


def test_get_hot_symbols(monkeypatch):
    monkeypatch.setattr(symbol_search, "_load_crypto_markets", lambda: _FAKE_MARKETS)
    hot = symbol_search.get_hot_symbols("crypto", 2)
    assert len(hot) == 2 and hot[0]["symbol"] == "BTC/USDT"
