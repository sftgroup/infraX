"""data-service 请求级限流中间件（G-3）。

对齐 ragservicer `api/middleware.py` 的 TokenBucket 实现，按 client IP
维度限流；超过配额返回统一 429 信封 `{code, message, data}`。

生效条件：`app/config.py` 的 `RATE_LIMIT_ENABLED=true`（默认 true，
可用 .env 的 `RATE_LIMIT_ENABLED=false` 关闭，`RATE_LIMIT_RPM` 调配额）。
豁免路径：`/health`（存活探针）与 `/admin/*`（管理端点，已由
ADMIN_API_KEY 独立鉴权）。
"""
from __future__ import annotations

import threading
import time

from fastapi.responses import JSONResponse

# 豁免路径（与 app_auth 豁免语义一致；/metrics 供监控探针免限流拉取）
_EXEMPT_PREFIXES = ("/health", "/admin/", "/metrics")


class _TokenBucket:
    """线程安全令牌桶：rate 个 token / per_seconds 秒。"""

    def __init__(self, rate: int, per_seconds: int = 60):
        self.rate = rate
        self.per_seconds = per_seconds
        self.tokens = float(rate)
        self.last_refill = time.monotonic()
        self._lock = threading.Lock()

    def consume(self, count: int = 1) -> bool:
        with self._lock:
            now = time.monotonic()
            elapsed = now - self.last_refill
            self.tokens = min(float(self.rate), self.tokens + elapsed * (self.rate / self.per_seconds))
            self.last_refill = now
            if self.tokens >= count:
                self.tokens -= count
                return True
            return False


_buckets: dict[str, _TokenBucket] = {}
_buckets_lock = threading.Lock()


def _get_bucket(key: str, rpm: int) -> _TokenBucket:
    with _buckets_lock:
        bucket = _buckets.get(key)
        if bucket is None:
            bucket = _TokenBucket(rpm)
            _buckets[key] = bucket
        return bucket


def _is_exempt(path: str) -> bool:
    return path.startswith(_EXEMPT_PREFIXES)


async def rate_limit_middleware(request, call_next):
    """FastAPI http 中间件：按 client IP 限流，超限返回 429 信封。"""
    import app.config as cfg

    if not cfg.RATE_LIMIT_ENABLED or _is_exempt(request.url.path):
        return await call_next(request)

    client = request.client.host if request.client else "unknown"
    if not _get_bucket(client, cfg.RATE_LIMIT_RPM).consume():
        return JSONResponse(
            status_code=429,
            content={"code": 429, "message": "Rate limit exceeded. Try again later.", "data": None},
        )
    return await call_next(request)
