"""LightRAG 自助开通 HTTP 客户端 — 选套餐即自动分配 lr_ key（B 端自助）。

data-service 内部持 ragservicer admin key（RAGSERVICER_ADMIN_URL / ADMIN_KEY，
仅本机回环可达），流程：
  1. 为用户（钱包地址）确定租户 id（owner 派生，确定性）并确保租户存在
  2. 签发 lr_ key（expires_days=0 永不过期）
  3. 明文写入 rag_grants（平台代管，用户可随时回看）

说明：ragservicer 的 lr_ key 明文仅签发时返回一次，落库是本平台"选套餐即
开通 + 随时回看"体验的前提（api_keys 仅存哈希的约定在此例外，动机见
rag_grants 模块注释）。
"""

from __future__ import annotations

import re
import threading

import requests

from app import rag_grants
from app.config import RAGSERVICER_ADMIN_KEY, RAGSERVICER_ADMIN_URL
from app.utils.logger import get_logger

logger = get_logger(__name__)

_TIMEOUT = 15
# 单实例内串行化开通流程，配合 rag_grants UNIQUE(owner) 兜底并发（跨实例仍安全）
_provision_lock = threading.Lock()


class ProvisionError(Exception):
    """开通失败（上层转换为 HTTP 4xx/5xx）。"""


def _admin_ready() -> str:
    base = (RAGSERVICER_ADMIN_URL or "").strip().rstrip("/")
    if not base or not RAGSERVICER_ADMIN_KEY:
        raise ProvisionError("LightRAG provisioning not configured (RAGSERVICER_ADMIN_URL/KEY)")
    return base


def _headers() -> dict:
    return {"Authorization": f"Bearer {RAGSERVICER_ADMIN_KEY}"}


def _tenant_id_for_owner(owner: str) -> str:
    """钱包地址 → 确定性租户 id（'u_' + 去 0x 后 32 位 hex）。"""
    addr = (owner or "").strip().lower()
    tail = re.sub(r"[^0-9a-f]", "", addr)
    return f"u_{tail[-32:]}"


def _call(method: str, url: str, **kw) -> tuple[int, dict]:
    """请求 ragservicer admin 端点，返回 (status, json)。"""
    try:
        resp = requests.request(method, url, headers=_headers(), timeout=_TIMEOUT, **kw)
    except requests.RequestException as exc:
        raise ProvisionError(f"LightRAG admin unreachable: {exc}") from exc
    try:
        body = resp.json() or {}
    except ValueError:
        body = {}
    return resp.status_code, body


def _ensure_tenant(base: str, tenant_id: str, owner: str) -> None:
    """创建租户；已存在（duplicate → 500）视为成功继续。"""
    status, body = _call(
        "POST",
        f"{base}/api/v1/tenants",
        json={
            "tenant_id": tenant_id,
            "name": f"wallet-{owner[-6:]}",
            "description": "B 端门户自助开通（rag_grants）",
        },
    )
    if status in (200, 201):
        logger.info("LightRAG tenant ensured: %s", tenant_id)
        return
    if status == 500:  # UNIQUE 冲突（create_tenant 直接 INSERT）→ 租户已存在
        logger.info("LightRAG tenant exists: %s (status=%s)", tenant_id, status)
        return
    raise ProvisionError(f"LightRAG create tenant failed: status={status} body={body}")


def _issue_key(base: str, tenant_id: str, owner: str) -> dict:
    """签发 lr_ key（明文仅此一次返回）。"""
    status, body = _call(
        "POST",
        f"{base}/api/v1/tenants/{tenant_id}/keys",
        json={"name": f"wallet-{owner[-6:]}", "expires_days": 0},
    )
    data = (body or {}).get("data") or {}
    if status not in (200, 201) or not data.get("key"):
        raise ProvisionError(f"LightRAG issue key failed: status={status} body={body}")
    return data


def provision(owner: str, plan_id: str = "lr_free") -> dict:
    """为用户自动分配 LightRAG 租户 + lr_ key，返回开通记录（含明文 key）。幂等。"""
    owner = (owner or "").strip().lower()
    if not owner:
        raise ProvisionError("missing wallet owner")
    with _provision_lock:
        existing = rag_grants.get_for_owner(owner)
        if existing:
            return existing
        base = _admin_ready()
        tenant_id = _tenant_id_for_owner(owner)
        _ensure_tenant(base, tenant_id, owner)
        key_info = _issue_key(base, tenant_id, owner)
        record = rag_grants.insert(
            owner=owner,
            tenant_id=key_info.get("tenant_id") or tenant_id,
            key_id=key_info.get("key_id") or "",
            api_key=key_info.get("key") or "",
            plan_id=plan_id or "lr_free",
        )
        if not record.get("api_key"):
            raise ProvisionError("LightRAG provision record missing api_key")
        logger.info("LightRAG provisioned: owner=%s tenant=%s plan=%s", owner, tenant_id, plan_id)
        return record
