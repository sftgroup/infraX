"""定时/手动注入器。

每个 inject_xxx 是独立方法——
  - 可以单独调用： injector.inject_macro()
  - 可以全量调用： injector.inject_all()
  - 可以被 REST API 触发： POST /inject/macro

每个方法被独立 try/except 包裹：
  - 一个数据源挂了不影响其他
  - 不会污染 worker 循环

v2: 集成 SQLite 数据库层
  - 原始数据自动存档到 raw_snapshots
  - 注入结果记录到 inject_log
  - 支持历史查询和失败重放
"""
from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timezone
from typing import Any

from injector.client import LightRAGClient
from injector import textify as txt
from injector.stats import STATS
from injector.denoise import Denoiser
from config import SETTINGS

logger = logging.getLogger(__name__)

# P2 单模型预测覆盖范围（与 ml-service _TARGETS / P2MlCollector 对齐）
_P2_MODELS = ("bolt", "moirai", "timesfm")
_P2_SYMBOLS = ("BTC", "ETH", "SPY", "QQQ")


class GraphInjector:
    """注入器。

    用法:
        from injector.worker import GraphInjector
        injector = GraphInjector()
        injector.inject_all()

    参数:
        dry_run: 为 True 时只打印不发送（用于验证）。
        db:      可选 InjectDB 实例，提供原始数据存档和注入日志。
    """

    def __init__(
        self,
        client: LightRAGClient | None = None,
        dry_run: bool = False,
        db: Any = None,
    ):
        self._client = client or LightRAGClient()
        self._dry_run = dry_run
        self._db = db
        # MQ-8 / C-6: 注入前语义去噪（可经 DENOISE_ENABLED 关闭）
        self._denoiser = Denoiser(
            similarity_threshold=SETTINGS.denoise_similarity_threshold,
        )

    @property
    def enabled(self) -> bool:
        return self._client._enabled

    def denoise_stats(self) -> dict:
        """MQ-8 / C-6: 去噪拦截统计（供 /status 诊断）。"""
        return self._denoiser.stats()

    def _save_raw(
        self, raw: Any, provider: str, data_type: str, symbol: str = ""
    ) -> int | None:
        """仅存档原始数据到 DB，不注入 LightRAG。"""
        if self._db is not None and raw is not None and provider:
            return self._db.save_snapshot(provider, data_type, raw, symbol)
        return None

    def _inject(
        self,
        text: str,
        file_source: str = "manual",
        *,
        raw: Any = None,
        provider: str = "",
        data_type: str = "",
        symbol: str = "",
        snap_id: int | None = None,
        namespace: str | None = None,
    ) -> bool:
        """注入单条数据，自动存档 + 记录日志。

        Args:
            text:        文本化后的注入内容
            file_source: 来源标识（会自动追加时间戳，作为 doc_id）
            raw:         原始数据（dict/list/None），不传则跳过存档
            provider:    数据提供方名（如 "sentiment", "onchain"）
            data_type:   数据类型（如 "vix", "btc_difficulty"）
            symbol:      关联标的（如 "BTC", "^VIX"）
            snap_id:     已有的 snapshot id，优先使用（不重复存档）
            namespace:   RAGservicer namespace（默认走 SETTINGS.default_namespace=market）
        """
        ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M")
        full_source = f"{file_source}:{ts}"

        # MQ-8 / C-6: 注入前语义去噪（黑名单规则 + 相似文本去重）
        if SETTINGS.denoise_enabled:
            inject_ok, denied_reason = self._denoiser.should_inject(text)
            if not inject_ok:
                logger.info("Denoise skipped %s (%s)", full_source, denied_reason)
                # 被拒仍存档原始数据（可审计），但不注入 LightRAG、不记 failed 日志
                if self._db is not None and raw is not None and provider:
                    self._db.save_snapshot(provider, data_type, raw, symbol)
                return False

        # 1. 存档原始数据（优先使用已有 snap_id）
        if snap_id is None and self._db is not None and raw is not None and provider:
            snap_id = self._db.save_snapshot(provider, data_type, raw, symbol)

        # 2. 注入 RAGservicer
        if self._dry_run:
            logger.info("[DRY-RUN] %s\n%s", full_source, text)
            ok = True
        else:
            ok = self._client.inject(text, doc_id=full_source, namespace=namespace)
            if not ok:
                logger.warning("Inject failed: %s (ns=%s)", full_source, namespace)

        # 3. 记录注入日志
        if self._db is not None:
            self._db.log_inject(
                snap_id or 0,
                full_source,
                text,
                status="success" if ok else "failed",
                error_msg=None if ok else "inject returned False",
            )

        return ok

    # ─── 每个 inject_xxx 独立且 fail-silent ──────────

    def inject_macro(self) -> bool:
        """注入宏观数据（VIX/DXY/US10Y）。"""
        try:
            from providers.sentiment import fetch_vix, fetch_dollar_index, fetch_yield_curve

            vix = fetch_vix()
            dxy = fetch_dollar_index()
            yc = fetch_yield_curve() or {}
            us10y = yc.get("us10y")

            text = txt.macro(
                vix=vix.get("value") if isinstance(vix, dict) else vix,
                dxy=dxy.get("value") if isinstance(dxy, dict) else dxy,
                us10y=us10y,
            )
            if text:
                # 逐条存档原始数据（仅 DB，不注入 LightRAG）
                self._save_raw(vix, "sentiment", "vix", "^VIX")
                self._save_raw(dxy, "sentiment", "dxy", "DX-Y.NYB")
                self._save_raw(yc, "sentiment", "us10y", "^TNX")
                return self._inject(text, file_source="macro:daily")
            return False
        except Exception:
            logger.warning("inject_macro failed", exc_info=True)
            return False

    def inject_sentiment(self) -> bool:
        """注入情绪数据（Fear & Greed）。"""
        try:
            from providers.sentiment import fetch_fear_greed_index

            fng = fetch_fear_greed_index()
            if not fng:
                return False
            score = fng.get("value", 50) if isinstance(fng, dict) else fng
            text = txt.sentiment(score, fear_greed=score)
            snap_id = self._save_raw(fng, "sentiment", "fear_greed")
            return self._inject(text, file_source="sentiment:daily", snap_id=snap_id)
        except Exception:
            logger.warning("inject_sentiment failed", exc_info=True)
            return False

    def inject_crypto_overview(self) -> bool:
        """注入加密币市场概览。"""
        try:
            from providers.sentiment import fetch_crypto_prices

            prices = fetch_crypto_prices()
            if not prices or not isinstance(prices, list):
                return False
            text = txt.crypto_overview(prices)
            snap_id = self._save_raw(prices, "sentiment", "crypto_prices")
            return self._inject(text, file_source="crypto:daily", snap_id=snap_id)
        except Exception:
            logger.warning("inject_crypto_overview failed", exc_info=True)
            return False

    def inject_volatility(self) -> bool:
        """注入波动率指标（VXN/GVZ/Put-Call）。"""
        try:
            from providers.volatility import fetch_vxn, fetch_gvz, fetch_put_call_ratio

            vxn = fetch_vxn()
            gvz = fetch_gvz()
            put_call = fetch_put_call_ratio()

            self._save_raw(vxn, "volatility", "vxn", "^VXN")
            self._save_raw(gvz, "volatility", "gvz", "^GVZ")
            snap_id = self._save_raw(put_call, "volatility", "put_call_ratio")

            text = txt.volatility_snapshot(vxn=vxn, gvz=gvz, put_call=put_call)
            if text:
                return self._inject(text, file_source="volatility:daily", snap_id=snap_id)
            return False
        except Exception:
            logger.warning("inject_volatility failed", exc_info=True)
            return False

    def inject_major_events(self) -> bool:
        """注入重大事件检测结果。"""
        try:
            from providers.events import check_major_events

            events = check_major_events(max_events=5)
            if not events:
                return False

            success = False
            for ev in events:
                text = txt.major_event(
                    event_type=ev.get("event_type", "unknown"),
                    description=ev.get("description", ""),
                    severity=ev.get("severity", "low"),
                )
                if text:
                    tag = ev.get("event_type", "unknown")
                    if self._inject(text, file_source=f"event:{tag}"):
                        success = True
            return success
        except Exception:
            logger.warning("inject_major_events failed", exc_info=True)
            return False

    def inject_news_sentiment(self) -> bool:
        """注入新闻情感聚合。"""
        try:
            from providers.news import fetch_news_sentiment_aggregate

            agg = fetch_news_sentiment_aggregate()
            if not agg:
                return False

            text = txt.news_sentiment_aggregate(
                total=agg.get("total", 0),
                positive=agg.get("positive", 0),
                negative=agg.get("negative", 0),
                neutral=agg.get("neutral", 0),
                positive_ratio=agg.get("positive_ratio", 0.0),
                negative_ratio=agg.get("negative_ratio", 0.0),
                sentiment_score=agg.get("sentiment_score", 0.0),
                classification=agg.get("classification", "neutral"),
                source=agg.get("source", "Finnhub"),
            )
            if text:
                return self._inject(text, file_source="news:sentiment_daily")
            return False
        except Exception:
            logger.warning("inject_news_sentiment failed", exc_info=True)
            return False

    def inject_fred_economics(self) -> bool:
        """注入 FRED 宏观经济指标。"""
        try:
            from providers.macro_economics import fetch_all_macro

            data_map = fetch_all_macro()
            if not data_map:
                return False

            # 使用 macro_summary 一次注入所有
            text = txt.macro_summary(data_map)
            if text and self._inject(text, file_source="macro:fred:daily"):
                return True

            # 兜底：逐条注入
            success = False
            for name, indicator in data_map.items():
                e = indicator.get("enriched", {})
                t = txt.economic_indicator(
                    name=name,
                    value=indicator.get("current", 0),
                    unit=indicator.get("unit", ""),
                    target=2.0 if "CPI" in name or "PCE" in name else None,
                    percentile=e.get("pctile"),
                    trend=e.get("trend"),
                )
                if t and self._inject(t, file_source=f"macro:fred:{name.lower()}"):
                    success = True
            return success
        except Exception:
            logger.warning("inject_fred_economics failed", exc_info=True)
            return False

    def inject_earnings_index(self) -> bool:
        """注入巨头企业财报指数。"""
        try:
            from providers.earnings import fetch_all_megacap_earnings

            report = fetch_all_megacap_earnings()
            if not report or report.get("total", 0) == 0:
                return False

            text = txt.megacap_earnings_index(report)
            if text:
                return self._inject(text, file_source="earnings:megacap:daily")
            return False
        except Exception:
            logger.warning("inject_earnings_index failed", exc_info=True)
            return False

    def inject_onchain(self) -> bool:
        """注入 BTC 链上数据（挖矿难度 + 巨鲸余额 + 转账流量）。"""
        try:
            from providers.onchain import (
                fetch_btc_difficulty,
                fetch_whale_balances,
                fetch_btc_transfers,
            )

            btc = fetch_btc_difficulty()
            whales = fetch_whale_balances()
            transfers = fetch_btc_transfers()

            self._save_raw(whales, "onchain", "whale_balances", "BTC")
            self._save_raw(transfers, "onchain", "btc_transfers", "BTC")

            success = False
            if btc:
                text = txt.onchain_btc(
                    difficulty=btc.get("difficulty_t", 0),
                    block_height=btc.get("height", 0),
                )
                if text:
                    snap_id = self._save_raw(btc, "onchain", "btc_difficulty", "BTC")
                    if self._inject(text, file_source="onchain:btc:daily", snap_id=snap_id):
                        success = True

            if transfers:
                text = txt.onchain_transfers(transfers)
                if text and self._inject(
                    text, file_source="onchain:btc_transfers:daily", namespace="onchain"
                ):
                    success = True

            for w in whales:
                text = (
                    f"[On-chain BTC] Whale {w.get('name', '?')} "
                    f"balance {w.get('balance_btc', 0):.1f} BTC."
                )
                if self._inject(text, file_source="onchain:whale:daily", namespace="onchain"):
                    success = True

            return success
        except Exception:
            logger.warning("inject_onchain failed", exc_info=True)
            return False

    def inject_defi_tvl(self) -> bool:
        """注入 DeFi TVL 数据。"""
        try:
            from providers.defi import fetch_chain_tvl

            chains = fetch_chain_tvl()
            if not chains:
                return False

            snap_id = self._save_raw(chains, "defi", "tvl")

            success = False
            for c in chains[:5]:  # top 5
                text = txt.defi_tvl(
                    chain=c.get("chain", ""),
                    tvl_usd=c.get("tvl", 0),
                    change_24h=c.get("change_24h"),
                )
                if text and self._inject(text, file_source=f"defi:tvl:{c.get('chain', '')}", snap_id=snap_id, namespace="onchain"):
                    success = True
            return success
        except Exception:
            logger.warning("inject_defi_tvl failed", exc_info=True)
            return False

    def inject_macro_trend(self) -> bool:
        """注入宏观趋势综合分析。"""
        try:
            from providers.sentiment import fetch_vix, fetch_dollar_index, fetch_yield_curve

            vix = fetch_vix()
            dxy = fetch_dollar_index()
            yc = fetch_yield_curve() or {}

            indicators = []
            if vix:
                indicators.append({"name": "VIX", "trend": "elevated" if vix.get("value", 20) > 25 else "normal"})
            if dxy:
                indicators.append({"name": "DXY", "trend": "rising" if dxy.get("value", 100) > 104 else "stable"})
            if yc.get("us10y"):
                us10y = yc["us10y"]
                indicators.append({"name": "US10Y", "trend": "rising" if us10y > 4.0 else "stable" if us10y > 3.0 else "falling"})

            if not indicators:
                return False

            text = txt.macro_trend_analysis(indicators)
            if text:
                return self._inject(text, file_source="macro:trend:daily")
            return False
        except Exception:
            logger.warning("inject_macro_trend failed", exc_info=True)
            return False

    def inject_evm(self) -> bool:
        """注入 EVM 链上数据（ETH 供应/燃烧/质押）。"""
        try:
            from providers.evm import fetch_evm_overview

            overview = fetch_evm_overview()
            if not overview:
                return False

            text = txt.eth_onchain(overview)
            if text:
                return self._inject(text, file_source="onchain:eth:daily", namespace="onchain")
            return False
        except Exception:
            logger.warning("inject_evm failed", exc_info=True)
            return False

    def inject_global_macro(self) -> bool:
        """注入多区域宏观数据（FRED + 中国 Tushare）。"""
        try:
            from providers.macro_economics import fetch_regions
            from providers.china_macro import fetch_all_china_macro

            regions = fetch_regions("JP", "EU", "DE", "UK")
            china = fetch_all_china_macro()

            success = False

            # 每个区域单独注入
            region_order = ("US", "JP", "EU", "DE", "UK")
            _us_indicators = None
            for code in region_order:
                data = regions.get(code) if code != "US" else None
                if not data:
                    continue
                text = txt.region_macro(code, data)
                if text and self._inject(text, file_source=f"macro:global:{code}"):
                    success = True

            # US 走已有的 inject_fred_economics
            if self.inject_fred_economics():
                success = True

            # 中国
            if china:
                text = txt.region_macro("CN", china)
                if text and self._inject(text, file_source="macro:china:daily"):
                    success = True

            return success
        except Exception:
            logger.warning("inject_global_macro failed", exc_info=True)
            return False

    def inject_indices(self) -> bool:
        """注入全球股指数据。"""
        try:
            from providers.indices import fetch_global_indices

            indices = fetch_global_indices()
            if not indices:
                return False

            snap_id = self._save_raw(indices, "indices", "global")

            text = txt.stock_indices(indices)
            if text:
                return self._inject(text, file_source="indices:global:daily", snap_id=snap_id)
            return False
        except Exception:
            logger.warning("inject_indices failed", exc_info=True)
            return False

    def inject_tech_analysis(self) -> bool:
        """注入技术指标分析（RSI/MACD/布林带/趋势/动量/波动率）。

        拉取 BTC/ETH/SOL 历史 K 线，用 enrichment 算子计算指标后注入。
        """
        try:
            from providers.sentiment import fetch_crypto_klines

            klines = fetch_crypto_klines()
            if not klines:
                return False

            success = False
            for sym, data in klines.items():
                close_list = data.get("close", [])
                if not close_list or len(close_list) < 30:
                    continue

                # 综合技术分析
                t = txt.tech_analysis(
                    symbol=sym,
                    current_price=data["current"],
                    close_history=close_list,
                    change_pct=data["change_pct"],
                )
                if t:
                    snap_id = self._save_raw(data, "tech", "tech_analysis", sym)
                    if self._inject(t, file_source=f"tech:{sym.lower()}:daily", snap_id=snap_id):
                        success = True

                # 轻量趋势摘要
                ts = txt.trend_summary(sym, close_list)
                if ts and self._inject(ts, file_source=f"trend:{sym.lower()}:daily"):
                    success = True

            return success
        except Exception:
            logger.warning("inject_tech_analysis failed", exc_info=True)
            return False

    def inject_ml_predictions(self) -> bool:
        """注入 Kronos-mini ML 波动率预测（ml-service 推理 + data-service sentiment_score 联动）。

        providers/ml.py 为 ml-service HTTP 客户端（GET /ml/volatility）；
        未配置 ML_SERVICE_URL 时返回 [] 直接跳过。未配置 DATA_SERVICE_URL 时
        跳过 sentiment 联动，仍注入波动率预测。
        """
        try:
            from providers.ml import predict_all_volatility
            from providers.data_service import fetch_sentiment_score

            results = predict_all_volatility()
            if not results:
                return False

            sentiment = fetch_sentiment_score()  # 联动（可选，fail-silent）
            text = txt.ml_volatility_report(results, sentiment=sentiment)
            if not text:
                return False

            snap_id = self._save_raw(
                {"predictions": results, "sentiment_score": sentiment},
                "ml", "volatility_prediction",
            )
            return self._inject(text, file_source="ml:volatility:daily", snap_id=snap_id)
        except Exception:
            logger.debug("inject_ml_predictions failed", exc_info=True)
            return False

    def inject_tree_ml(self) -> bool:
        """注入 LightGBM 方向预测（data-service tree_predictions 快照）。

        真实模型（训练于 kline 日线历史），非模拟数据。
        data-service 未启用 TREE_ML_ENABLED / 无快照时返回 False（fail-silent）。
        """
        try:
            from providers.data_service import fetch_tree_predictions

            payload = fetch_tree_predictions()
            if not payload:
                return False
            text = txt.tree_ml_report(payload)
            if not text:
                return False
            snap_id = self._save_raw(payload, "ml", "tree_predictions")
            return self._inject(text, file_source="ml:tree_direction:daily", snap_id=snap_id)
        except Exception:
            logger.debug("inject_tree_ml failed", exc_info=True)
            return False

    def inject_consensus(self) -> bool:
        """注入跨模型信号共识（data-service consensus 快照，M3）。

        ml-service 聚合 tree + Kronos + FinBERT 三路信号，输出确定性共识
        （consensus_score / divergence / risk_flag）。原始信号仍各自独立注入，
        本条只补充共识维度的快照描述。data-service 无快照时 fail-silent。
        """
        try:
            from providers.data_service import fetch_consensus

            payload = fetch_consensus()
            if not payload:
                return False
            text = txt.consensus_report(payload)
            if not text:
                return False
            snap_id = self._save_raw(payload, "ml", "consensus")
            return self._inject(text, file_source="ml:consensus:daily", snap_id=snap_id)
        except Exception:
            logger.debug("inject_consensus failed", exc_info=True)
            return False

    def inject_p2_predictions(self) -> bool:
        """注入 P2 单模型预测历史（data-service /ml/predictions 明细表）。

        P2MlCollector（data-service）每 30min 把 bolt/moirai/timesfm 对
        BTC/ETH/SPY/QQQ 的预测明细落库到 ml_predictions 表；本条把每个
        (model, symbol) 的历史序列文本化后注入 RAG，使 RAG 可检索到
        "模型过去是怎么预测的"（含方向分布 / prob_up 统计 / 最新输出）。
        某 model×symbol 无历史（404）或未配置 DATA_SERVICE_URL 时 fail-silent。
        """
        try:
            from providers.data_service import fetch_ml_predictions

            success = False
            for model in _P2_MODELS:
                for symbol in _P2_SYMBOLS:
                    payload = fetch_ml_predictions(model, symbol, limit=200)
                    if not payload:
                        continue
                    text = txt.p2_predictions_report(payload)
                    if not text:
                        continue
                    snap_id = self._save_raw(payload, "ml", f"p2_{model}", symbol)
                    if self._inject(
                        text,
                        file_source=f"ml:p2:{model}:{symbol.lower()}:daily",
                        snap_id=snap_id,
                    ):
                        success = True
            return success
        except Exception:
            logger.debug("inject_p2_predictions failed", exc_info=True)
            return False

    def inject_onchain_checkpoints(self) -> bool:
        """注入各链扫描位点聚合快照（旧栈 rawdata 合并 → data-service 快照）。

        data-service OnchainCollector 每 60s 从旧栈 collector 拉取 /health + /stats
        合并为 onchain_checkpoints（每链已扫高度 / 事件数 / 状态 / 最近抓取时间），
        本条把该聚合快照文本化注入 RAG（namespace=onchain）。无快照时 fail-silent。
        """
        try:
            from providers.data_service import fetch_onchain_checkpoints

            snap = fetch_onchain_checkpoints()
            if not snap:
                return False
            text = txt.onchain_checkpoints_report(snap.get("items") or [])
            if not text:
                return False
            snap_id = self._save_raw(snap, "collector_onchain", "onchain_checkpoints")
            return self._inject(
                text, file_source="onchain:checkpoints:daily",
                snap_id=snap_id, namespace="onchain",
            )
        except Exception:
            logger.debug("inject_onchain_checkpoints failed", exc_info=True)
            return False

    def inject_okx_market(self) -> bool:
        """注入 OKX ChainOS 行情快照（热门代币 + 指数价格，价格数据）。

        data-service OkxChainosCollector 每 60s 拉取旧栈 OKX DEX Market v6
        （hot-tokens 每链 10 个 + 头部代币指数价格），本条将快照文本化后注入
        RAG（namespace=market），使 RAG 可检索到链上真实价格/涨跌/热度。
        无快照或未配置 DATA_SERVICE_URL 时 fail-silent。
        """
        try:
            from providers.data_service import (
                fetch_okx_hot_tokens,
                fetch_okx_index_prices,
            )

            hot = fetch_okx_hot_tokens() or []
            index = fetch_okx_index_prices() or []
            if not hot and not index:
                return False
            text = txt.okx_market_report(hot, index)
            if not text:
                return False
            snap_id = self._save_raw(
                {"hot_tokens": hot, "index_prices": index},
                "okx_chainos", "okx_market_snapshot",
            )
            return self._inject(
                text, file_source="okx:market:daily", snap_id=snap_id
            )
        except Exception:
            logger.debug("inject_okx_market failed", exc_info=True)
            return False

    # ─── 配置化解析注入（DC / Collector raw data） ──

    def inject_parsed(self, source: str, limit: int = 100) -> list[dict]:
        """按 YAML 规则拉取并解析注入指定数据源。

        支持: ``infrax_dc``（DC 链上 raw 事件）、``infrax_collector``（Collector 信号）。
        返回 ``[{doc_id, namespace, ok}]``。
        """
        try:
            from injector.parser import load_rules, parse_snapshots

            rules = [r for r in load_rules("parsers") if r.get("source") == source]
            if not rules:
                logger.warning("No parsing rules for source=%s", source)
                return []

            if source == "infrax_dc":
                from providers.infrax_dc import fetch_dc_events
                snaps = fetch_dc_events(limit=limit)
            elif source == "infrax_collector":
                from providers.infrax_collector import fetch_market_signals, fetch_hot_tokens
                snaps = fetch_market_signals(limit=limit) + fetch_hot_tokens(limit=20)
            else:
                logger.warning("Unknown parsed source: %s", source)
                return []

            if not snaps:
                logger.info("inject_parsed(%s): no data fetched", source)
                return []

            # 整批原始数据存档（可回溯）
            snap_id = self._save_raw(snaps, source, f"{source}_batch")

            units = parse_snapshots(snaps, rules)
            results: list[dict] = []
            for u in units:
                if self._dry_run:
                    logger.info("[DRY-RUN] ns=%s %s\n%s", u.namespace, u.doc_id, u.text)
                    ok = True
                else:
                    ok = self._client.inject(u.text, doc_id=u.doc_id, namespace=u.namespace)
                results.append({"doc_id": u.doc_id, "namespace": u.namespace, "ok": ok})

            if self._db is not None:
                self._db.log_inject(
                    snap_id or 0,
                    f"{source}:parsed",
                    f"{len(results)} units parsed from {len(snaps)} snapshots",
                    status="success" if any(r["ok"] for r in results) else "failed",
                )
            logger.info("inject_parsed(%s): %d/%d units injected", source, sum(1 for r in results if r["ok"]), len(results))
            return results
        except Exception:
            logger.warning("inject_parsed(%s) failed", source, exc_info=True)
            return []

    # ─── 全量注入 ────────────────────────────────────

    def inject_all(self) -> dict[str, bool]:
        """执行所有已实现的注入。

        返回 {injector_name: success}。
        """
        results: dict[str, bool] = {}
        # 所有已实现的方法（ml_predictions 为占位实现返回模拟数据，未接入真实模型前
        # 不加入默认列表，避免随机数据污染 RAG；如需手动触发：POST /inject/ml_predictions）
        for name in (
            "macro", "sentiment", "crypto_overview",
            "volatility", "news_sentiment", "major_events",
            "onchain", "defi_tvl", "macro_trend",
            "fred_economics", "earnings_index", "evm",
            "global_macro", "indices", "tech_analysis",
            # tree_ml 为真实 LightGBM 模型（训练于 kline 历史），
            # data-service 未启用时 fail-silent 返回 False，不污染
            "tree_ml",
            # consensus 为跨模型共识（ml-service 聚合三路信号），
            # 无快照时 fail-silent 返回 False
            "consensus",
            # p2_predictions 为 P2 单模型预测历史（data-service ml_predictions 明细），
            # 无历史（404）时 fail-silent 返回 False
            "p2_predictions",
            # onchain_checkpoints / okx_market 为旧栈 rawdata + OKX ChainOS 合并数据
            # （data-service 快照），无快照时 fail-silent 返回 False
            "onchain_checkpoints", "okx_market",
        ):
            method = getattr(self, f"inject_{name}")
            t0 = time.monotonic()
            try:
                ok = method()
            except Exception:
                ok = False
                # 兜底（理论上每个 method 内部已有 try/except）
            duration_ms = (time.monotonic() - t0) * 1000
            results[name] = ok
            STATS.record(name, ok, duration_ms)
        return results

    # ─── 事件驱动接口（P3+） ─────────────────────────

    def on_economic_release(
        self,
        name: str,
        actual: float,
        forecast: float,
        unit: str = "",
    ) -> bool:
        """经济数据公布后，偏差超阈值时注入。"""
        deviation = abs(actual - forecast) / (abs(forecast) + 1e-9)
        if deviation < 0.01:
            return False
        text = txt.economic_release(name, actual, forecast, deviation, unit=unit)
        return self._inject(text, file_source=f"calendar:{name}")


# ─── asyncio 后台循环 ─────────────────────────────────


async def run_worker_loop(injector: GraphInjector) -> None:
    """后台协程：启动等待 → 每 6h 全量注入。

    适合 ``python main.py`` 启动，或 ``asyncio.create_task()`` 集成。
    """
    delay = SETTINGS.injector_startup_delay
    interval = max(300, SETTINGS.injector_interval_sec)  # 最小 5min

    logger.info(
        "Graph injector starts in %ss, interval %ds",
        delay, interval,
    )
    await asyncio.sleep(delay)

    while True:
        start = time.monotonic()
        logger.info("Injection cycle starting...")
        results = injector.inject_all()
        elapsed = time.monotonic() - start
        ok = sum(1 for v in results.values() if v)
        logger.info(
            "Injection cycle done in %.1fs (%d/%d ok)",
            elapsed, ok, len(results),
        )
        await asyncio.sleep(interval)


def start_worker_thread(injector: GraphInjector | None = None) -> None:
    """启动 worker 线程（适合集成到外部应用）。"""
    import threading

    _injector = injector or GraphInjector()

    def _run():
        asyncio.run(run_worker_loop(_injector))

    t = threading.Thread(target=_run, name="GraphInjectorWorker", daemon=True)
    t.start()
    logger.info("Graph injector worker thread started")
