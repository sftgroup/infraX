"""providers/ml.py 单测（ml-service 联动客户端）。

只测 HTTP 客户端行为，不触发 torch/网络：
  - ML_SERVICE_URL 未配置 → 返回 [] / None（fail-silent）
  - 配置后响应解析（200 + data list / data null / 非 200）
"""
from __future__ import annotations

import os
import sys
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

os.environ["ML_SERVICE_URL"] = ""  # 测试环境默认未配置

from providers import ml  # noqa: E402


class TestUnconfigured:
    """ML_SERVICE_URL 未设置时：不请求、不产生任何数据。"""

    def test_predict_all_empty(self):
        assert ml.predict_all_volatility() == []

    def test_predict_volatility_none(self):
        assert ml.predict_volatility("BTC") is None


class TestResponseParsing:
    def _set_url(self, url="http://ml:9120"):
        os.environ["ML_SERVICE_URL"] = url
        # config.SETTINGS 是模块加载时实例化的，需在设置 env 后重新读取
        from config import SETTINGS
        SETTINGS.ml_service_url = url
        SETTINGS.ml_api_key = ""

    def test_returns_list(self):
        self._set_url()
        payload = [{"symbol": "BTC", "volatility_score": 0.2, "volatility_level": "very_low"}]
        with patch("providers.ml.requests.get") as mocked:
            mocked.return_value.status_code = 200
            mocked.return_value.json.return_value = {"code": 0, "data": payload}
            assert ml.predict_all_volatility() == payload

    def test_null_data_returns_empty(self):
        self._set_url()
        with patch("providers.ml.requests.get") as mocked:
            mocked.return_value.status_code = 200
            mocked.return_value.json.return_value = {"code": 0, "data": None}
            assert ml.predict_all_volatility() == []

    def test_non_200_returns_empty(self):
        self._set_url()
        with patch("providers.ml.requests.get") as mocked:
            mocked.return_value.status_code = 500
            assert ml.predict_all_volatility() == []

    def test_predict_volatility_filters_symbol(self):
        self._set_url()
        payload = [
            {"symbol": "BTC", "volatility_score": 0.2},
            {"symbol": "ETH", "volatility_score": 0.4},
        ]
        with patch("providers.ml.requests.get") as mocked:
            mocked.return_value.status_code = 200
            mocked.return_value.json.return_value = {"code": 0, "data": payload}
            assert ml.predict_volatility("ETH")["symbol"] == "ETH"
            assert ml.predict_volatility("SPY") is None

    def test_sends_api_key_header(self):
        self._set_url()
        from config import SETTINGS
        SETTINGS.ml_api_key = "secret"
        try:
            with patch("providers.ml.requests.get") as mocked:
                mocked.return_value.status_code = 200
                mocked.return_value.json.return_value = {"code": 0, "data": []}
                ml.predict_all_volatility()
                kwargs = mocked.call_args.kwargs
                assert kwargs.get("headers", {}).get("X-API-Key") == "secret"
        finally:
            SETTINGS.ml_api_key = ""
