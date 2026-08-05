"""
Tushare A股数据源（HTTP POST + token 鉴权，多 key 轮换）。

接口：POST https://api.tushare.pro
  请求体：{"api_name": "daily", "token": "...", "params": {...}, "fields": "..."}
  响应体：{"code": 0, "data": {"fields": [...], "items": [[...], ...]}, "msg": "..."}

限制：
  - 仅支持日线（daily），按 ts_code 查询（000001.SZ / 600519.SH）
  - 需要积分权限（daily 需积分 ≥2000）；无权限时返回 code=40203，
    本模块 fail-silent 返回 []，上层回退腾讯/akshare。
"""

from __future__ import annotations

import datetime as _dt
import json
import logging
from typing import Any, Dict, List, Optional

import requests

from app.config import APIKeys
from app.utils.logger import get_logger

logger = get_logger(__name__)

TUSHARE_URL = "https://api.tushare.pro"
TIMEOUT = 15
_MAX_ATTEMPTS = 2

# daily 接口字段顺序（对齐 tushare daily 文档）
_DAILY_FIELDS = "ts_code,trade_date,open,high,low,close,vol,amount"


def _token() -> str:
    """多 key 轮换取 Tushare token（支持逗号分隔 key 池）。"""
    return APIKeys.rotate("TUSHARE_TOKEN") or ""


def is_configured() -> bool:
    return APIKeys.is_configured("TUSHARE_TOKEN")


def _to_ts_code(tencent_code: str) -> Optional[str]:
    """Tencent code（SH600519 / SZ000001 / 000001）→ Tushare ts_code（600519.SH / 000001.SZ）。"""
    c = (tencent_code or "").strip().upper()
    digits = c.replace("SH", "").replace("SZ", "").lstrip("SH")
    if not digits.isdigit():
        return None
    if c.startswith("SH") or (not c.startswith("SZ") and digits.startswith("6")):
        return f"{digits}.SH"
    return f"{digits}.SZ"


def _post(api_name: str, params: Dict[str, Any], fields: str) -> Optional[Dict[str, Any]]:
    """POST Tushare API。返回 data 字典或 None（无 token / 无权限 / 网络失败）。"""
    token = _token()
    if not token:
        return None
    body = {
        "api_name": api_name,
        "token": token,
        "params": params,
        "fields": fields,
    }
    for attempt in range(_MAX_ATTEMPTS):
        try:
            resp = requests.post(TUSHARE_URL, json=body, timeout=TIMEOUT)
            data = resp.json()
            break
        except Exception as e:
            if attempt + 1 >= _MAX_ATTEMPTS:
                logger.warning("Tushare request failed (%s): %s", api_name, e)
                return None
    else:
        return None

    code = data.get("code", -1)
    if code != 0:
        msg = data.get("msg", str(data))
        if "权限" in str(msg) or code == 40203:
            logger.warning("Tushare no permission (%s): %s", api_name, msg[:120])
        else:
            logger.warning("Tushare error %s (code=%s): %s", api_name, code, msg[:120])
        return None
    return data.get("data")


def fetch_tushare_klines(
    *,
    tencent_code: str,
    timeframe: str,
    limit: int,
    before_time: Optional[int] = None,
) -> List[Dict[str, Any]]:
    """Tushare 日线 K 线（仅 1D）。返回 kline dict 列表（time 为 unix 秒）。

    返回格式对齐 asia_stock_kline.fetch_twelvedata_klines：
      {"time": ts, "open": o, "high": h, "low": l, "close": c, "volume": v}
    """
    if (timeframe or "").strip().upper() != "1D":
        return []
    if not is_configured():
        return []

    ts_code = _to_ts_code(tencent_code)
    if not ts_code:
        return []

    # Tushare 分页（单次最多 6000 行），按交易日倒序取最近 limit 天
    end_date = _dt.date.today()
    if before_time:
        end_date = _dt.date.fromtimestamp(int(before_time))
    start_date = end_date - _dt.timedelta(days=int(limit * 1.6) + 60)  # 交易日≈自然日*0.7，留余量

    data = _post(
        "daily",
        {
            "ts_code": ts_code,
            "start_date": start_date.strftime("%Y%m%d"),
            "end_date": end_date.strftime("%Y%m%d"),
        },
        _DAILY_FIELDS,
    )
    if not data or not data.get("items"):
        return []

    fields = list(data.get("fields") or [])
    idx = {name: i for i, name in enumerate(fields)}

    out: List[Dict[str, Any]] = []
    for row in data["items"]:
        try:
            ts = int(_dt.datetime.strptime(row[idx["trade_date"]], "%Y%m%d").timestamp())
            o = float(row[idx["open"]])
            h = float(row[idx["high"]])
            low = float(row[idx["low"]])
            c = float(row[idx["close"]])
            vol = float(row[idx.get("vol") or idx.get("volume")] or 0)
            if o == 0 and c == 0:
                continue
            out.append({
                "time": ts,
                "open": round(o, 4),
                "high": round(h, 4),
                "low": round(low, 4),
                "close": round(c, 4),
                "volume": vol,
            })
        except (KeyError, IndexError, ValueError, TypeError):
            continue

    out.sort(key=lambda x: x["time"])
    if before_time:
        out = [r for r in out if r["time"] < before_time]
    out = out[-int(limit):] if limit > 0 else out
    return out
