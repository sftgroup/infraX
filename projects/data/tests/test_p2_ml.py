"""P2 单模型快照落库 + 历史查询单元测试（§5.7，不依赖网络）。

覆盖：
  - p2_ml._normalize_symbol / _save_predictions 幂等（UNIQUE 去重）
  - _purge_old 滚动清理
  - P2MlCollector._pull_and_save（monkeypatch ml_client：落库、禁用空转、异常 fail-silent）
  - factors.query_ml_predictions（区间过滤 / 符号归一化 / JSON 字段解析）
"""
from __future__ import annotations

import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("DATA_CONFIG_PATH", "data_config.json")

import pytest  # noqa: E402

from app import factors  # noqa: E402
from app.collectors import p2_ml  # noqa: E402


def _isolate_db(tmp_path, name: str):
    import app.storage.sqlite as sql
    sql._DB_PATH = str(tmp_path / name)
    sql._local.conn = None
    sql.init_db()
    return sql


def _p2_item(symbol="BTC", prob_up=0.9, direction="up", uncertainty="moderate"):
    return {
        "symbol": symbol,
        "direction": direction,
        "prob_up": prob_up,
        "uncertainty": uncertainty,
        "point_forecast": [1.0, 1.1],
        "quantiles": {"0.1": 0.9, "0.9": 1.2},
    }


# ── 落库幂等 / 符号归一化 ──────────────────────────────────

class TestSavePredictions:
    def test_normalize_symbol(self):
        assert p2_ml._normalize_symbol("BTC/USDT") == "BTC"
        assert p2_ml._normalize_symbol("BTC") == "BTC"

    def test_save_roundtrip_and_idempotent(self, tmp_path):
        sql = _isolate_db(tmp_path, "p2.db")
        now = int(time.time() * 1000)
        # 同一 model+symbol+generated_at 重复落库 → INSERT OR IGNORE 去重
        n1 = p2_ml._save_predictions("bolt", [_p2_item()], now)
        n2 = p2_ml._save_predictions("bolt", [_p2_item()], now)
        assert n1 == 1 and n2 == 1
        db = sql.get_db()
        assert db.execute("SELECT COUNT(*) FROM ml_predictions").fetchone()[0] == 1
        row = db.execute(
            "SELECT model, symbol, direction, prob_up, uncertainty, point_forecast, quantiles "
            "FROM ml_predictions").fetchone()
        assert row["model"] == "bolt" and row["symbol"] == "BTC"
        assert row["direction"] == "up" and row["prob_up"] == 0.9
        assert json.loads(row["point_forecast"]) == [1.0, 1.1]
        assert json.loads(row["quantiles"])["0.9"] == 1.2

    def test_save_normalizes_pair_symbol(self, tmp_path):
        sql = _isolate_db(tmp_path, "p2_norm.db")
        now = int(time.time() * 1000)
        p2_ml._save_predictions("timesfm", [_p2_item(symbol="BTC/USDT")], now)
        db = sql.get_db()
        assert db.execute(
            "SELECT symbol FROM ml_predictions WHERE model='timesfm'").fetchone()["symbol"] == "BTC"


# ── 滚动清理 ───────────────────────────────────────────────

class TestPurge:
    def test_purge_old_removes_expired_only(self, tmp_path):
        sql = _isolate_db(tmp_path, "p2_purge.db")
        now = int(time.time() * 1000)
        old = now - 100 * 86400 * 1000  # 100 天前
        p2_ml._save_predictions("bolt", [_p2_item()], now)
        p2_ml._save_predictions("bolt", [_p2_item()], old)  # 过期
        p2_ml._purge_old(90)
        db = sql.get_db()
        rows = db.execute("SELECT symbol FROM ml_predictions").fetchall()
        assert len(rows) == 1  # 旧行被清理，新行保留

    def test_purge_zero_keeps_all(self, tmp_path):
        sql = _isolate_db(tmp_path, "p2_purge0.db")
        p2_ml._save_predictions("bolt", [_p2_item()], int(time.time() * 1000))
        p2_ml._purge_old(0)
        assert sql.get_db().execute("SELECT COUNT(*) FROM ml_predictions").fetchone()[0] == 1


# ── collector 主流程（monkeypatch ml_client） ──────────────

class TestPullAndSave:
    def test_pull_and_save_all_models(self, monkeypatch, tmp_path):
        sql = _isolate_db(tmp_path, "p2_collect.db")
        monkeypatch.setattr(p2_ml, "P2_COLLECT_ENABLED", True)
        monkeypatch.setattr(p2_ml, "P2_RETENTION_DAYS", 90)
        monkeypatch.setattr(p2_ml.ml_client, "fetch_bolt",
                            lambda: [_p2_item(symbol="BTC"), _p2_item(symbol="ETH")])
        monkeypatch.setattr(p2_ml.ml_client, "fetch_moirai",
                            lambda: [_p2_item(symbol="BTC")])
        monkeypatch.setattr(p2_ml.ml_client, "fetch_timesfm",
                            lambda: [_p2_item(symbol="BTC")])

        p2_ml.P2MlCollector()._pull_and_save()

        db = sql.get_db()
        rows = [dict(r) for r in db.execute(
            "SELECT model, symbol FROM ml_predictions ORDER BY model, symbol").fetchall()]
        assert rows == [
            {"model": "bolt", "symbol": "BTC"},
            {"model": "bolt", "symbol": "ETH"},
            {"model": "moirai", "symbol": "BTC"},
            {"model": "timesfm", "symbol": "BTC"},
        ]

    def test_pull_and_save_disabled_noop(self, monkeypatch, tmp_path):
        sql = _isolate_db(tmp_path, "p2_disabled.db")
        monkeypatch.setattr(p2_ml, "P2_COLLECT_ENABLED", False)
        monkeypatch.setattr(p2_ml, "P2_RETENTION_DAYS", 90)

        def _boom():
            raise AssertionError("禁用时不应拉取")

        monkeypatch.setattr(p2_ml.ml_client, "fetch_bolt", _boom)
        monkeypatch.setattr(p2_ml.ml_client, "fetch_moirai", _boom)
        monkeypatch.setattr(p2_ml.ml_client, "fetch_timesfm", _boom)
        p2_ml.P2MlCollector()._pull_and_save()  # 静默空跑
        assert sql.get_db().execute("SELECT COUNT(*) FROM ml_predictions").fetchone()[0] == 0

    def test_pull_and_save_partial_failure_fail_silent(self, monkeypatch, tmp_path):
        sql = _isolate_db(tmp_path, "p2_partial.db")
        monkeypatch.setattr(p2_ml, "P2_COLLECT_ENABLED", True)
        monkeypatch.setattr(p2_ml, "P2_RETENTION_DAYS", 90)
        monkeypatch.setattr(p2_ml.ml_client, "fetch_bolt",
                            lambda: [_p2_item(symbol="BTC")])
        monkeypatch.setattr(p2_ml.ml_client, "fetch_moirai",
                            lambda: (_ for _ in ()).throw(RuntimeError("network down")))
        monkeypatch.setattr(p2_ml.ml_client, "fetch_timesfm", lambda: None)  # 无数据

        p2_ml.P2MlCollector()._pull_and_save()  # 不抛异常

        db = sql.get_db()
        rows = db.execute("SELECT DISTINCT model FROM ml_predictions").fetchall()
        assert [r["model"] for r in rows] == ["bolt"]  # 其余两模型被跳过


# ── 历史查询 ───────────────────────────────────────────────

class TestQueryPredictions:
    def _seed(self, tmp_path):
        sql = _isolate_db(tmp_path, "p2_query.db")
        base = 1_700_000_000_000
        p2_ml._save_predictions("bolt", [
            _p2_item(symbol="BTC", direction="up", prob_up=0.9),
        ], base + 1000)
        p2_ml._save_predictions("bolt", [
            _p2_item(symbol="BTC", direction="down", prob_up=0.3),
        ], base + 2000)
        p2_ml._save_predictions("bolt", [
            _p2_item(symbol="ETH", direction="up", prob_up=0.8),
        ], base + 3000)
        return sql, base

    def test_query_ascending_and_field_parse(self, tmp_path):
        self._seed(tmp_path)
        rows = factors.query_ml_predictions("bolt", "BTC")
        assert [r["direction"] for r in rows] == ["up", "down"]  # 升序
        assert rows[0]["prob_up"] == 0.9
        assert rows[0]["point_forecast"] == [1.0, 1.1]
        assert rows[0]["quantiles"]["0.9"] == 1.2

    def test_query_symbol_normalization(self, tmp_path):
        self._seed(tmp_path)
        rows = factors.query_ml_predictions("bolt", "BTC/USDT")
        assert len(rows) == 2  # 交易对归一化后命中 BTC

    def test_query_time_range_filter(self, tmp_path):
        sql, base = self._seed(tmp_path)
        rows = factors.query_ml_predictions("bolt", "BTC", start=base + 2000)
        assert [r["direction"] for r in rows] == ["down"]
        rows = factors.query_ml_predictions("bolt", "BTC", start=base + 1000, end=base + 1000)
        assert [r["direction"] for r in rows] == ["up"]
