"""FRED 宏观经济数据源。

从 Federal Reserve Economic Data (FRED) 获取美国经济指标。
需要设置环境变量 FRED_API_KEY。

每个指标函数：
  - 独立 HTTP 调用
  - 返回带增强上下文的数据（趋势、百分位、z-score）
  - 失败返回 None（不阻塞其他指标）

用法:
    >>> data = fetch_us_cpi()
    >>> data["current"]
    3.2
    >>> data["enriched"]["trend"]
    "falling"
"""
from __future__ import annotations

import logging
from typing import Any

import requests

from config import rotate_key

logger = logging.getLogger(__name__)

# ─── Series ID 配置 ──────────────────────────────────

_FRED_SERIES: dict[str, dict[str, Any]] = {
    "GDP":       {"series_id": "GDPC1",     "name": "Real GDP",          "unit": "Trillions USD", "freq": "quarterly"},
    "CPI":       {"series_id": "CPIAUCSL",  "name": "CPI",              "unit": "Index",         "freq": "monthly"},
    "Core CPI":  {"series_id": "CPILFESL",  "name": "Core CPI",         "unit": "Index",         "freq": "monthly"},
    "PCE":       {"series_id": "PCEPI",     "name": "PCE Price Index",  "unit": "Index",         "freq": "monthly"},
    "Core PCE":  {"series_id": "PCEPILFE",  "name": "Core PCE",         "unit": "Index",         "freq": "monthly"},
    "NFP":       {"series_id": "PAYEMS",    "name": "Non-farm Payrolls", "unit": "Thousands",    "freq": "monthly"},
    "Unemployment": {"series_id": "UNRATE", "name": "Unemployment Rate", "unit": "%",            "freq": "monthly"},
    "PMI":       {"series_id": "NAPM",      "name": "ISM Manufacturing PMI", "unit": "Index",    "freq": "monthly"},
    "Fed Funds": {"series_id": "FEDFUNDS",  "name": "Fed Funds Rate",   "unit": "%",             "freq": "daily"},
    "Retail Sales": {"series_id": "RSXFS",  "name": "Retail Sales",     "unit": "Millions USD",  "freq": "monthly"},
    "Industrial Production": {"series_id": "INDPRO", "name": "Industrial Production", "unit": "Index", "freq": "monthly"},
    "Avg Hourly Earnings": {"series_id": "AHETPI", "name": "Avg Hourly Earnings", "unit": "USD/hour", "freq": "monthly"},
}


# ─── 私有工具函数 ────────────────────────────────────


def _fred_get(series_id: str, limit: int = 24) -> list[dict] | None:
    """从 FRED API 拉取观测值。

    返回 [{"date": "2026-06-01", "value": 3.2}, ...]。
    API Key 为空时返回 None。
    """
    api_key = rotate_key("FRED_API_KEY")
    if not api_key:
        return None

    try:
        resp = requests.get(
            "https://api.stlouisfed.org/fred/series/observations",
            params={
                "series_id": series_id,
                "file_type": "json",
                "api_key": api_key,
                "sort_order": "desc",
                "limit": limit,
            },
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()
        obs = data.get("observations", [])
        results = []
        for o in obs:
            val = o.get("value", "")
            if val and val != ".":
                results.append({
                    "date": o["date"],
                    "value": float(val),
                })
        results.reverse()  # 升序
        return results
    except Exception:
        logger.debug("FRED series %s fetch failed", series_id, exc_info=True)
        return None


def _calc_trend(values: list[float], window: int = 6) -> str:
    """判断趋势方向。比较最近 window/2 期 vs 前 window/2 期的均值。"""
    if len(values) < window:
        return "unknown"
    recent = values[-window // 2:]
    prior = values[-(window):-(window // 2)] if window // 2 > 0 else values[-window:]
    if not prior:
        return "unknown"
    avg_recent = sum(recent) / len(recent)
    avg_prior = sum(prior) / len(prior)
    diff_pct = (avg_recent - avg_prior) / (abs(avg_prior) + 1e-9)
    if diff_pct > 0.005:
        return "rising"
    if diff_pct < -0.005:
        return "falling"
    return "stable"


def _calc_pctile(value: float, history: list[float]) -> float:
    """计算值在历史数据中的百分位（0~100）。"""
    if len(history) < 2:
        return 50.0
    sorted_h = sorted(history)
    less_than = sum(1 for v in sorted_h if v < value)
    return less_than / (len(sorted_h) - 1) * 100


def _calc_zscore(value: float, history: list[float]) -> float:
    """z-score。"""
    n = len(history)
    if n < 2:
        return 0.0
    mean = sum(history) / n
    var = sum((v - mean) ** 2 for v in history) / (n - 1)
    std = var ** 0.5
    if std < 1e-12:
        return 0.0
    return (value - mean) / std


def _enrich_series(
    series_id: str,
    name: str,
    unit: str,
    limit: int = 24,
    target: float | None = None,
) -> dict[str, Any] | None:
    """拉取单个 FRED 系列并做增强计算。"""
    obs = _fred_get(series_id, limit=limit)
    if not obs or len(obs) < 2:
        return None

    current = obs[-1]["value"]
    values = [o["value"] for o in obs]
    trend = _calc_trend(values)

    enriched = {
        "pctile": round(_calc_pctile(current, values), 0),
        "z_score": round(_calc_zscore(current, values), 2),
        "trend": trend,
    }
    if target is not None:
        enriched["target_gap"] = round(current - target, 2)

    return {
        "name": name,
        "series_id": series_id,
        "unit": unit,
        "current": current,
        "trend": trend,
        "enriched": enriched,
        "updated": obs[-1]["date"],
    }


# ─── 公开函数 ────────────────────────────────────────


def fetch_us_cpi() -> dict[str, Any] | None:
    """Consumer Price Index (YoY 变化)。"""
    raw = _enrich_series("CPIAUCSL", "CPI", "Index", target=2.0)
    if not raw:
        return None
    # 计算 YoY 变化率
    obs = _fred_get("CPIAUCSL", limit=13)
    if obs and len(obs) >= 13:
        yoy = (obs[-1]["value"] - obs[0]["value"]) / obs[0]["value"] * 100
        raw["current"] = round(yoy, 1)
        raw["unit"] = "% YoY"
        raw["enriched"]["yoy_change"] = round(yoy, 1)
    return raw


def fetch_us_core_cpi() -> dict[str, Any] | None:
    """核心 CPI（不含食品能源）。"""
    return _enrich_series("CPILFESL", "Core CPI", "Index YoY", target=2.0)


def fetch_us_pce() -> dict[str, Any] | None:
    """PCE 物价指数。"""
    obs = _fred_get("PCEPI", limit=13)
    if not obs or len(obs) < 13:
        return None
    yoy = (obs[-1]["value"] - obs[0]["value"]) / obs[0]["value"] * 100
    values = [o["value"] for o in obs]
    trend = _calc_trend(values)
    return {
        "name": "PCE",
        "series_id": "PCEPI",
        "unit": "% YoY",
        "current": round(yoy, 1),
        "trend": trend,
        "enriched": {
            "pctile": round(_calc_pctile(obs[-1]["value"], values), 0),
            "z_score": round(_calc_zscore(obs[-1]["value"], values), 2),
            "trend": trend,
            "target_gap": round(yoy - 2.0, 1),
        },
        "updated": obs[-1]["date"],
    }


def fetch_us_nonfarm() -> dict[str, Any] | None:
    """非农就业 (NFP)。"""
    raw = _enrich_series("PAYEMS", "Non-farm Payrolls", "Thousands")
    if not raw:
        return None
    # 计算月度变化
    obs = _fred_get("PAYEMS", limit=3)
    if obs and len(obs) >= 2:
        raw["enriched"]["mom_change"] = round(obs[-1]["value"] - obs[-2]["value"], 0)
    return raw


def fetch_us_unemployment() -> dict[str, Any] | None:
    """失业率。"""
    return _enrich_series("UNRATE", "Unemployment Rate", "%")


def fetch_us_pmi() -> dict[str, Any] | None:
    """ISM 制造业 PMI。"""
    raw = _enrich_series("NAPM", "ISM Manufacturing PMI", "Index")
    if raw:
        raw["enriched"]["zone"] = "expansion" if raw["current"] > 50 else "contraction"
        raw["enriched"]["below_50"] = raw["current"] < 50
    return raw


def fetch_us_gdp() -> dict[str, Any] | None:
    """实际 GDP。"""
    return _enrich_series("GDPC1", "Real GDP", "Trillions USD")


def fetch_fed_funds_rate() -> dict[str, Any] | None:
    """联邦基金利率。"""
    return _enrich_series("FEDFUNDS", "Fed Funds Rate", "%")


def fetch_all_macro() -> dict[str, Any]:
    """并行拉取所有宏观指标。

    返回:
        {
            "CPI": {...},
            "PCE": {...},
            "NFP": {...},
            "Unemployment": {...},
            "PMI": {...},
            "GDP": {...},
            "Fed Funds": {...},
        }
    """
    results = {}
    for name, func in [
        ("CPI", fetch_us_cpi),
        ("Core CPI", fetch_us_core_cpi),
        ("PCE", fetch_us_pce),
        ("NFP", fetch_us_nonfarm),
        ("Unemployment", fetch_us_unemployment),
        ("PMI", fetch_us_pmi),
        ("GDP", fetch_us_gdp),
        ("Fed Funds", fetch_fed_funds_rate),
    ]:
        try:
            data = func()
            if data:
                results[name] = data
        except Exception:
            logger.debug("fetch_%s failed", name, exc_info=True)
    if results:
        logger.info("Fetched %d macro indicators", len(results))
    return results


# ─── 多区域 FRED 支持 ─────────────────────────────────

# 每个区域的核心指标 Series ID（FRED 覆盖全球主要经济体）
_REGION_SERIES: dict[str, dict[str, dict]] = {
    "US": {
        "CPI":       {"id": "CPIAUCSL",    "name": "CPI",          "target": 2.0},
        "Unemployment": {"id": "UNRATE",   "name": "Unemployment Rate", "target": None},
        "GDP":       {"id": "GDPC1",       "name": "Real GDP",     "target": None},
        "FedFunds":  {"id": "FEDFUNDS",    "name": "Fed Funds Rate", "target": None},
    },
    "JP": {
        "CPI":       {"id": "JPNCPIALLMINMEI", "name": "Japan CPI", "target": 2.0},
        "GDP":       {"id": "JPNNGDP",         "name": "Japan GDP",  "target": None},
        "Unemployment": {"id": "LRUNTTTTJPQ156N", "name": "Japan Unemployment", "target": None},
        "Rate":      {"id": "INTDSRJPM193N",    "name": "Japan Policy Rate", "target": None},
    },
    "EU": {
        "CPI":       {"id": "CP0000EZ19M086NEST", "name": "Eurozone HICP", "target": 2.0},
        "GDP":       {"id": "CPMNACSCAB1GQEA19",  "name": "Eurozone GDP",  "target": None},
        "Unemployment": {"id": "LRUNTTTTEZQ156N", "name": "Eurozone Unemployment", "target": None},
        "Rate":      {"id": "IRSTCI01EZM156N",    "name": "Eurozone Rate", "target": None},
    },
    "DE": {
        "CPI":       {"id": "DEUCPIALLMINMEI",    "name": "Germany CPI",     "target": 2.0},
        "GDP":       {"id": "DEURGDPR",           "name": "Germany GDP",     "target": None},
        "Unemployment": {"id": "DEUURHARMQDSMEI", "name": "Germany Unemployment", "target": None},
        "Rate":      {"id": "INTDSRDEM193N",      "name": "Germany Policy Rate", "target": None},
    },
    "UK": {
        "CPI":       {"id": "GBRCPIALLMINMEI",    "name": "UK CPI",          "target": 2.0},
        "GDP":       {"id": "GBRRGDPR",           "name": "UK GDP",           "target": None},
        "Unemployment": {"id": "GBRURHARMQDSMEI", "name": "UK Unemployment",  "target": None},
        "Rate":      {"id": "INTDSRUKM193N",      "name": "UK Policy Rate",   "target": None},
    },
}


def _fetch_region_indicators(region: str) -> dict[str, Any] | None:
    """拉取单个区域的所有 FRED 指标。

    返回 {"CPI": {...}, "GDP": {...}, ...} 或 None（无 Key / 全失败）。
    """
    series_map = _REGION_SERIES.get(region)
    if not series_map:
        logger.debug("Unknown region: %s", region)
        return None

    results = {}
    for key, cfg in series_map.items():
        obs = _fred_get(cfg["id"], limit=24)
        if not obs or len(obs) < 2:
            continue

        current = obs[-1]["value"]
        values = [o["value"] for o in obs]
        trend = _calc_trend(values)

        enriched = {
            "pctile": round(_calc_pctile(current, values), 0),
            "z_score": round(_calc_zscore(current, values), 2),
            "trend": trend,
        }
        if cfg["target"] is not None:
            enriched["target_gap"] = round(current - cfg["target"], 2)

        # CPI 系列做 YoY
        if "CPI" in key and len(obs) >= 13:
            yoy = (obs[-1]["value"] - obs[-13]["value"]) / obs[-13]["value"] * 100
            current = round(yoy, 1)
            enriched["yoy"] = current

        results[key] = {
            "name": cfg["name"],
            "series_id": cfg["id"],
            "current": current,
            "trend": trend,
            "enriched": enriched,
            "updated": obs[-1]["date"],
        }

    return results if results else None


def fetch_regions(*region_codes: str) -> dict[str, dict[str, Any]]:
    """获取多个区域的经济指标。

    用法:
        >>> data = fetch_regions("JP", "EU", "DE", "UK")
        >>> data["JP"]["CPI"]["current"]
        2.1
    """
    if not region_codes:
        region_codes = tuple(_REGION_SERIES.keys())

    results = {}
    for code in region_codes:
        try:
            data = _fetch_region_indicators(code)
            if data:
                results[code] = data
        except Exception:
            logger.debug("fetch_region(%s) failed", code, exc_info=True)

    if results:
        logger.info("Fetched %d regions via FRED", len(results))
    return results
