"""textify 纯函数单元测试。

所有 textify 函数是纯函数（无 IO、无状态），
因此测试不需要 mock，不需要网络连接。
"""
from __future__ import annotations

import sys
import os

# 添加项目根到 sys.path（允许 from injector import textify）
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from injector import textify as txt


class TestMacro:
    def test_all_fields(self):
        result = txt.macro(vix=14.2, dxy=104.35, us10y=4.12)
        assert "[Macro]" in result
        assert "VIX 14.2" in result
        assert "DXY 104.35" in result
        assert "US10Y 4.12" in result
        assert "rising" in result

    def test_partial(self):
        result = txt.macro(vix=30.0)
        assert "[Macro]" in result
        assert "VIX 30.0" in result
        assert "risk-off" in result

    def test_empty(self):
        result = txt.macro()
        assert result == "[Macro] No data."


class TestEconomicIndicator:
    def test_full(self):
        result = txt.economic_indicator(
            "CPI", 3.2, forecast=3.0, prev=2.8, target=2.0, percentile=35, trend="falling"
        )
        assert "CPI 3.2%" in result
        assert "trend falling" in result
        assert "35th percentile" in result
        assert "above forecast" in result

    def test_gap(self):
        result = txt.economic_indicator("CPI", 3.2, target=2.0)
        assert "gap" in result


class TestPrice:
    def test_minimal(self):
        result = txt.price("BTC", 68250, 2.3)
        assert "BTC $68250.00" in result

    def test_full(self):
        result = txt.price("ETH", 3500, -1.2, volume=15e9, high_24h=3600, low_24h=3400)
        assert "ETH $3500.00" in result
        assert "vol $15,000,000,000" in result
        assert "high $3600.00" in result


class TestPriceAction:
    def test_all_indicators(self):
        result = txt.price_action(
            "BTC", 68250, 2.3, volume=28e9, rsi=45, macd_signal="bearish",
            sma50=65000, sma200=64200, support=65000, resistance=70000,
        )
        assert "BTC $68250.00" in result
        assert "RSI 45 (neutral)" in result
        assert "MACD bearish" in result
        assert "above SMA200" in result
        assert "support $65000" in result

    def test_overbought(self):
        result = txt.price_action("BTC", 70000, 5.0, rsi=75)
        assert "overbought" in result


class TestSentiment:
    def test_bullish(self):
        result = txt.sentiment(72, fear_greed=65)
        assert "bullish" in result
        assert "Fear & Greed: 65" in result

    def test_extreme_fear(self):
        result = txt.sentiment(20, fear_greed=15)
        assert "bearish" in result
        assert "extreme fear" in result

    def test_no_fng(self):
        result = txt.sentiment(50)
        assert "neutral" in result
        assert "Fear & Greed" not in result


class TestNews:
    def test_basic(self):
        result = txt.news("BTC rally", "Bitcoin price surges", "CoinDesk")
        assert "[News] (CoinDesk)" in result
        assert "BTC rally" in result


class TestMajorEvent:
    def test_war(self):
        result = txt.major_event("war_conflict", "Escalation in region", "severe")
        assert "war_conflict" in result
        assert "severe" in result

    def test_truncation(self):
        desc = "x" * 300
        result = txt.major_event("test", desc, "low")
        assert len(result) < 250


class TestCryptoOverview:
    def test_top_five(self):
        prices = [
            {"symbol": "BTC", "price": 68250, "change24h": 2.3},
            {"symbol": "ETH", "price": 3500, "change24h": -1.2},
        ]
        result = txt.crypto_overview(prices)
        assert "BTC $68250.00" in result
        assert "ETH $3500.00" in result


class TestEconomicRelease:
    def test_deviation(self):
        result = txt.economic_release("CPI MoM", 0.3, 0.2, 0.5)
        assert "CPI MoM" in result
        assert "deviation" in result


class TestOnchainBtc:
    def test_difficulty(self):
        result = txt.onchain_btc(110.45, 870123)
        assert "110.5T" in result
        assert "870,123" in result


class TestMlPrediction:
    def test_prediction(self):
        result = txt.ml_prediction(
            "Kronos-mini", "BTC",
            volatility_level="high", volatility_score=0.72,
            direction_consensus=0.53, uncertainty="high",
        )
        assert "Kronos-mini" in result
        assert "BTC" in result
        assert "volatility high" in result
        assert "uncertainty high" in result


class TestMlVolatilityReport:
    _RESULTS = [
        {"symbol": "BTC", "volatility_level": "high", "volatility_score": 0.72,
         "direction_consensus": 0.53, "uncertainty": "high"},
        {"symbol": "ETH", "volatility_level": "moderate", "volatility_score": 0.55,
         "direction_consensus": 0.6, "uncertainty": "moderate"},
    ]

    def test_with_sentiment(self):
        result = txt.ml_volatility_report(self._RESULTS, sentiment={"value": -0.5, "ts": 1})
        assert "[ML Volatility]" in result
        assert "BTC: volatility high" in result
        assert "sentiment_score -0.50 → bearish" in result
        # 高波动 + 负面情绪 → 联动风险提示
        assert "elevated market-stress risk" in result

    def test_with_neutral_sentiment(self):
        result = txt.ml_volatility_report(self._RESULTS, sentiment={"value": 0.1, "ts": 1})
        assert "sentiment_score +0.10 → neutral" in result
        assert "market-stress risk" not in result

    def test_without_sentiment(self):
        result = txt.ml_volatility_report(self._RESULTS)
        assert "Market sentiment_score: unavailable" in result
        assert "sentiment_score -" not in result

    def test_empty(self):
        assert txt.ml_volatility_report([]) == ""
        assert txt.ml_volatility_report(None) == ""

    def test_simulated_flag(self):
        simulated_results = [{**r, "simulated": True} for r in self._RESULTS]
        result = txt.ml_volatility_report(simulated_results)
        assert "[SIMULATED] 模拟数据（占位实现，非真实预测，仅供参考框架）" in result
        # 非模拟数据不带标注
        assert "[SIMULATED]" not in txt.ml_volatility_report(self._RESULTS)


class TestVolatilitySnapshot:
    def test_all_fields(self):
        result = txt.volatility_snapshot(
            vxn={"value": 25.5, "level": "high"},
            gvz={"value": 18.2, "level": "moderate"},
            put_call={"value": 1.05, "term_structure": "backwardation", "signal": "bearish"},
        )
        assert "[Volatility Snapshot]" in result
        assert "VXN 25.5" in result
        assert "GVZ 18.2" in result
        assert "Put/Call ratio" in result

    def test_partial(self):
        result = txt.volatility_snapshot(vxn={"value": 30.0, "level": "very_high"})
        assert "VXN 30.0" in result
        assert "GVZ" not in result

    def test_empty(self):
        result = txt.volatility_snapshot()
        assert "No data" in result


class TestNewsSentimentAggregate:
    def test_positive(self):
        result = txt.news_sentiment_aggregate(
            total=50, positive=25, negative=10, neutral=15,
            positive_ratio=0.5, negative_ratio=0.2,
            sentiment_score=0.3, classification="positive",
            source="Finnhub",
        )
        assert "Finnhub" in result
        assert "50 articles" in result
        assert "positive" in result
        assert "0.3" in result

    def test_negative(self):
        result = txt.news_sentiment_aggregate(
            total=30, positive=5, negative=20, neutral=5,
            positive_ratio=0.167, negative_ratio=0.667,
            sentiment_score=-0.5, classification="negative",
        )
        assert "negative" in result
        assert "-0.5" in result

    def test_zero_articles(self):
        result = txt.news_sentiment_aggregate(total=0)
        assert "0 articles" in result


class TestMacroSummary:
    def test_multiple(self):
        data_map = {
            "CPI": {
                "current": 3.2, "unit": "% YoY",
                "enriched": {"trend": "falling", "pctile": 35, "target_gap": 1.2},
            },
            "PMI": {
                "current": 49.5, "unit": "",
                "enriched": {"trend": "falling", "zone": "contraction"},
            },
        }
        result = txt.macro_summary(data_map)
        assert "Macro Summary" in result
        assert "CPI" in result
        assert "PMI" in result
        assert "falling" in result

    def test_empty(self):
        result = txt.macro_summary({})
        assert "No data" in result


class TestMegacapEarningsIndex:
    def test_normal(self):
        report = {
            "total": 25, "beat_count": 19, "miss_count": 6,
            "beat_rate": 76.0, "avg_surprise_pct": 3.2,
            "health_score": 73, "updated": "2026Q2",
            "sector_breakdown": {
                "Tech (Mag 7)": {"total": 7, "beat_rate": 85.7, "avg_surprise": 5.1},
            },
        }
        result = txt.megacap_earnings_index(report)
        assert "Earnings Index" in result
        assert "19/25" in result
        assert "76.0%" in result
        assert "Tech" in result

    def test_no_data(self):
        result = txt.megacap_earnings_index({"total": 0})
        assert "No data" in result


class TestPriceActionEnriched:
    def test_all_fields(self):
        result = txt.price_action_enriched(
            "BTC", 68250, 2.3, volume=28e9, volume_ma20=25e9,
            ath=77500, low_52w=15500, high_52w=77500,
            momentum_30d=8.2, rsi=45, ma_alignment="bullish",
            macd_signal="bearish", support=65000, resistance=70000,
            atr_pct=3.5,
        )
        assert "BTC" in result
        assert "ATH $77,500" in result
        assert "52w range" in result
        assert "30d momentum" in result
        assert "RSI 45" in result
        assert "bullish" in result
        assert "support" in result
        assert "ATR 3.5%" in result

    def test_minimal(self):
        result = txt.price_action_enriched("ETH", 3500, -1.5)
        assert "ETH" in result


class TestMacroTrendAnalysis:
    def test_all_falling(self):
        indicators = [
            {"name": "CPI", "trend": "falling"},
            {"name": "PCE", "trend": "falling"},
            {"name": "PMI", "trend": "falling"},
        ]
        result = txt.macro_trend_analysis(indicators)
        assert "3 falling" in result
        assert "disinflation" in result

    def test_mixed(self):
        indicators = [
            {"name": "CPI", "trend": "falling"},
            {"name": "GDP", "trend": "stable"},
            {"name": "NFP", "trend": "rising"},
        ]
        result = txt.macro_trend_analysis(indicators)
        assert "mixed" in result or "falling" in result

    def test_empty(self):
        result = txt.macro_trend_analysis([])
        assert "No indicator data" in result


class TestRegionMacro:
    def test_japan(self):
        data = {
            "CPI": {"current": 2.1, "unit": "% YoY", "enriched": {"trend": "rising", "pctile": 65}},
            "GDP": {"current": 1.2, "unit": "%", "enriched": {"trend": "stable", "pctile": 50}},
        }
        result = txt.region_macro("JP", data)
        assert "Japan" in result
        assert "CPI" in result
        assert "GDP" in result
        assert "rising" in result

    def test_china(self):
        data = {
            "CPI": {"current": 0.3, "unit": "% YoY", "enriched": {"trend": "falling"}},
            "PMI": {"current": 50.2, "unit": "Index", "enriched": {"zone": "expansion"}},
        }
        result = txt.region_macro("CN", data)
        assert "China" in result
        assert "expansion" in result

    def test_no_data(self):
        result = txt.region_macro("EU", {})
        assert "No data" in result


class TestGlobalMacroSummary:
    def test_multi_region(self):
        region_data = {
            "US": {"CPI": {"current": 3.2, "unit": "%"}},
            "JP": {"CPI": {"current": 2.1, "unit": "%"}},
        }
        result = txt.global_macro_summary(region_data)
        assert "United States" in result
        assert "Japan" in result
        assert "3.2" in result
        assert "2.1" in result

    def test_empty(self):
        result = txt.global_macro_summary({})
        assert "No data" in result


class TestStockIndices:
    def test_multiple_indices(self):
        indices = [
            {"region": "US", "name": "S&P 500", "price": 5500.25, "change_pct": 0.45},
            {"region": "JP", "name": "Nikkei 225", "price": 38000.0, "change_pct": -0.8},
        ]
        result = txt.stock_indices(indices)
        assert "Stock Indices" in result
        assert "S&P 500" in result
        assert "Nikkei 225" in result
        assert "5,500.25" in result or "5500.25" in result
        assert "+0.45" in result or "-0.8" in result

    def test_empty(self):
        result = txt.stock_indices([])
        assert "No data" in result
