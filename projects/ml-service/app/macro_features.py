"""宏观特征模块 — 把 FRED 宏观历史/DXY/VIX/US10Y 转为预测可消费的特征。

供 ml-service 各预测端点引用（tree/consensus 附加 macro_context，
独立端点 /ml/macro_features 供 B 端直接消费）。

每个系列派生特征（与 injector fred_economics 同思路的统计增强，非 ML）：
  - latest / date        最新观测值
  - chg_30d_pct / chg_90d_pct  相对 30/90 天的变化率
  - trend                 近 window 期均值对比（rising/falling/stable）
  - percentile            最新值在历史序列中的百分位

fail-silent：data-service 未配置 / 请求失败 / 序列不足时返回 None，
不影响模型预测主流程（宏观特征是增强，不是依赖）。
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from app import data_client

logger = logging.getLogger(__name__)

# 趋势判定窗口（期数）
_TREND_WINDOW = 6
# 变化率窗口（天）
_CHG_30D = 30
_CHG_90D = 90
# 各系列需达到的最少观测数（不足则跳过趋势/百分位，只给 latest）
_MIN_POINTS = 5


def _parse_ts(date_str: str) -> Optional[int]:
    """YYYY-MM-DD → unix ms。"""
    try:
        return int(datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp() * 1000)
    except Exception:
        return None


def _calc_trend(values: list[float]) -> str:
    """比较最近 window/2 期 vs 前 window/2 期均值。"""
    if len(values) < _TREND_WINDOW:
        return "unknown"
    half = _TREND_WINDOW // 2
    recent = values[-half:]
    prior = values[-_TREND_WINDOW:-half]
    avg_recent = sum(recent) / len(recent)
    avg_prior = sum(prior) / len(prior)
    diff = (avg_recent - avg_prior) / (abs(avg_prior) + 1e-9)
    if diff > 0.005:
        return "rising"
    if diff < -0.005:
        return "falling"
    return "stable"


def _calc_percentile(value: float, history: list[float]) -> float:
    if len(history) < 2:
        return 50.0
    less = sum(1 for v in history if v < value)
    return round(less / (len(history) - 1) * 100, 1)


def _chg_pct(series: list[dict], days: int) -> Optional[float]:
    """相对 days 天前的变化率（%）。"""
    if len(series) < 2:
        return None
    latest = series[-1]
    latest_ts = _parse_ts(latest["date"])
    if latest_ts is None:
        return None
    cutoff = latest_ts - days * 86400 * 1000
    target = None
    for p in reversed(series[:-1]):
        ts = _parse_ts(p["date"])
        if ts is not None and ts <= cutoff:
            target = p
            break
    if target is None or not target.get("value"):
        return None
    base = float(target["value"])
    if abs(base) < 1e-9:
        return None
    return round((float(latest["value"]) - base) / abs(base) * 100, 2)


def _series_features(obs: list[dict]) -> Optional[dict]:
    """单系列 → 派生特征。"""
    if not obs:
        return None
    latest = obs[-1]
    try:
        value = float(latest["value"])
    except (TypeError, ValueError):
        return None
    values = []
    for p in obs:
        try:
            values.append(float(p["value"]))
        except (TypeError, ValueError):
            continue
    feat: dict[str, Any] = {
        "latest": round(value, 4),
        "date": latest["date"],
    }
    c30 = _chg_pct(obs, _CHG_30D)
    c90 = _chg_pct(obs, _CHG_90D)
    if c30 is not None:
        feat["chg_30d_pct"] = c30
    if c90 is not None:
        feat["chg_90d_pct"] = c90
    if len(values) >= _MIN_POINTS:
        feat["trend"] = _calc_trend(values)
        feat["percentile"] = _calc_percentile(value, values)
    return feat


def compute_macro_features() -> Optional[dict]:
    """主入口：拉取 FRED 宏观历史 + DXY/VIX/US10Y → 派生特征 dict。

    返回 {"ts", "series": {name: feat}, "market": {vix/dxy/us10y}} 或 None。
    """
    hist = data_client.fetch_macro_history()
    if not hist:
        return None

    series: dict[str, dict] = {}
    for name, obs in hist.get("series", {}).items():
        feat = _series_features(obs)
        if feat:
            series[name] = feat

    # DXY/VIX/US10Y 最新快照（provider=macro）
    market: dict[str, Any] = {}
    for dt, field in (("vix", "value"), ("dxy", "value"), ("us10y", "us10y")):
        snap = data_client.fetch_snapshot_factor(dt, field)
        if snap:
            market[dt] = snap["value"]

    if not series and not market:
        return None
    return {"ts": hist.get("ts", 0), "series": series, "market": market}
