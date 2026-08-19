"""ml-service 图谱因子引擎（GX-1 / GX-2 / GX-3，统一图模型扩展机制）。

数据源（全部经 data-service HTTP，fail-silent，见 app.data_client）：
  - /snapshots?type=heatmap：板块分组 / 市值 / 价格 / 24h 涨跌（GX-1 静态图）
  - /bars：滚动 60 日对数收益 → 相关性动态图（GX-2，|ρ|≥0.6 建边）
  - /snapshots?provider=moomoo_f10：美股 F10 财报/估值/一致预期（GX-3.4）+
    卖空/资金流 mm_short_capital（GX-3.5.2）
  - /factors/crypto-derivatives：衍生品资金费率/持仓/多空比（GX-3.5.3）
  - /snapshots?type=tvl：链上 DeFi TVL（GX-3.5.4，链节点 + 链-资产关系边）

扩展机制（GX-3，infrax_tasklist §9.22）：
  - SourceAdapter（数据源适配器）：统一接口 fetch → normalize（GraphSourceData
    节点/边/属性）→ 引擎 upsert 合并；新数据面只需实现一个适配器注册即用
  - EdgeBuilder（边构建器注册表）：每类边独立构建器（industry/supply_chain/corr/
    earnings_event/financial_similarity），按图层权重合并
  - AttributeInjector（属性注入器）：行情/财报/估值/资金费率等作为节点属性注入，
    不占图结构（features JSON 字段）

因子（18 个，id 与 data-service app/factors._GRAPH_FACTORS 对齐）：
  - 结构：gf_degree / gf_betweenness / gf_pagerank / gf_community / gf_structural_hole
  - 邻居聚合：gf_neighbor_mom / gf_neighbor_vol / gf_sector_mom / gf_cc_spillover / gf_community_mom
  - 图嵌入：gf_node2vec_1..8（对称归一化邻接谱嵌入，类 Node2Vec 的低维表示）

依赖 networkx（+ numpy）；缺失时 compute 返回 None（fail-silent，不产生模拟数据）。
全图 + 结构因子计算结果由 main.py _async_runner 做 TTL 缓存（ML_CACHE_TTL_SEC），
首次 miss 后台计算、预热线程周期刷新 —— 端点只做字典过滤，秒回。
"""
from __future__ import annotations

import logging
import math
import os
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

import numpy as np

import config
from app import data_client

logger = logging.getLogger(__name__)

try:  # networkx 缺失时降级：compute 返回 None（fail-silent），catalog 仍可用
    import networkx as nx
    _NX_OK = True
except Exception:  # pragma: no cover
    nx = None
    _NX_OK = False


# ── 常量 ────────────────────────────────────────────────────
_CORR_WINDOW = 60            # 相关性窗口（滚动 60 个共同交易日）
_CORR_THRESHOLD = 0.6        # |ρ|≥0.6 建边
_CORR_MIN_OVERLAP = 30       # 共同交易日下限（不足不建边）
_BARS_LIMIT = 70             # 每标的拉取 bar 数（60 收益 + 余量）
_BARS_WORKERS = 8            # bars 并行拉取并发数
_NODE2VEC_DIMS = 8           # 图嵌入维度（gf_node2vec_1..8）
_UNIVERSE_CAP = 150          # 构图宇宙上限（市值降序，控制 bar 拉取量）
_EDGE_WEIGHT_SECTOR = 1.0
_EDGE_WEIGHT_SUPPLY = 0.8
_EDGE_WEIGHT_EARNINGS = 0.6        # 财报事件边（自环标记，GX-3.4.3）
_EDGE_WEIGHT_CHAIN_ASSET = 0.4     # 链-资产关系边（GX-3.5.4）
_FIN_SIM_THRESHOLD = 0.8           # 财务结构特征向量余弦相似度阈值（GX-3.4.4）
_FIN_SIM_MIN_FEATURES = 2          # 相似度特征维数下限（不足不建边）

# 板块名规范（heatmap 键 → 展示名）
_SECTOR_LABELS = {
    "layer1": "Layer1", "layer2": "Layer2", "defi": "DeFi", "meme": "Meme",
    "ai": "AI", "gaming": "Gaming", "infra": "Infra",
    "topcap": "TopCap", "other": "Other",
    "stocks": "Stocks", "fx": "FX", "commodities": "Commodities",
}

# 兜底板块映射（heatmap 不可用时仍可构图；与 data-service heatmap.CRYPTO_SECTORS 对齐）
_SECTOR_MAP: dict[str, str] = {
    "BTC": "Layer1", "ETH": "Layer1", "SOL": "Layer1", "XRP": "Layer1",
    "AVAX": "Layer1", "DOT": "Layer1",
    "NEAR": "Layer1", "APT": "Layer1", "SUI": "Layer1", "SEI": "Layer1",
    "INJ": "Layer1", "ATOM": "Layer1", "ADA": "Layer1", "TRX": "Layer1",
    "TON": "Layer1", "ALGO": "Layer1", "EGLD": "Layer1", "ICP": "Layer1",
    "HBAR": "Layer1", "FLOW": "Layer1", "XTZ": "Layer1", "ROSE": "Layer1",
    "MATIC": "Layer2", "POL": "Layer2", "ARB": "Layer2", "OP": "Layer2",
    "IMX": "Layer2", "STRK": "Layer2", "MANTA": "Layer2", "METIS": "Layer2",
    "UNI": "DeFi", "AAVE": "DeFi", "MKR": "DeFi", "COMP": "DeFi",
    "CRV": "DeFi", "SNX": "DeFi", "LDO": "DeFi", "RUNE": "DeFi",
    "GMX": "DeFi", "PENDLE": "DeFi", "DYDX": "DeFi", "JUP": "DeFi",
    "DOGE": "Meme", "SHIB": "Meme", "PEPE": "Meme", "WIF": "Meme",
    "BONK": "Meme", "FLOKI": "Meme", "POPCAT": "Meme",
    "FET": "AI", "RNDR": "AI", "TAO": "AI", "WLD": "AI", "ARKM": "AI",
    "SAND": "Gaming", "MANA": "Gaming", "AXS": "Gaming", "GALA": "Gaming",
    "LINK": "Infra", "FIL": "Infra", "AR": "Infra", "GRT": "Infra",
    "ANKR": "Infra", "BAND": "Infra", "PYTH": "Infra", "TRB": "Infra",
    "HNT": "Infra", "IOTX": "Infra", "LPT": "Infra",
}

# 供应链边（curated，可扩展）：仅当两端节点都在图中时建边
_SUPPLY_CHAIN: dict[str, list[str]] = {
    # ETH 生态 L2（结算/数据依赖以太坊）
    "ETH": ["ARB", "OP", "STRK", "MANTA", "METIS", "BOBA", "LRC", "IMX", "POL"],
    # 基础设施服务方（预言机/索引/存储 → 服务全生态）
    "LINK": ["PYTH", "BAND", "API3", "TRB"],
    "GRT": ["LINK", "PYTH"],
    "FIL": ["AR"],
}

# 因子 catalog（18 项，与 data-service _GRAPH_FACTORS 完全对齐；/ml/graph/catalog 输出）
GRAPH_FACTOR_CATALOG: list[dict] = [
    {"id": "gf_degree", "name": "Degree Centrality", "category": "graph", "type": "float", "range": [0, 1], "description": "节点度中心性（图谱内关联度）", "unit": None},
    {"id": "gf_betweenness", "name": "Betweenness Centrality", "category": "graph", "type": "float", "range": [0, 1], "description": "介数中心性（传导枢纽地位）", "unit": None},
    {"id": "gf_pagerank", "name": "PageRank Centrality", "category": "graph", "type": "float", "range": [0, 1], "description": "PageRank 中心度（信息网络重要性）", "unit": None},
    {"id": "gf_community", "name": "Community Index", "category": "graph", "type": "int", "range": [0, None], "description": "社区编号（同社区联动分组）", "unit": None},
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


# ── GX-3 框架：数据结构 ───────────────────────────────────

@dataclass
class GEdge:
    """规范化边：u/v 为归一化符号，kind 为边类型，weight 为图层权重。"""
    u: str
    v: str
    kind: str
    weight: float = 1.0
    attrs: dict = field(default_factory=dict)


@dataclass
class GraphSourceData:
    """SourceAdapter 的规范化输出：节点（symbol → 属性）+ 边 + 元数据。"""
    nodes: dict[str, dict] = field(default_factory=dict)
    edges: list[GEdge] = field(default_factory=list)
    meta: dict = field(default_factory=dict)


# ── GX-3 框架：接口 + 注册表 ──────────────────────────────

class SourceAdapter(ABC):
    """数据源适配器：fetch → normalize（GraphSourceData）→ 引擎 upsert。"""
    name: str = "base"

    @abstractmethod
    def fetch(self) -> GraphSourceData | None:
        ...


class EdgeBuilder(ABC):
    """边构建器：每类边独立构建器，注册进 EDGE_BUILDERS，按图层权重合并。"""
    name: str = "base"

    @abstractmethod
    def build(self, ctx: dict[str, Any]) -> list[GEdge]:
        ...


class AttributeInjector(ABC):
    """属性注入器：行情/财报等作为节点属性注入（不占图结构）。"""
    name: str = "base"

    @abstractmethod
    def inject(self, ctx: dict[str, Any], nodes: dict[str, dict]) -> None:
        ...


SOURCE_ADAPTERS: dict[str, SourceAdapter] = {}
EDGE_BUILDERS: dict[str, EdgeBuilder] = {}
ATTRIBUTE_INJECTORS: dict[str, AttributeInjector] = {}


def register_source_adapter(adapter: SourceAdapter) -> None:
    if adapter.name in SOURCE_ADAPTERS:
        raise ValueError(f"source adapter already registered: {adapter.name}")
    SOURCE_ADAPTERS[adapter.name] = adapter


def register_edge_builder(builder: EdgeBuilder) -> None:
    if builder.name in EDGE_BUILDERS:
        raise ValueError(f"edge builder already registered: {builder.name}")
    EDGE_BUILDERS[builder.name] = builder


def register_attribute_injector(injector: AttributeInjector) -> None:
    if injector.name in ATTRIBUTE_INJECTORS:
        raise ValueError(f"attribute injector already registered: {injector.name}")
    ATTRIBUTE_INJECTORS[injector.name] = injector


# ── 内置：Heatmap SourceAdapter（GX-1 静态图数据面） ────────

class HeatmapAdapter(SourceAdapter):
    """data-service /snapshots?type=heatmap → 节点（sector/price/mcap/change）。

    heatmap 不可用时回退内置 _SECTOR_MAP（仅板块归属，无价格信息）。
    """

    name = "heatmap"

    def fetch(self) -> GraphSourceData | None:
        data = GraphSourceData()
        payload = data_client.fetch_heatmap()
        if isinstance(payload, dict) and payload:
            for key, rows in payload.items():
                sector = _SECTOR_LABELS.get(str(key).lower())
                if not isinstance(rows, list):
                    continue
                for row in rows:
                    if not isinstance(row, dict):
                        continue
                    sym = _norm_symbol(str(row.get("name") or row.get("symbol") or ""))
                    if not sym:
                        continue
                    # topcap/other 无真实板块：用内置映射回填（BTC/XRP 等归 Layer1）
                    if sector in ("TopCap", "Other") and sym in _SECTOR_MAP:
                        sector = _SECTOR_MAP[sym]
                    data.nodes[sym] = {
                        "sector": sector,
                        "price": _safe_float(row.get("price")),
                        "market_cap": _safe_float(row.get("marketCap") or row.get("market_cap")),
                        "change_24h": _safe_float(row.get("value")),
                    }
        # 兜底：未覆盖的已知 token 补板块归属
        for sym, sector in _SECTOR_MAP.items():
            data.nodes.setdefault(sym, {}).setdefault("sector", sector)
        if not data.nodes:
            return None
        return data


# ── 内置：Industry / Supply Chain / Correlation EdgeBuilder ──

class IndustryEdgeBuilder(EdgeBuilder):
    """同板块（行业）边：共享 sector 的 token 两两相连（GX-1.2 same_industry）。

    真实板块才有行业边；TopCap/Other/None 不做全连接。
    """

    name = "industry"

    def build(self, ctx: dict[str, Any]) -> list[GEdge]:
        nodes = ctx.get("nodes", {})
        by_sector: dict[str, list[str]] = {}
        for sym, attrs in nodes.items():
            sec = attrs.get("sector")
            if sec and sec not in ("TopCap", "Other"):
                by_sector.setdefault(sec, []).append(sym)
        edges: list[GEdge] = []
        for members in by_sector.values():
            for i in range(len(members)):
                for j in range(i + 1, len(members)):
                    edges.append(GEdge(members[i], members[j], "industry",
                                       weight=_EDGE_WEIGHT_SECTOR))
        return edges


class SupplyChainEdgeBuilder(EdgeBuilder):
    """供应链边：curated 上下游映射，仅当两端节点都在图中时建边（GX-1.2 supply_chain）。"""

    name = "supply_chain"

    def build(self, ctx: dict[str, Any]) -> list[GEdge]:
        nodes = ctx.get("nodes", {})
        edges: list[GEdge] = []
        for u, downstream in _SUPPLY_CHAIN.items():
            if u not in nodes:
                continue
            for v in downstream:
                if v in nodes and u != v:
                    edges.append(GEdge(u, v, "supply_chain", weight=_EDGE_WEIGHT_SUPPLY))
        return edges


class CorrelationEdgeBuilder(EdgeBuilder):
    """相关性动态边（GX-2.1）：/bars 滚动 60 日对数收益，|ρ|≥0.6 建边。

    weight=|ρ|（结构/邻居聚合使用），attrs["rho"] 保留带符号 ρ（溢出因子用）。
    """

    name = "corr"

    def build(self, ctx: dict[str, Any]) -> list[GEdge]:
        frames = ctx.get("returns", {})
        if len(frames) < 2:
            return []
        rd = {sym: dict(zip(ts, rets)) for sym, (rets, ts) in frames.items()}
        syms = list(rd)
        edges: list[GEdge] = []
        for i in range(len(syms)):
            for j in range(i + 1, len(syms)):
                si, sj = syms[i], syms[j]
                common = sorted(set(rd[si]) & set(rd[sj]))[-_CORR_WINDOW:]
                if len(common) < _CORR_MIN_OVERLAP:
                    continue
                x = np.array([rd[si][t] for t in common])
                y = np.array([rd[sj][t] for t in common])
                if x.std() < 1e-12 or y.std() < 1e-12:
                    continue
                rho = float(np.corrcoef(x, y)[0, 1])
                if not math.isfinite(rho) or abs(rho) < _CORR_THRESHOLD:
                    continue
                edges.append(GEdge(si, sj, "corr", weight=abs(rho), attrs={"rho": rho}))
        return edges


# ── 内置：Bars AttributeInjector（行情属性注入） ───────────

class BarsAttributeInjector(AttributeInjector):
    """把 /bars 行情注入节点属性：ret_1d / ret_5d / vol_20d（GX-1.4 邻居聚合输入）。

    属性只挂节点、不建边 —— 财报/估值/情绪等扩展数据面复用同一注入通道（GX-3.3）。
    """

    name = "bars"

    def inject(self, ctx: dict[str, Any], nodes: dict[str, dict]) -> None:
        for sym, attrs in nodes.items():
            rows = ctx.get("bars", {}).get(sym)
            if not rows:
                continue
            closes = [r for r in rows if isinstance(r.get("close"), (int, float))]
            if len(closes) < 6:
                continue
            prices = np.array([float(r["close"]) for r in closes])
            if np.any(prices <= 0):
                continue
            rets = np.diff(np.log(prices))
            attrs["ret_1d"] = float(rets[-1]) if len(rets) >= 1 else None
            attrs["ret_5d"] = float(np.sum(rets[-5:])) if len(rets) >= 5 else None
            if len(rets) >= 20:
                attrs["vol_20d"] = float(rets[-20:].std())


# ── GX-3.4：moomoo F10 财报数据面（SourceAdapter + Injector + EdgeBuilder） ──
# F10 标的为美股（AAPL/MSFT/NVDA/TSLA/SPY），与 crypto 图宇宙并集；
# FinancialsAdapter 归一化结果经 meta["financials"] 供属性注入/事件边/相似边复用。

# moomoo F10 items 关键指标 → 财务结构特征（显示名模糊匹配，中文/英文均可）
_FIN_METRIC_KEYS: dict[str, tuple[str, ...]] = {
    "roe": ("roe", "净资产收益率", "return on equity", "权益净利率"),
    "gross_margin": ("毛利率", "gross margin", "gross_margin", "销售毛利率"),
    "debt_ratio": ("资产负债率", "负债率", "debt", "liabilities ratio"),
    "revenue": ("营业总收入", "营业收入", "revenue", "total revenue", "operating revenue"),
    "net_income": ("净利润", "net income", "net_income", "归母净利润"),
    "total_assets": ("总资产", "total assets"),
    "total_liab": ("总负债", "total liabilities"),
    "equity": ("股东权益", "equity", "总权益", "净资产"),
}

# 链名 → 生态资产（curated，链-资产关系边，仅当两端都在图中时建边，GX-3.5.4）
_CHAIN_ASSET_MAP: dict[str, list[str]] = {
    "Ethereum": ["ETH"], "Solana": ["SOL"],
    "BSC": ["BNB"], "BNB Chain": ["BNB"],
    "Arbitrum": ["ARB"], "Optimism": ["OP"],
    "Polygon": ["MATIC", "POL"], "Avalanche": ["AVAX"],
    "Tron": ["TRX"], "Sui": ["SUI"], "Aptos": ["APT"],
    "Bitcoin": ["BTC"],
}


def _fin_metric_value(items: dict, metric: str) -> float | None:
    """按显示名模糊匹配 items 中的数值字段（支持中文/英文名，含子串匹配）。

    仅取数值项；匹配不到返回 None（fail-silent，缺字段不影响整体）。
    """
    keys = _FIN_METRIC_KEYS.get(metric, ())
    if not keys or not isinstance(items, dict):
        return None
    for k, v in items.items():
        if not isinstance(v, (int, float)):
            continue
        nk = str(k).lower().replace(" ", "")
        for kw in keys:
            nkw = kw.lower().replace(" ", "")
            if nkw == nk or nkw in nk or nk in nkw:
                return float(v)
    return None


def _pick_named(d: dict, keys: tuple[str, ...]) -> Any:
    """从 dict 中按名称（前缀匹配，支持中文/英文键）取第一个非空值。"""
    if not isinstance(d, dict):
        return None
    for k, v in d.items():
        if v is None:
            continue
        nk = str(k).lower().replace(" ", "").replace("_", "")
        for key in keys:
            nkey = key.lower().replace(" ", "").replace("_", "")
            if nkey == nk or nk.startswith(nkey):
                return v
    return None


def _normalize_f10_entry(entry: dict) -> dict | None:
    """moomoo F10 快照 → 规范化财务结构（items/metrics/report_period 等）。

    entry 形如 {"symbol", "code", "financials": [最新报告], "analyst_consensus",
    "valuation"}；无任何可用数据返回 None（fail-silent）。
    """
    if not isinstance(entry, dict):
        return None
    financials = entry.get("financials") or []
    latest: dict = {}
    if isinstance(financials, list):
        for rep in financials:
            if isinstance(rep, dict) and (rep.get("items") or rep.get("_financial_type")):
                latest = rep
                break
    items = latest.get("items") if isinstance(latest.get("items"), dict) else {}
    # 报告期（moomoo report_list 的 period 元信息，键名不定，模糊匹配）
    report_period = ""
    for k, v in latest.items():
        if k in ("items", "structure_list", "item_list", "_financial_type") or v is None:
            continue
        if any(t in str(k).lower() for t in ("period", "report_date", "date", "start", "end")):
            report_period = str(v)
            break
    # 财务结构比率：优先 items 直接字段，缺失用派生公式（ROE=净利/权益、负债率=负债/总资产）
    metrics: dict[str, float] = {}
    roe = _fin_metric_value(items, "roe")
    if roe is None:
        ni = _fin_metric_value(items, "net_income")
        eq = _fin_metric_value(items, "equity")
        if ni is not None and eq:
            roe = ni / eq
    if roe is not None:
        metrics["roe"] = roe
    gm = _fin_metric_value(items, "gross_margin")
    if gm is not None:
        metrics["gross_margin"] = gm
    dr = _fin_metric_value(items, "debt_ratio")
    if dr is None:
        ta = _fin_metric_value(items, "total_assets")
        tl = _fin_metric_value(items, "total_liab")
        if ta and tl:
            dr = tl / ta
    if dr is not None:
        metrics["debt_ratio"] = dr
    rev = _fin_metric_value(items, "revenue")
    if rev is not None:
        metrics["revenue"] = rev
    if not items and not metrics and not entry.get("valuation") and not entry.get("analyst_consensus"):
        return None
    return {
        "symbol": str(entry.get("symbol") or ""),
        "financial_type": latest.get("_financial_type") or "",
        "report_period": report_period,
        "items": items,
        "metrics": metrics,
        "valuation": entry.get("valuation") or [],
        "consensus": entry.get("analyst_consensus") or {},
    }


class FinancialsAdapter(SourceAdapter):
    """moomoo F10 财报数据面（GX-3.4.1）：/snapshots?provider=moomoo_f10 → 美股节点。

    只产生节点（financial_type/报告期关键字段），详细指标走 meta["financials"]
    供属性注入/事件边/相似边复用；F10 标的与 crypto 图宇宙并集（attr 级合并去重），
    数据缺失 fail-silent（返回 None 不参与构图）。
    """

    name = "financials"

    def fetch(self) -> GraphSourceData | None:
        payload = data_client.fetch_moomoo_f10()
        fin_by_sym = (payload or {}).get("mm_f10") or {}
        if not isinstance(fin_by_sym, dict) or not fin_by_sym:
            return None
        data = GraphSourceData()
        financials: dict[str, dict] = {}
        for raw_sym, entry in fin_by_sym.items():
            norm = _normalize_f10_entry(entry)
            if norm is None:
                continue
            sym = _norm_symbol(norm["symbol"] or str(raw_sym))
            if not sym:
                continue
            data.nodes[sym] = {
                "financial_type": norm["financial_type"],
                "fin_report_period": norm["report_period"] or None,
            }
            financials[sym] = norm
        if not data.nodes:
            return None
        data.meta = {"financials": financials}
        return data


class FinancialsAttributeInjector(AttributeInjector):
    """财报/估值/一致预期 → 节点属性（GX-3.4.2，不建边）。

    读取 FinancialsAdapter 归一化结果（ctx["meta"]["financials"]），把财务结构
    比率/估值/目标价等挂为 fin_* 节点属性（features JSON 字段）。
    """

    name = "financials_attrs"

    def inject(self, ctx: dict[str, Any], nodes: dict[str, dict]) -> None:
        financials = ctx.get("meta", {}).get("financials", {})
        for sym, attrs in nodes.items():
            norm = financials.get(sym)
            if not norm:
                continue
            items = norm.get("items") or {}
            metrics = norm.get("metrics") or {}
            fin: dict[str, Any] = {}
            # 财务结构比率（优先已计算 metrics，缺失回退 items 直接字段）
            for metric in ("roe", "gross_margin", "debt_ratio"):
                val = metrics.get(metric)
                if val is None:
                    val = _fin_metric_value(items, metric)
                if val is not None:
                    fin[f"fin_{metric}"] = _r(val, 4)
            rev = metrics.get("revenue")
            if rev is None:
                rev = _fin_metric_value(items, "revenue")
            if rev is not None:
                fin["fin_revenue"] = _r(rev)
            ni = _fin_metric_value(items, "net_income")
            if ni is not None:
                fin["fin_net_income"] = _r(ni)
            # 估值（valuation 列表取最新条目的 PE/PB）
            valuation = norm.get("valuation") or []
            if isinstance(valuation, list) and valuation and isinstance(valuation[0], dict):
                for field, keys in (("fin_pe", ("pe", "pe_ttm", "市盈率")),
                                    ("fin_pb", ("pb", "市净率"))):
                    v = _pick_named(valuation[0], keys)
                    if v is not None:
                        fin[field] = _r(v, 4)
            # 一致预期（目标价/评级）
            consensus = norm.get("consensus") or {}
            if isinstance(consensus, dict):
                v = _pick_named(consensus, ("target_price", "targetprice", "目标价", "price_target"))
                if v is not None:
                    fin["fin_target_price"] = _r(v, 4)
                v = _pick_named(consensus, ("rating", "评级", "recommend"))
                if v is not None:
                    fin["fin_consensus_rating"] = v
            if norm.get("report_period"):
                fin["fin_report_period"] = norm["report_period"]
            attrs.update(fin)


class EarningsEventEdgeBuilder(EdgeBuilder):
    """财报事件边（GX-3.4.3）：有财报期数据的标的 → 标的事件自环边。

    财报期（report 时间）标记在标的上（kind="earnings_event"，u==v 自环，
    attrs 带 report_period），仅当标的在图内才建边；权重 _EDGE_WEIGHT_EARNINGS。
    """

    name = "earnings_event"

    def build(self, ctx: dict[str, Any]) -> list[GEdge]:
        nodes = ctx.get("nodes", {})
        financials = ctx.get("meta", {}).get("financials", {})
        edges: list[GEdge] = []
        for sym, norm in financials.items():
            if sym not in nodes or not norm.get("report_period"):
                continue
            edges.append(GEdge(
                sym, sym, "earnings_event",
                weight=_EDGE_WEIGHT_EARNINGS,
                attrs={"report_period": norm["report_period"]},
            ))
        return edges


class FinancialSimilarityEdgeBuilder(EdgeBuilder):
    """基本面相似边（GX-3.4.4）：财务结构特征向量余弦相似 ≥ 阈值建边。

    特征 = ROE/毛利率/资产负债率/营收（可用字段，跨标的并集；缺失列均值填充
    后逐维 min-max 归一化），可用特征维 ≥ _FIN_SIM_MIN_FEATURES 才计算；
    weight=余弦相似度（对齐 corr 边 weight=|ρ| 的模式），并入图层权重合并。
    """

    name = "financial_similarity"

    def build(self, ctx: dict[str, Any]) -> list[GEdge]:
        nodes = ctx.get("nodes", {})
        financials = ctx.get("meta", {}).get("financials", {})
        syms = [s for s in financials if s in nodes]
        if len(syms) < 2:
            return []
        # 特征列：跨标的并集（metrics 仅含 roe/gross_margin/debt_ratio/revenue）
        feat_order: list[str] = []
        for sym in syms:
            for f in (financials[sym].get("metrics") or {}):
                if f not in feat_order:
                    feat_order.append(f)
        if len(feat_order) < _FIN_SIM_MIN_FEATURES:
            return []
        X = np.full((len(syms), len(feat_order)), np.nan)
        for i, sym in enumerate(syms):
            m = financials[sym].get("metrics") or {}
            for j, f in enumerate(feat_order):
                v = m.get(f)
                if v is not None and math.isfinite(float(v)):
                    X[i, j] = float(v)
        # 每列至少 2 个非空值才作为特征维（不足的列剔除）
        keep = [j for j in range(X.shape[1]) if np.isfinite(X[:, j]).sum() >= 2]
        if len(keep) < _FIN_SIM_MIN_FEATURES:
            return []
        X = X[:, keep]
        # 缺失列均值填充 → 逐维 min-max 归一化 → 余弦相似度
        for j in range(X.shape[1]):
            col = X[:, j]
            mean = float(np.nanmean(col))
            col[np.isnan(col)] = mean
            lo, hi = float(col.min()), float(col.max())
            if hi - lo > 1e-12:
                X[:, j] = (X[:, j] - lo) / (hi - lo)
            else:
                X[:, j] = 0.0
        edges: list[GEdge] = []
        for i in range(len(syms)):
            for j in range(i + 1, len(syms)):
                a, b = X[i], X[j]
                denom = float(np.linalg.norm(a) * np.linalg.norm(b))
                if denom < 1e-12:
                    continue
                sim = float(np.dot(a, b) / denom)
                if sim >= _FIN_SIM_THRESHOLD:
                    edges.append(GEdge(syms[i], syms[j], "financial_similarity",
                                       weight=round(sim, 4)))
        return edges


# ── GX-3.5：扩展数据面（卖空/资金流、资金费率、链上 DeFi TVL） ──

class MoomooShortAttributeInjector(AttributeInjector):
    """moomoo 卖空/资金流 → F10 标的节点属性（GX-3.5.2，不建边）。

    读 /snapshots?provider=moomoo_f10 的 mm_short_capital（short_interest /
    daily_short_volume / capital_flow，按标的落库），挂 short_*/main_flow 属性；
    数据缺失 fail-silent。
    """

    name = "short_capital"

    def inject(self, ctx: dict[str, Any], nodes: dict[str, dict]) -> None:
        payload = data_client.fetch_moomoo_f10()
        short_by_sym = (payload or {}).get("mm_short_capital") or {}
        if not isinstance(short_by_sym, dict):
            return
        for sym, entry in short_by_sym.items():
            if sym not in nodes or not isinstance(entry, dict):
                continue
            fin: dict[str, Any] = {}
            si = entry.get("short_interest") or []
            if isinstance(si, list) and si and isinstance(si[0], dict):
                latest = si[0]
                v = _pick_named(latest, ("short_percent", "卖空占比"))
                if v is not None:
                    fin["short_pct"] = _r(v, 4)
                v = _pick_named(latest, ("shares_short", "卖空股数"))
                if v is not None:
                    fin["short_shares"] = _r(v)
                v = _pick_named(latest, ("days_to_cover", "回补天数"))
                if v is not None:
                    fin["days_to_cover"] = _r(v, 4)
            if "short_pct" not in fin:
                dv = entry.get("daily_short_volume") or []
                if isinstance(dv, list) and dv and isinstance(dv[0], dict):
                    v = _pick_named(dv[0], ("short_percent",))
                    if v is not None:
                        fin["short_pct"] = _r(v, 4)
            cf = entry.get("capital_flow") or []
            if isinstance(cf, list) and cf and isinstance(cf[-1], dict):
                latest = cf[-1]  # 时间升序，取最新
                v = _pick_named(latest, ("main_in_flow", "主力净流入"))
                if v is not None:
                    fin["main_flow"] = _r(v)
                v = _pick_named(latest, ("super_in_flow", "超大单净流入"))
                if v is not None:
                    fin["super_flow"] = _r(v)
            if fin:
                nodes[sym].update(fin)


class FundingRateInjector(AttributeInjector):
    """衍生品资金费率数据面（GX-3.5.3）：db_cache crypto_factors → crypto 节点属性。

    经 /factors/crypto-derivatives 读取 funding_rate/open_interest/
    open_interest_change_24h/long_short_ratio（Coinglass 主源 + Binance 兜底，
    ttl 300s），注入对应 crypto 节点（与 heatmap 标的重合），不建边、fail-silent。
    """

    name = "funding_rate"

    def inject(self, ctx: dict[str, Any], nodes: dict[str, dict]) -> None:
        if not nodes:
            return
        factors = data_client.fetch_crypto_derivatives(list(nodes))
        if not isinstance(factors, dict) or not factors:
            return
        for sym, f in factors.items():
            if sym not in nodes or not isinstance(f, dict):
                continue
            fin: dict[str, Any] = {}
            for field in ("funding_rate", "open_interest", "open_interest_change_24h", "long_short_ratio"):
                v = f.get(field)
                if v is not None:
                    fin[field] = _r(v, 6)
            if fin:
                nodes[sym].update(fin)


class DefiTvlAdapter(SourceAdapter):
    """链上 DeFi TVL 数据面（GX-3.5.4）：/snapshots?type=tvl → 链节点。

    链名节点（Ethereum/Solana/...）与 crypto 资产节点空间共存（无 market_cap
    不参与宇宙截断，经 chain_asset 关系边入图）；属性含 tvl/change_24h/
    dominance；数据缺失 fail-silent（返回 None）。
    """

    name = "defi_tvl"

    def fetch(self) -> GraphSourceData | None:
        chains = data_client.fetch_defi_tvl()
        if not chains:
            return None
        data = GraphSourceData()
        for row in chains:
            if not isinstance(row, dict):
                continue
            name = str(row.get("chain") or "").strip()
            if not name:
                continue
            tvl = _safe_float(row.get("tvl"))
            change_24h = _safe_float(
                row.get("change_1d") if row.get("change_1d") is not None else row.get("change_24h")
            )
            dominance = _safe_float(row.get("dominance"))
            attrs: dict[str, Any] = {"node_type": "chain"}
            if tvl is not None:
                attrs["tvl"] = tvl
            if change_24h is not None:
                attrs["chain_change_24h"] = change_24h
            if dominance is not None:
                attrs["chain_dominance"] = dominance
            data.nodes[name] = attrs
        # 链-资产关系边（curated，仅当两端节点都在图中时建边）
        for chain, assets in _CHAIN_ASSET_MAP.items():
            if chain not in data.nodes:
                continue
            for asset in assets:
                if asset != chain:
                    data.edges.append(GEdge(chain, asset, "chain_asset",
                                            weight=_EDGE_WEIGHT_CHAIN_ASSET))
        if not data.nodes:
            return None
        return data


# ── 注册内置实现 ───────────────────────────────────────────

register_source_adapter(HeatmapAdapter())
register_source_adapter(FinancialsAdapter())
register_source_adapter(DefiTvlAdapter())
register_edge_builder(IndustryEdgeBuilder())
register_edge_builder(SupplyChainEdgeBuilder())
register_edge_builder(CorrelationEdgeBuilder())
register_edge_builder(EarningsEventEdgeBuilder())
register_edge_builder(FinancialSimilarityEdgeBuilder())
register_attribute_injector(BarsAttributeInjector())
register_attribute_injector(FinancialsAttributeInjector())
register_attribute_injector(MoomooShortAttributeInjector())
register_attribute_injector(FundingRateInjector())


# ── 工具 ───────────────────────────────────────────────────

_CRYPTO_QUOTES = ("USDT", "USDC", "BUSD", "FDUSD", "TUSD", "DAI", "BTC", "ETH")


def _norm_symbol(symbol: str) -> str:
    """符号归一化：BTC/USDT、BTCUSDT、BTC-USD、btc → BTC；非 crypto 仅大写。"""
    s = (symbol or "").strip().upper()
    if "/" in s:
        s = s.split("/", 1)[0]
    elif ":" in s:
        s = s.split(":", 1)[0]
    for q in _CRYPTO_QUOTES:
        if s.endswith(q) and len(s) > len(q):
            s = s[: -len(q)]
            break
    if "-" in s:
        s = s.split("-", 1)[0]
    return s


def _safe_float(v) -> float | None:
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _r(v, nd: int = 6) -> float | None:
    """可空浮点圆整（None 原样返回）。"""
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(f):
        return None
    return round(f, nd)


def _fetch_bars_parallel(symbols: list[str]) -> dict[str, list[dict]]:
    """并行拉取各标的日线（fail-silent：失败标的直接缺失）。

    GP-3：300s 结果缓存按标的集合键控复用——universe 在快照新鲜窗口内稳定，
    避免每次全量构建重复拉取全市场日线。
    """
    from concurrent.futures import ThreadPoolExecutor

    global _BARS_CACHE
    cache_key = "|".join(sorted(symbols)) if symbols else ""
    now = time.time()
    if (cache_key and _BARS_CACHE.get("key") == cache_key
            and now - _BARS_CACHE.get("ts", 0) < _BARS_CACHE_TTL_S):
        return _BARS_CACHE.get("data", {})

    out: dict[str, list[dict]] = {}

    def _one(sym: str):
        rows = data_client.fetch_bars(sym, timeframe="1d", limit=_BARS_LIMIT)
        # data-service 对 crypto 裸对（BTC）返回 0 根，需补 /USDT 交易对形式
        if not rows and "/" not in sym:
            rows = data_client.fetch_bars(f"{sym}/USDT", timeframe="1d", limit=_BARS_LIMIT)
        if rows:
            out[sym] = rows

    try:
        with ThreadPoolExecutor(max_workers=_BARS_WORKERS) as pool:
            list(pool.map(_one, symbols))
    except Exception as exc:
        logger.debug("parallel bars fetch failed: %s", exc)
    if cache_key:
        _BARS_CACHE = {"key": cache_key, "ts": time.time(), "data": out}
    return out


def _returns_frames(bars_by_sym: dict[str, list[dict]]) -> dict[str, tuple[np.ndarray, list[int]]]:
    """bars → {sym: (对数收益数组, 对齐 ts)}，过滤数据不足/异常标的。"""
    frames: dict[str, tuple[np.ndarray, list[int]]] = {}
    for sym, rows in bars_by_sym.items():
        rows = sorted(rows, key=lambda r: r.get("ts", 0))
        if len(rows) < _CORR_MIN_OVERLAP + 2:
            continue
        ts = [int(r.get("ts", 0)) for r in rows]
        prices = np.array([float(r.get("close") or 0.0) for r in rows])
        if np.any(prices <= 0):
            continue
        rets = np.diff(np.log(prices))
        if not np.all(np.isfinite(rets)):
            continue
        frames[sym] = (rets, ts[1:])
    return frames


def _community_labels(G: nx.Graph) -> dict[str, int]:
    """标签传播社区检测（Louvain 类，确定性：节点序 + 平局取小 id）。"""
    nodes = list(G.nodes())
    labels: dict[str, int] = {n: i for i, n in enumerate(nodes)}
    for _ in range(30):
        changed = False
        for n in nodes:
            cnt: dict[int, int] = {}
            for nb in G.neighbors(n):
                cnt[labels[nb]] = cnt.get(labels[nb], 0) + 1
            if not cnt:
                continue
            new = max(cnt, key=lambda k: (cnt[k], -k))
            if new != labels[n]:
                labels[n] = new
                changed = True
        if not changed:
            break
    # 按社区大小重编号（0..k-1），保证跨批次稳定性
    size = {}
    for lab in labels.values():
        size[lab] = size.get(lab, 0) + 1
    order = sorted(size, key=lambda k: (-size[k], k))
    remap = {old: i for i, old in enumerate(order)}
    return {n: remap[l] for n, l in labels.items()}


def _graph_embedding(G: nx.Graph, dims: int = _NODE2VEC_DIMS) -> dict[str, list[float]]:
    """对称归一化邻接的谱嵌入（类 Node2Vec 的低维表示，确定性 SVD）。

    取前 dims 个非平凡右奇异向量 × sqrt(奇异值)；孤立节点为全 0 向量。
    """
    nodes = list(G.nodes())
    n = len(nodes)
    if n < 2:
        return {}
    idx = {s: i for i, s in enumerate(nodes)}
    A = np.zeros((n, n))
    for u, v, d in G.edges(data=True):
        i, j = idx[u], idx[v]
        w = float(d.get("weight", 1.0))
        if w > 0:
            A[i, j] += w
            A[j, i] += w
    deg = A.sum(axis=1)
    dinv = np.where(deg > 1e-12, 1.0 / np.sqrt(np.maximum(deg, 1e-12)), 0.0)
    A_n = A * dinv[:, None] * dinv[None, :]
    try:
        U, S, _ = np.linalg.svd(A_n)
        k = min(dims, n - 1)
        cols = [U[:, d] * math.sqrt(max(S[d], 0.0)) for d in range(1, k + 1)]
        E = np.column_stack(cols) if cols else np.zeros((n, 0))
    except Exception as exc:
        logger.debug("graph embedding SVD failed: %s", exc)
        return {}
    return {s: [float(x) for x in E[i]] for i, s in enumerate(nodes)}


# ── 全图构建 ───────────────────────────────────────────────

# 最近一次成功构建的图快照（供 /ml/graph/edges 数据面复用，保证与 gf_* 完全同口径；
# REQ-G1：相关性图边表 nodes(community/pagerank/size) + edges(corr/weight)）
_LAST_GRAPH: dict | None = None

# 图快照新鲜窗口（秒，GP-1/GP-3）：窗口内复用 _LAST_GRAPH，避免 graph_factors /
# graph_edges / 预热线程在同一窗口内重复全量构建（构建含 bars 拉取 + 全市场相关性）。
_GRAPH_SNAPSHOT_TTL_S = float(os.getenv("ML_GRAPH_SNAPSHOT_TTL_S", "1800"))

# bars 拉取结果缓存（秒，GP-3：全市场日线每次构建重复拉取，300s 按标的集合键控复用）
_BARS_CACHE: dict = {}
_BARS_CACHE_TTL_S = float(os.getenv("ML_GRAPH_BARS_CACHE_TTL_S", "300"))


def _build_graph() -> dict | None:
    """组装全市场图并计算 18 个图因子（后台线程重算，结果由调用方缓存）。

    返回 {"updated_at": ms, "values": {sym: {gf_*: value}}}；任一步骤失败/无节点
    返回 None（fail-silent）。
    """
    global _LAST_GRAPH
    # 快照新鲜检查（GP-1/GP-3）：_LAST_GRAPH 在新鲜窗口内直接复用，多入口
    # （graph_factors / graph_edges / 预热）共享一次构建结果，不重复全量构建。
    if _LAST_GRAPH is not None and _LAST_GRAPH.get("values"):
        age_ms = int(time.time() * 1000) - _LAST_GRAPH["updated_at"]
        if 0 <= age_ms < _GRAPH_SNAPSHOT_TTL_S * 1000:
            return {"updated_at": _LAST_GRAPH["updated_at"], "values": _LAST_GRAPH["values"]}
    ctx: dict[str, Any] = {"nodes": {}, "edges": [], "bars": {}, "returns": {}, "meta": {}}

    # 1) Source Adapter：heatmap 数据面 → 节点
    for adapter in SOURCE_ADAPTERS.values():
        try:
            data = adapter.fetch()
            if data:
                ctx["nodes"].update(data.nodes)
                ctx["edges"].extend(data.edges)
                ctx["meta"].update(data.meta or {})
        except Exception as exc:
            logger.debug("source adapter %s failed: %s", adapter.name, exc)
    if not ctx["nodes"]:
        return None

    # 市值降序截断宇宙，控制 bars 拉取量
    universe = sorted(
        ctx["nodes"],
        key=lambda s: -(ctx["nodes"][s].get("market_cap") or 0.0),
    )[:_UNIVERSE_CAP]

    # 2) /bars 拉取 → 收益矩阵（相关性边 + 行情属性注入的输入）
    ctx["bars"] = _fetch_bars_parallel(universe)
    ctx["returns"] = _returns_frames(ctx["bars"])

    # 3) Edge Builder：industry / supply_chain / corr 按图层合并
    for builder in EDGE_BUILDERS.values():
        try:
            ctx["edges"].extend(builder.build(ctx))
        except Exception as exc:
            logger.debug("edge builder %s failed: %s", builder.name, exc)

    # 4) Attribute Injector：行情属性注入节点
    for injector in ATTRIBUTE_INJECTORS.values():
        try:
            injector.inject(ctx, ctx["nodes"])
        except Exception as exc:
            logger.debug("attribute injector %s failed: %s", injector.name, exc)

    # 5) networkx 构图（平行边保留：同对多类边 = 关联更强）
    G = nx.MultiGraph()
    G.add_nodes_from(universe)
    for e in ctx["edges"]:
        if e.u in ctx["nodes"] and e.v in ctx["nodes"] and e.weight > 0:
            G.add_edge(e.u, e.v, key=e.kind, kind=e.kind, weight=e.weight, **e.attrs)

    if G.number_of_nodes() < 2:
        return None

    # 6) 结构量一次计算全图
    try:
        degree = dict(G.degree())
        betweenness = nx.betweenness_centrality(G, weight="weight", normalized=True)
        pagerank = nx.pagerank(G, weight="weight")
        try:
            constraint = nx.constraint(G, nodes=universe, weight="weight")
        except Exception:
            constraint = {s: 1.0 for s in universe}
        community = _community_labels(G)
        embedding = _graph_embedding(G)
    except Exception as exc:
        logger.warning("graph structural compute failed: %s", exc)
        return None

    n_nodes = max(G.number_of_nodes() - 1, 1)
    values: dict[str, dict] = {}
    for sym in universe:
        attrs = ctx["nodes"][sym]
        f: dict[str, Any] = {
            "gf_degree": degree.get(sym, 0) / n_nodes,
            "gf_betweenness": _r(betweenness.get(sym)),
            "gf_pagerank": _r(pagerank.get(sym)),
            "gf_community": community.get(sym),
            "gf_structural_hole": _r(constraint.get(sym)),
        }
        # 邻居聚合（权重 = 边图层权重合并）
        nmom, nvol, nw = 0.0, 0.0, 0.0
        cc_num, cc_den = 0.0, 0.0
        for nb, edge_data in G[sym].items():
            w = sum(d.get("weight", 1.0) for d in edge_data.values())
            rho = next((d.get("rho") for d in edge_data.values() if "rho" in d), None)
            nb_ret = ctx["nodes"].get(nb, {}).get("ret_1d")
            nb_vol = ctx["nodes"].get(nb, {}).get("vol_20d")
            if nb_ret is not None:
                nmom += w * nb_ret
                nw += w
            if nb_vol is not None:
                nvol += w * nb_vol
            if rho is not None and nb_ret is not None:
                cc_num += rho * nb_ret
                cc_den += abs(rho)
        if nw > 0:
            f["gf_neighbor_mom"] = _r(nmom / nw)
        if nw > 0:
            f["gf_neighbor_vol"] = _r(nvol / nw)
        if cc_den > 0:
            f["gf_cc_spillover"] = _r(cc_num / cc_den)

        # 板块动量 / 社区动量（排除自身）
        sector = attrs.get("sector")
        if sector and sector not in ("TopCap", "Other"):
            peers = [s for s in universe if s != sym and ctx["nodes"][s].get("sector") == sector]
            rets = [ctx["nodes"][s].get("ret_1d") for s in peers if ctx["nodes"][s].get("ret_1d") is not None]
            if rets:
                f["gf_sector_mom"] = _r(float(np.mean(rets)))
        my_com = community.get(sym)
        if my_com is not None:
            c_peers = [s for s in universe if s != sym and community.get(s) == my_com]
            c_rets = [ctx["nodes"][s].get("ret_1d") for s in c_peers
                      if ctx["nodes"][s].get("ret_1d") is not None]
            if c_rets:
                f["gf_community_mom"] = _r(float(np.mean(c_rets)))

        # 图嵌入维度（孤立节点全 0）
        emb = embedding.get(sym)
        if emb:
            for d, val in enumerate(emb, start=1):
                f[f"gf_node2vec_{d}"] = _r(val, 8)

        # 至少要有结构因子才入列
        if any(v is not None for v in f.values()):
            values[sym] = f

    if not values:
        return None
    # 缓存图快照（REQ-G1 边表数据面复用；仅成功构建后更新，引用赋值原子）
    _LAST_GRAPH = {
        "G": G,
        "universe": universe,
        "community": community,
        "pagerank": pagerank,
        "ctx": ctx,
        "values": values,
        "updated_at": int(time.time() * 1000),
    }
    logger.info(
        "graph built: nodes=%d edges=%d sectors=%s communities=%d values=%d",
        G.number_of_nodes(), G.number_of_edges(),
        len({a.get("sector") for a in ctx["nodes"].values() if a.get("sector")}),
        len(set(community.values())), len(values),
    )
    return {"updated_at": int(time.time() * 1000), "values": values}


def compute_graph_payload() -> dict | None:
    """全市场图谱因子 payload（main.py _async_runner 缓存入口）。

    返回 {"updated_at": ms, "values": {sym: {gf_*}}} 或 None（依赖缺失/构建失败，
    fail-silent，不产生模拟数据）。
    """
    if not _NX_OK:
        logger.debug("graph engine unavailable: networkx missing")
        return None
    return _build_graph()


def compute_graph_edges_payload(
    symbols: list[str] | None = None,
    window: int = 60,
    min_abs_corr: float = 0.6,
    limit: int = 300,
) -> dict | None:
    """相关性图边数据面（REQ-G1：/ml/graph/edges → data-service /factors/graph/edges）。

    复用最近一次成功构建的图快照（_LAST_GRAPH），保证 nodes 的 community/pagerank
    与 gf_community / gf_pagerank **完全同口径**（同一图、同一计算），
    不做另起炉灶的重算。

    返回 {"updated_at", "window", "min_abs_corr", "nodes": [{id,symbol,community,pagerank,size}],
          "edges": [{source,target,corr,abs_corr,weight,kind}]}；快照未就绪返回 None。
    edges 仅含真实相关性边（kind=corr，corr=带符号 ρ）；非 corr 图层边不进入本数据面
    （REQ-G9：杜绝把图层权重伪装成相关系数）。window/min_abs_corr 为契约兼容参数
    （当前图按 GX-2 固定窗口/阈值构建，仅记录进 meta）。
    """
    if not _NX_OK or not _LAST_GRAPH:
        logger.debug("graph edges unavailable: no graph snapshot yet")
        return None
    G = _LAST_GRAPH["G"]
    universe = _LAST_GRAPH["universe"]
    community = _LAST_GRAPH["community"]
    pagerank = _LAST_GRAPH["pagerank"]

    # nodes：全图（size = pagerank 归一化 ×100，与需求对齐）
    nodes: list[dict] = []
    for sym in universe:
        pr = float(pagerank.get(sym) or 0.0)
        nodes.append({
            "id": sym,
            "symbol": sym,
            "community": community.get(sym),
            "pagerank": _r(pr),
            "size": _r(pr * 100, 1),
        })

    # edges：仅输出真实相关性边（REQ-G9——非 corr 图层边不再伪装成 corr=1.0）。
    # corr 带符号 ρ∈[-1,1]；abs_corr=|ρ|；weight=|ρ|（前端线宽归一化 / 正负着色输入）。
    edges: list[dict] = []
    for u, v, key, d in G.edges(data=True, keys=True):
        if u not in universe or v not in universe:
            continue
        rho = d.get("rho")
        if rho is None:
            continue  # industry/supply_chain 等非相关边不进入相关性边数据面
        rho = float(rho)
        edges.append({
            "source": u,
            "target": v,
            "corr": _r(rho),
            "abs_corr": _r(abs(rho)),
            "weight": _r(abs(rho)),
            "kind": d.get("kind", key),
        })

    # 按 abs_corr 降序（可视化优先级：强相关在前）
    edges.sort(key=lambda e: e["abs_corr"] or 0.0, reverse=True)

    payload = {
        "updated_at": _LAST_GRAPH["updated_at"],
        "window": window,
        "min_abs_corr": min_abs_corr,
        "nodes": nodes,
        "edges": edges,
    }
    # symbols（1-hop）与 limit 裁剪由端点侧按请求参数执行（全图缓存复用）
    return filter_graph_edges_payload(payload, symbols=symbols, limit=limit)


def filter_graph_edges_payload(
    payload: dict,
    symbols: list[str] | None = None,
    limit: int = 300,
) -> dict:
    """按请求 symbols（目标节点 1-hop 邻边）与 limit 裁剪全图边表 payload。

    GP-1：/ml/graph/edges 缓存全图边表（TTL 1800s），不同 symbols/limit 请求
    从全图裁剪，避免逐参数缓存。空 symbols 仅按 limit 截断（强相关在前）。
    """
    nodes = list(payload.get("nodes", []))
    edges = list(payload.get("edges", []))
    if symbols:
        node_ids = {nd["id"] for nd in nodes}
        keep: set[str] = set()
        for s in symbols:
            n = _norm_symbol(s) if s in node_ids else s
            keep.add(n)
        edge_keep = [e for e in edges if e["source"] in keep or e["target"] in keep]
        if edge_keep:
            edges = edge_keep
            edge_ids = {e["source"] for e in edges} | {e["target"] for e in edges}
            nodes = [n for n in nodes if n["id"] in edge_ids or n["id"] in keep]
    if limit and limit > 0:
        edges = edges[:limit]
    return {**payload, "nodes": nodes, "edges": edges}