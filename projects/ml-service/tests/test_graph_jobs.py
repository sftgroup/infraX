"""GP-2/GP-3 图谱异步化：AsyncCacheRunner job 跟踪 + /ml/graph/edges 202 冷态 + job 查询。

覆盖：
  - trigger 新启动返回 job_id / 同 key 防重入返回 None
  - active_job_id / get_job_status（running→success / error 带 error 信息）
  - 任务记录裁剪（_JOB_KEEP_MAX）
  - /ml/graph/edges 冷态 → 202 + meta.status=building + meta.job_id；就绪 → 200 + ready
  - /ml/graph/jobs/{job_id} 200 / 404
"""
import threading
import time

from fastapi.testclient import TestClient

from app.async_cache import AsyncCacheRunner
from app.cache import TTLCache

import main as M


# ── AsyncCacheRunner job 跟踪 ──────────────────────────────

def test_job_tracking_roundtrip():
    release = threading.Event()
    runner = AsyncCacheRunner(TTLCache(), ttl=60)

    def slow():
        release.wait(timeout=3)
        return {"ok": True}

    job_id = runner.trigger("graph_edges", slow)
    assert job_id and job_id.startswith("graph_edges-")
    assert runner.trigger("graph_edges", slow) is None  # 防重入
    assert runner.active_job_id("graph_edges") == job_id
    assert runner.get_job_status(job_id)["status"] == "running"

    release.set()
    for _ in range(50):
        if runner.active_job_id("graph_edges") is None:
            break
        time.sleep(0.1)
    st = runner.get_job_status(job_id)
    assert st is not None and st["status"] == "success"
    assert st["duration_ms"] is not None and st["finished_at"] is not None
    assert runner.get_job_status("nope-1") is None
    assert runner.active_job_id("graph_edges") is None


def test_job_error_status():
    r2 = threading.Event()
    runner = AsyncCacheRunner(TTLCache(), ttl=60)

    def boom():
        r2.wait(timeout=3)
        raise RuntimeError("boom")

    job_id = runner.trigger("graph_edges_err", boom)
    r2.set()
    for _ in range(50):
        if runner.active_job_id("graph_edges_err") is None:
            break
        time.sleep(0.1)
    st = runner.get_job_status(job_id)
    assert st["status"] == "error" and st["error"] == "boom"


def test_job_trim_caps():
    runner = AsyncCacheRunner(TTLCache(), ttl=60)
    runner._JOB_KEEP_MAX = 3
    for i in range(6):
        runner.trigger(f"k{i}", lambda: 1)
        time.sleep(0.01)
    while runner._running:
        time.sleep(0.05)
    assert len(runner._jobs) <= 3


# ── /ml/graph/edges 202 冷态 + /ml/graph/jobs ──────────────

def _client() -> TestClient:
    return TestClient(M.app)


def test_graph_edges_cold_202_and_job_query(monkeypatch):
    monkeypatch.setattr(M, "_compute_graph_edges", lambda: None)
    c = _client()
    r = c.get("/ml/graph/edges?limit=50")
    assert r.status_code == 202, (r.status_code, r.text)
    body = r.json()
    assert body["meta"]["status"] == "building"
    job_id = body["meta"]["job_id"]
    assert job_id and job_id.startswith("graph_edges-")
    assert body["data"]["nodes"] == [] and body["data"]["edges"] == []

    jr = c.get(f"/ml/graph/jobs/{job_id}")
    assert jr.status_code == 200, jr.text
    jbody = jr.json()["data"]
    assert jbody["status"] in ("running", "success")
    assert jbody["key"] == "graph_edges"


def test_graph_job_not_found_404():
    c = _client()
    r = c.get("/ml/graph/jobs/nope-123")
    assert r.status_code == 404
    assert r.json()["code"] == 404


def test_graph_edges_ready(monkeypatch):
    payload = {
        "updated_at": 1, "window": 60, "min_abs_corr": 0.6,
        "nodes": [{"id": "BTC", "community": 1, "pagerank": 0.5, "size": 3}],
        "edges": [{"source": "BTC", "target": "ETH", "weight": 0.8, "corr": 0.7}],
    }
    monkeypatch.setattr(M, "_compute_graph_edges", lambda: payload)
    M._async_runner._cache._set("graph_edges", payload, ttl=60)
    c = _client()
    r = c.get("/ml/graph/edges?limit=50")
    assert r.status_code == 200, (r.status_code, r.text)
    j = r.json()
    assert j["meta"]["status"] == "ready"
    assert j["data"]["edges"][0]["source"] == "BTC"


# ── GP-3 全量构建互斥锁 ───────────────────────────────────

def test_build_graph_lock_serializes_concurrent_builds(monkeypatch):
    """并发调用 _build_graph 时构建体串行执行（冷态只构建一次，峰值并发=1）。"""
    from app import graph_engine as GE
    active, peak, alock = 0, 0, threading.Lock()

    def tracked():
        nonlocal active, peak
        with alock:
            active += 1
            peak = max(peak, active)
        time.sleep(0.2)
        with alock:
            active -= 1
        return {"updated_at": 1, "values": {"A": {}}}

    monkeypatch.setattr(GE, "_build_graph_locked", tracked)
    out: list = []
    threads = [threading.Thread(target=lambda: out.append(GE._build_graph())) for _ in range(3)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(out) == 3
    assert peak == 1, f"构建体重叠（peak={peak}）"
