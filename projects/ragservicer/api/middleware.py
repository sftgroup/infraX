"""
Middleware: rate limiting + audit logging.
Pluggable into Flask via before_request / after_request hooks.
"""
import time
import logging
from collections import defaultdict
from threading import Lock

from flask import request, g, jsonify
from config import get_config
from api.code_refactor import _ANON_FALLBACK as ANON_FALLBACK, _UNKNOWN_ENDPOINT as UNKNOWN_ENDPOINT

logger = logging.getLogger("ragservicer.middleware")


# ── Token Bucket Rate Limiter ──────────────────────────────

class TokenBucket:
    """Thread-safe token bucket for per-tenant rate limiting."""

    def __init__(self, rate: int, per_seconds: int = 60):
        self.rate = rate
        self.per_seconds = per_seconds
        self.tokens = float(rate)
        self.last_refill = time.time()
        self._lock = Lock()

    def consume(self, count: int = 1) -> bool:
        with self._lock:
            now = time.time()
            elapsed = now - self.last_refill
            self.tokens = min(float(self.rate), self.tokens + elapsed * (self.rate / self.per_seconds))
            self.last_refill = now
            if self.tokens >= count:
                self.tokens -= count
                return True
            return False


_buckets: dict[str, TokenBucket] = {}
_buckets_lock = Lock()


def _get_bucket(key: str) -> TokenBucket:
    with _buckets_lock:
        if key not in _buckets:
            cfg = get_config().server
            _buckets[key] = TokenBucket(cfg.rate_limit_rpm, cfg.rate_limit_window)
        return _buckets[key]


# ── Flask Middleware Hooks ─────────────────────────────────

def rate_limit_middleware():
    """
    Flask before_request handler.
    Rate-limits by tenant_id. Returns 429 JSON response if exceeded.
    Attach to app.before_request.
    NOTE: g.tenant_id must be set BEFORE this middleware runs (see register_tenant_on_g).
    """
    tenant = getattr(g, 'tenant_id', None) or request.remote_addr or ANON_FALLBACK
    bucket = _get_bucket(tenant)
    if not bucket.consume():
        logger.warning(f"Rate limit exceeded for tenant={tenant}")
        return jsonify({"error": "Rate limit exceeded. Try again later."}), 429
    g.request_start = time.time()
    return None


def audit_log_middleware(response):
    """
    Flask after_request handler.
    Logs every API call: tenant, endpoint, status, duration.
    Attach to app.after_request.
    """
    tenant = getattr(g, 'tenant_id', None) or request.remote_addr or ANON_FALLBACK
    endpoint = request.endpoint or UNKNOWN_ENDPOINT
    status = response.status_code
    start = getattr(g, 'request_start', None)
    duration = f"{time.time() - start:.3f}s" if start else "?"
    logger.info(f"AUDIT tenant={tenant} endpoint={endpoint} status={status} duration={duration}")
    return response
