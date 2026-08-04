"""结构化金融数据 → 自然语言文本。

纯函数，无外部依赖，无 IO。
每个函数： dict | args → str （< 500 token）
可独立测试：给定输入，输出确定。

前缀标记（[Macro], [Price], [Sentiment] 等）
引导 LightRAG 做实体类型识别和关系提取。

设计原则：
  - 函数签名写死命名参数，不接 **kwargs（避免隐式依赖）
  - 返回值 < 500 token（LightRAG 实体提取效率上限）
  - 只做事实描述，不做分析（注入器是记录仪，不是分析师）
"""
from __future__ import annotations

from typing import Optional

import numpy as np


# ─── 宏观 / 经济 ──────────────────────────────────────

def macro(
    vix: Optional[float] = None,
    dxy: Optional[float] = None,
    us10y: Optional[float] = None,
) -> str:
    """宏观经济指标 → 文本（带趋势判断）。"""
    parts = ["[Macro]"]
    if vix is not None:
        level = "elevated (risk-off)" if vix > 25 else "normal (risk-on)"
        parts.append(f"VIX {vix:.1f} ({level})")
    if dxy is not None:
        parts.append(f"DXY {dxy:.2f}")
    if us10y is not None:
        trend = "rising" if us10y > 4.0 else "stable" if us10y > 3.0 else "low"
        parts.append(f"US10Y {us10y:.2f}% ({trend})")
    return ". ".join(parts) + "." if len(parts) > 1 else "[Macro] No data."


def macro_trend_analysis(indicators: list[dict]) -> str:
    """宏观趋势综合分析。

    参数:
        indicators: [
            {"name": "CPI", "trend": "falling"},
            {"name": "GDP", "trend": "stable"},
            ...
        ]
    返回跨指标趋势综合判断。
    """
    if not indicators:
        return "[Macro Trend] No indicator data."

    counts: dict[str, int] = {}
    names: dict[str, list[str]] = {}
    for ind in indicators:
        trend = ind.get("trend", "unknown")
        name = ind.get("name", "?")
        counts[trend] = counts.get(trend, 0) + 1
        names.setdefault(trend, []).append(name)

    parts = ["[Macro Trend] Cross-indicator analysis:"]
    for trend in ("falling", "rising", "stable", "unknown"):
        cnt = counts.get(trend, 0)
        if cnt > 0:
            parts.append(f"{cnt} {trend} ({', '.join(names.get(trend, []))})")

    # 综合判断
    falling = counts.get("falling", 0)
    rising = counts.get("rising", 0)
    total = len(indicators)
    if falling > total * 0.5:
        verdict = "broad disinflation / economic slowdown signal"
    elif rising > total * 0.5:
        verdict = "broad acceleration / economic expansion signal"
    elif falling > 0 and rising > 0:
        verdict = "mixed signals — diverging trends across indicators"
    else:
        verdict = "stable across indicators"

    parts.append(f"Overall: {verdict}.")
    return " ".join(parts)


def economic_indicator(
    name: str,
    value: float,
    unit: str = "%",
    forecast: Optional[float] = None,
    prev: Optional[float] = None,
    target: Optional[float] = None,
    percentile: Optional[float] = None,
    trend: Optional[str] = None,
) -> str:
    """单项经济指标 → 带上下文的文本。

    这是增强注入的核心函数。不是传"CPI 3.2"，而是传"CPI 3.2%,
    高于目标 1.2pp，过去 6 月趋势下降，历史 35 分位"。
    """
    parts = [f"[Macro] {name} {value}{unit}"]
    if forecast is not None:
        diff = value - forecast
        direction = "above" if diff > 0 else "below"
        parts.append(f"{direction} forecast {forecast}{unit}")
    if target is not None:
        gap = value - target
        parts.append(f"target {target}{unit} (gap {gap:+.1f}{unit})")
    if prev is not None:
        parts.append(f"prev {prev}{unit}")
    if trend:
        parts.append(f"trend {trend}")
    if percentile is not None:
        parts.append(f"historical {percentile:.0f}th percentile")
    return ". ".join(parts) + "."


def macro_summary(data_map: dict) -> str:
    """多指标宏观汇总 → 文本。

    参数:
        data_map: {"CPI": {...}, "NFP": {...}, ...}
        每个值是 fetch_us_cpi() 等函数返回的字典。
    """
    lines = ["[Macro Summary] US economic indicators:"]
    for name, data in data_map.items():
        if not data or not isinstance(data, dict):
            continue
        line = f"[Macro] {name}"
        current = data.get("current")
        unit = data.get("unit", "")
        if current is not None:
            line += f" {current}{unit}"
        enriched = data.get("enriched", {})
        if enriched.get("trend"):
            line += f", trend {enriched['trend']}"
        if enriched.get("pctile") is not None:
            line += f", {enriched['pctile']:.0f}th pctile"
        if enriched.get("target_gap") is not None:
            gap = enriched["target_gap"]
            line += f", target gap {gap:+.1f}"
        if enriched.get("zone"):
            line += f", zone {enriched['zone']}"
        if enriched.get("yoy_change"):
            line += f", YoY {enriched['yoy_change']:+.1f}%"
        lines.append(line)

    if len(lines) == 1:
        return "[Macro Summary] No data."

    return "\n".join(lines)


# ─── 价格 / 技术指标 ─────────────────────────────────

def price(
    symbol: str,
    price_usd: float,
    change_pct: float,
    volume: Optional[float] = None,
    high_24h: Optional[float] = None,
    low_24h: Optional[float] = None,
) -> str:
    """当前价格快照 → 文本。"""
    parts = [f"[Price] {symbol} ${price_usd:.2f}, {change_pct:+.2f}% 24h"]
    if volume:
        parts.append(f"vol ${volume:,.0f}")
    if high_24h:
        parts.append(f"high ${high_24h:.2f}")
    if low_24h:
        parts.append(f"low ${low_24h:.2f}")
    return ". ".join(parts) + "."


def price_action(
    symbol: str,
    price_usd: float,
    change_pct: float,
    volume: Optional[float] = None,
    rsi: Optional[float] = None,
    macd_signal: Optional[str] = None,
    sma50: Optional[float] = None,
    sma200: Optional[float] = None,
    support: Optional[float] = None,
    resistance: Optional[float] = None,
) -> str:
    """增强价格描述（含技术指标上下文）。"""
    parts = [f"[Price Action] {symbol} ${price_usd:.2f}, {change_pct:+.2f}% 24h"]
    if volume:
        parts.append(f"volume ${volume:,.0f}")
    if rsi is not None:
        zone = "overbought" if rsi > 70 else "oversold" if rsi < 30 else "neutral"
        parts.append(f"RSI {rsi:.0f} ({zone})")
    if macd_signal:
        parts.append(f"MACD {macd_signal}")
    for ma_name, ma_val in [("SMA50", sma50), ("SMA200", sma200)]:
        if ma_val and price_usd:
            rel = "above" if price_usd > ma_val else "below"
            parts.append(f"{rel} {ma_name} (${ma_val:.0f})")
    if support:
        parts.append(f"support ${support:.0f}")
    if resistance:
        parts.append(f"resistance ${resistance:.0f}")
    return ". ".join(parts) + "."


def price_action_enriched(
    symbol: str,
    price_usd: float,
    change_pct: float,
    volume: Optional[float] = None,
    volume_ma20: Optional[float] = None,
    ath: Optional[float] = None,
    low_52w: Optional[float] = None,
    high_52w: Optional[float] = None,
    momentum_30d: Optional[float] = None,
    rsi: Optional[float] = None,
    ma_alignment: Optional[str] = None,
    macd_signal: Optional[str] = None,
    support: Optional[float] = None,
    resistance: Optional[float] = None,
    atr_pct: Optional[float] = None,
) -> str:
    """增强版价格描述（含 ATH 距离、成交量分析、均线排列、动量评分）。

    比 price_action 更丰富，适合主注入使用。
    所有增强字段由 enrichment.py 计算，无需外部数据源。
    """
    parts = [f"[Price Action] {symbol} ${price_usd:.2f}, {change_pct:+.2f}% 24h"]

    # 历史极值对比
    if ath and ath > 0:
        ath_dist = (price_usd - ath) / ath * 100
        parts.append(f"ATH ${ath:,.0f} (distance {ath_dist:+.1f}%)")
    if high_52w and low_52w:
        range_pct = (price_usd - low_52w) / (high_52w - low_52w) * 100 if high_52w > low_52w else 50
        parts.append(f"52w range ${low_52w:,.0f}–${high_52w:,.0f} (pos {range_pct:.0f}%)")

    # 动量
    if momentum_30d is not None:
        momentum_label = "strong" if abs(momentum_30d) > 15 else "moderate" if abs(momentum_30d) > 5 else "weak"
        parts.append(f"30d momentum {momentum_30d:+.1f}% ({momentum_label})")

    # 技术指标
    if rsi is not None:
        zone = "overbought" if rsi > 70 else "oversold" if rsi < 30 else "neutral"
        parts.append(f"RSI {rsi:.0f} ({zone})")
    if macd_signal:
        parts.append(f"MACD {macd_signal}")

    # 均线排列
    if ma_alignment:
        parts.append(f"MA alignment: {ma_alignment}")

    # 成交量分析
    if volume is not None and volume_ma20 is not None and volume_ma20 > 0:
        vol_ratio = volume / volume_ma20
        vol_label = "elevated" if vol_ratio > 1.3 else "normal" if vol_ratio > 0.7 else "low"
        parts.append(f"volume ${volume:,.0f} ({vol_label}, {vol_ratio:.2f}x MA20)")

    # 波动率
    if atr_pct:
        vol_label = "high" if atr_pct > 5 else "moderate" if atr_pct > 2 else "low"
        parts.append(f"ATR {atr_pct:.1f}% ({vol_label} vol)")

    # 支撑/阻力
    if support:
        parts.append(f"support ${support:,.0f}")
    if resistance:
        parts.append(f"resistance ${resistance:,.0f}")

    return ". ".join(parts) + "."


# ─── 情绪 / 新闻 ──────────────────────────────────────

def sentiment(
    score: float,
    fear_greed: Optional[int] = None,
    label: Optional[str] = None,
) -> str:
    """市场情绪数据 → 文本。"""
    parts = ["[Sentiment]"]
    lbl = label or ("bullish" if score > 60 else "bearish" if score < 40 else "neutral")
    parts.append(f"social sentiment {score:.0f}/100 ({lbl})")
    if fear_greed is not None:
        fg_label = (
            "extreme fear" if fear_greed < 25 else
            "fear" if fear_greed < 45 else
            "neutral" if fear_greed < 55 else
            "greed" if fear_greed < 75 else
            "extreme greed"
        )
        parts.append(f"Fear & Greed: {fear_greed} ({fg_label})")
    return ". ".join(parts) + "."


def news(title: str, snippet: str, source: str = "") -> str:
    """新闻 → 文本。"""
    src = f" ({source})" if source else ""
    return f"[News]{src} {title}\n{snippet[:500]}"


# ─── 重大事件 ─────────────────────────────────────────

def major_event(
    event_type: str,
    description: str,
    severity: str,
) -> str:
    """重大突发事件 → 文本。"""
    return (
        f"[MajorEvent] type={event_type}, severity={severity}: "
        f"{description[:200]}"
    )


# ─── 市场概览 ─────────────────────────────────────────

def crypto_overview(prices: list[dict]) -> str:
    """Top N 加密币价格概览 → 文本。"""
    lines = ["[Market Overview] Crypto market snapshot:"]
    for c in prices[:5]:
        sym = c.get("symbol", "")
        price_v = c.get("price", c.get("usdPrice", 0))
        chg = c.get("changePercent", c.get("change24h", 0))
        lines.append(f"{sym} ${price_v:.2f} ({chg:+.2f}%)")
    return "\n".join(lines)


def economic_release(
    name: str,
    actual: float,
    forecast: float,
    deviation: float,
    unit: str = "",
) -> str:
    """经济数据公布后，偏差分析 → 文本。"""
    return (
        f"[EconomicRelease] {name}: actual {actual}{unit}, "
        f"forecast {forecast}{unit}, deviation {deviation:+.1%}."
    )


def megacap_earnings_index(report: dict) -> str:
    """巨型企业财报指数 → 文本。

    参数:
        report: fetch_all_megacap_earnings() 的返回值
    """
    total = report.get("total", 0)
    if total == 0:
        return "[Earnings Index] No data."

    parts = [
        f"[Earnings Index] Megacap earnings for {report.get('updated', '?')}: "
        f"{report.get('beat_count', 0)}/{total} beat ({report.get('beat_rate', 0)}%), "
        f"avg surprise {report.get('avg_surprise_pct', 0):+.1f}%, "
        f"health score {report.get('health_score', 0)}/100"
    ]

    sector_breakdown = report.get("sector_breakdown", {})
    if sector_breakdown:
        sectors = []
        for sec, data in sector_breakdown.items():
            sectors.append(
                f"{sec}: {data.get('beat_rate', 0)}% beat, "
                f"avg surprise {data.get('avg_surprise', 0):+.1f}%"
            )
        parts.append("Sectors: " + " | ".join(sectors))

    return ". ".join(parts) + "."


# ─── 波动率快照 ───────────────────────────────────────

def volatility_snapshot(
    vxn: dict | None = None,
    gvz: dict | None = None,
    put_call: dict | None = None,
) -> str:
    """波动率指标快照 → 文本。

    参数:
        vxn: 来自 fetch_vxn() 的字典，含 value / level
        gvz: 来自 fetch_gvz() 的字典，含 value / level
        put_call: 来自 fetch_put_call_ratio() 的字典，含 value / term_structure / signal
    """
    parts = ["[Volatility Snapshot]"]

    if vxn:
        v = vxn.get("value", "?")
        lvl = vxn.get("level", "?")
        parts.append(f"VXN {v} ({lvl})")

    if gvz:
        v = gvz.get("value", "?")
        lvl = gvz.get("level", "?")
        parts.append(f"GVZ {v} ({lvl})")

    if put_call:
        v = put_call.get("value", "?")
        term = put_call.get("term_structure", "?")
        sig = put_call.get("signal", "?")
        parts.append(f"Put/Call ratio {v} ({term}, signal {sig})")

    if len(parts) == 1:
        return "[Volatility Snapshot] No data."

    return ". ".join(parts) + "."


# ─── 新闻情感聚合 ────────────────────────────────────

def news_sentiment_aggregate(
    total: int = 0,
    positive: int = 0,
    negative: int = 0,
    neutral: int = 0,
    positive_ratio: float = 0.0,
    negative_ratio: float = 0.0,
    sentiment_score: float = 0.0,
    classification: str = "neutral",
    source: str = "unknown",
) -> str:
    """新闻情感聚合结果 → 文本。

    参数直接对应 fetch_news_sentiment_aggregate() 返回值字段。
    """
    parts = [
        f"[News Sentiment] {source}: {total} articles in 24h, "
        f"sentiment {sentiment_score:+.3f} ({classification})"
    ]
    if total > 0:
        parts.append(
            f"positive {positive} ({positive_ratio:.0%}), "
            f"negative {negative} ({negative_ratio:.0%}), "
            f"neutral {neutral}"
        )
    return ". ".join(parts) + "."


# ─── 链上数据 ─────────────────────────────────────────

def onchain_btc(difficulty: float, block_height: int) -> str:
    """BTC 链上数据 → 文本。"""
    return f"[On-chain BTC] Difficulty {difficulty:.1f}T. Block height {block_height:,}."


def defi_tvl(chain: str, tvl_usd: float, change_24h: Optional[float] = None) -> str:
    """DeFi TVL → 文本。"""
    chg = f" ({change_24h:+.1f}% 24h)" if change_24h is not None else ""
    return f"[DeFi TVL] {chain} ${tvl_usd:,.0f}{chg}."


def eth_onchain(overview: dict) -> str:
    """ETH 链上数据 → 文本。

    参数:
        overview: fetch_evm_overview() 的返回值
    """
    parts = ["[On-chain ETH]"]

    supply = overview.get("eth_supply")
    if supply:
        label = supply.get("supply_label", "?")
        circulating = supply.get("circulating_label", "?")
        burned = supply.get("burned_label")
        line = f"Total supply {label}, circulating {circulating}"
        if burned:
            line += f", {burned} burned since EIP-1559"
        parts.append(line)

    staking = overview.get("eth_staking")
    if staking:
        parts.append(
            f"{staking.get('staked_label', '?')} staked "
            f"({staking.get('validators', 0):,} validators, APR {staking.get('apr', 0)}%)"
        )

    if len(parts) == 1:
        return "[On-chain ETH] No data."

    return ". ".join(parts) + "."


# ─── ML 预测（预留接口） ──────────────────────────────

def ml_prediction(
    model: str,
    symbol: str,
    volatility_level: str = "",
    volatility_score: float = 0.0,
    direction_consensus: float = 0.0,
    uncertainty: str = "",
) -> str:
    """ML 波动率预测 → 文本。

    Kronos-mini 仅用于波动率预测和市场不确定性评估。
    """
    parts = [
        f"[ML Volatility] {model} | {symbol}:",
        f"  volatility {volatility_level} (score {volatility_score:.2f})",
        f"  direction_consensus {direction_consensus:.2f}",
        f"  uncertainty {uncertainty}",
    ]
    return "\n".join(parts)


def ml_volatility_report(
    results: list[dict],
    sentiment: dict | None = None,
) -> str:
    """Kronos-mini 多资产波动率预测 + market sentiment_score 联动 → 文本。

    参数:
        results:   predict_all_volatility() 的输出列表（每项含 symbol /
                   volatility_level / volatility_score / direction_consensus /
                   uncertainty）。
        sentiment: fetch_sentiment_score() 的输出 {"value": [-1,1], "ts": ...}
                   或 None（未配置 data-service / 拉取失败）。

    sentiment_score ∈ [-1, 1]，来自 data-service SentimentCollector：
      正值 = 偏多，负值 = 偏空。报告末尾输出联动解读（高波动 + 负面情绪
      → 市场承压风险上升）。
    """
    if not results:
        return ""
    simulated = any(r.get("simulated") for r in results)
    if simulated:
        lines = ["[ML Volatility] Kronos-mini 多资产波动率与市场情绪联动:",
                 "[SIMULATED] 模拟数据（占位实现，非真实预测，仅供参考框架）"]
    else:
        lines = ["[ML Volatility] Kronos-mini 多资产波动率与市场情绪联动:"]
    for r in results:
        sym = r.get("symbol", "?")
        level = r.get("volatility_level", "unknown")
        score = r.get("volatility_score", 0)
        consensus = r.get("direction_consensus", 0)
        uncertainty = r.get("uncertainty", "unknown")
        lines.append(
            f"  {sym}: volatility {level} (score {float(score):.2f}), "
            f"direction_consensus {float(consensus):.2f}, uncertainty {uncertainty}"
        )

    score = None
    if sentiment and isinstance(sentiment.get("value"), (int, float)):
        score = float(sentiment["value"])
    if score is not None:
        if score > 0.2:
            label = "bullish"
        elif score < -0.2:
            label = "bearish"
        else:
            label = "neutral"
        lines.append(f"  Market sentiment_score {score:+.2f} → {label}")

        # 联动解读：高波动 + 负面情绪 = 市场承压
        avg_vol = sum(float(r.get("volatility_score", 0) or 0) for r in results) / max(len(results), 1)
        if score < -0.2 and avg_vol >= 0.6:
            lines.append("  Note: elevated volatility + negative sentiment "
                         "→ elevated market-stress risk")
    else:
        lines.append("  Market sentiment_score: unavailable")
    return "\n".join(lines)


# ─── 全球宏观（多区域） ───────────────────────────────

_REGION_NAMES = {
    "US": "United States",
    "JP": "Japan",
    "EU": "Eurozone",
    "DE": "Germany",
    "UK": "United Kingdom",
    "CN": "China",
}

def region_macro(region: str, data_map: dict) -> str:
    """单个区域的经济指标汇总 → 文本。

    参数:
        region: "US" / "JP" / "EU" / "DE" / "UK" / "CN"
        data_map: {"CPI": {...}, "GDP": {...}, ...}
    """
    region_name = _REGION_NAMES.get(region, region)
    lines = [f"[Global Macro] {region_name} economic indicators:"]

    for key, data in data_map.items():
        if not data or not isinstance(data, dict):
            continue
        line = f"  {key}"
        current = data.get("current")
        unit = data.get("unit", "")
        if current is not None:
            line += f" {current}{unit}"
        enriched = data.get("enriched", {})
        if enriched.get("trend"):
            line += f", trend {enriched['trend']}"
        if enriched.get("pctile") is not None:
            line += f", {enriched['pctile']:.0f}th pctile"
        if enriched.get("zone"):
            line += f", zone {enriched['zone']}"
        if enriched.get("target_gap") is not None:
            line += f", target gap {enriched['target_gap']:+.1f}"
        if enriched.get("yoy") is not None:
            line += f", YoY {enriched['yoy']:+.1f}%"
        lines.append(line)

    if len(lines) == 1:
        return f"[Global Macro] {region_name}: No data."
    return "\n".join(lines)


def global_macro_summary(region_data: dict) -> str:
    """多区域宏观汇总 → 文本。

    参数:
        region_data: {"US": {"CPI": {...}, ...}, "JP": {...}, ...}
    """
    parts = ["[Global Macro] Cross-region summary:"]
    for region, data_map in region_data.items():
        if not data_map:
            continue
        region_name = _REGION_NAMES.get(region, region)
        indicators = ", ".join(
            f"{k} {v.get('current', '?')}{v.get('unit', '')}"
            for k, v in data_map.items()
            if isinstance(v, dict) and v.get("current") is not None
        )
        parts.append(f"{region_name}: {indicators}")
    return "\n".join(parts) if len(parts) > 1 else "[Global Macro] No data."


# ─── 股票指数 ─────────────────────────────────────────

def stock_indices(indices: list[dict]) -> str:
    """全球股指快照 → 文本。

    参数:
        indices: fetch_global_indices() 的返回值
    """
    if not indices:
        return "[Stock Indices] No data."

    lines = ["[Stock Indices] Global market snapshot:"]
    for i in indices:
        region = i.get("region", "?")
        name = i.get("name", "?")
        price = i.get("price", 0)
        chg = i.get("change_pct", 0)
        lines.append(f"  [{region}] {name} {price:,.2f} ({chg:+.2f}%)")
    return "\n".join(lines)


# ─── 技术分析增强 (enrichment 因子接入) ─────────────


def tech_analysis(
    symbol: str,
    current_price: float,
    close_history: list[float],
    change_pct: float = 0.0,
    volume: float | None = None,
) -> str | None:
    """技术指标综合分析 — 单次注入。

    从价格历史计算 RSI/MACD/布林带/趋势/动量/波动率，
    生成一条综合技术面自然语言描述。

    Args:
        symbol:         标的（如 "BTC", "ETH"）
        current_price:  当前价格
        close_history:  收盘价序列（越长越好，>=50 点最优）
        change_pct:     日涨跌幅
        volume:         可选成交量
    """
    close = np.array(close_history, dtype=float)
    if len(close) < 30:
        return None  # 数据不足

    from injector.enrichment import (
        rsi, macd, bollinger_bands,
        trend_direction, momentum_phase, rsi_signal, volatility_level,
        ath_distance, ts_slope, price_percentile,
    )

    # 计算所有指标
    rsi_vals = rsi(close)
    current_rsi = float(rsi_vals[-1]) if not np.isnan(rsi_vals[-1]) else 50.0
    macd_data = macd(close)
    bb_data = bollinger_bands(close)
    trend = trend_direction(close)
    momentum = momentum_phase(close)
    vol_level = volatility_level(close)
    rsi_label = rsi_signal(current_rsi)
    ath_dist = ath_distance(current_price, close)
    pctile = price_percentile(current_price, close)

    # MACD 当前值
    macd_val = float(macd_data["macd_line"][-1]) if not np.isnan(macd_data["macd_line"][-1]) else 0
    macd_sig = float(macd_data["signal_line"][-1]) if not np.isnan(macd_data["signal_line"][-1]) else 0
    macd_hist = float(macd_data["histogram"][-1]) if not np.isnan(macd_data["histogram"][-1]) else 0
    macd_signal = "bullish" if macd_hist > 0 else "bearish"

    # 布林带位置
    bb_upper = float(bb_data["upper"][-1]) if not np.isnan(bb_data["upper"][-1]) else current_price * 1.1
    bb_lower = float(bb_data["lower"][-1]) if not np.isnan(bb_data["lower"][-1]) else current_price * 0.9
    bb_pct_b = float(bb_data["percent_b"][-1]) if not np.isnan(bb_data["percent_b"][-1]) else 0.5
    bb_bw = float(bb_data["bandwidth"][-1]) if not np.isnan(bb_data["bandwidth"][-1]) else 0

    lines = [
        f"[Technical] {symbol} @ {current_price:,.2f} ({change_pct:+.2f}%):",
        f"  trend {trend}, momentum {momentum},",
        f"  volatility {vol_level},",
        f"  RSI {current_rsi:.1f} ({rsi_label}),",
        f"  MACD {macd_val:+.4f} (signal {macd_sig:+.4f}, histogram {macd_hist:+.4f}, {macd_signal}),",
        f"  Bollinger: upper {bb_upper:,.2f}, lower {bb_lower:,.2f}",
        f"    (bandwidth {bb_bw*100:.1f}%, %b {bb_pct_b:.2f}),",
        f"  ATH distance {ath_dist:+.1f}%, {pctile*100:.0f}th percentile in history.",
    ]
    if volume is not None:
        lines.append(f"  volume {volume:,.0f}.")

    return "\n".join(lines)


def trend_summary(
    symbol: str,
    close_history: list[float],
) -> str | None:
    """纯趋势/动量摘要 — 轻量版。"""
    close = np.array(close_history, dtype=float)
    if len(close) < 20:
        return None

    from injector.enrichment import trend_direction, momentum_phase, volatility_level, ath_distance

    trend = trend_direction(close)
    momentum = momentum_phase(close)
    vol = volatility_level(close)
    ath = ath_distance(float(close[-1]), close)

    return (
        f"[Trend] {symbol}: direction {trend}, momentum {momentum}, "
        f"volatility {vol}, ATH distance {ath:+.1f}%."
    )
