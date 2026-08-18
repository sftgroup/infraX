"""Factor definitions — catalog + current-values query + snapshots.

All available factors are declared here (single source of truth).
/GET /factors/catalog returns the full list.
/GET /factors/current returns latest values from raw_snapshots.
/GET /snapshots returns full snapshot data for complex types (heatmap, calendar, etc.).
"""

from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from app.storage import get_db
from app.config import FACTORS_FFILL, FRESHNESS_MS

# ─── Built-in factor catalog ────────────────────────────


_BUILTIN = [
    # -- technical (computed in kline_store, stored in kline_1m) --
    {"id": "rsi_14", "name": "RSI(14)", "category": "technical", "type": "float", "range": [0, 100], "description": "14 周期相对强弱指标（>70 超买 / <30 超卖）", "unit": None},
    {"id": "macd", "name": "MACD Line", "category": "technical", "type": "float", "range": None, "description": "MACD 快线（12 与 26 EMA 之差）", "unit": None},
    {"id": "macd_signal", "name": "MACD Signal", "category": "technical", "type": "float", "range": None, "description": "MACD 信号线（快线的 9 期 EMA）", "unit": None},
    {"id": "macd_hist", "name": "MACD Histogram", "category": "technical", "type": "float", "range": None, "description": "MACD 柱（快线 - 信号线）", "unit": None},
    {"id": "bb_upper", "name": "BB Upper", "category": "technical", "type": "float", "range": None, "description": "布林带上轨（中轨 + k×std）", "unit": None},
    {"id": "bb_middle", "name": "BB Middle", "category": "technical", "type": "float", "range": None, "description": "布林带中轨（20 期 SMA）", "unit": None},
    {"id": "bb_lower", "name": "BB Lower", "category": "technical", "type": "float", "range": None, "description": "布林带下轨（中轨 - k×std）", "unit": None},
    {"id": "atr_14", "name": "ATR(14)", "category": "technical", "type": "float", "range": [0, None], "description": "14 周期平均真实波幅（波动率）", "unit": None},
    {"id": "ma_5", "name": "MA(5)", "category": "technical", "type": "float", "range": None, "description": "5 周期简单移动平均", "unit": None},
    {"id": "ma_10", "name": "MA(10)", "category": "technical", "type": "float", "range": None, "description": "10 周期简单移动平均", "unit": None},
    {"id": "ma_20", "name": "MA(20)", "category": "technical", "type": "float", "range": None, "description": "20 周期简单移动平均", "unit": None},
    # -- macro (from external APIs, stored in raw_snapshots) --
    {"id": "vix", "name": "VIX Volatility", "category": "macro", "type": "float", "range": [0, None], "description": "CBOE VIX 波动率指数（市场恐慌度）", "unit": None},
    {"id": "vxn", "name": "CBOE VXN", "category": "macro", "type": "float", "range": [0, None], "description": "CBOE 纳指 100 波动率指数", "unit": None},
    {"id": "gvz", "name": "CBOE GVZ", "category": "macro", "type": "float", "range": [0, None], "description": "CBOE 黄金波动率指数", "unit": None},
    {"id": "dxy", "name": "US Dollar Index", "category": "macro", "type": "float", "range": [50, 150], "description": "美元指数（兑一篮子货币强弱）", "unit": None},
    {"id": "us10y", "name": "US 10Y Yield", "category": "macro", "type": "float", "range": [0, 10], "description": "美国 10 年期国债收益率", "unit": "%"},
    # -- sentiment (from external APIs) --
    {"id": "fear_greed", "name": "Fear & Greed Index", "category": "sentiment", "type": "int", "range": [0, 100], "description": "恐惧与贪婪指数（0 极度恐惧 - 100 极度贪婪）", "unit": None},
    {"id": "sentiment_score", "name": "News Sentiment Score", "category": "sentiment", "type": "float", "range": [-1, 1], "description": "新闻情绪得分（-1 负面 - 1 正面）", "unit": None},
    {"id": "put_call_ratio", "name": "Put/Call Ratio", "category": "sentiment", "type": "float", "range": [0, None], "description": "期权认沽认购比（>1 偏空；含 interpretation/level 解读）", "unit": None},
    # -- onchain --
    {"id": "btc_difficulty", "name": "BTC Mining Difficulty", "category": "onchain", "type": "float", "range": [0, None], "description": "BTC 挖矿难度", "unit": "T"},
    {"id": "btc_hashrate", "name": "BTC Hashrate", "category": "onchain", "type": "float", "range": [0, None], "description": "BTC 全网算力", "unit": "EH/s"},
]

# ─── ML factor catalog（DS-13，来源 ml-service，category="ml"）───
# tree_* 来自 /ml/tree_predictions（LightGBM）；finbert_* 来自 /ml/sentiment；
# bolt/moirai/timesfm_* 来自 ml_predictions 明细表；consensus_* 来自 /ml/consensus。
# direction 统一数值化：up=1 / flat=0 / down=-1（catalog type=int，见 B 端 DS-13 要求）。
_ML_FACTORS = [
    {"id": "tree_direction", "name": "LightGBM Direction", "category": "ml", "type": "int", "range": [-1, 1], "description": "LightGBM 方向预测（1 涨 / 0 平 / -1 跌）", "unit": None},
    {"id": "tree_prob_up", "name": "LightGBM P(Up)", "category": "ml", "type": "float", "range": [0, 1], "description": "LightGBM 上涨概率（0-1）", "unit": None},
    {"id": "finbert_sentiment", "name": "FinBERT Sentiment", "category": "ml", "type": "float", "range": [-1, 1], "description": "FinBERT 金融情绪得分（-1 负面 - 1 正面）", "unit": None},
    {"id": "consensus_score", "name": "Cross-model Consensus", "category": "ml", "type": "float", "range": [0, 1], "description": "多模型共识得分（0-1，越高一致性越强）", "unit": None},
    {"id": "bolt_direction", "name": "Bolt Direction", "category": "ml", "type": "int", "range": [-1, 1], "description": "Bolt 方向预测（1 涨 / 0 平 / -1 跌）", "unit": None},
    {"id": "bolt_prob_up", "name": "Bolt P(Up)", "category": "ml", "type": "float", "range": [0, 1], "description": "Bolt 上涨概率（0-1）", "unit": None},
    {"id": "moirai_direction", "name": "Moirai Direction", "category": "ml", "type": "int", "range": [-1, 1], "description": "Moirai 方向预测（1 涨 / 0 平 / -1 跌）", "unit": None},
    {"id": "moirai_prob_up", "name": "Moirai P(Up)", "category": "ml", "type": "float", "range": [0, 1], "description": "Moirai 上涨概率（0-1）", "unit": None},
    {"id": "timesfm_direction", "name": "TimesFM Direction", "category": "ml", "type": "int", "range": [-1, 1], "description": "TimesFM 方向预测（1 涨 / 0 平 / -1 跌）", "unit": None},
    {"id": "timesfm_prob_up", "name": "TimesFM P(Up)", "category": "ml", "type": "float", "range": [0, 1], "description": "TimesFM 上涨概率（0-1）", "unit": None},
]

# ─── 图谱因子 catalog（GX-1.5，来源 ml-service graph 引擎，category="graph"）───
# gf_degree/betweenness/pagerank/community/structural_hole 为结构因子；
# gf_neighbor_mom/vol、gf_sector_mom、gf_cc_spillover 为邻居聚合；
# gf_community_mom 为社区动量；gf_node2vec_1..8 为图嵌入。
# 实际数值由 ml-service /ml/graph_factors 透传（data-service 侧仅做 passthrough，
# 此处为 /factors/catalog 静态声明，type/range 与 ml-service /ml/graph/catalog 对齐）。
_GRAPH_FACTORS = [
    {"id": "gf_degree", "name": "Degree Centrality", "category": "graph", "type": "float", "range": [0, 1], "description": "节点度中心性（图谱内关联度）", "unit": None},
    {"id": "gf_betweenness", "name": "Betweenness Centrality", "category": "graph", "type": "float", "range": [0, 1], "description": "介数中心性（传导枢纽地位）", "unit": None},
    {"id": "gf_pagerank", "name": "PageRank Centrality", "category": "graph", "type": "float", "range": [0, 1], "description": "PageRank 中心度（信息网络重要性）", "unit": None},
    {"id": "gf_community", "name": "Community Index", "category": "graph", "type": "int", "range": [0, None], "description": "Louvain 社区编号（同社区联动分组）", "unit": None},
    {"id": "gf_structural_hole", "name": "Structural Hole Constraint", "category": "graph", "type": "float", "range": [0, 1], "description": "结构洞约束（约束越低桥接价值越高）", "unit": None},
    {"id": "gf_neighbor_mom", "name": "Neighbor Momentum", "category": "graph", "type": "float", "range": [-1, 1], "description": "邻居节点动量聚合（传导方向）", "unit": None},
    {"id": "gf_neighbor_vol", "name": "Neighbor Volatility", "category": "graph", "type": "float", "range": [0, None], "description": "邻居节点波动率聚合", "unit": None},
    {"id": "gf_sector_mom", "name": "Sector Momentum", "category": "graph", "type": "float", "range": [-1, 1], "description": "同行业/板块动量", "unit": None},
    {"id": "gf_cc_spillover", "name": "CC Spillover", "category": "graph", "type": "float", "range": [-1, 1], "description": "相关性联动溢出", "unit": None},
    {"id": "gf_community_mom", "name": "Community Momentum", "category": "graph", "type": "float", "range": [-1, 1], "description": "社区动量", "unit": None},
    {"id": "gf_node2vec_1", "name": "Node2Vec Dim 1", "category": "graph", "type": "float", "range": [None, None], "description": "图嵌入第 1 维", "unit": None},
    {"id": "gf_node2vec_2", "name": "Node2Vec Dim 2", "category": "graph", "type": "float", "range": [None, None], "description": "图嵌入第 2 维", "unit": None},
    {"id": "gf_node2vec_3", "name": "Node2Vec Dim 3", "category": "graph", "type": "float", "range": [None, None], "description": "图嵌入第 3 维", "unit": None},
    {"id": "gf_node2vec_4", "name": "Node2Vec Dim 4", "category": "graph", "type": "float", "range": [None, None], "description": "图嵌入第 4 维", "unit": None},
    {"id": "gf_node2vec_5", "name": "Node2Vec Dim 5", "category": "graph", "type": "float", "range": [None, None], "description": "图嵌入第 5 维", "unit": None},
    {"id": "gf_node2vec_6", "name": "Node2Vec Dim 6", "category": "graph", "type": "float", "range": [None, None], "description": "图嵌入第 6 维", "unit": None},
    {"id": "gf_node2vec_7", "name": "Node2Vec Dim 7", "category": "graph", "type": "float", "range": [None, None], "description": "图嵌入第 7 维", "unit": None},
    {"id": "gf_node2vec_8", "name": "Node2Vec Dim 8", "category": "graph", "type": "float", "range": [None, None], "description": "图嵌入第 8 维", "unit": None},
]

# ML 因子（history asof 对齐时并入 _NON_TECH_FACTORS 同型序列）
_ML_FACTOR_IDS = tuple(f["id"] for f in _ML_FACTORS)

# direction 字符串 → 数值（up=1 / flat=0 / down=-1）
_DIRECTION_VALUE = {"up": 1, "flat": 0, "down": -1}


# crypto 裸对 → 交易对存储键（resolve 返回 BTCUSDT 形式，kline 存 BTC/USDT）。
# 仅识别已知 quote 后缀，非 crypto 符号（AAPL/GC=F/EURUSD/600519）原样返回。
_CRYPTO_QUOTES = ("USDT", "USDC", "BUSD", "FDUSD", "TUSD", "DAI", "BTC", "ETH")


def normalize_crypto_pair(symbol: str, market_type: str = "spot") -> str:
    """crypto 裸对 → 存储键：``BTCUSDT`` → spot ``BTC/USDT`` / swap ``BTC/USDT:USDT``。

    已含 ``/`` 或 ``:`` 的符号原样返回；非 crypto 符号原样返回。
    """
    if "/" in symbol or ":" in symbol:
        return symbol
    for q in _CRYPTO_QUOTES:
        if symbol.endswith(q) and len(symbol) > len(q):
            base = symbol[: -len(q)]
            if market_type == "swap":
                return f"{base}/{q}:{q}"
            return f"{base}/{q}"
    return symbol


def _load_extra_factors() -> list[dict]:
    """Load additional factors from FACTORS_CONFIG_PATH JSON file."""
    path = os.getenv("FACTORS_CONFIG_PATH", "")
    if not path:
        return []
    fp = Path(path)
    if not fp.exists():
        return []
    try:
        data = json.loads(fp.read_text())
        extra = data.get("extra", [])
        valid = []
        for item in extra:
            if isinstance(item, dict) and item.get("id") and item.get("name"):
                item.setdefault("category", "external")
                item.setdefault("type", "float")
                item.setdefault("range", None)
                # 描述/单位（方便下游展示与使用；缺省填空值，保证 catalog 字段统一）
                item.setdefault("description", "")
                item.setdefault("unit", None)
                valid.append(item)
        return valid
    except Exception:
        return []


def get_catalog() -> list[dict]:
    """Return full factor catalog (built-in + ML + graph + extra from config)."""
    return _BUILTIN + _ML_FACTORS + _GRAPH_FACTORS + _load_extra_factors()


# ─── Category → provider/data_type mapping ─────────────

_CATEGORY_MAP = {
    "external":   [("sentiment", "fear_greed"), ("macro", "vix"), ("volatility", "volatility"), ("macro", "dxy"), ("macro", "us10y"), ("sentiment", "sentiment_score"), ("sentiment", "put_call_ratio")],
    "sentiment":  [
        ("sentiment", "yield_curve"), ("sentiment", "put_call_ratio"),
        ("sentiment", "adanos_sentiment"), ("sentiment", "sentiment_score"),
        ("sentiment", "fear_greed"),
    ],
    "news":       [("news", "news")],
    "opportunities": [("opportunities", "opportunities")],
    "heatmap":    [("market", "heatmap")],
    "calendar":   [("calendar", "calendar")],
    "snapshot":   [
        ("market", "crypto_prices"), ("market", "indices"),
        ("onchain", "btc_difficulty"), ("onchain", "btc_hashrate"), ("defi", "tvl"),
        ("volatility", "volatility"), ("macro", "us_indicators"),
        ("fundamental", "earnings"),
        ("global_market", "commodities"), ("global_market", "forex_pairs"),
        ("global_market", "market_overview"),
        ("collector_onchain", "onchain_checkpoints"),
        ("okx_chainos", "okx_hot_tokens"), ("okx_chainos", "okx_index_prices"),
        ("okx_chainos", "okx_candles"),
    ],
}
# Flatten: data_type → category
_SIMPLE_FACTOR_IDS = {
    "fear_greed", "vix", "dxy", "us10y",
    "btc_difficulty", "btc_hashrate", "sentiment_score",
}

# get_current_factors 结果 TTL 缓存（键=(symbols tuple, category)，5s 过期）
_FACTORS_CURRENT_CACHE: dict = {}
_FACTORS_CURRENT_TTL = 5.0

# _load_non_tech_history 全局结果缓存（30s 过期，宏观数据慢变）
_NON_TECH_HIST_CACHE: dict = {}
_NON_TECH_HIST_TTL = 30.0
# _load_ml_history 按 symbol 缓存（30s 过期，ML 预测低频更新）
_ML_HIST_CACHE: dict = {}
_ML_HIST_TTL = 30.0


def get_current_factors(
    symbols: Optional[list[str]] = None,
    category: Optional[str] = None,
) -> dict:
    """Return latest factor values for given symbols.

    If category is specified, filters by collector type.
    Simple numeric factors are returned per-symbol.
    Complex data (heatmap, calendar) is returned as raw structures.

    NOTE: 结果按 (symbols, category) 做 5s TTL 缓存 —— 底层快照分钟级更新，
    高频轮询时避免每次全量解析 raw_snapshots 大 JSON（load 热点，见 2026-08-13 诊断）。
    """
    target = symbols or ["BTC"]
    cache_key = (tuple(target), category)
    _hit = _FACTORS_CURRENT_CACHE.get(cache_key)
    if _hit and time.time() - _hit[0] < _FACTORS_CURRENT_TTL:
        return _hit[1]

    db = get_db()
    now_ms = int(time.time() * 1000)

    result: dict = {}
    for sym in target:
        result[sym] = {}

    # DQ-4: 因子新鲜度元数据 {factor_id: {age_ms, fresh}}（同因子多源取最大 age）
    meta: dict[str, dict] = {}

    def _track(fid: str, age_ms):
        age_ms = max(int(age_ms), 0)
        prev = meta.get(fid)
        if prev is None or age_ms > prev["age_ms"]:
            meta[fid] = {"age_ms": age_ms, "fresh": age_ms <= FRESHNESS_MS}

    # Determine which (provider, data_type) pairs to look for
    if category and category in _CATEGORY_MAP:
        wanted = _CATEGORY_MAP[category]
    elif category:
        # Unknown category — try matching data_type prefix
        wanted = []
    else:
        # No filter: include all simple factors + complex snapshots
        wanted = None  # signal: return everything

    # Get latest snapshot per (provider, data_type) — 直接 SQL 去重，
    # 避免旧实现取 200 条后再在应用层去重（200 条里约 7 成重复，JSON 解析浪费）。
    rows = db.execute(
        """SELECT provider, data_type, raw_json, fetched_at
           FROM raw_snapshots
           WHERE id IN (SELECT MAX(id) FROM raw_snapshots GROUP BY provider, data_type)
           ORDER BY fetched_at DESC"""
    ).fetchall()

    seen: set = set()
    max_ts = 0
    complex_data: dict = {}

    for r in rows:
        fid = r["data_type"]
        provider = r["provider"]
        key = (provider, fid)

        if key in seen:
            continue
        seen.add(key)

        fetched = r["fetched_at"]
        if fetched and fetched > max_ts:
            max_ts = fetched

        # Check if this (provider, data_type) is wanted
        if wanted is not None and (provider, fid) not in wanted:
            continue

        try:
            data = json.loads(r["raw_json"]) if r["raw_json"] else {}
        except (json.JSONDecodeError, TypeError):
            continue
        if not data:
            continue

        # Compound snapshot → simple factors: volatility → vxn/gvz（PRD Arbitrage §2.1）
        if fid == "volatility":
            for sub in ("vxn", "gvz"):
                if isinstance(data.get(sub), (int, float)):
                    val = round(data[sub], 6)
                    _track(sub, now_ms - (fetched or 0))
                    for sym in target:
                        result[sym][sub] = val
            continue

        # Simple numeric factors → map to each target symbol
        if fid in _SIMPLE_FACTOR_IDS:
            field = _FACTOR_FIELD.get(fid)
            if field and field in data:
                val = data[field]
            else:
                val = next((v for v in data.values() if isinstance(v, (int, float))), None)

            if val is not None:
                if isinstance(val, float) and not isinstance(val, int):
                    val = round(val, 6)
                _track(fid, now_ms - (fetched or 0))
                for sym in target:
                    result[sym][fid] = val

        # Complex data (heatmap, calendar, snapshots) → store under "_complex"
        else:
            # Strip envelope: if data has a single key like {"categories": ...}, unwrap
            if len(data) == 1:
                inner_key = next(iter(data))
                complex_data[fid] = data[inner_key]
            else:
                complex_data[fid] = data

    # Also add technical factors from kline table
    for sym in target:
        # kline 表 spot 存储键为 `BTC/USDT`；兼容无市场后缀的裸符号（如默认 BTC）
        row = None
        candidates = [sym]
        normalized = sym.replace("/", "").replace("USDT", "")
        if normalized != sym:
            candidates.append(normalized)
        if "/" not in sym:
            candidates.append(f"{sym}/USDT")
        for cand in candidates:
            row = db.execute(
                "SELECT * FROM kline WHERE symbol = ? ORDER BY ts DESC LIMIT 1",
                (cand,),
            ).fetchone()
            if row is not None:
                break
        if row:
            for fid in _TECH_FACTORS:
                val = row[fid]
                if val is not None:
                    result[sym][fid] = val
                    _track(fid, now_ms - (row["ts"] or 0))

    # DQ-4: ML 因子新鲜度 —— ml_predictions 按 model×symbol 最新 generated_at；
    # tree_predictions / consensus 取最新快照 fetched_at。
    ml_ts: dict[tuple, int] = {}
    for r in db.execute(
        "SELECT model, symbol, MAX(generated_at) AS g FROM ml_predictions GROUP BY model, symbol"
    ).fetchall():
        ml_ts[(r["model"], r["symbol"])] = int(r["g"] or 0)
    snap_ts: dict[str, int] = {}
    for dt in ("tree_predictions", "consensus"):
        r = db.execute(
            "SELECT fetched_at FROM raw_snapshots WHERE data_type=? ORDER BY fetched_at DESC LIMIT 1",
            (dt,),
        ).fetchone()
        if r and r["fetched_at"]:
            snap_ts[dt] = int(r["fetched_at"])

    def _ml_age(fid: str, sym: str, key: str) -> Optional[int]:
        if fid in ("tree_direction", "tree_prob_up"):
            ts = snap_ts.get("tree_predictions")
        elif fid in ("consensus_score", "finbert_sentiment"):
            ts = snap_ts.get("consensus")
        else:
            model = next((m for m in ("bolt", "moirai", "timesfm") if fid.startswith(f"{m}_")), None)
            if not model:
                return None
            ts = ml_ts.get((model, key)) or ml_ts.get((model, sym))
        return now_ms - ts if ts else None

    # DS-13: ML 因子并入（tree/consensus/ml_predictions，按 symbol 广播）
    latest_ml = _load_latest_ml()
    for sym in target:
        key = _ml_symbol_key(sym)
        for fid, val in latest_ml.get(key, {}).items():
            result[sym][fid] = val
            age = _ml_age(fid, sym, key)
            if age is not None:
                _track(fid, age)

    result["_ts"] = int(max_ts)
    if meta:
        result["_meta"] = meta
    if complex_data:
        result["_complex"] = complex_data
    # TTL 缓存：限制条目数防无界增长（组合爆炸时直接清空重建）
    if len(_FACTORS_CURRENT_CACHE) > 64:
        _FACTORS_CURRENT_CACHE.clear()
    _FACTORS_CURRENT_CACHE[cache_key] = (time.time(), result)
    return result


def get_snapshots(data_type: Optional[str] = None, provider: Optional[str] = None) -> dict:
    """Return latest complex snapshot data (heatmap, calendar, indices, etc.).

    If data_type is specified, returns only that type's latest raw_json.
    Otherwise returns all complex snapshots.
    If provider is specified, returns latest row per (data_type, symbol) for
    that provider as {data_type: {symbol: payload}}（GX-3.4/3.5：moomoo_f10
    等按标的落库的 provider，ml-service 图谱引擎读取用；可叠加 type 过滤）。
    """
    db = get_db()

    # GX-3.4/3.5: provider 模式 —— 按 (data_type, symbol) 取每组最新（不叠加
    # 单键信封解包，保持 {data_type: {symbol: payload}} 稳定契约）
    if provider:
        where = "provider = ?"
        params: list = [provider]
        if data_type:
            where += " AND data_type = ?"
            params.append(data_type)
        rows = db.execute(
            f"""SELECT provider, data_type, symbol, raw_json, fetched_at
                FROM raw_snapshots
                WHERE {where} AND id IN (
                    SELECT MAX(id) FROM raw_snapshots WHERE {where} GROUP BY data_type, symbol
                )
                ORDER BY fetched_at DESC""",
            params + params,
        ).fetchall()
        result: dict = {}
        max_ts = 0
        for r in rows:
            if r["fetched_at"] and r["fetched_at"] > max_ts:
                max_ts = r["fetched_at"]
            try:
                payload = json.loads(r["raw_json"]) if r["raw_json"] else {}
            except Exception:
                continue
            if not payload:
                continue
            result.setdefault(r["data_type"], {})[r["symbol"] or "_global"] = payload
        result["_ts"] = int(max_ts)
        return result

    # G-4: 汇总别名 → 前缀匹配。onchain 数据实际落 btc_difficulty /
    # btc_transfers / btc_hashrate / whale_balances 及新合并的 onchain_checkpoints
    # 等子类型，type=onchain 聚合返回全部；okx 聚合返回 okx_* 行情子类型。
    _SNAPSHOT_TYPE_ALIASES = {
        "onchain": ["btc_%", "onchain_%", "whale_%"],
        "okx": "okx_%",
    }

    if data_type:
        patterns = _SNAPSHOT_TYPE_ALIASES.get(data_type)
        if patterns:
            if isinstance(patterns, str):
                patterns = [patterns]
            where = " OR ".join(["data_type LIKE ?"] * len(patterns))
            sql = (
                "SELECT provider, data_type, raw_json, fetched_at "
                "FROM raw_snapshots "
                f"WHERE ({where}) "
                "ORDER BY fetched_at DESC "
                "LIMIT 50"
            )
            params = tuple(patterns)
        else:
            sql = """SELECT provider, data_type, raw_json, fetched_at
                     FROM raw_snapshots
                     WHERE data_type = ?
                     ORDER BY fetched_at DESC
                     LIMIT 1"""
            params = (data_type,)
        rows = db.execute(sql, params).fetchall()
    else:
        # 按 (provider, data_type) 分组取每组最新，替代全局 LIMIT 50：
        # 高频快照（onchain_checkpoints / okx_* 等 1-2 分钟级）会把低频快照
        # （heatmap 等 10 分钟级）挤出最近 50 行窗口，导致 /snapshots 间歇缺项。
        rows = db.execute(
            """SELECT provider, data_type, raw_json, fetched_at
               FROM raw_snapshots
               WHERE id IN (
                   SELECT MAX(id) FROM raw_snapshots GROUP BY provider, data_type
               )
               ORDER BY fetched_at DESC"""
        ).fetchall()

    seen: set = set()
    result: dict = {}
    max_ts = 0

    for r in rows:
        fid = r["data_type"]
        key = (r["provider"], fid)
        if key in seen:
            continue
        seen.add(key)

        if r["fetched_at"] and r["fetched_at"] > max_ts:
            max_ts = r["fetched_at"]

        try:
            data = json.loads(r["raw_json"]) if r["raw_json"] else {}
        except Exception:
            continue
        if not data:
            continue

        # Unwrap single-key envelopes
        if len(data) == 1:
            inner_key = next(iter(data))
            result[fid] = data[inner_key]
        else:
            result[fid] = data

    result["_ts"] = int(max_ts)
    return result


# Map: factor_id → raw_json field name (only when differs from first-numeric heuristic)
_FACTOR_FIELD = {
    "fear_greed": "value",
    "sentiment_score": "value",
    "btc_difficulty": "difficulty",
    "btc_hashrate": "hashrate",
}

# Technical factors come from kline table
_TECH_FACTORS = (
    "rsi_14", "macd", "macd_signal", "macd_hist",
    "bb_upper", "bb_middle", "bb_lower", "atr_14",
    "ma_5", "ma_10", "ma_20",
)

# Macro / sentiment factors with history kept in raw_snapshots (per-collect rows).
# /factors/history merges these asof-aligned (fetched_at <= bar ts, nearest previous).
_NON_TECH_FACTORS = (
    "vix", "dxy", "us10y", "fear_greed", "sentiment_score",
)

# 非技术因子 → macro_history 系列映射（FRED/alternative.me 1 年日频历史）。
# /factors/history 把这些系列合并进 asof 序列，覆盖 raw_snapshots 未积累的早期 bar。
_FACTOR_MACRO_SERIES: dict[str, str] = {
    "vix": "VIXCLS",
    "dxy": "DTWEXBGS",
    "us10y": "DGS10",
    "fear_greed": "FNG",
}


# ─── ML factor loaders（DS-13）────────────────────────────────

# 各源 symbol 形式不同：tree_predictions 用 "BTC/USDT"，consensus/ml_predictions 用 "BTC"。
# 统一归一化到裸代号大写（BTCUSDT → BTC；btc、BTC-USD 同样归一到 BTC；非 crypto 原样返回）。
def _ml_symbol_key(symbol: str) -> str:
    s = (symbol or "").strip().upper()
    if "/" in s:
        s = s.split("/")[0].strip()
    elif ":" in s:
        s = s.split(":")[0].strip()
    for q in _CRYPTO_QUOTES:
        if s.endswith(q) and len(s) > len(q):
            s = s[: -len(q)]
            break
    # BTC-USD / BTC-USDT → BTC（短横线分隔的 crypto 对）
    if "-" in s:
        s = s.split("-")[0].strip()
    return s


def normalize_ml_symbol(symbol: str) -> str:
    """ML 符号规范化公开入口（DQ-5）：大写 + 交易对/quote 剥离。

    ``BTC/USDT``、``BTCUSDT``、``BTC-USD``、``btc`` → ``BTC``；非 crypto 原样（仅大写）。
    """
    return _ml_symbol_key(symbol)


def _dir_val(v) -> int | None:
    """direction 字符串 → 数值（up=1/flat=0/down=-1）；已是数值原样返回。"""
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return int(v) if v in (1, 0, -1) else v
    return _DIRECTION_VALUE.get(str(v).strip().lower())


def _load_latest_ml() -> dict[str, dict]:
    """Latest ML factors indexed by normalized symbol key.

    数据源（ml_predictions 表最新 + raw_snapshots 最新快照）：
      tree_predictions → tree_direction / tree_prob_up
      consensus       → consensus_score / finbert_sentiment / bolt·timesfm 信号
      ml_predictions  → 每 model×symbol 最新 direction/prob_up（bolt/moirai/timesfm）
    """
    db = get_db()
    out: dict[str, dict] = {}

    # 1. tree_predictions 最新快照
    row = db.execute(
        "SELECT raw_json FROM raw_snapshots WHERE data_type='tree_predictions' ORDER BY fetched_at DESC LIMIT 1"
    ).fetchone()
    if row:
        try:
            data = json.loads(row["raw_json"] or "{}") or {}
        except Exception:
            data = {}
        for p in data.get("predictions") or []:
            k = _ml_symbol_key(str(p.get("symbol", "")))
            if not k:
                continue
            d = out.setdefault(k, {})
            if "direction" in p:
                d["tree_direction"] = _dir_val(p.get("direction"))
            if p.get("prob_up") is not None:
                d["tree_prob_up"] = round(float(p["prob_up"]), 6)

    # 2. consensus 最新快照（聚合 tree/bolt/timesfm/sentiment 信号）
    row = db.execute(
        "SELECT raw_json FROM raw_snapshots WHERE data_type='consensus' ORDER BY fetched_at DESC LIMIT 1"
    ).fetchone()
    if row:
        try:
            data = json.loads(row["raw_json"] or "{}") or {}
        except Exception:
            data = {}
        for s in data.get("symbols") or []:
            k = _ml_symbol_key(str(s.get("symbol", "")))
            if not k:
                continue
            d = out.setdefault(k, {})
            if s.get("consensus_score") is not None:
                d["consensus_score"] = round(float(s["consensus_score"]), 6)
            if s.get("sentiment_score") is not None:
                d["finbert_sentiment"] = round(float(s["sentiment_score"]), 6)
            if "tree_direction" in s:
                d["tree_direction"] = _dir_val(s.get("tree_direction"))
            if s.get("tree_prob_up") is not None:
                d["tree_prob_up"] = round(float(s["tree_prob_up"]), 6)
            for m in ("bolt", "moirai", "timesfm"):
                if s.get(f"{m}_direction") is not None:
                    d[f"{m}_direction"] = _dir_val(s.get(f"{m}_direction"))
                if s.get(f"{m}_prob_up") is not None:
                    d[f"{m}_prob_up"] = round(float(s[f"{m}_prob_up"]), 6)

    # 3. ml_predictions 每 model×symbol 最新（bolt/moirai/timesfm）
    rows = db.execute(
        """SELECT m.model, m.symbol, m.direction, m.prob_up
           FROM ml_predictions m
           JOIN (SELECT model, symbol, MAX(generated_at) AS g
                 FROM ml_predictions GROUP BY model, symbol) t
             ON m.model = t.model AND m.symbol = t.symbol AND m.generated_at = t.g"""
    ).fetchall()
    for r in rows:
        k = _ml_symbol_key(r["symbol"])
        if not k:
            continue
        d = out.setdefault(k, {})
        if r["direction"] is not None:
            d[f"{r['model']}_direction"] = _dir_val(r["direction"])
        if r["prob_up"] is not None:
            d[f"{r['model']}_prob_up"] = round(float(r["prob_up"]), 6)

    return out


def _load_ml_history(symbol: str) -> dict[str, tuple[list[int], list[float]]]:
    """Per-symbol ML factor step history: {factor_id: (sorted_ts, values)}。

    回测 asof 对齐使用（fetched_at/generated_at ≤ bar ts 最近值），与
    _load_non_tech_history 同型。来源：
      tree_predictions / consensus 快照历史（raw_snapshots，每快照按 symbol 提取）
      ml_predictions 明细表（逐 model×symbol×generated_at）

    ML 预测低频更新（模型按小时级产出）—— 按 symbol 加 30s TTL 缓存，
    避免每次 /factors/history 请求重复全量扫快照与 ml_predictions（load 热点）。
    """
    now = time.time()
    key0 = _ml_symbol_key(symbol)
    hit = _ML_HIST_CACHE.get(key0)
    if hit and now - hit[0] < _ML_HIST_TTL:
        return hit[1]

    db = get_db()
    key = key0
    raw: dict[str, list[tuple[int, float]]] = {f: [] for f in _ML_FACTOR_IDS}

    def _push(fid: str, ts: int, val):
        if val is None:
            return
        try:
            v = float(val)
        except (TypeError, ValueError):
            return
        raw[fid].append((int(ts), v))

    # 快照历史（tree_predictions / consensus）
    for dt in ("tree_predictions", "consensus"):
        rows = db.execute(
            "SELECT raw_json, fetched_at FROM raw_snapshots WHERE data_type=? ORDER BY fetched_at ASC LIMIT 50000",
            (dt,),
        ).fetchall()
        for r in rows:
            ts = r["fetched_at"]
            if not ts:
                continue
            try:
                data = json.loads(r["raw_json"] or "{}") or {}
            except Exception:
                continue
            items = data.get("symbols") if dt == "consensus" else data.get("predictions")
            for s in items or []:
                if _ml_symbol_key(str(s.get("symbol", ""))) != key:
                    continue
                if dt == "tree_predictions":
                    _push("tree_direction", ts, _dir_val(s.get("direction")))
                    _push("tree_prob_up", ts, s.get("prob_up"))
                else:
                    _push("consensus_score", ts, s.get("consensus_score"))
                    _push("finbert_sentiment", ts, s.get("sentiment_score"))
                    if s.get("tree_direction") is not None:
                        _push("tree_direction", ts, _dir_val(s.get("tree_direction")))
                    if s.get("tree_prob_up") is not None:
                        _push("tree_prob_up", ts, s.get("tree_prob_up"))
                    for m in ("bolt", "moirai", "timesfm"):
                        if s.get(f"{m}_direction") is not None:
                            _push(f"{m}_direction", ts, _dir_val(s.get(f"{m}_direction")))
                        if s.get(f"{m}_prob_up") is not None:
                            _push(f"{m}_prob_up", ts, s.get(f"{m}_prob_up"))

    # ml_predictions 明细历史（bolt/moirai/timesfm）
    rows = db.execute(
        "SELECT model, symbol, generated_at, direction, prob_up FROM ml_predictions ORDER BY generated_at ASC LIMIT 50000"
    ).fetchall()
    for r in rows:
        if _ml_symbol_key(r["symbol"]) != key:
            continue
        ts = r["generated_at"]
        m = r["model"]
        _push(f"{m}_direction", ts, _dir_val(r["direction"]))
        _push(f"{m}_prob_up", ts, r["prob_up"])

    # 值变化步进压缩（同 _load_non_tech_history）
    out: dict[str, tuple[list[int], list[float]]] = {}
    for fid, seq in raw.items():
        if not seq:
            continue
        steps: dict[int, float] = {}
        last = None
        for t, v in seq:
            if v != last:
                steps[t] = v
                last = v
        ts_list = sorted(steps)
        out[fid] = (ts_list, [steps[t] for t in ts_list])
    if len(_ML_HIST_CACHE) > 64:
        _ML_HIST_CACHE.clear()
    _ML_HIST_CACHE[key] = (time.time(), out)
    return out


def get_history_factors(
    symbol: str,
    timeframe: str = "1m",
    ids: Optional[list[str]] = None,
    start: Optional[int] = None,
    end: Optional[int] = None,
    limit: int = 500,
) -> dict:
    """Return a per-bar factor time series from the kline table.

    Technical factors (rsi_14/macd/bb/atr/ma_*) are stored per-bar and are
    returned aligned to candle timestamps — this is what backtests need to
    reproduce live factor values bar-by-bar.

    Macro / sentiment factors (vix/dxy/us10y/fear_greed/sentiment_score) are
    merged from raw_snapshots history, asof-aligned to each bar (nearest value
    with fetched_at <= bar ts). When ``ids`` is omitted, all technical +
    macro/sentiment factors are returned.

    ``ids`` filters to the requested factor ids (technical or macro ids).
    ``ts`` is in milliseconds, matching /bars.
    """
    db = get_db()
    cols = ", ".join(_TECH_FACTORS)
    limit = max(1, min(int(limit or 500), 5000))
    timeframe = str(timeframe or "1m").strip().lower()  # 存储键小写，大小写不敏感

    def _query(sym: str):
        where = "symbol = ? AND timeframe = ?"
        params: list = [sym, timeframe]
        if start is not None:
            where += " AND ts >= ?"
            params.append(start)
        if end is not None:
            where += " AND ts <= ?"
            params.append(end)
        if start is None and end is None:
            # 未指定时间区间时默认取「最近 limit 根」（趋势图/最新因子场景），
            # 内层降序取最近 N 根、外层升序输出；带 start/end 时保持升序过滤。
            sql = (
                f"SELECT ts, {cols} FROM ("
                f"SELECT ts, {cols} FROM kline WHERE {where} ORDER BY ts DESC LIMIT ?"
                f") ORDER BY ts ASC"
            )
            return db.execute(sql, (*params, limit)).fetchall()
        return db.execute(
            f"SELECT ts, {cols} FROM kline WHERE {where} ORDER BY ts ASC LIMIT ?",
            (*params, limit),
        ).fetchall()

    rows = _query(symbol)
    if not rows and "/" in symbol:
        rows = _query(symbol.split("/", 1)[0])
    if not rows and "/" not in symbol:
        # crypto 裸对（resolve 返回 BTCUSDT）→ 交易对存储键再查（D7）
        pair = normalize_crypto_pair(symbol)
        if pair != symbol:
            rows = _query(pair)

    # 宏观/情绪历史（raw_snapshots，按 data_type 取 per-collect 历史）
    import bisect
    macro_hist = _load_non_tech_history()

    # DS-13: ML 因子历史（tree/consensus/ml_predictions，按 symbol 取 asof 序列）
    ml_hist = _load_ml_history(symbol)

    wanted = set(ids) if ids else set(_TECH_FACTORS + _NON_TECH_FACTORS + _ML_FACTOR_IDS)
    _aso = {}
    for col in _NON_TECH_FACTORS:
        if col in wanted and macro_hist.get(col):
            _aso[col] = macro_hist[col]
    for col in _ML_FACTOR_IDS:
        if col in wanted and ml_hist.get(col):
            _aso[col] = ml_hist[col]

    series: list[dict] = []
    for r in rows:
        item: dict = {"ts": r["ts"]}
        for col in _TECH_FACTORS:
            if col in wanted and r[col] is not None:
                item[col] = r[col]
        for col in _NON_TECH_FACTORS:
            if col in wanted and col in _aso:
                ts_list, val_list = _aso[col]
                idx = bisect.bisect_right(ts_list, r["ts"]) - 1
                if idx >= 0:
                    item[col] = val_list[idx]
        for col in _ML_FACTOR_IDS:
            if col in wanted and col in _aso:
                ts_list, val_list = _aso[col]
                idx = bisect.bisect_right(ts_list, r["ts"]) - 1
                if idx >= 0:
                    item[col] = val_list[idx]
        series.append(item)

    # DQ-2: 缺值因子列前值填充（ffill，同 symbol 内按时间序、不引入未来值）。
    # 技术因子早期 bar 未计算（rsi 等）或外部因子无更早快照时，
    # 用序列内最近的非空值前向填充；FACTORS_FFILL=false 则保持缺值（null 占位）。
    if FACTORS_FFILL and series:
        all_keys = sorted({k for it in series for k in it if k != "ts"})
        last: dict[str, float] = {}
        for item in series:
            for k in all_keys:
                if k in item:
                    if item[k] is not None:
                        last[k] = item[k]
                elif k in last:
                    item[k] = last[k]

    return {
        "symbol": symbol,
        "timeframe": timeframe,
        "count": len(series),
        "series": series,
    }


def _load_non_tech_history() -> dict[str, tuple[list[int], list[float]]]:
    """Load macro/sentiment factor history from raw_snapshots.

    Returns ``{factor_id: (sorted_fetched_at, values)}`` — a value-change
    step function. Consumers asof-lookup the nearest ``fetched_at <= bar_ts``.

    结果全局（不依赖 symbol）且宏观数据分钟级更新 —— 加 30s TTL 缓存，
    避免每次 /factors/history 请求都全量扫 5 万条快照并解析 JSON（load 热点）。
    """
    now = time.time()
    hit = _NON_TECH_HIST_CACHE.get(0)
    if hit and now - hit[0] < _NON_TECH_HIST_TTL:
        return hit[1]

    db = get_db()
    rows = db.execute(
        f"SELECT data_type, raw_json, fetched_at FROM raw_snapshots "
        f"WHERE data_type IN ({','.join('?' * len(_NON_TECH_FACTORS))}) "
        f"ORDER BY fetched_at ASC LIMIT 50000",
        _NON_TECH_FACTORS,
    ).fetchall()
    by_type: dict[str, list[tuple[int, float]]] = {f: [] for f in _NON_TECH_FACTORS}
    for r in rows:
        if not r["fetched_at"]:
            continue
        try:
            data = json.loads(r["raw_json"]) if r["raw_json"] else {}
        except (json.JSONDecodeError, TypeError):
            continue
        if not isinstance(data, dict):
            continue
        field = _FACTOR_FIELD.get(r["data_type"])
        val = data.get(field) if field else None
        if val is None:
            val = next((v for v in data.values() if isinstance(v, (int, float))), None)
        if val is None:
            continue
        by_type[r["data_type"]].append((int(r["fetched_at"]), float(val)))

    # 宏观历史（macro_history 表，FRED 日频 / FNG 1 年）合并进非技术因子 asof 序列：
    # raw_snapshots 只积累最近数天，早期 bar 无快照可对齐 → 用 macro_history 补齐（B 端反馈）。
    try:
        mrows = db.execute(
            f"SELECT series_id, date, value FROM macro_history "
            f"WHERE series_id IN ({','.join('?' * len(_FACTOR_MACRO_SERIES))}) "
            f"AND value IS NOT NULL ORDER BY date ASC",
            list(_FACTOR_MACRO_SERIES.values()),
        ).fetchall()
        for r in mrows:
            try:
                t = int(
                    datetime.strptime(r["date"], "%Y-%m-%d")
                    .replace(tzinfo=timezone.utc)
                    .timestamp() * 1000
                )
            except (TypeError, ValueError):
                continue
            for fid, sid in _FACTOR_MACRO_SERIES.items():
                if r["series_id"] == sid:
                    by_type[fid].append((t, float(r["value"])))
                    break
    except Exception:
        logger.debug("macro_history merge into non-tech factors failed", exc_info=True)

    out: dict[str, tuple[list[int], list[float]]] = {}
    for fid, seq in by_type.items():
        if not seq:
            continue
        steps: dict[int, float] = {}
        last_v = None
        for t, v in seq:
            if v != last_v:
                steps[t] = v
                last_v = v
        ts_list = sorted(steps)
        out[fid] = (ts_list, [steps[t] for t in ts_list])
    _NON_TECH_HIST_CACHE[0] = (time.time(), out)
    return out


def save_snapshot(provider: str, data_type: str, data: dict, symbol: str = ""):
    """Save a raw factor snapshot to raw_snapshots table. Best-effort."""
    import hashlib
    import time

    try:
        raw = json.dumps(data, default=str)
        checksum = hashlib.md5(raw.encode()).hexdigest()
        db = get_db()
        db.execute(
            """INSERT INTO raw_snapshots (provider, data_type, symbol, raw_json, fetched_at, checksum)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (provider, data_type, symbol, raw, int(time.time() * 1000), checksum),
        )
        db.commit()
    except Exception as exc:
        # 落库失败不能静默 —— 数据采集链路的关键故障点
        logger.warning(
            "save_snapshot failed provider=%s data_type=%s symbol=%s: %s",
            provider, data_type, symbol, exc,
        )


def query_ml_predictions(
    model: str,
    symbol: str,
    start: Optional[int] = None,
    end: Optional[int] = None,
    limit: int = 500,
) -> list[dict]:
    """P2 单模型预测历史查询（ml_predictions 明细表，§5.7）。

    符号归一化（BTC/USDT、btc → BTC，DQ-5），generated_at 升序，start/end 区间过滤。
    """
    sym = normalize_ml_symbol(symbol)
    db = get_db()
    sql = (
        "SELECT generated_at, direction, prob_up, uncertainty, "
        "point_forecast, quantiles FROM ml_predictions "
        "WHERE model=? AND symbol=?"
    )
    params: list = [model, sym]
    if start is not None:
        sql += " AND generated_at >= ?"
        params.append(start)
    if end is not None:
        sql += " AND generated_at <= ?"
        params.append(end)
    sql += " ORDER BY generated_at ASC LIMIT ?"
    params.append(limit)

    rows = db.execute(sql, params).fetchall()
    result = []
    for r in rows:
        result.append({
            "generated_at": r["generated_at"],
            "direction": r["direction"],
            "prob_up": r["prob_up"],
            "uncertainty": r["uncertainty"],
            "point_forecast": json.loads(r["point_forecast"]) if r["point_forecast"] else None,
            "quantiles": json.loads(r["quantiles"]) if r["quantiles"] else None,
        })
    return result


# ─── 宏观历史（macro_history 表，FRED 观测值 1 年回填）────────────

_MACRO_SERIES_NAMES: dict[str, str] = {
    "CPIAUCSL": "CPI",
    "PCEPILFE": "Core PCE",
    "PAYEMS": "NFP",
    "UNRATE": "Unemployment",
    "GDP": "GDP",
    "FEDFUNDS": "Fed Funds Rate",
    "VIXCLS": "VIX",
    "DTWEXBGS": "DXY",
    "DGS10": "US10Y",
}

# 非 FRED 系列（alternative.me 等）显示名：仅供 /macro/history 展示，
# 不并入 fred_series，避免 FRED 采集器尝试拉取非 FRED 系列。
_MACRO_DISPLAY_EXTRA: dict[str, str] = {
    "FNG": "Fear & Greed",
}


def macro_series_map() -> dict[str, str]:
    """data_config.json → macro.fred_series 映射（series_id → 展示名）。

    兜底 _MACRO_SERIES_NAMES（与 us_indicators 快照键一致）。
    """
    path = os.getenv("DATA_CONFIG_PATH", "data_config.json")
    try:
        cfg = json.loads(Path(path).read_text()) if Path(path).exists() else {}
        series = cfg.get("macro", {}).get("fred_series", {}) or {}
        if series:
            return dict(series)
    except Exception:
        pass
    return dict(_MACRO_SERIES_NAMES)


def save_macro_observations(series_id: str, observations: list[dict], now_ms: Optional[int] = None):
    """Upsert 宏观观测值到 macro_history（幂等，INSERT OR IGNORE）。

    observations: [{"date": "2026-06-01", "value": 332.5, "predict_value": 333.0}, ...]
    predict_value（moomoo 宏观一致预期，MM-4）可选，缺省 None；FRED 系列不受影响。
    """
    if not observations:
        return 0
    now_ms = int(now_ms or time.time() * 1000)
    db = get_db()
    rows = []
    for obs in observations:
        date_str = (obs or {}).get("date", "")
        value = (obs or {}).get("value")
        predict_value = (obs or {}).get("predict_value")
        if not date_str or (value is None and predict_value is None):
            continue
        try:
            value = float(value) if value is not None else None
        except (TypeError, ValueError):
            value = None
        try:
            predict_value = float(predict_value) if predict_value is not None else None
        except (TypeError, ValueError):
            predict_value = None
        if value is None and predict_value is None:
            continue
        rows.append((series_id, date_str, value, predict_value, now_ms))
    if not rows:
        return 0
    db.executemany(
        """INSERT OR IGNORE INTO macro_history (series_id, date, value, predict_value, fetched_at)
           VALUES (?, ?, ?, ?, ?)""",
        rows,
    )
    db.commit()
    return len(rows)


def get_macro_history(
    series_ids: Optional[list[str]] = None,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    limit: int = 5000,
) -> dict:
    """按 series 分组返回宏观历史序列。

    返回 {"ts": int, "series": {name: [{"date", "value"}, ...]}}。
    series_ids 为 None 时返回全部已采集系列；name 用 data_config 映射展示名。
    """
    db = get_db()
    names = macro_series_map()
    names = {**names, **_MACRO_DISPLAY_EXTRA}
    sql = "SELECT series_id, date, value, predict_value FROM macro_history"
    params: list = []
    if series_ids:
        sql += f" WHERE series_id IN ({','.join('?' * len(series_ids))})"
        params.extend(series_ids)
    if start_date:
        sql += " AND date >= ?" if series_ids else " WHERE date >= ?"
        params.append(start_date)
    if end_date:
        sql += (" AND " if ("WHERE" in sql or "AND" in sql) else " WHERE ") + "date <= ?"
        params.append(end_date)
    sql += " ORDER BY series_id, date ASC LIMIT ?"
    params.append(max(1, min(int(limit or 5000), 50000)))

    rows = db.execute(sql, params).fetchall()
    series: dict[str, list[dict]] = {}
    for r in rows:
        sid = r["series_id"]
        name = names.get(sid, sid)
        series.setdefault(name, []).append({
            "date": r["date"],
            "value": r["value"],
            "predict_value": r["predict_value"] if "predict_value" in r.keys() else None,
        })
    ts_row = db.execute("SELECT MAX(fetched_at) AS t FROM macro_history").fetchone()
    return {
        "ts": int(ts_row["t"] or 0) if ts_row else 0,
        "series": series,
    }

