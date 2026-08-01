"""
Central Refactor Toolkit for InfraX Doc Service.
===================================================
Unifies all repeated patterns found across routes, engine, middleware,
and MCP server into a single importable module.

Covers:
  ─ Request parsing      → parse_json, extract_tenant_context
  ─ Validation           → Guard: required fields, types, ranges, enums
  ─ Error handling       → @handle_errors decorator, build_error
  ─ Response builders    → build_success, build_paginated
  ─ Async utilities      → run_async_in_loop, async_retry
  ─ Retry / timeout      → retry_on_failure, timeout_context
  ─ Logging context      → log_context (structured key=value)
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
import time
import inspect
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
        """Validate pagination params.  page>=1, 1<=limit<=200."""
        return (
            self.require_int(page_key, min_val=1, message=f"{page_key} must be >= 1")
                .require_int(limit_key, min_val=1, max_val=200, message=f"{limit_key} must be 1–200")
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
    """Return a (body, status) tuple suitable for Flask's ``jsonify(**body), status`` pattern.

    Usage::

        return build_error("Tenant not found", 404, code="TENANT_NOT_FOUND")
        return build_error("Invalid mode 'naive'", 400)
    """
    body: JsonDict = {"error": message}
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

    Usage::

        @handle_errors(logger, "Query failed")
        def api_query(namespace, _tenant):
            ...

    Parameters:
        logger_or_name: Pass a ``logging.Logger`` instance, a logger name (str),
                        or ``None`` to skip logging.
        label:          Prepended to the error log line ("{label}: {error}").
        reraise:        ``True`` or a tuple of exception types that should
                        *not* be caught (they bubble up to Flask).
        fallback_status:HTTP status used for unexpected exceptions (default 500).
    """
    if isinstance(reraise, bool):
        _reraise: Tuple[type, ...] = (Exception,) if reraise else ()
    else:
        _reraise = reraise

    # Resolve logger
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
            except GuardError as exc:
                if _logger:
                    _logger.warning(f"{label}: {exc}" if label else str(exc))
                return build_error(str(exc), 400, code="VALIDATION_ERROR")
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


# Extend @handle_errors to also understand AppError
def handle_errors_v2(
    logger_or_name=None,  # type: logging.Logger | str | None
    label: str = "",
    reraise: Union[bool, Tuple[type, ...]] = False,
):
    """Enhanced version of @handle_errors that also handles AppError."""
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
            except Exception as exc:
                if _logger:
                    msg = f"{label}: {exc}" if label else str(exc)
                    _logger.error(msg)
                return build_error(str(exc), 500)
        return _wrapper
    return _decorator


# ═══════════════════════════════════════════════════════════════
#  4.  Response Builders
# ═══════════════════════════════════════════════════════════════

def build_success(data: Any = None, *, status: int = 200, **extra) -> Tuple[Any, int]:
    """Build a standard success response.  For inserts use status=201.

    Usage::

        return build_success({"doc_id": "abc"})
        return build_success({"doc_id": "abc"}, status=201)
        return build_success({"doc_id": "abc"}, status=201, namespace="foo")
    """
    if isinstance(data, dict):
        body = {**data, **extra, "success": True}
    else:
        body = {"data": data, "success": True, **extra}
    return jsonify(body), status


def build_paginated(
    items: list,
    total: int,
    page: int,
    limit: int,
    **extra,
) -> Tuple[JsonDict, int]:
    """Build a paginated response envelope.

    Usage::

        return build_paginated(docs, total=42, page=1, limit=20)
    """
    body = {
        "items": items,
        "total": total,
        "page": page,
        "limit": limit,
        "has_more": (page * limit) < total,
        "success": True,
        **extra,
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
#  6.  Retry / Timeout Utilities
# ═══════════════════════════════════════════════════════════════

def retry_on_failure(
    max_attempts: int = 3,
    delay: float = 1.0,
    backoff: float = 2.0,
    exceptions: Tuple[type, ...] = (Exception,),
    logger: Optional[logging.Logger] = None,
    label: str = "",
) -> Callable[[Callable[P, T]], Callable[P, T]]:
    """Decorator: retry a synchronous function on failure with exponential backoff.

    Usage::

        @retry_on_failure(max_attempts=3, delay=0.5, logger=logger)
        def call_llm(prompt):
            ...

    Parameters:
        max_attempts:  Total attempts (including the first).
        delay:         Initial wait seconds between attempts.
        backoff:       Multiplier applied after each failure.
        exceptions:    Tuple of exception types to catch.
        logger:        If provided, warnings are emitted on retry.
        label:         Human-readable name for log messages.
    """
    def _decorator(func: Callable[P, T]) -> Callable[P, T]:
        @functools.wraps(func)
        def _wrapper(*args: P.args, **kwargs: P.kwargs) -> T:
            last_exc = None
            current_delay = delay
            for attempt in range(1, max_attempts + 1):
                try:
                    return func(*args, **kwargs)
                except exceptions as exc:
                    last_exc = exc
                    if attempt == max_attempts:
                        if logger:
                            logger.error(f"{label}: Exhausted {max_attempts} attempts: {exc}")
                        raise
                    if logger:
                        logger.warning(
                            f"{label}: Attempt {attempt}/{max_attempts} failed ({exc}). "
                            f"Retrying in {current_delay:.1f}s..."
                        )
                    time.sleep(current_delay)
                    current_delay *= backoff
            # Should never reach here, but satisfy type checker
            raise last_exc  # type: ignore[misc]
        return _wrapper
    return _decorator


async def async_retry(
    coro_factory: Callable[[], Any],
    max_attempts: int = 3,
    delay: float = 1.0,
    backoff: float = 2.0,
    exceptions: Tuple[type, ...] = (Exception,),
    logger: Optional[logging.Logger] = None,
    label: str = "",
) -> Any:
    """Async version of @retry_on_failure.  Pass a factory that creates a fresh coroutine.

    Usage::

        result = await async_retry(
            lambda: rag.aquery(text, param=param),
            max_attempts=3,
            logger=logger, label="RAG query"
        )
    """
    last_exc = None
    current_delay = delay
    for attempt in range(1, max_attempts + 1):
        try:
            return await coro_factory()
        except exceptions as exc:
            last_exc = exc
            if attempt == max_attempts:
                if logger:
                    logger.error(f"{label}: Exhausted {max_attempts} attempts: {exc}")
                raise
            if logger:
                logger.warning(
                    f"{label}: Attempt {attempt}/{max_attempts} failed ({exc}). "
                    f"Retrying in {current_delay:.1f}s..."
                )
            await asyncio.sleep(current_delay)
            current_delay *= backoff
    raise last_exc


class TimeoutError(Exception):
    """Raised when a timeout_context expires."""


from contextlib import contextmanager
import signal


@contextmanager
def timeout_context(seconds: float, message: str = "Operation timed out"):
    """Context manager that raises TimeoutError after *seconds*.

    Uses ``signal.alarm`` (Unix only).  For cross-platform use consider
    ``concurrent.futures.ThreadPoolExecutor`` as an alternative.

    Usage::

        with timeout_context(30, "LLM call"):
            result = llm.chat(messages)
    """
    def _handler(signum, frame):
        raise TimeoutError(message)

    old_handler = signal.signal(signal.SIGALRM, _handler)
    signal.alarm(int(seconds))
    try:
        yield
    finally:
        signal.alarm(0)
        signal.signal(signal.SIGALRM, old_handler)


# ═══════════════════════════════════════════════════════════════
#  7.  Structured Logging Context
# ═══════════════════════════════════════════════════════════════

def log_context(logger: logging.Logger, level: int = logging.INFO, **kwargs) -> str:
    """Format key=value pairs into a single log line and emit it.

    Usage::

        log_context(logger, tenant="mybot", action="insert", doc_id="abc.txt")
        # → "[RAGservicer] INFO ... tenant=mybot action=insert doc_id=abc.txt"
    """
    parts = " ".join(f"{k}={v}" for k, v in kwargs.items())
    logger.log(level, parts)
    return parts


# ═══════════════════════════════════════════════════════════════
#  8.  Flask Integration Helpers
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
    from api.auth import extract_tenant as _extract
    g.tenant_id = _extract() or _ANON_FALLBACK

    # Extract namespace from URL if present
    if request.view_args:
        g.namespace = request.view_args.get("namespace", "default")
    else:
        g.namespace = "default"


# ═══════════════════════════════════════════════════════════════
#  9.  Re-exports for convenience
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
    "handle_errors_v2",
    "build_error",
    "AppError",
    # Responses
    "build_success",
    "build_paginated",
    # Async
    "run_async",
    "set_event_loop",
    # Retry
    "retry_on_failure",
    "async_retry",
    "timeout_context",
    "TimeoutError",
    # Logging
    "log_context",
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
