"""
Authentication middleware.
Extracts and validates API Key / Admin Key / Tenant ID.
Does NOT fall back to 'default' tenant — unknown requests get 401.
"""
import functools
import logging

from flask import request
from config import get_config
from tenants import manager as tm
from api.code_refactor import build_error

# 统一 header 提取契约（app_auth，projects/shared/app_auth.py）
import app_auth

logger = logging.getLogger("ragservicer.auth")


def extract_tenant():
    """
    Extract tenant_id from request.  All paths require valid credentials.
    
    Valid credentials:
      1. Bearer token matching RAGSERVICER_API_KEY env var → tenant "default" (internal bridge)
      2. Bearer token matching Admin key → tenant "admin"
      3. Bearer token or X-API-Key / X-Service-Key validated against DB → bound tenant
      4. Any valid key + X-Tenant-ID header → uses header tenant (service accounts)
    
    Returns None if authentication fails.
    """
    # 统一 header 提取：Bearer / X-API-Key / X-Service-Key（app_auth 契约）
    key = app_auth.extract_api_key(request.headers.get)
    if not key:
        return None

    cfg = get_config()

    # Internal RAGSERVICER_API_KEY → tenant "default" (aiservicer bridge)
    if cfg.server.ragservicer_api_key and key == cfg.server.ragservicer_api_key:
        tenant_header = request.headers.get("X-Tenant-ID", "")
        return tenant_header if tenant_header else "default"

    # G-7: 监控只读 key — 仅允许安全方法（GET/HEAD/OPTIONS），写操作拒绝
    if cfg.server.monitor_api_key and key == cfg.server.monitor_api_key:
        return "monitor" if request.method in ("GET", "HEAD", "OPTIONS") else None

    # Admin key
    if cfg.server.admin_api_key and key == cfg.server.admin_api_key:
        return "admin"

    # Validate against DB (API keys generated via admin API)
    info = tm.validate_api_key(key)
    if not info:
        return None

    # If X-Tenant-ID header is present, use it (cross-tenant service account)
    tenant_header = request.headers.get("X-Tenant-ID", "")
    if tenant_header:
        return tenant_header

    return info["tenant_id"]


def require_tenant(f):
    """Decorator: require valid tenant authentication."""
    @functools.wraps(f)
    def wrapper(*args, **kwargs):
        tenant = extract_tenant()
        if not tenant:
            return build_error("Missing or invalid API key", 401)
        kwargs["_tenant"] = tenant
        return f(*args, **kwargs)
    return wrapper


def require_service(f):
    """Decorator: require a service-level API key for factor endpoints.

    因子端点（/factors/graph、/factors/catalog）仅允许服务间透传：
    请求 key 必须在 RAGSERVICER_FACTOR_KEYS 白名单内（data-service 内部
    服务 key），B 端因子一律走 data-service /factors/graph（dx_* key），
    不直接持有 ragservicer 因子访问权。
    """
    @functools.wraps(f)
    def wrapper(*args, **kwargs):
        key = app_auth.extract_api_key(request.headers.get)
        if not key:
            return build_error("Missing or invalid API key", 401)
        cfg = get_config()
        whitelist = {k.strip() for k in (cfg.server.factor_service_keys or "").split(",") if k.strip()}
        if not whitelist:
            return build_error("Factor service endpoint not enabled", 403)
        if key not in whitelist:
            return build_error("Service-level key required for factor endpoints", 403)
        tenant = extract_tenant()
        if not tenant:
            return build_error("Missing or invalid API key", 401)
        kwargs["_tenant"] = tenant
        return f(*args, **kwargs)
    return wrapper


def require_admin(f):
    """Decorator: require admin API key."""
    @functools.wraps(f)
    def wrapper(*args, **kwargs):
        admin_key = get_config().server.admin_api_key
        if not admin_key:
            return build_error("Admin API key not configured on server", 403)

        auth = request.headers.get("Authorization", "")
        if auth != f"Bearer {admin_key}":
            return build_error("Admin access required", 403)
        return f(*args, **kwargs)
    return wrapper
