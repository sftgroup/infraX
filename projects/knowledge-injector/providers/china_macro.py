"""中国宏观经济数据源。

通过 Tushare Pro 获取中国宏观指标。
需要设置环境变量 TUSHARE_API_KEY。

每个指标函数：
  - 独立 API 调用
  - 失败返回 None（不阻塞其他指标）
  - 免费积分（120 点）即可访问基础宏观接口

用法:
    >>> data = fetch_china_cpi()
    >>> data["current"]
    0.3
"""
from __future__ import annotations

import logging
from typing import Any

from config import SETTINGS

logger = logging.getLogger(__name__)


def _get_api() -> Any | None:
    """获取 tushare pro API 实例。"""
    token = SETTINGS.tushare_api_key
    if not token:
        return None
    try:
        import tushare as ts
        ts.set_token(token)
        return ts.pro_api()
    except Exception:
        logger.debug("Tushare init failed", exc_info=True)
        return None


def _calc_trend(values: list[float], window: int = 6) -> str:
    """判断趋势方向（与 macro_economics.py 保持一致）。"""
    if len(values) < window:
        return "unknown"
    recent = values[-window // 2:]
    prior = values[-(window):-(window // 2)] if window // 2 > 0 else values[-window:]
    if not prior:
        return "unknown"
    avg_recent = sum(recent) / len(recent)
    avg_prior = sum(prior) / len(prior)
    diff_pct = abs(avg_prior) + 1e-9
    if (avg_recent - avg_prior) / diff_pct > 0.005:
        return "rising"
    if (avg_recent - avg_prior) / diff_pct < -0.005:
        return "falling"
    return "stable"


def _calc_pctile(value: float, history: list[float]) -> float:
    if len(history) < 2:
        return 50.0
    sorted_h = sorted(history)
    less_than = sum(1 for v in sorted_h if v < value)
    return less_than / (len(sorted_h) - 1) * 100


def _calc_zscore(value: float, history: list[float]) -> float:
    n = len(history)
    if n < 2:
        return 0.0
    mean = sum(history) / n
    var = sum((v - mean) ** 2 for v in history) / (n - 1)
    std = var ** 0.5
    if std < 1e-12:
        return 0.0
    return (value - mean) / std


def fetch_china_cpi() -> dict[str, Any] | None:
    """中国 CPI 同比 (%)。"""
    api = _get_api()
    if not api:
        return None
    try:
        df = api.cpi(ts_code="", start_date="", end_date="")
        if df is None or df.empty:
            return None
        df = df.sort_values("month")
        values = [float(v) for v in df["nt_yoy"].dropna().values]
        if len(values) < 2:
            return None
        current = values[-1]
        trend = _calc_trend(values)
        return {
            "name": "China CPI",
            "current": current,
            "unit": "% YoY",
            "trend": trend,
            "enriched": {
                "pctile": round(_calc_pctile(current, values), 0),
                "z_score": round(_calc_zscore(current, values), 2),
                "trend": trend,
            },
            "updated": df.iloc[-1]["month"],
        }
    except Exception:
        logger.debug("China CPI fetch failed", exc_info=True)
        return None


def fetch_china_gdp() -> dict[str, Any] | None:
    """中国 GDP 同比 (%)。"""
    api = _get_api()
    if not api:
        return None
    try:
        df = api.cn_gdp()
        if df is None or df.empty:
            return None
        df = df.sort_values("year")
        values = [float(v) for v in df["gdp_yoy"].dropna().values]
        if len(values) < 2:
            return None
        current = values[-1]
        trend = _calc_trend(values)
        return {
            "name": "China GDP",
            "current": current,
            "unit": "% YoY",
            "trend": trend,
            "enriched": {
                "pctile": round(_calc_pctile(current, values), 0),
                "z_score": round(_calc_zscore(current, values), 2),
                "trend": trend,
            },
            "updated": df.iloc[-1]["year"],
        }
    except Exception:
        logger.debug("China GDP fetch failed", exc_info=True)
        return None


def fetch_china_ppi() -> dict[str, Any] | None:
    """中国 PPI 同比 (%)。"""
    api = _get_api()
    if not api:
        return None
    try:
        df = api.cpi(ts_code="", start_date="", end_date="")
        if df is None or df.empty:
            return None
        df = df.sort_values("month")
        values = [float(v) for v in df["ppi_yoy"].dropna().values]
        if len(values) < 2:
            return None
        current = values[-1]
        trend = _calc_trend(values)
        return {
            "name": "China PPI",
            "current": current,
            "unit": "% YoY",
            "trend": trend,
            "enriched": {
                "pctile": round(_calc_pctile(current, values), 0),
                "z_score": round(_calc_zscore(current, values), 2),
                "trend": trend,
            },
            "updated": df.iloc[-1]["month"],
        }
    except Exception:
        logger.debug("China PPI fetch failed", exc_info=True)
        return None


def fetch_china_m2() -> dict[str, Any] | None:
    """中国 M2 货币供应量同比 (%)。"""
    api = _get_api()
    if not api:
        return None
    try:
        df = api.cn_m()
        if df is None or df.empty:
            return None
        df = df.sort_values("year")
        values = [float(v) for v in df["m2_yoy"].dropna().values]
        if len(values) < 2:
            return None
        current = values[-1]
        trend = _calc_trend(values)
        return {
            "name": "China M2",
            "current": current,
            "unit": "% YoY",
            "trend": trend,
            "enriched": {
                "pctile": round(_calc_pctile(current, values), 0),
                "z_score": round(_calc_zscore(current, values), 2),
                "trend": trend,
            },
            "updated": df.iloc[-1]["year"],
        }
    except Exception:
        logger.debug("China M2 fetch failed", exc_info=True)
        return None


def fetch_china_pmi() -> dict[str, Any] | None:
    """中国官方制造业 PMI。"""
    api = _get_api()
    if not api:
        return None
    try:
        df = api.cn_pmi()
        if df is None or df.empty:
            return None
        df = df.sort_values("year")
        values = [float(v) for v in df["mfg"].dropna().values]
        if len(values) < 2:
            return None
        current = values[-1]
        trend = _calc_trend(values)
        return {
            "name": "China PMI",
            "current": current,
            "unit": "Index",
            "trend": trend,
            "enriched": {
                "pctile": round(_calc_pctile(current, values), 0),
                "z_score": round(_calc_zscore(current, values), 2),
                "trend": trend,
                "zone": "expansion" if current > 50 else "contraction",
                "below_50": current < 50,
            },
            "updated": df.iloc[-1]["year"],
        }
    except Exception:
        logger.debug("China PMI fetch failed", exc_info=True)
        return None


def fetch_all_china_macro() -> dict[str, Any]:
    """并行拉取所有中国宏观指标。"""
    results = {}
    for name, func in [
        ("CPI", fetch_china_cpi),
        ("GDP", fetch_china_gdp),
        ("PPI", fetch_china_ppi),
        ("M2", fetch_china_m2),
        ("PMI", fetch_china_pmi),
    ]:
        try:
            data = func()
            if data:
                results[name] = data
        except Exception:
            logger.debug("fetch_china_%s failed", name.lower(), exc_info=True)
    if results:
        logger.info("Fetched %d China macro indicators", len(results))
    return results
