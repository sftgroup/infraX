"""LightRAG 门户自助开通单元测试（/api/v2/lightrag/provision 数据层）。

覆盖 rag_provision.provision：
  - 未配置 admin URL/KEY → ProvisionError
  - 首次开通：建租户 + 签发 lr_ key + 落 rag_grants（幂等，二次直接返回）
  - 租户已存在（500 duplicate）→ 继续签发 key
  - 签发 key 失败（404）→ ProvisionError
  - admin 不可达 → ProvisionError
覆盖 rag_grants：owner 唯一，重复 insert 返回已存在记录。
"""
from __future__ import annotations

import os
import sys
import threading

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("DATA_CONFIG_PATH", "data_config.json")

import pytest  # noqa: E402

from app import rag_grants, rag_provision  # noqa: E402
from app.rag_provision import ProvisionError, _tenant_id_for_owner  # noqa: E402


def _use_tmp_db(monkeypatch, tmp_path):
    """每个测试独立 SQLite 文件（_local 为线程本地缓存，须一并替换）。"""
    import app.storage.sqlite as s

    monkeypatch.setattr(s, "_DB_PATH", str(tmp_path / "test.db"))
    monkeypatch.setattr(s, "_local", threading.local())
    monkeypatch.setattr(s, "_lock", threading.Lock())
    rag_grants._ensure_table()  # 换库后重建 rag_grants 表


class FakeResp:
    def __init__(self, status: int, body: dict):
        self.status_code = status
        self._body = body

    def json(self):
        return self._body


def _install_admin(monkeypatch, *, url="http://rag-admin:9721", key="adminkey"):
    monkeypatch.setattr(rag_provision, "RAGSERVICER_ADMIN_URL", url)
    monkeypatch.setattr(rag_provision, "RAGSERVICER_ADMIN_KEY", key)


def _install_requests(monkeypatch, handler):
    import requests

    calls = []

    def _req(method, url, **kw):
        calls.append((method, url, kw))
        return handler(method, url, **kw)

    monkeypatch.setattr(requests, "request", _req)
    return calls


# ── 租户 id 派生 ────────────────────────────────────────────────


def test_tenant_id_deterministic():
    a1 = _tenant_id_for_owner("0xAbCdEf1234567890AbCdEf1234567890AbCdEf12")
    a2 = _tenant_id_for_owner("0xabcdef1234567890abcdef1234567890abcdef12")
    b = _tenant_id_for_owner("0x1111111111111111111111111111111111111111")
    assert a1 == a2  # 大小写无关、确定性
    assert a1.startswith("u_") and len(a1) == 34  # 'u_' + 去 0x 后 32 位 hex
    assert a1 != b


# ── provision 主流程 ────────────────────────────────────────────


def test_provision_not_configured(monkeypatch, tmp_path):
    _use_tmp_db(monkeypatch, tmp_path)
    monkeypatch.setattr(rag_provision, "RAGSERVICER_ADMIN_URL", "")
    monkeypatch.setattr(rag_provision, "RAGSERVICER_ADMIN_KEY", "")
    with pytest.raises(ProvisionError, match="not configured"):
        rag_provision.provision("0xabc")


def test_provision_creates_and_idempotent(monkeypatch, tmp_path):
    _use_tmp_db(monkeypatch, tmp_path)
    _install_admin(monkeypatch)

    def _handler(method, url, **kw):
        if url.endswith("/api/v1/tenants"):
            return FakeResp(201, {"code": 0, "message": "ok", "data": {"tenant_id": "u_abc", "name": "x"}})
        if url.endswith("/keys"):
            return FakeResp(201, {"code": 0, "message": "ok", "data": {
                "key_id": "key_1", "tenant_id": "u_abc", "name": "x",
                "key": "lr_" + "a" * 48, "key_prefix": "lr_aaaaaaaa", "expires_at": None,
            }})
        return FakeResp(404, {})

    calls = _install_requests(monkeypatch, _handler)

    owner = "0xabcdef1234567890abcdef1234567890abcdef12"
    r1 = rag_provision.provision(owner, "lr_pro")
    assert r1["api_key"].startswith("lr_")
    assert r1["tenant_id"] == "u_abc"
    assert r1["plan_id"] == "lr_pro"

    # 幂等：二次调用命中 rag_grants，不再触达 admin
    r2 = rag_provision.provision(owner, "lr_enterprise")
    assert r2["api_key"] == r1["api_key"]
    tenant_calls = [c for c in calls if c[1].endswith("/tenants")]
    assert len(tenant_calls) == 1


def test_provision_duplicate_tenant_continues(monkeypatch, tmp_path):
    _use_tmp_db(monkeypatch, tmp_path)
    _install_admin(monkeypatch)

    def _handler(method, url, **kw):
        if url.endswith("/api/v1/tenants"):
            return FakeResp(500, {"code": 500, "message": "UNIQUE constraint failed"})
        if url.endswith("/keys"):
            return FakeResp(201, {"code": 0, "message": "ok", "data": {
                "key_id": "key_2", "tenant_id": "u_dup", "name": "x",
                "key": "lr_" + "b" * 48, "key_prefix": "lr_bbbbbbbb", "expires_at": None,
            }})
        return FakeResp(404, {})

    _install_requests(monkeypatch, _handler)
    r = rag_provision.provision("0xabcdef1234567890abcdef1234567890abcdef12")
    assert r["api_key"].startswith("lr_")


def test_provision_key_404_fails(monkeypatch, tmp_path):
    _use_tmp_db(monkeypatch, tmp_path)
    _install_admin(monkeypatch)

    def _handler(method, url, **kw):
        if url.endswith("/api/v1/tenants"):
            return FakeResp(201, {"code": 0, "message": "ok", "data": {"tenant_id": "u_x"}})
        return FakeResp(404, {"code": 404, "message": "Tenant 'u_x' not found"})

    _install_requests(monkeypatch, _handler)
    with pytest.raises(ProvisionError, match="issue key failed"):
        rag_provision.provision("0xabcdef1234567890abcdef1234567890abcdef12")


def test_provision_admin_unreachable(monkeypatch, tmp_path):
    _use_tmp_db(monkeypatch, tmp_path)
    _install_admin(monkeypatch)

    import requests

    def _boom(*_a, **_kw):
        raise requests.ConnectionError("refused")

    monkeypatch.setattr(requests, "request", _boom)
    with pytest.raises(ProvisionError, match="unreachable"):
        rag_provision.provision("0xabcdef1234567890abcdef1234567890abcdef12")


# ── rag_grants 唯一约束兜底 ──────────────────────────────────────


def test_rag_grants_insert_conflict_returns_existing(monkeypatch, tmp_path):
    _use_tmp_db(monkeypatch, tmp_path)
    owner = "0xabcdef1234567890abcdef1234567890abcdef12"
    a = rag_grants.insert(owner, "u_abc", "key_1", "lr_" + "c" * 48)
    b = rag_grants.insert(owner, "u_other", "key_2", "lr_" + "d" * 48)  # 冲突 → 返回已存在
    assert b["api_key"] == a["api_key"]
    assert b["tenant_id"] == "u_abc"
    assert rag_grants.get_for_owner(owner)["tenant_id"] == "u_abc"
