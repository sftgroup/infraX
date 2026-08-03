"""Data providers — caching and fetch utilities."""
import json
import pickle
import time
import os
import hashlib
import threading
from functools import wraps
from typing import Any, Callable, Optional

# ---------------------------------------------------------------------------
# Redis cache backend (optional)
# ---------------------------------------------------------------------------
_redis_client: Optional[Any] = None


def _get_redis():
    global _redis_client
    if _redis_client is not None:
        return _redis_client

    redis_url = os.getenv('REDIS_URL', '')
    if not redis_url:
        _redis_client = False  # sentinel: disabled
        return None

    try:
        import redis
        _redis_client = redis.from_url(redis_url, decode_responses=False)
    except Exception:
        _redis_client = False
    return _redis_client if _redis_client is not False else None


# ---------------------------------------------------------------------------
# In-memory fallback cache
# ---------------------------------------------------------------------------
_cache: dict = {}


def _cache_key(*args) -> str:
    raw = json.dumps(args, sort_keys=True, default=str)
    return hashlib.md5(raw.encode()).hexdigest()


def get_cached(key: str, ttl: int = 300) -> Any:
    """Retrieve cached value (Redis preferred, in-memory fallback)."""
    r = _get_redis()
    if r:
        raw = r.get(key)
        if raw:
            try:
                return pickle.loads(raw)
            except Exception:
                pass
    entry = _cache.get(key)
    if entry and time.time() < entry['expires']:
        return entry['value']
    return None


def set_cached(key: str, value: Any, ttl: int = 300):
    """Store value in cache (Redis preferred, in-memory fallback)."""
    r = _get_redis()
    if r:
        r.setex(key, ttl, pickle.dumps(value, protocol=pickle.HIGHEST_PROTOCOL))
    _cache[key] = {'value': value, 'expires': time.time() + ttl}


def clear_cache(pattern: Optional[str] = None):
    """Clear in-memory cache. Redis keys matching pattern."""
    global _cache
    _cache.clear()
    r = _get_redis()
    if r and pattern:
        for key in r.scan_iter(pattern):
            r.delete(key)


def invalidate(key: str):
    """Remove a single key from both caches."""
    _cache.pop(key, None)
    r = _get_redis()
    if r:
        r.delete(key)


def safe_float(v: Any, default: float = 0.0) -> float:
    """Safely coerce a value to float."""
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def cached_or_compute(key: str, ttl: int = 300):
    """Decorator: cache function result by key template."""

    def decorator(func: Callable):
        @wraps(func)
        def wrapper(*args, **kwargs):
            k = key.format(*args, **kwargs)
            cached = get_cached(k, ttl)
            if cached is not None:
                return cached
            result = func(*args, **kwargs)
            set_cached(k, result, ttl)
            return result

        return wrapper

    return decorator
