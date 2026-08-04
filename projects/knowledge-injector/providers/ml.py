"""ml-service 联动 — Kronos 波动率预测（HTTP 客户端）。

Kronos 推理已拆分到独立 ml-service（projects/ml-service/），本模块只做
"拉取 → 返回结果"，不承载模型推理。

ml-service 端点：
    GET /ml/volatility → {"code":0, "data": [{symbol, volatility_score, ...}]}

行为约定：
  - 未配置 ML_SERVICE_URL 或请求失败时返回 []（fail-silent，不影响注入器主循环）。
  - 模型/依赖不可用时 ml-service 返回 data=null → 本模块返回 []（无模拟数据）。
"""
from __future__ import annotations

import logging
from typing import Any

import requests

from config import SETTINGS

logger = logging.getLogger(__name__)

_TIMEOUT = 120  # ml-service 首次加载 Kronos 模型可能较慢


def _headers() -> dict:
    return {"X-API-Key": SETTINGS.ml_api_key} if SETTINGS.ml_api_key else {}


def predict_volatility(symbol: str) -> dict[str, Any] | None:
    """（兼容入口）拉取全部预测并返回指定 symbol 的一项；不可用返回 None。"""
    for pred in predict_all_volatility():
        if pred.get("symbol") == symbol:
            return pred
    return None


def predict_all_volatility() -> list[dict[str, Any]]:
    """拉取 ml-service Kronos 波动率预测（全部目标资产）。失败返回 []。"""
    base = (SETTINGS.ml_service_url or "").strip().rstrip("/")
    if not base:
        return []
    try:
        resp = requests.get(f"{base}/ml/volatility", headers=_headers(), timeout=_TIMEOUT)
        if resp.status_code != 200:
            logger.debug("ml-service /ml/volatility → %s", resp.status_code)
            return []
        data = (resp.json() or {}).get("data")
        return data if isinstance(data, list) else []
    except requests.Timeout:
        logger.debug("ml-service /ml/volatility timeout (%ss)", _TIMEOUT)
        return []
    except requests.RequestException as exc:
        logger.debug("ml-service /ml/volatility request failed: %s", exc)
        return []
    except Exception as exc:
        logger.debug("ml-service /ml/volatility parse failed: %s", exc)
        return []
