"""DS-12 入站鉴权单元测试。

覆盖 _api_authorized：
  - 未配置 DATA_API_KEY → 开放（True）
  - 配置后：X-Service-Key / X-API-Key / Bearer 任一匹配 → True
  - 无头 / 不匹配 → False
  - /health 豁免（_PUBLIC_PATHS）
"""
from __future__ import annotations

import os
import sys
from types import SimpleNamespace

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ.setdefault("DATA_CONFIG_PATH", "data_config.json")

import pytest  # noqa: E402

from main import _api_authorized, _PUBLIC_PATHS  # noqa: E402


def _req(**headers):
    return SimpleNamespace(headers=headers)


def test_open_when_no_key(monkeypatch):
    monkeypatch.setattr("app.config.DATA_API_KEY", "")
    assert _api_authorized(_req()) is True


def test_service_key_matches(monkeypatch):
    monkeypatch.setattr("app.config.DATA_API_KEY", "s3cret")
    assert _api_authorized(_req(**{"X-Service-Key": "s3cret"})) is True


def test_api_key_matches(monkeypatch):
    monkeypatch.setattr("app.config.DATA_API_KEY", "s3cret")
    assert _api_authorized(_req(**{"X-API-Key": "s3cret"})) is True


def test_bearer_matches(monkeypatch):
    monkeypatch.setattr("app.config.DATA_API_KEY", "s3cret")
    assert _api_authorized(_req(Authorization="Bearer s3cret")) is True


def test_no_header_rejected(monkeypatch):
    monkeypatch.setattr("app.config.DATA_API_KEY", "s3cret")
    assert _api_authorized(_req()) is False


def test_wrong_key_rejected(monkeypatch):
    monkeypatch.setattr("app.config.DATA_API_KEY", "s3cret")
    assert _api_authorized(_req(**{"X-Service-Key": "wrong"})) is False
    assert _api_authorized(_req(**{"X-API-Key": "wrong"})) is False
    assert _api_authorized(_req(Authorization="Bearer wrong")) is False


def test_health_exempt():
    assert "/health" in _PUBLIC_PATHS
