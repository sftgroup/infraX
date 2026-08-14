"""app/factorengine jobs/catalog 状态机 + 持久化单测（需求5 R5-2 / 需求6 FF-3）。

用临时 SQLite 文件隔离全局 FACTOR_DB_PATH，不碰生产库：
  - JobStore: create/update/get/list/save_results/results/recover
  - 状态机流转：CREATED→PARSED→QUEUED→RUNNING→COMPLETED / FAILED / TIMEOUT
  - cancel 语义：仅非终态可取消
  - CatalogStore: upsert/list/set_status/active_keys + register_qualified
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest  # noqa: E402

import config  # noqa: E402
from app.factorengine.job import build_spec  # noqa: E402
from app.factorengine.jobs import (  # noqa: E402
    JobStatus,
    JobStore,
    cancel_job,
    get_store,
)
from app.factorengine.catalog import CatalogStore, register_qualified  # noqa: E402


@pytest.fixture()
def store(tmp_path):
    return JobStore(str(tmp_path / "ff_test.db"))


# ── JobStore CRUD ──────────────────────────────────────────


class TestJobStore:
    def test_create_and_get(self, store):
        spec, _ = build_spec()
        job = store.create(spec)
        assert job["job_id"].startswith("ff_")
        assert job["status"] == JobStatus.CREATED.value
        got = store.get(job["job_id"])
        assert got["spec"]["preferences"]["timeframe"] == "1d"

    def test_update_status(self, store):
        spec, _ = build_spec()
        job = store.create(spec)
        store.update(job["job_id"], status=JobStatus.RUNNING, stage="eval")
        got = store.get(job["job_id"])
        assert got["status"] == JobStatus.RUNNING.value
        assert got["stage"] == "eval"

    def test_list_order(self, store):
        for _ in range(3):
            store.create(build_spec()[0])
        rows = store.list()
        assert len(rows) == 3

    def test_save_and_read_results(self, store):
        spec, _ = build_spec()
        job = store.create(spec)
        store.save_results(job["job_id"], [
            {"factor_key": "ret_5", "ic": 0.05, "icir": 0.4, "passed": True, "detail": {}},
            {"factor_key": "vol_20", "ic": 0.01, "icir": 0.1, "passed": False, "detail": {}},
        ])
        results = store.results(job["job_id"])
        assert len(results) == 2
        assert results[0]["factor_key"] == "ret_5"  # 按 ic 降序

    def test_recover_marks_running_failed(self, store):
        spec, _ = build_spec()
        job = store.create(spec)
        store.update(job["job_id"], status=JobStatus.RUNNING, stage="pool")
        store.recover()
        got = store.get(job["job_id"])
        assert got["status"] == JobStatus.FAILED.value
        assert "restarted" in (got.get("error") or "")

    def test_cancel_semantics(self, store, monkeypatch):
        # cancel_job/job_status 走全局 get_store() → patch 指向临时库
        import app.factorengine.jobs as jobs_mod
        monkeypatch.setattr(jobs_mod, "_store", store)
        spec, _ = build_spec()
        job = store.create(spec)
        store.update(job["job_id"], status=JobStatus.QUEUED)
        assert cancel_job(job["job_id"]) is True
        assert store.get(job["job_id"])["status"] == JobStatus.CANCELLED.value
        # 终态不可再取消
        assert cancel_job(job["job_id"]) is False

    def test_run_wrapper_none_marks_failed(self, store, monkeypatch):
        # 回归：run_mine 返回 None（无可用数据）→ job 必须落 FAILED，不能停 RUNNING
        import app.factorengine.jobs as jobs_mod
        monkeypatch.setattr(jobs_mod, "_store", store)
        import app.factorengine.runner as runner_mod
        monkeypatch.setattr(runner_mod, "run_mine", lambda spec, progress=None: None)
        spec, _ = build_spec()
        job = store.create(spec)
        jobs_mod._run_wrapper(job["job_id"], spec)
        got = store.get(job["job_id"])
        assert got["status"] == JobStatus.FAILED.value
        assert "无可用数据" in (got.get("error") or "")

    def test_run_wrapper_cancelled_before_run(self, store, monkeypatch):
        # 回归：job 已在 _cancelled（cancel_job 已落 CANCELLED）→ _run_wrapper 直接终止，
        # 不得被无条件 RUNNING 覆盖
        import app.factorengine.jobs as jobs_mod
        monkeypatch.setattr(jobs_mod, "_store", store)
        spec, _ = build_spec()
        job = store.create(spec)
        store.update(job["job_id"], status=JobStatus.CANCELLED, error="cancelled by user")
        jobs_mod._cancelled.add(job["job_id"])
        jobs_mod._run_wrapper(job["job_id"], spec)
        got = store.get(job["job_id"])
        assert got["status"] == JobStatus.CANCELLED.value

    def test_run_wrapper_completed_registers_catalog(self, store, monkeypatch):
        # 回归（FF-3.1）：job 完成 → passed 因子登记 catalog。
        # 关闭自动闭环开关，验证旧语义：登记为 inactive（待人工激活）。
        monkeypatch.setattr(config, "FACTOR_MINER_AUTO_ACTIVATE", False)
        monkeypatch.setattr(config, "FACTOR_MINER_AUTO_RETRAIN", False)
        import app.factorengine.jobs as jobs_mod
        monkeypatch.setattr(jobs_mod, "_store", store)
        import app.factorengine.catalog as cat_mod
        cat_mod._catalog = None  # 重建 catalog 单例，复用 patched store 的同库连接
        import app.factorengine.runner as runner_mod

        def fake_run(spec, progress=None):
            for s in ("pool", "eval", "select", "persist"):
                if progress and not progress(s):
                    return None
            return {"results": [
                {"factor_key": "ret_5", "ic": 0.05, "icir": 0.4, "passed": True},
                {"factor_key": "vol_20", "ic": 0.01, "icir": 0.1, "passed": False},
            ], "selected": ["ret_5"], "stats": {}}
        monkeypatch.setattr(runner_mod, "run_mine", fake_run)
        spec, _ = build_spec()
        job = store.create(spec)
        jobs_mod._run_wrapper(job["job_id"], spec)
        got = store.get(job["job_id"])
        assert got["status"] == JobStatus.COMPLETED.value
        cat = cat_mod.get_catalog()
        row = cat.get("ret_5")
        assert row is not None and row["status"] == "inactive"
        assert "auto-mined" in row["description"]
        assert cat.get("vol_20") is None  # 未 passed 不登记

    def test_run_wrapper_auto_closed_loop(self, store, monkeypatch):
        # 自动闭环（FF-4.3）：passed 因子登记后自动激活 + 置模型过期（下次预测重训）
        monkeypatch.setattr(config, "FACTOR_MINER_AUTO_ACTIVATE", True)
        monkeypatch.setattr(config, "FACTOR_MINER_AUTO_RETRAIN", True)
        import app.factorengine.jobs as jobs_mod
        monkeypatch.setattr(jobs_mod, "_store", store)
        import app.factorengine.catalog as cat_mod
        cat_mod._catalog = None
        import app.factorengine.runner as runner_mod
        invalidated = []

        def fake_run(spec, progress=None):
            for s in ("pool", "eval", "select", "persist"):
                if progress and not progress(s):
                    return None
            return {"results": [
                {"factor_key": "ret_5", "ic": 0.05, "icir": 0.4, "passed": True},
            ], "selected": ["ret_5"], "stats": {}}

        monkeypatch.setattr(runner_mod, "run_mine", fake_run)
        import app.analytics.tree_models as tm_mod
        monkeypatch.setattr(tm_mod, "invalidate_models",
                            lambda: invalidated.append(1))
        spec, _ = build_spec()
        job = store.create(spec)
        jobs_mod._run_wrapper(job["job_id"], spec)
        cat = cat_mod.get_catalog()
        assert cat.get("ret_5")["status"] == "active"  # 自动激活
        assert len(invalidated) == 1  # 置模型过期一次

    def test_health_check_active_decays(self, store, monkeypatch):
        # 衰退淘汰（FF-4.4）：|IC|/|ICIR| 低于停用阈值的激活因子自动停用；
        # 未登记评估环境（asset_pool）的因子跳过（不误停用）。
        import numpy as np
        import pandas as pd
        import app.factorengine.jobs as jobs_mod
        monkeypatch.setattr(jobs_mod, "_store", store)  # 隔离真实 DB，防污染生产 catalog
        import app.factorengine.catalog as cat_mod
        cat_mod._catalog = None
        cat = cat_mod.get_catalog()
        base = {"name": "x", "category": "L0", "template": None,
                "description": "t", "source": "t", "version": "1.0",
                "registered_at": 0, "updated_at": 0}
        cat.upsert({"factor_key": "decay_me", "status": "active",
                    "params": {"asset_pool": ["X"], "horizon": 1}, **base})
        cat.upsert({"factor_key": "no_env", "status": "active",
                    "params": {}, **base})
        n = 200
        idx = pd.date_range("2024-01-01", periods=n, freq="D")
        close = pd.Series(np.arange(n) + np.sin(np.arange(n)), index=idx)
        df = pd.DataFrame({"close": close.values}, index=idx)
        # 假因子：与未来收益无相关（IC≈0）→ 衰减停用
        monkeypatch.setattr("app.factorengine.runner._kline_df",
                            lambda sym, timeframe="1d": df)
        monkeypatch.setattr("app.factorengine.factors.compute_factor",
                            lambda key, d: pd.Series(
                                np.sin(np.arange(len(d))) * 0.001 + 0.0001,
                                index=d.index))
        n_decay = cat_mod.health_check_active()
        assert n_decay == 1
        assert cat.get("decay_me")["status"] == "inactive"
        assert "decayed" in cat.get("decay_me")["description"]
        assert cat.get("no_env")["status"] == "active"  # 未登记环境跳过


# ── CatalogStore（FF-3） ───────────────────────────────────


@pytest.fixture()
def cat_store(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "FACTOR_DB_PATH", str(tmp_path / "ff_cat.db"))
    # 清全局单例，确保指向临时库
    import app.factorengine.jobs as _jobs
    _jobs._store = None
    import app.factorengine.catalog as _cat
    _cat._catalog = None
    return CatalogStore()


class TestCatalog:
    def test_upsert_list_status(self, cat_store):
        cat_store.upsert({
            "factor_key": "ret_5", "name": "Ret(5)", "category": "L0",
            "template": "ret", "params": {"n": 5}, "updated_at": 1,
        })
        rows = cat_store.list()
        assert len(rows) == 1 and rows[0]["factor_key"] == "ret_5"
        assert cat_store.set_status("ret_5", "inactive") is True
        assert cat_store.active_keys() == []
        assert cat_store.set_status("ret_5", "active") is True
        assert cat_store.active_keys() == ["ret_5"]
        assert cat_store.set_status("nope", "active") is False  # 不存在

    def test_register_qualified_only_passed(self, cat_store, store):
        spec, _ = build_spec()
        job = store.create(spec)
        n = register_qualified(job["job_id"], [
            {"factor_key": "ret_5", "ic": 0.05, "icir": 0.4, "passed": True},
            {"factor_key": "vol_20", "ic": 0.01, "icir": 0.1, "passed": False},
        ])
        assert n == 1
        row = cat_store.get("ret_5")
        assert row is not None and row["status"] == "inactive"  # 待人工激活
        assert cat_store.get("vol_20") is None
