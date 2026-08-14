"""scheduler.py（FF-4.1 定时挖掘调度）纯逻辑单测。

只测决策/解析/启停逻辑，不启动真实循环、不触网络、不落库：
  - should_run：无任务/活跃任务/距上次终态间隔 三场景
  - build_default_spec：SPEC JSON 与 INTENT（mock parse_intent）两来源
  - start_miner_scheduler：禁用/缺配置/正常 三场景
"""
from __future__ import annotations

import json
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest  # noqa: E402

import config  # noqa: E402
from app.factorengine import scheduler as sch  # noqa: E402


class _FakeStore:
    """最小 store 替身：只暴露 scheduler 用到的 list()。"""

    def __init__(self, jobs):
        self._jobs = jobs

    def list(self, limit=50):
        return self._jobs[:limit]


def _job(status, updated_at, created_at=None):
    return {"status": status, "updated_at": updated_at,
            "created_at": created_at or updated_at}


class TestShouldRun:
    def test_no_jobs_returns_true(self):
        assert sch.should_run(_FakeStore([]), interval_s=6 * 3600) is True

    def test_queued_job_skips(self):
        store = _FakeStore([_job("QUEUED", int(time.time() * 1000))])
        assert sch.should_run(store, 6 * 3600) is False

    def test_running_job_skips(self):
        store = _FakeStore([_job("RUNNING", int(time.time() * 1000))])
        assert sch.should_run(store, 6 * 3600) is False

    def test_recent_terminal_skips(self):
        # 10 分钟前完成（interval 6h）→ 跳过，防重启重复跑
        store = _FakeStore([_job("COMPLETED", int(time.time() * 1000) - 600_000)])
        assert sch.should_run(store, 6 * 3600) is False

    def test_old_terminal_runs(self):
        # 7 小时前完成（interval 6h）→ 触发
        store = _FakeStore([_job("FAILED", int(time.time() * 1000) - 7 * 3600_000)])
        assert sch.should_run(store, 6 * 3600) is True


class TestBuildDefaultSpec:
    def test_spec_json_source(self, monkeypatch):
        monkeypatch.setattr(config, "FACTOR_MINER_SCHEDULE_INTENT", "")
        monkeypatch.setattr(config, "FACTOR_MINER_SCHEDULE_SPEC", json.dumps({
            "preferences": {"asset_pool": ["BTC", "ETH"], "timeframe": "1d", "horizon": 5},
            "constraints": {"max_factors": 10, "max_runtime_min": 30, "max_targets": 5},
        }))
        spec, conflicts = sch.build_default_spec()
        assert conflicts == []
        assert spec.preferences.asset_pool == ["BTC", "ETH"]
        assert spec.constraints.max_factors == 10
        assert spec.constraints.max_runtime_min == 30

    def test_intent_source_preferred(self, monkeypatch):
        import app.factorengine.intent as intent_mod

        monkeypatch.setattr(config, "FACTOR_MINER_SCHEDULE_INTENT", "挖掘波动率因子")
        monkeypatch.setattr(
            intent_mod, "parse_intent",
            lambda text: {"preferences": {"factor_styles": ["volatility"]},
                          "constraints": {"max_factors": 3}})
        spec, conflicts = sch.build_default_spec()
        assert conflicts == []
        assert spec.preferences.factor_styles == ["volatility"]
        assert spec.constraints.max_factors == 3

    def test_bad_json_raises(self, monkeypatch):
        monkeypatch.setattr(config, "FACTOR_MINER_SCHEDULE_INTENT", "")
        monkeypatch.setattr(config, "FACTOR_MINER_SCHEDULE_SPEC", "{not json")
        with pytest.raises(Exception):
            sch.build_default_spec()


class TestStartScheduler:
    def test_disabled_returns_none(self, monkeypatch):
        monkeypatch.setattr(config, "FACTOR_MINER_SCHEDULE_ENABLED", False)
        assert sch.start_miner_scheduler() is None

    def test_enabled_no_spec_returns_none(self, monkeypatch):
        monkeypatch.setattr(config, "FACTOR_MINER_SCHEDULE_ENABLED", True)
        monkeypatch.setattr(config, "FACTOR_MINER_SCHEDULE_INTENT", "")
        monkeypatch.setattr(config, "FACTOR_MINER_SCHEDULE_SPEC", "")
        assert sch.start_miner_scheduler() is None

    def test_enabled_with_spec_starts_thread(self, monkeypatch):
        monkeypatch.setattr(config, "FACTOR_MINER_SCHEDULE_ENABLED", True)
        monkeypatch.setattr(config, "FACTOR_MINER_SCHEDULE_INTENT", "")
        monkeypatch.setattr(config, "FACTOR_MINER_SCHEDULE_SPEC", json.dumps({
            "preferences": {}, "constraints": {}}))
        monkeypatch.setattr(config, "FACTOR_MINER_SCHEDULE_DELAY_S", 1e9)  # 测试期间不 tick
        t = sch.start_miner_scheduler()
        assert t is not None and t.is_alive()
        assert t.daemon is True
