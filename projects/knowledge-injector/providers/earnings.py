"""巨型企业财报数据源。

从 Finnhub 获取 25 只巨型企业（Mag 7 + 各行业龙头）的财报数据。
需要设置环境变量 FINNHUB_API_KEY。

返回聚合指数：
  - beat_rate（超预期比例）
  - avg_surprise（平均偏离）
  - sector_breakdown（板块分析）
  - health_score（综合评分）
"""
from __future__ import annotations

import logging
from typing import Any

import requests

from config import SETTINGS

logger = logging.getLogger(__name__)

# 25 只追踪的巨型企业（按行业分组）
_MEGACAP_TICKERS: dict[str, list[str]] = {
    "Tech (Mag 7)": ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"],
    "Finance":      ["JPM", "V", "MA"],
    "Energy":       ["XOM"],
    "Consumer":     ["WMT", "HD", "KO"],
    "Pharma":       ["JNJ"],
    "Tech Others":  ["CRM", "AVGO", "ORCL", "ADBE", "NFLX", "AMD"],
    "Traditional":  ["BRK.B", "DIS"],
}

# 展平为 ticker → sector 映射
_TICKER_SECTOR: dict[str, str] = {}
for sector, tickers in _MEGACAP_TICKERS.items():
    for t in tickers:
        _TICKER_SECTOR[t] = sector

_ALL_TICKERS = list(_TICKER_SECTOR.keys())


def fetch_earnings(ticker: str, limit: int = 2) -> dict[str, Any] | None:
    """获取单个股票的财报数据。

    返回:
        {
            "ticker": "NVDA",
            "period": "2026Q2",
            "actual": 2.40,
            "estimate": 2.35,
            "surprise_pct": 2.1,
            "beat": True,
        }
    """
    api_key = SETTINGS.finnhub_api_key
    if not api_key:
        return None

    try:
        resp = requests.get(
            "https://finnhub.io/api/v1/stock/earnings",
            params={"symbol": ticker, "token": api_key, "limit": limit},
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()
    except Exception:
        logger.debug("Earnings fetch failed for %s", ticker, exc_info=True)
        return None

    if not isinstance(data, list) or not data:
        return None

    latest = data[0]
    actual = latest.get("actual")
    estimate = latest.get("estimate")

    if actual is None or estimate is None or estimate == 0:
        return None

    surprise_pct = (actual - estimate) / abs(estimate) * 100
    return {
        "ticker": ticker,
        "sector": _TICKER_SECTOR.get(ticker, "Other"),
        "period": latest.get("period", "?"),
        "actual": actual,
        "estimate": estimate,
        "surprise_pct": round(surprise_pct, 2),
        "beat": actual > estimate,
    }


def fetch_all_megacap_earnings() -> dict[str, Any]:
    """获取所有 25 只巨型企业财报并计算聚合指数。

    返回:
        {
            "total": 25,
            "beat_count": 19,
            "miss_count": 6,
            "beat_rate": 76.0,
            "avg_surprise_pct": 3.2,
            "sector_breakdown": {
                "Tech (Mag 7)": {"beat_rate": 85.7, ...},
                ...
            },
            "health_score": 73,
            "updated": "2026Q2",
        }
    """
    api_key = SETTINGS.finnhub_api_key
    if not api_key:
        return {"total": 0, "error": "FINNHUB_API_KEY not set"}

    results: list[dict[str, Any]] = []
    for ticker in _ALL_TICKERS:
        try:
            ear = fetch_earnings(ticker)
            if ear:
                results.append(ear)
        except Exception:
            logger.debug("Earnings fetch failed for %s", ticker, exc_info=True)

    if not results:
        return {"total": 0, "error": "No earnings data"}

    # ── 聚合 ──
    beat_count = sum(1 for r in results if r["beat"])
    total = len(results)
    beat_rate = beat_count / total * 100
    avg_surprise = sum(r["surprise_pct"] for r in results) / total

    # 板块分析
    sector_data: dict[str, dict] = {}
    for r in results:
        sec = r["sector"]
        if sec not in sector_data:
            sector_data[sec] = {"total": 0, "beat": 0, "surprise_sum": 0.0}
        sector_data[sec]["total"] += 1
        sector_data[sec]["beat"] += 1 if r["beat"] else 0
        sector_data[sec]["surprise_sum"] += r["surprise_pct"]

    sector_breakdown: dict[str, dict] = {}
    for sec, data in sector_data.items():
        s_total = data["total"]
        sector_breakdown[sec] = {
            "total": s_total,
            "beat_rate": round(data["beat"] / s_total * 100, 1) if s_total > 0 else 0,
            "avg_surprise": round(data["surprise_sum"] / s_total, 2) if s_total > 0 else 0,
        }

    # 健康评分（beat_rate 权重 0.6 + avg_surprise 权重 0.4）
    surprise_score = min(100, max(0, (avg_surprise + 10) * 5))
    health_score = round(beat_rate * 0.6 + surprise_score * 0.4)

    report = {
        "total": total,
        "beat_count": beat_count,
        "miss_count": total - beat_count,
        "beat_rate": round(beat_rate, 1),
        "avg_surprise_pct": round(avg_surprise, 2),
        "sector_breakdown": sector_breakdown,
        "health_score": health_score,
        "updated": results[0].get("period", "?"),
    }

    logger.info(
        "Megacap earnings: %d/%d beat, beat_rate=%.1f%%, health=%d",
        beat_count, total, beat_rate, health_score,
    )
    return report
