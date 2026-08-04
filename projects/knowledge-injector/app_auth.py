"""统一鉴权契约 app_auth — 数据栈四个服务共用同一套入站鉴权。

单来源（source of truth）：projects/shared/app_auth.py。
data / knowledge-injector / ragservicer / ml-service 的 config.py 启动时
优先加载本文件（../shared，systemd/本地 git checkout 路径）；Docker 构建
无共享目录时回退到各项目根同名副本（副本与本文件保持一致，改动必须从
本文件同步）。

统一约定（契约统一 + key 治理收敛）：
  1. key 携带方式三选一，任一匹配即通过：
       Authorization: Bearer <key>
       X-API-Key: <key>
       X-Service-Key: <key>        # AItrader 服务间调用统一用此 header
  2. key 值收敛为平台 bridge key（回退链 RAGSERVICER_API_KEY →
     DOC_API_KEY → LIGHTRAG_API_KEY，见各服务 config.py）；未配置任何
     key 时保持开放（向后兼容），配置后强制校验。
  3. 统一豁免：/health 存活探针 + 各服务 admin 前缀。
  4. 统一 401 响应体：{"detail": "unauthorized"}。

纯标准库、框架无关（get_header 由各服务 web 框架注入
request.headers.get），可独立测试。
"""
from __future__ import annotations

import hmac
from typing import Callable, Container

# 统一 401 响应体（与 data-service DS-12 契约一致）
UNAUTHORIZED = {"detail": "unauthorized"}

# 默认豁免路径（存活探针）
DEFAULT_PUBLIC_PATHS = frozenset({"/health"})

HeaderGetter = Callable[[str], str]


def extract_api_key(get_header: HeaderGetter) -> str:
    """提取凭据：Bearer > X-API-Key > X-Service-Key；未携带返回空串。"""
    auth = (get_header("Authorization") or "").strip()
    if auth.startswith("Bearer "):
        return auth[7:]
    for header in ("X-API-Key", "X-Service-Key"):
        key = (get_header(header) or "").strip()
        if key:
            return key
    return ""


def is_authorized(get_header: HeaderGetter, expected_key: str | None) -> bool:
    """常量时间比较；expected_key 为空 → 未配置即开放（向后兼容）。"""
    if not expected_key:
        return True
    key = extract_api_key(get_header)
    return bool(key) and hmac.compare_digest(key, expected_key)


def is_exempt(
    path: str,
    exact: Container[str] = DEFAULT_PUBLIC_PATHS,
    prefixes: Container[str] = (),
) -> bool:
    """路径是否豁免：命中精确路径（/health 等）或前缀（/admin/ 等）。"""
    if path in exact:
        return True
    return any(path.startswith(p) for p in prefixes)
