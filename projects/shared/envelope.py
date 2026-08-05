"""可选响应信封中间件（G-2）。

data / ml-service（FastAPI）成功响应默认返回裸字段（FastAPI 原生），
与 injector / ragservicer（Flask）的 `{code, message, data}` 信封不一致。

本中间件提供向后兼容的可选信封：
- 请求带 `?envelope=1` 或 header `X-Envelope: 1` 时，2xx JSON 响应统一包装为
  `{"code": 0, "message": "ok", "data": <原响应>}`
- 默认不带开关时行为不变（裸字段），现有调用方零影响
- 错误响应（4xx/5xx）已是 `{code, message, data}` 信封，不重复包装
- 非 JSON 响应（如 Prometheus /metrics 文本）不包装

接入：FastAPI 服务调用 `install_envelope_middleware(app)` 即可。
"""
from __future__ import annotations

import json


def install_envelope_middleware(app) -> None:
    """FastAPI：可选 `{code, message, data}` 信封中间件。"""
    from starlette.responses import JSONResponse

    @app.middleware("http")
    async def _envelope(request, call_next):
        # 开关：?envelope=1 或 X-Envelope: 1（仅成功响应需要）
        want = (
            request.query_params.get("envelope") in ("1", "true", "yes")
            or request.headers.get("x-envelope") in ("1", "true", "yes")
        )
        response = await call_next(request)
        if not want:
            return response
        if not 200 <= response.status_code < 300:
            return response  # 错误已是信封
        if request.url.path == "/metrics":
            return response  # Prometheus 文本，不包装

        # 读取响应体并尝试 JSON 解析
        body = b"".join([chunk async for chunk in response.body_iterator])
        if not body:
            return response
        try:
            data = json.loads(body)
        except (ValueError, UnicodeDecodeError):
            return response  # 非 JSON，不包装

        # 已是信封（含 code/message/data）则跳过，避免二次包装
        if isinstance(data, dict) and {"code", "message", "data"} <= set(data):
            return response

        headers = {k: v for k, v in response.headers.items() if k.lower() != "content-length"}
        return JSONResponse(
            {"code": 0, "message": "ok", "data": data},
            status_code=response.status_code,
            headers=headers,
        )
