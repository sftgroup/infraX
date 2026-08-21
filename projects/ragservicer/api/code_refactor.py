"""
Central Refactor Toolkit for InfraX Doc Service.
===================================================
Unifies all repeated patterns found across routes, engine, middleware,
and MCP server into a single importable module.

Covers:
  ─ Request parsing      → parse_json, extract_tenant_context
  ─ Validation           → Guard: required fields, types, ranges, enums
  ─ Error handling       → @handle_errors decorator, build_error, AppError
  ─ Response builders    → build_success, build_paginated
  ─ Async utilities      → run_async, set_event_loop
  ─ Flask integration    → register_tenant_on_g (fixes g.tenant_id bug)
  ─ Type aliases         → JsonDict, TenantId, Namespace, DocId

Usage (in any route module)::

    from api.code_refactor import parse_json, Guard, handle_errors, build_success

    @api.route("/namespaces/<namespace>/query", methods=["POST"])
    @handle_errors(logger, "Query failed")
    def api_query(namespace, _tenant):
        data = parse_json()
        Guard(data).require("query").check_mode("mode")
        result = rag_query(_tenant, namespace, data["query"], data.get("mode", "mix"))
        return build_success(result)

Design principles:
  - Zero hardcoded configuration (imports from config.py)
  - All helpers are stateless / pure functions
  - Works with both sync Flask routes and async MCP tools
  - Progressive enhancement — existing code works without changes
"""

from __future__ import annotations

import asyncio
import functools
import logging
import inspect
import sqlite3
from typing import (
    Any, Callable, Dict, List, Optional, Tuple, TypeVar, Union, ParamSpec,
)

from flask import request, jsonify, g


# ═══════════════════════════════════════════════════════════════
#  Type Aliases
# ═══════════════════════════════════════════════════════════════

JsonDict   = Dict[str, Any]
JsonList   = List[JsonDict]
TenantId   = str
Namespace  = str
DocId      = str
RouteFunc  = Callable[..., Any]

P  = ParamSpec("P")
T  = TypeVar("T")

# ═══════════════════════════════════════════════════════════════
#  Constants
# ═══════════════════════════════════════════════════════════════

_VALID_QUERY_MODES = frozenset({"naive", "local", "global", "hybrid", "mix"})
_DEFAULT_DOC_ID    = "document.txt"
_ANON_FALLBACK     = "anonymous"
_UNKNOWN_ENDPOINT  = "unknown"


def _observe_sqlite_busy() -> None:
    """RWL-4: 记录一次 SQLite 写锁冲突（供 /metrics 监控告警）。

    metrics 可选依赖：prometheus_client 不可用时静默降级，不阻断请求路径。
    """
    try:
        from metrics import SQLITE_BUSY_TOTAL
        SQLITE_BUSY_TOTAL.labels(service="ragservicer").inc()
    except Exception:
        pass


# ═══════════════════════════════════════════════════════════════
#  1.  Request Parsing
# ═══════════════════════════════════════════════════════════════

def parse_json() -> JsonDict:
    """Extract and return the JSON body from the current Flask request.

    Returns an empty dict when the body is missing or unparseable
    (avoiding the ``get_json(silent=True) or {}`` boilerplate).
    """
    return request.get_json(silent=True) or {}


def extract_tenant_context() -> Tuple[TenantId, Namespace]:
    """Return (tenant_id, namespace) from the current Flask request context.

    Priority:
      1. ``g.tenant_id`` / ``g.namespace`` (set by @register_tenant_on_g)
      2. ``X-Tenant-ID`` header / URL ``namespace`` param
      3. Fallback to ``'default'`` / ``'default'``
    """
    tenant = getattr(g, "tenant_id", None) or request.headers.get("X-Tenant-ID", "") or "default"
    ns     = getattr(g, "namespace", None)  or request.view_args.get("namespace", "") if request.view_args else ""
    return tenant, ns or "default"


# ═══════════════════════════════════════════════════════════════
#  2.  Guard — Declarative Input Validation
# ═══════════════════════════════════════════════════════════════

class GuardError(ValueError):
    """Raised by Guard when validation fails.  Compatible with @handle_errors."""


class Guard:
    """Fluent validator for JSON-like dicts (e.g. Flask request bodies).

    Usage::

        data = parse_json()
        Guard(data).require("text").require("doc_id").check_mode("mode")

    ``require(name)`` ensures *name* is present and non-empty (after .strip()).
    ``check_mode(key)`` ensures *key* is a valid query mode if present.
    All checks raise ``GuardError`` with a human-readable message on failure.
    """

    __slots__ = ("_data",)

    def __init__(self, data: JsonDict) -> None:
        self._data = data

    def require(self, name: str, message: Optional[str] = None) -> "Guard":
        value = self._data.get(name, "")
        if not str(value).strip():
            raise GuardError(message or f"{name} is required")
        return self

    def check_mode(self, key: str = "mode") -> "Guard":
        """If *key* is present, assert it is a valid LightRAG query mode."""
        mode = self._data.get(key)
        if mode is None:
            return self
        if mode not in _VALID_QUERY_MODES:
            raise GuardError(
                f"Invalid mode '{mode}'. Valid modes: {', '.join(sorted(_VALID_QUERY_MODES))}"
            )
        return self

    def require_int(
        self, name: str, min_val: Optional[int] = None, max_val: Optional[int] = None,
        message: Optional[str] = None,
    ) -> "Guard":
        raw = self._data.get(name)
        if raw is None:
            raise GuardError(message or f"{name} is required")
        try:
            val = int(raw)
        except (TypeError, ValueError):
            raise GuardError(message or f"{name} must be an integer")
        if min_val is not None and val < min_val:
            raise GuardError(message or f"{name} must be >= {min_val}")
        if max_val is not None and val > max_val:
            raise GuardError(message or f"{name} must be <= {max_val}")
        self._data[name] = val  # <-- coerce in place so callers get an int
        return self

    def require_page_limit(self, page_key: str = "page", limit_key: str = "limit") -> "Guard":
        """Validate pagination params.  page>=1, 1<=limit<=page_limit_max."""
        from config import get_config as _cfg
        max_limit = _cfg().rag.page_limit_max
        return (
            self.require_int(page_key, min_val=1, message=f"{page_key} must be >= 1")
                .require_int(limit_key, min_val=1, max_val=max_limit, message=f"{limit_key} must be 1–{max_limit}")
        )

    @property
    def data(self) -> JsonDict:
        return self._data


# ═══════════════════════════════════════════════════════════════
#  3.  Error Handling — Decorator + Helpers
# ═══════════════════════════════════════════════════════════════

def build_error(
    message: str,
    status: int = 400,
    code: Optional[str] = None,
    **extra,
) -> Tuple[JsonDict, int]:
    """Return InfraX-standard (body, status) tuple.

    Usage::

        return build_error("Tenant not found", 404, code="TENANT_NOT_FOUND")
        return build_error("Invalid mode 'naive'", 400)
    """
    body: JsonDict = {"code": status, "message": message, "data": None}
    if code:
        body["code"] = code
    body.update(extra)
    return jsonify(body), status


def handle_errors(
    logger_or_name=None,  # type: logging.Logger | str | None
    label: str = "",
    reraise: Union[bool, Tuple[type, ...]] = False,
    fallback_status: int = 500,
):
    """Decorator that catches exceptions in a Flask route and returns JSON.

    Handles: AppError, GuardError, and generic Exception.
    Usage::

        @handle_errors(logger, "Query failed")
        def api_query(namespace, _tenant):
            ...

    Parameters:
        logger_or_name: logging.Logger / logger name (str) / None.
        label:          Prepended to error log line.
        reraise:        True or tuple of exception types to bubble up.
        fallback_status: HTTP status for unexpected exceptions (default 500).
    """
    if isinstance(reraise, bool):
        _reraise: Tuple[type, ...] = (Exception,) if reraise else ()
    else:
        _reraise = reraise

    _logger: Optional[logging.Logger] = None
    if isinstance(logger_or_name, logging.Logger):
        _logger = logger_or_name
    elif isinstance(logger_or_name, str):
        _logger = logging.getLogger(logger_or_name)

    def _decorator(func):
        @functools.wraps(func)
        def _wrapper(*args, **kwargs):
            try:
                return func(*args, **kwargs)
            except _reraise:
                raise
            except AppError as exc:
                if _logger:
                    _logger.warning(f"{label}: {exc}" if label else str(exc))
                return build_error(str(exc), exc.status, code=exc.code)
            except GuardError as exc:
                if _logger:
                    _logger.warning(f"{label}: {exc}" if label else str(exc))
                return build_error(str(exc), 400, code="VALIDATION_ERROR")
            except sqlite3.OperationalError as exc:
                # RWL-2: SQLite 写锁冲突（database is locked）→ 可重试的瞬时故障，
                # 返回 503 + Retry-After，而不是 500/HTML，让集成方按标准语义重试。
                if "locked" in str(exc):
                    if _logger:
                        _logger.warning(f"{label}: database busy (retryable): {exc}")
                    _observe_sqlite_busy()
                    resp, status = build_error(
                        "Database busy, retry later", 503, code="DATABASE_BUSY")
                    resp.headers["Retry-After"] = "5"
                    return resp, status
                raise
            except Exception as exc:
                if _logger:
                    msg = f"{label}: {exc}" if label else str(exc)
                    _logger.error(msg)
                return build_error(str(exc), fallback_status)
        return _wrapper
    return _decorator


class AppError(Exception):
    """Application-level error with HTTP status code.  Use in route logic for
    structured error responses captured by @handle_errors.

    Usage::

        raise AppError("Tenant not found", 404, code="TENANT_NOT_FOUND")
    """

    def __init__(self, message: str, status: int = 400, code: Optional[str] = None) -> None:
        super().__init__(message)
        self.status = status
        self.code = code


# ═══════════════════════════════════════════════════════════════
#  4.  Response Builders
# ═══════════════════════════════════════════════════════════════

def build_success(data: Any = None, *, status: int = 200, **extra) -> Tuple[Any, int]:
    """Build InfraX-standard success response.

    Usage::

        return build_success({"doc_id": "abc"})
        return build_success({"doc_id": "abc"}, status=201)
        return build_success({"doc_id": "abc"}, status=201, namespace="foo")
    """
    body = {"code": 0, "message": "ok"}
    if isinstance(data, dict):
        body["data"] = {**data, **extra}
    elif data is not None:
        body["data"] = data
    elif extra:
        body["data"] = extra
    else:
        body["data"] = None
    return jsonify(body), status


def build_paginated(
    items: list,
    total: int,
    page: int,
    limit: int,
    **extra,
) -> Tuple[JsonDict, int]:
    """Build an InfraX-standard paginated response.

    Usage::

        return build_paginated(docs, total=42, page=1, limit=20)
    """
    body = {
        "code": 0,
        "message": "ok",
        "data": {
            "items": items,
            "total": total,
            "page": page,
            "limit": limit,
            "has_more": (page * limit) < total,
            **extra,
        },
    }
    return jsonify(body), 200


# ═══════════════════════════════════════════════════════════════
#  5.  Async Utilities
# ═══════════════════════════════════════════════════════════════

# Reference to the persistent loop (set by engine.py at startup)
_loop: Optional[asyncio.AbstractEventLoop] = None


def set_event_loop(loop: asyncio.AbstractEventLoop) -> None:
    """Called by engine.start_event_loop so helpers can reuse the same loop."""
    global _loop
    _loop = loop


def run_async(coro, timeout: Optional[float] = None) -> Any:
    """Safely run an async coroutine from a synchronous context.

    Uses the persistent loop set by engine.py for Flask/MCP threads,
    or falls back to ``asyncio.run()`` (creates a temp loop).
    """
    if _loop is not None and _loop.is_running():
        future = asyncio.run_coroutine_threadsafe(coro, _loop)
        if timeout is not None:
            return future.result(timeout=timeout)
        return future.result()

    # Fallback: create a one-shot loop (works in threads without a loop)
    try:
        loop = asyncio.get_event_loop()
    except RuntimeError:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
    if loop.is_running():
        future = asyncio.run_coroutine_threadsafe(coro, loop)
        return future.result(timeout=timeout) if timeout else future.result()
    return loop.run_until_complete(coro)


# ═══════════════════════════════════════════════════════════════
#  6.  Flask Integration Helpers
# ═══════════════════════════════════════════════════════════════

def register_tenant_on_g():
    """Populate ``g.tenant_id`` and ``g.namespace`` from the current request.

    Call this in a Flask ``before_request`` handler so that middleware
    (rate-limiting, audit logging) and downstream route code can access
    the tenant context without re-parsing headers.

    **Fixes the bug** where ``g.tenant_id`` was never set — rate-limiting
    and audit-logging always fell back to the client IP.

    Usage::

        @app.before_request
        def _set_tenant():
            from api.code_refactor import register_tenant_on_g
            register_tenant_on_g()
    """
    # Extract tenant (priority: X-Tenant-ID > Bearer token > X-API-Key)
    from api.auth import extract_tenant as _extract, TenantForbiddenError
    try:
        g.tenant_id = _extract() or _ANON_FALLBACK
    except TenantForbiddenError:
        # R-TN: X-Tenant-ID 越权尝试记录为 unauthorized（业务路由会返回 403）
        g.tenant_id = "unauthorized"

    # Extract namespace from URL if present
    if request.view_args:
        g.namespace = request.view_args.get("namespace", "default")
    else:
        g.namespace = "default"


# ═══════════════════════════════════════════════════════════════
#  7.  Re-exports for convenience
# ═══════════════════════════════════════════════════════════════

__all__ = [
    # Request
    "parse_json",
    "extract_tenant_context",
    # Validation
    "Guard",
    "GuardError",
    # Errors
    "handle_errors",
    "build_error",
    "AppError",
    # Responses
    "build_success",
    "build_paginated",
    # Async
    "run_async",
    "set_event_loop",
    # Flask
    "register_tenant_on_g",
    # Types
    "JsonDict",
    "JsonList",
    "TenantId",
    "Namespace",
    "DocId",
    # Constants
    "_VALID_QUERY_MODES",
]
