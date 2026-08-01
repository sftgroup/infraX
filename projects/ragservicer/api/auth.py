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

logger = logging.getLogger("ragservicer.auth")


def extract_tenant():
    """
    Extract tenant_id from request.  All paths require valid credentials.
    
    Valid credentials:
      1. Bearer token matching RAGSERVICER_API_KEY env var → tenant "default" (internal bridge)
      2. Bearer token matching Admin key → tenant "admin"
      3. Bearer token or X-API-Key validated against DB → bound tenant
      4. Any valid key + X-Tenant-ID header → uses header tenant (service accounts)
    
    Returns None if authentication fails.
    """
    # Extract key from Bearer or X-API-Key
    auth = request.headers.get("Authorization", "")
    api_key_header = request.headers.get("X-API-Key", "")
    key = ""
    if auth.startswith("Bearer "):
        key = auth[7:]
    elif api_key_header:
        key = api_key_header

    if not key:
        return None

    cfg = get_config()

    # Internal RAGSERVICER_API_KEY → tenant "default" (aiservicer bridge)
    if cfg.server.ragservicer_api_key and key == cfg.server.ragservicer_api_key:
        tenant_header = request.headers.get("X-Tenant-ID", "")
        return tenant_header if tenant_header else "default"

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
