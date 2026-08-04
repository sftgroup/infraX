"""DS-8 swap 采集器 + DS-7 /ticker 纯函数单元测试（不依赖网络）。

覆盖：
  - enrich._normalize_kline_symbol（/bars market_type 存储键规范化）
  - ticker.infer_market / _swap_symbol / _cn_prefix（市场推断与 swap 符号）
  - kline_store._swap_ccxt_symbol / _collect_swap（mock ccxt + 临时 SQLite，
    验证采集调用符号、落库键、指标完整性、禁用/异常 fail-silent）
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("DATA_CONFIG_PATH", "data_config.json")

import pytest  # noqa: E402

from app import enrich  # noqa: E402
from app import kline_store as ks  # noqa: E402
from app import ticker  # noqa: E402


def _mock_ohlcv(n: int = 60, start_price: float = 100.0) -> list:
    """生成 n 根可算指标的模拟 OHLCV（ts 间隔 1min）。"""
    base_ts = 1_700_000_000_000
    rows, price = [], start_price
    for i in range(n):
        price += 0.5
        rows.append([base_ts + i * 60_000, price, price + 1, price - 1, price, 1000.0])
    return rows


def _isolate_db(tmp_path, name: str):
    """把 sqlite 连接重定向到独立临时 DB 并建表。"""
    import app.storage.sqlite as sql
    sql._DB_PATH = str(tmp_path / name)
    sql._local.conn = None
    sql.init_db()
    return sql


# ── /bars market_type 存储键规范化 ─────────────────────────

class TestNormalizeKlineSymbol:
    def test_spot_keeps_pair(self):
        assert enrich._normalize_kline_symbol("BTC/USDT", "spot") == "BTC/USDT"

    def test_swap_appends_quote(self):
        assert enrich._normalize_kline_symbol("BTC/USDT", "swap") == "BTC/USDT:USDT"

    def test_swap_suffix_kept_as_is(self):
        assert enrich._normalize_kline_symbol("BTC/USDT:USDT", "swap") == "BTC/USDT:USDT"

    def test_non_pair_unaffected(self):
        assert enrich._normalize_kline_symbol("AAPL", "swap") == "AAPL"
        assert enrich._normalize_kline_symbol("EURUSD=X", "swap") == "EURUSD=X"


# ── ticker 市场推断 / swap 符号 ───────────────────────────

class TestTickerHelpers:
    def test_infer_market(self):
        assert ticker.infer_market("BTC/USDT") == "crypto"
        assert ticker.infer_market("AAPL") == "usstock"
        assert ticker.infer_market("EURUSD=X") == "forex"
        assert ticker.infer_market("GC=F") == "futures"
        assert ticker.infer_market("000333") == "cnstock"
        assert ticker.infer_market("00700") == "hkstock"

    def test_swap_symbol(self):
        assert ticker._swap_symbol("BTC/USDT") == "BTC/USDT:USDT"
        assert ticker._swap_symbol("BTC/USDT:USDT") == "BTC/USDT:USDT"
        assert ticker._swap_symbol("AAPL") == "AAPL"

    def test_cn_prefix(self):
        assert ticker._cn_prefix("600519") == "sh"
        assert ticker._cn_prefix("000333") == "sz"
        assert ticker._cn_prefix("002594") == "sz"


# ── swap 采集器 ──────────────────────────────────────────

class TestSwapCollector:
    def test_swap_ccxt_symbol(self):
        assert ks._swap_ccxt_symbol("BTC/USDT") == "BTC/USDT:USDT"
        assert ks._swap_ccxt_symbol("BTC/USDT:USDT") == "BTC/USDT:USDT"
        assert ks._swap_ccxt_symbol("AAPL") == "AAPL"

    def test_collect_swap_uses_swap_key_and_indicators(self, monkeypatch, tmp_path):
        sql = _isolate_db(tmp_path, "swap_test.db")

        class FakeEx:
            def __init__(self):
                self.calls = []

            def fetch_ohlcv(self, symbol, timeframe, limit=None):
                self.calls.append((symbol, timeframe))
                return _mock_ohlcv()

        fake = FakeEx()
        monkeypatch.setattr(ks, "KL_SWAP_ENABLED", True)
        monkeypatch.setattr(ks, "_SWAP_SYMBOLS", ["BTC/USDT", "ETH/USDT"])
        monkeypatch.setattr(ks, "_SWAP_TIMEFRAMES", ["1m"])
        monkeypatch.setattr(ks.KlineStore, "_get_exchange", lambda self: fake)

        ks.KlineStore()._collect_swap()

        # ccxt 调用符号为 base/quote:quote，落库键一致
        assert fake.calls == [("BTC/USDT:USDT", "1m"), ("ETH/USDT:USDT", "1m")]
        db = sql.get_db()
        syms = {r["symbol"] for r in db.execute(
            "SELECT DISTINCT symbol FROM kline").fetchall()}
        assert syms == {"BTC/USDT:USDT", "ETH/USDT:USDT"}
        # 指标完整（末根 rsi/macd/bb/atr/ma 均已计算）
        row = db.execute(
            "SELECT rsi_14, macd, bb_upper, atr_14, ma_20 FROM kline "
            "WHERE symbol='BTC/USDT:USDT' ORDER BY ts DESC LIMIT 1").fetchone()
        assert row["rsi_14"] is not None
        assert row["macd"] is not None
        assert row["bb_upper"] is not None
        assert row["atr_14"] is not None
        assert row["ma_20"] is not None

    def test_collect_swap_disabled_noop(self, monkeypatch, tmp_path):
        sql = _isolate_db(tmp_path, "swap_disabled.db")
        monkeypatch.setattr(ks, "KL_SWAP_ENABLED", False)
        monkeypatch.setattr(ks, "_SWAP_SYMBOLS", ["BTC/USDT"])

        class FakeEx:
            def fetch_ohlcv(self, *a, **k):
                raise AssertionError("禁用时不应触发采集")

        monkeypatch.setattr(ks.KlineStore, "_get_exchange", lambda self: FakeEx())
        ks.KlineStore()._collect_swap()  # 静默空跑
        assert sql.get_db().execute("SELECT COUNT(*) FROM kline").fetchone()[0] == 0

    def test_collect_swap_fetch_error_fail_silent(self, monkeypatch, tmp_path):
        sql = _isolate_db(tmp_path, "swap_err.db")
        monkeypatch.setattr(ks, "KL_SWAP_ENABLED", True)
        monkeypatch.setattr(ks, "_SWAP_SYMBOLS", ["BTC/USDT", "ETH/USDT"])
        monkeypatch.setattr(ks, "_SWAP_TIMEFRAMES", ["1m"])

        class FakeEx:
            def fetch_ohlcv(self, *a, **k):
                raise RuntimeError("network down")

        monkeypatch.setattr(ks.KlineStore, "_get_exchange", lambda self: FakeEx())
        ks.KlineStore()._collect_swap()  # 全部失败不抛异常
        assert sql.get_db().execute("SELECT COUNT(*) FROM kline").fetchone()[0] == 0

    def test_upsert_bars_roundtrip(self, tmp_path):
        """_upsert_bars_with_indicators 幂等：重复 upsert 不产生重复行。"""
        sql = _isolate_db(tmp_path, "upsert.db")
        store = ks.KlineStore()
        ohlcv = _mock_ohlcv(40)
        n1 = store._upsert_bars_with_indicators("BTC/USDT:USDT", "1m", ohlcv)
        n2 = store._upsert_bars_with_indicators("BTC/USDT:USDT", "1m", ohlcv)
        assert n1 == n2 == len(ohlcv)
        total = sql.get_db().execute(
            "SELECT COUNT(*) FROM kline WHERE symbol='BTC/USDT:USDT'").fetchone()[0]
        assert total == len(ohlcv)  # INSERT OR REPLACE 去重
