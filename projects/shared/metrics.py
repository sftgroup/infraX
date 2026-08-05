"""统一 Prometheus /metrics 暴露（G-6）。

四服务共用同一套请求指标（prometheus-client，纯 Python 无编译依赖）：
  http_requests_total{service,method,path,status}     Counter
  http_request_duration_seconds{service,method,path}  Histogram
外加 prometheus-client 默认注册的进程/运行时指标（process_*、
python_gc* 等）。

接入：
  - FastAPI（data :9112 / ml-service :9120）：register_fastapi(app, "data")
  - Flask（injector :9113 / ragservicer :9721）：register_flask(app, "injector")

/metrics 已纳入 app_auth 公开豁免（DEFAULT_PUBLIC_PATHS 含 /metrics），
监控探针可免 key 拉取；与 /health + /stats + /admin/status 的 HTTP
轮询探针互补（SERVICE_ENDPOINTS_OBSERVABILITY.md §8）。
"""
from __future__ import annotations

import time

from prometheus_client import CONTENT_TYPE_LATEST, Counter, Histogram, generate_latest

# ── 请求指标（各服务进程独立加载，全局单例） ──────────────
REQUESTS = Counter(
    "http_requests_total",
    "Total HTTP requests handled",
    ["service", "method", "path", "status"],
)
DURATION = Histogram(
    "http_request_duration_seconds",
    "HTTP request duration in seconds",
    ["service", "method", "path"],
    buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0),
)


def _observe(service: str, method: str, path: str, status: int, duration: float) -> None:
    REQUESTS.labels(service=service, method=method, path=path, status=str(status)).inc()
    DURATION.labels(service=service, method=method, path=path).observe(duration)


def register_fastapi(app, service: str) -> None:
    """FastAPI：请求指标中间件 + GET /metrics。"""
    from fastapi import Request
    from fastapi.responses import PlainTextResponse

    @app.middleware("http")
    async def _http_metrics(request: Request, call_next):
        if request.url.path == "/metrics":
            return await call_next(request)
        start = time.monotonic()
        response = await call_next(request)
        _observe(service, request.method, request.url.path, response.status_code,
                 time.monotonic() - start)
        return response

    @app.get("/metrics", include_in_schema=False)
    async def metrics() -> PlainTextResponse:
        return PlainTextResponse(generate_latest(), media_type=CONTENT_TYPE_LATEST)


def register_flask(app, service: str) -> None:
    """Flask：请求指标记录 + GET /metrics。"""
    from flask import request, Response

    @app.before_request
    def _metrics_start():
        request.environ["_metrics_start"] = time.monotonic()

    @app.after_request
    def _metrics_observe(response):
        start = request.environ.get("_metrics_start")
        if start is not None and request.path != "/metrics":
            _observe(service, request.method, request.path, response.status_code,
                     time.monotonic() - start)
        return response

    @app.route("/metrics")
    def metrics():
        return Response(generate_latest(), mimetype=CONTENT_TYPE_LATEST)
