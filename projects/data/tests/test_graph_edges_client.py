"""GP-2 相关性图 edges 拉取：building/ready 透传 + 短 TTL 轮询缓存。

覆盖 ml_client.fetch_graph_edges：
  - ml-service 冷态 202 + meta.job_id → {"status":"building", job_id}（30s 短 TTL）
  - 就绪 200 → {"status":"ready", ...}（标准 TTL 1800s）
  - building 缓存 30s 内命中不重复请求；过期后重新请求
"""
import time
from unittest.mock import patch

from app import ml_client as MC

_BUILDING_BODY = {
    "code": 0, "message": "ok",
    "data": {"updated_at": 1, "nodes": [], "edges": []},
    "meta": {"status": "building", "job_id": "graph_edges-123", "reason": "in progress"},
}
_READY_BODY = {
    "code": 0, "message": "ok",
    "data": {"updated_at": 2, "window": 60, "min_abs_corr": 0.6,
             "nodes": [{"id": "BTC"}],
             "edges": [{"source": "BTC", "target": "ETH", "weight": 0.8}]},
    "meta": {"status": "ready"},
}


def _patch_get(monkeypatch, status_code, body):
    class FakeResp:
        def __init__(self, code, payload):
            self.status_code = code
            self._payload = payload

        def json(self):
            return self._payload

    monkeypatch.setattr(MC.requests, "get", lambda *a, **k: FakeResp(status_code, body))
    monkeypatch.setattr(MC, "ML_SERVICE_URL", "http://ml:9120")
    MC._GRAPH_EDGES_CACHE = {}


def test_fetch_graph_edges_building_passthrough(monkeypatch):
    _patch_get(monkeypatch, 202, _BUILDING_BODY)
    d = MC.fetch_graph_edges(None, 200)
    assert d["status"] == "building"
    assert d["job_id"] == "graph_edges-123"
    assert d["edges"] == []
    assert MC._GRAPH_EDGES_CACHE["ttl"] == 30  # 构建中短 TTL，客户端可轮询


def test_fetch_graph_edges_ready(monkeypatch):
    _patch_get(monkeypatch, 200, _READY_BODY)
    d = MC.fetch_graph_edges(["BTC"], 100)
    assert d["status"] == "ready"
    assert d["edges"][0]["source"] == "BTC"
    assert MC._GRAPH_EDGES_CACHE["ttl"] == MC._GRAPH_EDGES_CACHE_TTL_S


def test_fetch_graph_edges_building_cache_short_ttl(monkeypatch):
    _patch_get(monkeypatch, 202, _BUILDING_BODY)
    MC.fetch_graph_edges(None, 200)  # 建立 _all building 缓存
    MC._GRAPH_EDGES_CACHE["ts"] = time.time() - 5  # 30s TTL 内
    calls = []

    def fake_get(*a, **k):
        calls.append(1)
        return _Fake202()

    monkeypatch.setattr(MC.requests, "get", fake_get)
    d = MC.fetch_graph_edges(None, 200)
    assert calls == []  # 命中缓存，不重复请求
    assert d["status"] == "building"

    MC._GRAPH_EDGES_CACHE["ts"] = time.time() - 60  # 过期 → 重新请求
    d2 = MC.fetch_graph_edges(None, 200)
    assert calls == [1]
    assert d2["status"] == "building" and d2["job_id"] == "graph_edges-123"


class _Fake202:
    status_code = 202

    def json(self):
        return _BUILDING_BODY
