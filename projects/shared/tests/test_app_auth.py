"""统一鉴权契约 app_auth 单元测试（纯函数，不依赖网络/框架）。

覆盖：
  - 三种 header 提取优先级（Bearer > X-API-Key > X-Service-Key）
  - 未配置 key → 开放；配置后强制校验（常量时间比较）
  - /health 精确豁免 + admin 前缀豁免
  - 统一 401 响应体
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import app_auth  # noqa: E402


def _headers(mapping: dict[str, str]):
    return lambda name: mapping.get(name, "")


# ─── 提取优先级 ──────────────────────────────────────────

def test_extract_prefers_bearer():
    h = _headers({"Authorization": "Bearer abc", "X-API-Key": "def", "X-Service-Key": "ghi"})
    assert app_auth.extract_api_key(h) == "abc"


def test_extract_x_api_key():
    h = _headers({"X-API-Key": "def"})
    assert app_auth.extract_api_key(h) == "def"


def test_extract_x_service_key():
    h = _headers({"X-Service-Key": "ghi"})
    assert app_auth.extract_api_key(h) == "ghi"


def test_extract_empty_when_none():
    assert app_auth.extract_api_key(_headers({})) == ""
    assert app_auth.extract_api_key(_headers({"Authorization": "Basic xyz"})) == ""


# ─── 鉴权 ───────────────────────────────────────────────

def test_open_when_no_key_configured():
    assert app_auth.is_authorized(_headers({}), "") is True
    assert app_auth.is_authorized(_headers({}), None) is True


def test_authorized_any_header():
    for h in (
        {"Authorization": "Bearer s3cret"},
        {"X-API-Key": "s3cret"},
        {"X-Service-Key": "s3cret"},
    ):
        assert app_auth.is_authorized(_headers(h), "s3cret") is True


def test_rejected_wrong_or_missing():
    assert app_auth.is_authorized(_headers({}), "s3cret") is False
    assert app_auth.is_authorized(_headers({"X-Service-Key": "wrong"}), "s3cret") is False


def test_bearer_prefix_not_trimmed_body():
    # "Bearer " 前缀剥离；整体两侧空白被 strip
    assert app_auth.extract_api_key(_headers({"Authorization": "Bearer s3cret "})) == "s3cret"


# ─── 豁免 ───────────────────────────────────────────────

def test_health_exempt_by_default():
    assert app_auth.is_exempt("/health") is True
    assert app_auth.is_exempt("/bars") is False


def test_admin_prefix_exempt():
    assert app_auth.is_exempt("/admin/config", prefixes=("/admin/",)) is True
    assert app_auth.is_exempt("/bars", prefixes=("/admin/",)) is False


# ─── 统一 401 ───────────────────────────────────────────

def test_unified_401_body():
    assert app_auth.UNAUTHORIZED == {"detail": "unauthorized"}
