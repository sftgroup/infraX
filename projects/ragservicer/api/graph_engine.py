"""
Graph data loader — reads LightRAG on-disk storage files directly.

Serves the GF-5 graph-visualization endpoint (`GET /api/v1/graph/entities`):
ECharts force-directed graph data (nodes + edges), built without touching a
LightRAG instance.

Files are read from the per-(tenant, namespace) storage directory
`{working_dir}/{tenant}/{namespace}/`:
  - graph_chunk_entity_relation.graphml  → topology + entity/relation attrs
  - kv_store_full_entities.json          → entity details (entity_type/description)
  - kv_store_full_relations.json         → relation details (weight/keywords)

All loaders use a module-level cache keyed by (tenant_id, namespace); only
successful loads are cached so a graph created after the first request is
picked up on the next call.
"""
import ast
import json
import logging
import os
import re
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

import networkx as nx

from config import get_config

logger = logging.getLogger("ragservicer.graph_engine")

GRAPHML_FILE = "graph_chunk_entity_relation.graphml"
ENTITIES_FILE = "kv_store_full_entities.json"
RELATIONS_FILE = "kv_store_full_relations.json"

DEFAULT_LIMIT = 200

# ── node category 映射（9 枚举；顺序即匹配优先级，首个命中生效）──
_CATEGORY_RULES = [
    (("央行", "美联储", "ecb"), "central_bank"),
    (("交易所", "binance", "coinbase", "okx"), "exchange"),
    (("etf", "基金", "机构", "贝莱德", "blackrock"), "fund"),
    (("矿工", "鲸鱼", "whale", "miner"), "whale"),
    (("项目", "协议", "链", "project", "protocol", "chain"), "project"),
    (("媒体", "news", "彭博", "bloomberg", "报道"), "media"),
    (("政策", "监管", "法规", "policy", "regulation", "sec"), "policy"),
    (("会议", "公告", "事件", "降息", "加息", "meeting", "event"), "event"),
]
_DEFAULT_CATEGORY = "asset"

# ── REQ-G8：中文实体英文名（预存映射表 + 值后缀降级）──────
_NAME_EN_FILE = "entity_name_en.json"
_name_en_map: dict[str, str] = {}
_name_en_loaded = False
# 尾部数值/百分比/金额/篇数等值后缀（剥离后回查核心词，如 机会评分48/100）
_VALUE_SUFFIX_RE = re.compile(
    r"(?:[+\-]?\d[\d,]*(?:\.\d+)?%?|(?:\d+/\d+)|(?:\d[\d,.]*美元)|\d+篇)$"
)

# ── edge relation 映射（8 枚举；顺序即匹配优先级，首个命中生效）──
_RELATION_RULES = [
    (("增持", "投资", "流入", "funding", "买入"), "funding"),
    (("托管", "custody"), "custody"),
    (("上架", "listing", "上线"), "listing"),
    (("鲸鱼", "转账", "whale_move", "转移"), "whale_move"),
    (("etf", "申购", "etf_flow"), "etf_flow"),
    (("监管", "政策", "regulation", "sec"), "regulation"),
    (("情绪", "sentiment"), "sentiment_correlate"),
    (("影响", "推动", "导致", "affects"), "affects"),
]
_DEFAULT_RELATION = "affects"

# ── sentiment 关键词打分（-1~1；无命中返回 null）──────────
_POSITIVE_WORDS = (
    "上涨", "利好", "增长", "突破", "看涨", "买入", "增持",
    "新高", "乐观", "获批", "approve", "bullish", "rise", "gain", "surge",
)
_NEGATIVE_WORDS = (
    "下跌", "利空", "暴跌", "看跌", "抛售", "卖出", "减持",
    "新低", "悲观", "拒绝", "否决", "bearish", "fall", "drop", "crash", "sell", "fear",
)

# ── 模块级缓存（SWR：只缓存成功加载 + TTL 过期后台重建，旧图始终可用）──
# R1（AITRADER_GRAPH_PERF_REQ）：实体/文档增量更新时保持旧图可用、后台重建 + 原子切换。
# 缓存值为 (ts, data)；TTL 内直接返回，过期返回旧值并起后台线程重建（防重入）。
_graph_cache: dict[tuple[str, str], tuple[float, Optional[nx.Graph]]] = {}
_entities_cache: dict[tuple[str, str], tuple[float, Optional[dict]]] = {}
_relations_cache: dict[tuple[str, str], tuple[float, Optional[dict]]] = {}

_GRAPH_CACHE_TTL_S = float(os.getenv("GRAPH_CACHE_TTL_S", "1800"))
_rebuild_keys: set[tuple[str, str]] = set()
_rebuild_lock = threading.Lock()


def _rebuild_async(key: tuple[str, str], cache: dict, loader) -> None:
    """TTL 过期后后台重建（防重入：同 key 已在重建则跳过），原子替换缓存。"""
    with _rebuild_lock:
        if key in _rebuild_keys:
            return
        _rebuild_keys.add(key)

    def _run():
        try:
            data = loader()
            if data is not None:
                cache[key] = (time.time(), data)
        except Exception:
            logger.exception("graph cache rebuild failed: %s", key)
        finally:
            with _rebuild_lock:
                _rebuild_keys.discard(key)

    threading.Thread(target=_run, name=f"graph-rebuild-{key[0]}-{key[1]}", daemon=True).start()


def _cache_get(key: tuple[str, str], cache: dict, loader, ttl: float):
    """SWR 读：命中新鲜返回；过期返回旧值 + 后台重建；未缓存则同步加载。"""
    entry = cache.get(key)
    if entry is not None:
        ts, data = entry
        if data is not None and time.time() - ts < ttl:
            return data
        # 过期：旧值立即可用（R1：保持旧图可用），后台重建 + 原子切换
        _rebuild_async(key, cache, loader)
        return data
    data = loader()
    if data is not None:
        cache[key] = (time.time(), data)
    return data


def graph_dir(tenant_id: str, namespace: str = "default") -> Path:
    """Per-(tenant, namespace) storage directory."""
    cfg = get_config()
    return Path(cfg.storage.working_dir) / tenant_id / namespace


def resolve_graph_dir(tenant_id: str, namespace: str = "default") -> Path:
    """图谱数据目录：租户目录缺 GraphML 时回退到 default（共享 market 数据面）。

    GF-3/GF-5 面向 LightRAG market 知识图谱；新签发 key（如 GF-6 AItrader）
    绑定独立 tenant 但尚无注入数据 → 回退 default，保证因子可读且不破坏
    tenant 鉴权隔离（仅影响只读图谱数据路径）。
    """
    primary = graph_dir(tenant_id, namespace)
    if tenant_id != "default" and not (primary / GRAPHML_FILE).exists():
        fallback = graph_dir("default", namespace)
        if (fallback / GRAPHML_FILE).exists():
            logger.info(
                "graph data fallback: %s/%s -> default/%s",
                tenant_id, namespace, namespace,
            )
            return fallback
    return primary


# ── Loaders（模块级缓存）──────────────────────────────────

def load_graphml(tenant_id: str, namespace: str = "default") -> Optional[nx.Graph]:
    """Load the entity-relation GraphML as a networkx Graph.

    SWR（R1）：TTL 内返回缓存；过期返回旧图 + 后台重建；返回 None when missing.
    """
    key = (tenant_id, namespace)

    def _load() -> Optional[nx.Graph]:
        path = resolve_graph_dir(tenant_id, namespace) / GRAPHML_FILE
        graph: Optional[nx.Graph] = None
        if path.exists():
            try:
                graph = nx.read_graphml(str(path))
            except Exception:
                logger.exception("Failed to read GraphML: %s", path)
        return graph

    return _cache_get(key, _graph_cache, _load, _GRAPH_CACHE_TTL_S)


def load_entities(tenant_id: str, namespace: str = "default") -> Optional[dict]:
    """Load {entity_name: {entity_type, description, ...}} from the kv store.

    SWR（R1）：TTL 内返回缓存；过期返回旧值 + 后台重建。
    """
    key = (tenant_id, namespace)

    def _load() -> Optional[dict]:
        path = resolve_graph_dir(tenant_id, namespace) / ENTITIES_FILE
        data: Optional[dict] = None
        if path.exists():
            try:
                with open(path, encoding="utf-8") as fh:
                    data = json.load(fh)
            except Exception:
                logger.exception("Failed to read entities store: %s", path)
        return data

    return _cache_get(key, _entities_cache, _load, _GRAPH_CACHE_TTL_S)


def load_name_en_map() -> dict[str, str]:
    """Lazy-load 中文实体 → 英文名预存映射表（api/entity_name_en.json）。"""
    global _name_en_map, _name_en_loaded
    if _name_en_loaded:
        return _name_en_map
    _name_en_loaded = True
    try:
        path = Path(__file__).resolve().parent / _NAME_EN_FILE
        if path.exists():
            _name_en_map = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        logger.debug("name_en map load failed", exc_info=True)
    return _name_en_map


def name_en_of(node_id: str) -> Optional[str]:
    """实体英文名（REQ-G8）：精确查表 → 剥离值后缀回查核心词（如
    「机会评分48/100」→ Opportunity Score 48/100）→ 未命中返回 None。"""
    m = load_name_en_map()
    if node_id in m:
        return m[node_id]
    core = _VALUE_SUFFIX_RE.sub("", node_id).rstrip(" ")
    if core and core != node_id and core in m:
        suffix = node_id[len(core):].strip()
        # 值后缀语言化：76.14美元 → 76.14 USD；10篇 → 10
        suffix = re.sub(r"美元$", " USD", suffix).strip()
        suffix = re.sub(r"^(\d+)篇$", r"\1", suffix).strip()
        return f"{m[core]} {suffix}" if suffix else m[core]
    return None


def load_relations(tenant_id: str, namespace: str = "default") -> Optional[dict]:
    """Load relations as {(source, target): {weight, keywords, ...}}.

    The raw kv-store keys are serialized (source, target) pairs — e.g.
    '["比特币", "ETF"]' (json.dumps) or "('比特币', 'ETF')" (str of tuple).
    SWR（R1）：TTL 内返回缓存；过期返回旧值 + 后台重建。
    """
    key = (tenant_id, namespace)

    def _load() -> Optional[dict]:
        path = resolve_graph_dir(tenant_id, namespace) / RELATIONS_FILE
        relations: Optional[dict] = None
        if path.exists():
            try:
                with open(path, encoding="utf-8") as fh:
                    raw = json.load(fh)
                relations = {}
                for raw_key, value in (raw or {}).items():
                    pair = _parse_relation_key(raw_key)
                    if pair and isinstance(value, dict):
                        relations[pair] = value
            except Exception:
                logger.exception("Failed to read relations store: %s", path)
        return relations

    return _cache_get(key, _relations_cache, _load, _GRAPH_CACHE_TTL_S)


# ── 内部工具函数 ──────────────────────────────────────────

def _parse_relation_key(raw: str) -> Optional[tuple[str, str]]:
    """Parse a serialized (source, target) pair into two strings."""
    for loader in (json.loads, ast.literal_eval):
        try:
            value = loader(raw)
        except (ValueError, SyntaxError, TypeError):
            continue
        if isinstance(value, (list, tuple)) and len(value) == 2:
            return str(value[0]), str(value[1])
    return None


def _map_category(name: str, entity_type: str) -> str:
    """Map an entity (name + type) to one of the 9 node categories."""
    haystack = f"{name} {entity_type}".lower()
    for keywords, category in _CATEGORY_RULES:
        if any(kw in haystack for kw in keywords):
            return category
    return _DEFAULT_CATEGORY


def _map_relation(text: str) -> str:
    """Map relation keywords to one of the 8 edge relations."""
    text = text.lower()
    for keywords, relation in _RELATION_RULES:
        if any(kw in text for kw in keywords):
            return relation
    return _DEFAULT_RELATION


def _map_sentiment(text: str) -> Optional[float]:
    """Keyword-based sentiment score in [-1, 1]; None when no hits."""
    if not text:
        return None
    t = text.lower()
    pos = sum(t.count(w) for w in _POSITIVE_WORDS)
    neg = sum(t.count(w) for w in _NEGATIVE_WORDS)
    total = pos + neg
    if total == 0:
        return None
    return round((pos - neg) / total, 4)


def _edge_context(graph: nx.Graph, u: str, v: str, relations: dict) -> str:
    """Collect every textual attribute of an edge (graphml + relations store)."""
    parts: list[str] = []
    for value in graph[u][v].values():
        if isinstance(value, str):
            parts.append(value)
        elif isinstance(value, (list, tuple)):
            parts.extend(str(x) for x in value)
    rel = relations.get((u, v)) or relations.get((v, u)) or {}
    for value in rel.values():
        if isinstance(value, str):
            parts.append(value)
        elif isinstance(value, (list, tuple)):
            parts.extend(str(x) for x in value)
    return " ".join(parts)


def _edge_weight(graph: nx.Graph, u: str, v: str, relations: dict) -> float:
    """Edge weight in [0, 1] — relations store first, then GraphML attr."""
    weight = relations.get((u, v)) or relations.get((v, u))
    if isinstance(weight, dict):
        weight = weight.get("weight")
    else:
        weight = None
    if weight is None:
        weight = graph[u][v].get("weight")
    try:
        weight = float(weight)
    except (TypeError, ValueError):
        weight = None
    if weight is None:
        weight = 0.5
    return round(min(1.0, max(0.0, weight)), 4)


def _pagerank_python(graph: nx.Graph, alpha: float = 0.85,
                     max_iter: int = 100, tol: float = 1e-6) -> dict:
    """Pure-Python PageRank (networkx reference implementation).

    Fallback used when ``nx.pagerank`` is unavailable (its default scipy
    backend requires the optional ``scipy`` dependency, which is not part of
    the project requirements).
    """
    if graph.number_of_nodes() == 0:
        return {}
    directed = graph.to_directed() if not graph.is_directed() else graph
    W = nx.stochastic_graph(directed, weight="weight")
    n = W.number_of_nodes()
    x = dict.fromkeys(W, 1.0 / n)
    p = dict.fromkeys(W, 1.0 / n)
    dangling_nodes = [node for node in W if W.out_degree(node, weight="weight") == 0.0]
    for _ in range(max_iter):
        xlast = x
        x = dict.fromkeys(xlast.keys(), 0.0)
        danglesum = alpha * sum(xlast[node] for node in dangling_nodes)
        for node in x:
            for _src, nbr, wt in W.edges(node, data="weight"):
                x[nbr] += alpha * xlast[node] * wt
            x[node] += danglesum * p[node] + (1.0 - alpha) * p[node]
        err = sum(abs(x[node] - xlast[node]) for node in x)
        if err < n * tol:
            return x
    return x


def _pagerank_sizes(graph: nx.Graph) -> dict[str, float]:
    """PageRank of every node, min-max normalized to [0, 1]."""
    if graph.number_of_nodes() == 0:
        return {}
    try:
        pr = nx.pagerank(graph, weight="weight")
    except Exception:
        pr = _pagerank_python(graph)
    if not pr:
        return {}
    values = list(pr.values())
    lo, hi = min(values), max(values)
    if hi - lo < 1e-12:
        return {node: 1.0 for node in pr}
    return {node: round((value - lo) / (hi - lo), 4) for node, value in pr.items()}


# ── 核心函数（route 与冒烟测试直接调用）──────────────────

def build_graph_payload(
    tenant_id: str,
    namespace: str = "default",
    limit: int = DEFAULT_LIMIT,
    symbol: Optional[str] = None,
) -> Optional[dict]:
    """Build the ECharts force-directed graph payload.

    Returns None when the graph file is missing (route maps to 503).
    ``limit`` keeps the top-N nodes by PageRank size (plus their edges);
    ``symbol`` instead returns that entity's one-hop subgraph.
    """
    graph = load_graphml(tenant_id, namespace)
    if graph is None:
        return None

    entities = load_entities(tenant_id, namespace) or {}
    relations = load_relations(tenant_id, namespace) or {}
    sizes = _pagerank_sizes(graph)

    if symbol:
        if symbol not in graph:
            return {"nodes": [], "edges": []}
        selected = {symbol} | set(graph.neighbors(symbol))
        if graph.is_directed():
            selected |= set(graph.predecessors(symbol))
        node_ids = sorted(selected)
    else:
        node_ids = list(graph.nodes())
        if limit and limit < len(node_ids):
            node_ids = sorted(node_ids, key=lambda n: sizes.get(n, 0.0), reverse=True)[:max(1, limit)]
        selected = set(node_ids)

    nodes = []
    for node_id in node_ids:
        entity = entities.get(node_id) or {}
        name = str(node_id)
        entity_type = str(
            graph.nodes[node_id].get("entity_type") or entity.get("entity_type") or ""
        )
        description = str(
            entity.get("description") or graph.nodes[node_id].get("description") or ""
        )
        nodes.append({
            "id": name,
            "name_en": name_en_of(name),
            "category": _map_category(name, entity_type),
            "size": sizes.get(node_id, 0.0),
            "sentiment": _map_sentiment(description),
        })

    edges = []
    for u, v, _data in graph.edges(data=True):
        if u not in selected or v not in selected:
            continue
        edges.append({
            "source": str(u),
            "target": str(v),
            "relation": _map_relation(_edge_context(graph, u, v, relations)),
            "weight": _edge_weight(graph, u, v, relations),
        })

    return {"nodes": nodes, "edges": edges}


# ═══════════════════════════════════════════════════════════════
#  GF-3 — Graph factor computation (GET /api/v1/factors/graph)
# ═══════════════════════════════════════════════════════════════

_FACTOR_CACHE_TTL = 3600  # 因子计算结果缓存 1 小时
_POLICY_TYPE_KEYWORDS = ("policy", "regulation", "regulatory", "central_bank", "监管", "政策", "央行")
_SOURCE_TS_RE = re.compile(r"(\d{8})[T_](\d{4,6})")
_TOP_ENTITY_LIMIT = 10
_TOP_EVENT_LIMIT = 5

# 符号别名（大小写不敏感 keyword 匹配用）
_SYMBOL_ALIASES = {
    "btc": ("bitcoin", "比特币"),
    "eth": ("ethereum", "以太坊"),
    "sol": ("solana", "索拉纳"),
    "doge": ("dogecoin", "狗狗币"),
    "xrp": ("ripple", "瑞波"),
}

# 情绪词典（中文子串 + 英文词边界匹配，加权打分）
_POS_CN = ("利好", "看涨", "上涨", "上升", "反弹", "增持", "突破", "新高", "乐观", "获批", "增长", "买入")
_NEG_CN = ("利空", "看跌", "下跌", "回落", "减持", "跌破", "新低", "悲观", "拒绝", "否决", "暴跌", "抛售", "卖出")
_POS_EN_RE = re.compile(r"\b(positive|up|bull|bullish|rally|surge|gain|rise|upgrade|buy|approve)\b", re.IGNORECASE)
_NEG_EN_RE = re.compile(r"\b(negative|down|bear|bearish|drop|fall|decline|downgrade|slump|sell|fear|crash)\b", re.IGNORECASE)


class GraphDataUnavailable(Exception):
    """图谱存储文件缺失或不可读。路由捕获后返回 503。"""


# 因子结果缓存（进程内存，TTL 1 小时）
_factor_cache: dict[str, tuple[float, dict]] = {}
_factor_cache_lock = threading.Lock()

# 原始 PageRank 缓存（进程内存；因子计算复用，避免每次重复计算）
_pr_cache: dict[tuple[str, str], dict] = {}
_pr_cache_lock = threading.Lock()


def _raw_pagerank(graph: nx.Graph, tenant_id: str, namespace: str) -> dict:
    """原始 PageRank（概率值，和为 1；进程内存缓存）。"""
    key = (tenant_id, namespace)
    with _pr_cache_lock:
        cached = _pr_cache.get(key)
    if cached is not None:
        return cached
    try:
        pr = nx.pagerank(graph, weight="weight", max_iter=50)
    except Exception as exc:
        logger.warning("PageRank failed for %s/%s: %s", tenant_id, namespace, exc)
        n = graph.number_of_nodes() or 1
        pr = {node: 1.0 / n for node in graph.nodes}
    with _pr_cache_lock:
        _pr_cache[key] = pr
    return pr


def _factor_cache_get(key: str) -> Optional[dict]:
    with _factor_cache_lock:
        entry = _factor_cache.get(key)
        if entry is not None and time.time() - entry[0] < _FACTOR_CACHE_TTL:
            return entry[1]
    return None


def _factor_cache_set(key: str, value: dict) -> None:
    with _factor_cache_lock:
        _factor_cache[key] = (time.time(), value)


def _as_list(value) -> list[str]:
    """source_id 等字段可能是数组或逗号分隔字符串，统一转 list。"""
    if value is None:
        return []
    if isinstance(value, list):
        return [str(v) for v in value]
    if isinstance(value, str):
        return [v.strip() for v in value.split(",") if v.strip()]
    return [str(value)]


def _raw_rel_weight(graph: nx.Graph, u: str, v: str, relations: dict) -> float:
    """关系原始权重（relations store 优先，其次 GraphML 边属性）。"""
    rel = relations.get((u, v)) or relations.get((v, u)) or {}
    raw = rel.get("weight") if isinstance(rel, dict) else None
    if raw is None:
        raw = graph[u][v].get("weight")
    try:
        raw = float(raw)
    except (TypeError, ValueError):
        raw = 1.0
    return raw if raw > 0 else 1.0


def _symbol_keywords(symbol: str) -> set:
    """symbol 关键词集合（自身 + 双向别名），用于大小写不敏感匹配。

    "BTC" → {btc, bitcoin, 比特币}；"比特币" 反向命中同一集合。
    """
    sym = (symbol or "").strip().lower()
    kws = {sym} if sym else set()
    for base, aliases in _SYMBOL_ALIASES.items():
        if sym == base or sym in aliases:
            kws.add(base)
            kws.update(aliases)
    return kws


def match_entity_keys(entities: dict, symbol: str) -> list[str]:
    """大小写不敏感 keyword 匹配：BTC 匹配实体名含 btc/bitcoin/比特币 的 key。"""
    kws = _symbol_keywords(symbol)
    if not kws:
        return []
    return [name for name in entities if any(k in name.lower() for k in kws)]


def _is_entity_node(graph: nx.Graph, node: str) -> bool:
    """GraphML 节点：含 entity_type 属性视为实体，否则为 chunk。"""
    attrs = graph.nodes.get(node, {}) or {}
    return bool(attrs.get("entity_type")) or "chunk_id" not in attrs


def _resolve_target_nodes(graph: nx.Graph, entities: dict, symbol: str) -> list[str]:
    """在 GraphML 节点中定位 symbol 对应实体节点（与实体 key 匹配逻辑一致）。"""
    kws = _symbol_keywords(symbol)
    if not kws:
        return []
    entity_names = set(match_entity_keys(entities, symbol))
    nodes = [n for n in graph.nodes if n in entity_names]
    if not nodes:
        nodes = [
            n for n in graph.nodes
            if any(k in str(n).lower() for k in kws)
        ]
    return nodes


def _build_subgraph(graph: nx.Graph, target_nodes: list[str]) -> nx.Graph:
    """目标实体子图：自身 + 一跳实体邻居（一跳为空时扩展二跳）。"""
    if not target_nodes:
        return graph.subgraph([])

    one_hop = set()
    for t in target_nodes:
        one_hop.update(graph.neighbors(t))
    neighbors = [n for n in one_hop if _is_entity_node(graph, n) and n not in target_nodes]

    if not neighbors:
        two_hop = set()
        for t in target_nodes:
            for n in graph.neighbors(t):
                two_hop.update(graph.neighbors(n))
        neighbors = [n for n in two_hop if _is_entity_node(graph, n) and n not in target_nodes]

    return graph.subgraph(set(target_nodes) | set(neighbors))


def _parse_source_timestamp(source_id: str) -> Optional[datetime]:
    """从 `crypto:daily:20260818T...` 提取时间戳；无有效时间戳返回 None。"""
    m = _SOURCE_TS_RE.search(source_id or "")
    if not m:
        return None
    date_part, time_part = m.group(1), m.group(2)
    try:
        if len(time_part) == 6:
            return datetime.strptime(date_part + time_part, "%Y%m%d%H%M%S")
        return datetime.strptime(date_part + time_part, "%Y%m%d%H%M")
    except ValueError:
        return None


def _sentiment_score(texts: list[str], weights: Optional[list[float]] = None) -> Optional[float]:
    """加权情绪打分 → [-1, 1]；无情绪词返回 None。"""
    pos = neg = 0.0
    for i, text in enumerate(texts):
        w = weights[i] if weights else 1.0
        t = text or ""
        pos += sum(t.count(k) for k in _POS_CN) * w
        neg += sum(t.count(k) for k in _NEG_CN) * w
        pos += len(_POS_EN_RE.findall(t)) * w
        neg += len(_NEG_EN_RE.findall(t)) * w
    if pos + neg <= 0:
        return None
    return round((pos - neg) / (pos + neg), 4)


def compute_graph_factors(tenant_id: str, namespace: str, symbol: str) -> dict:
    """计算 symbol 的 8 个图谱因子（结果进程内存缓存 1 小时）。

    返回 GF-3 契约字段：graph_entity_count / graph_relation_count /
    graph_sentiment / graph_event_intensity / graph_centrality /
    graph_momentum_affinity / graph_policy_exposure / graph_top_entities /
    graph_top_events。数据不可读时抛 GraphDataUnavailable。
    """
    cache_key = f"factors:{tenant_id}/{namespace}:{symbol.strip().lower()}"
    cached = _factor_cache_get(cache_key)
    if cached is not None:
        return cached

    graph = load_graphml(tenant_id, namespace)
    entities = load_entities(tenant_id, namespace)
    relations = load_relations(tenant_id, namespace)
    if graph is None or entities is None or relations is None:
        raise GraphDataUnavailable("graph data files missing or unreadable")

    target_nodes = _resolve_target_nodes(graph, entities, symbol)
    subgraph = _build_subgraph(graph, target_nodes)
    pr = _raw_pagerank(graph, tenant_id, namespace)

    # ── 子图统计（仅实体节点，chunk 不计入） ──
    entity_nodes = [n for n in subgraph.nodes if _is_entity_node(subgraph, n)]
    graph_entity_count = len(entity_nodes)
    entity_edges = [
        (u, v) for u, v in subgraph.edges
        if _is_entity_node(subgraph, u) and _is_entity_node(subgraph, v)
    ]
    graph_relation_count = len(entity_edges)

    # ── 情绪：实体 description + 关系 description/keywords 加权 ──
    sent_texts: list[str] = []
    sent_weights: list[float] = []
    for n in entity_nodes:
        desc = str(
            subgraph.nodes[n].get("description") or entities.get(n, {}).get("description") or ""
        )
        if desc:
            sent_texts.append(desc)
            sent_weights.append(float(pr.get(n, 0.0)) or 1.0)
    for u, v in entity_edges:
        rel = relations.get((u, v)) or relations.get((v, u)) or {}
        rel_text = " ".join([
            str(rel.get("description", "")),
            " ".join(_as_list(rel.get("keywords", ""))),
        ]).strip()
        if rel_text:
            sent_texts.append(rel_text)
            sent_weights.append(_raw_rel_weight(graph, u, v, relations))
    graph_sentiment = _sentiment_score(sent_texts, sent_weights)

    # ── 事件强度：source_id 时间戳近 7 天占比 ──
    source_ids = set()
    for n in entity_nodes:
        source_ids.update(
            _as_list(subgraph.nodes[n].get("source_id") or entities.get(n, {}).get("source_id"))
        )
    for u, v in entity_edges:
        rel = relations.get((u, v)) or relations.get((v, u)) or {}
        source_ids.update(_as_list(rel.get("source_id")))
        source_ids.update(_as_list(subgraph[u][v].get("source_id")))
    timestamps = [ts for ts in (_parse_source_timestamp(s) for s in source_ids) if ts is not None]
    if timestamps:
        cutoff = datetime.now() - timedelta(days=7)
        graph_event_intensity = round(sum(1 for ts in timestamps if ts >= cutoff) / len(timestamps), 4)
    else:
        graph_event_intensity = 0.0

    # ── centrality：子图实体 PageRank 最大值（0~1） ──
    graph_centrality = round(max((pr.get(n, 0.0) for n in entity_nodes), default=0.0), 4)

    # ── momentum_affinity：与目标实体直接关联强度（权重占比近似 → -1~1） ──
    edge_weights = [_raw_rel_weight(graph, u, v, relations) for u, v in entity_edges]
    if edge_weights and target_nodes:
        related = [
            _raw_rel_weight(graph, u, v, relations)
            for u, v in entity_edges if u in target_nodes or v in target_nodes
        ]
        mean_related = sum(related) / len(related) if related else 0.0
        max_weight = max(edge_weights)
        ratio = (mean_related / max_weight) if max_weight > 0 else 0.0
        graph_momentum_affinity = round(2.0 * ratio - 1.0, 4)
    else:
        graph_momentum_affinity = 0.0

    # ── policy_exposure：政策/监管/央行类实体权重占比 ──
    # 实体类型多为通用枚举（other/artifact/concept…），政策判定须同时匹配
    # 实体名关键词（美联储/央行/SEC/监管/政策…），否则恒为 0。
    def _is_policy(n: str) -> bool:
        et = str(
            subgraph.nodes[n].get("entity_type") or entities.get(n, {}).get("entity_type") or ""
        ).lower()
        if any(k in et for k in _POLICY_TYPE_KEYWORDS):
            return True
        name = str(n).lower()
        return any(k in name for k in _POLICY_TYPE_KEYWORDS)

    total_size = sum(pr.get(n, 0.0) for n in entity_nodes) or 1.0
    policy_size = sum(pr.get(n, 0.0) for n in entity_nodes if _is_policy(n))
    graph_policy_exposure = round(policy_size / total_size, 4)

    # ── top_entities：按 PageRank 权重 Top 10 ──
    ranked = sorted(entity_nodes, key=lambda n: pr.get(n, 0.0), reverse=True)[:_TOP_ENTITY_LIMIT]
    graph_top_entities = [
        {
            "name": n,
            "entity_type": str(
                subgraph.nodes[n].get("entity_type") or entities.get(n, {}).get("entity_type") or ""
            ),
            "weight": round(pr.get(n, 0.0), 6),
        }
        for n in ranked
    ]

    # ── top_events：按 source_id 时间最新 Top 5（summary 取关联描述） ──
    event_map = {}
    for n in entity_nodes:
        for sid in _as_list(subgraph.nodes[n].get("source_id") or entities.get(n, {}).get("source_id")):
            ts = _parse_source_timestamp(sid)
            if ts is not None:
                entry = event_map.setdefault(sid, {"source_id": sid, "ts": ts, "summary": ""})
                if not entry["summary"]:
                    entry["summary"] = str(subgraph.nodes[n].get("description") or "")[:200]
    for u, v in entity_edges:
        rel = relations.get((u, v)) or relations.get((v, u)) or {}
        for sid in _as_list(rel.get("source_id")):
            ts = _parse_source_timestamp(sid)
            if ts is not None:
                entry = event_map.setdefault(sid, {"source_id": sid, "ts": ts, "summary": ""})
                if not entry["summary"]:
                    desc = rel.get("description") or " ".join(_as_list(rel.get("keywords", "")))
                    entry["summary"] = str(desc)[:200]
        for sid in _as_list(subgraph[u][v].get("source_id")):
            ts = _parse_source_timestamp(sid)
            if ts is not None:
                entry = event_map.setdefault(sid, {"source_id": sid, "ts": ts, "summary": ""})
                if not entry["summary"]:
                    entry["summary"] = str(subgraph[u][v].get("description") or "")[:200]
    graph_top_events = [
        {"source_id": e["source_id"], "summary": e["summary"]}
        for e in sorted(event_map.values(), key=lambda e: e["ts"], reverse=True)[:_TOP_EVENT_LIMIT]
    ]

    result = {
        "graph_entity_count": graph_entity_count,
        "graph_relation_count": graph_relation_count,
        "graph_sentiment": graph_sentiment,
        "graph_event_intensity": graph_event_intensity,
        "graph_centrality": graph_centrality,
        "graph_momentum_affinity": graph_momentum_affinity,
        "graph_policy_exposure": graph_policy_exposure,
        "graph_top_entities": graph_top_entities,
        "graph_top_events": graph_top_events,
    }
    _factor_cache_set(cache_key, result)
    return result


# ═══════════════════════════════════════════════════════════════
#  GF-4 — Graph factor catalog
# ═══════════════════════════════════════════════════════════════

GRAPH_FACTOR_CATALOG: list[dict[str, str]] = [
    {
        "factor_id": "graph_entity_count",
        "category": "graph",
        "name": "图谱实体数",
        "type": "integer",
        "range": "[0, ∞)",
        "description": "与 symbol 关联的子图实体总数（一跳邻居 + 自身）",
    },
    {
        "factor_id": "graph_relation_count",
        "category": "graph",
        "name": "图谱关系数",
        "type": "integer",
        "range": "[0, ∞)",
        "description": "子图实体间的关系边数",
    },
    {
        "factor_id": "graph_sentiment",
        "category": "graph",
        "name": "图谱情绪",
        "type": "float",
        "range": "[-1, 1]",
        "description": "关联实体加权情绪，1 乐观 / -1 悲观，无情绪词为 null",
    },
    {
        "factor_id": "graph_event_intensity",
        "category": "graph",
        "name": "事件强度",
        "type": "float",
        "range": "[0, 1]",
        "description": "近 7 天事件密度（source_id 时间戳近 7 天占比）",
    },
    {
        "factor_id": "graph_centrality",
        "category": "graph",
        "name": "图谱中心度",
        "type": "float",
        "range": "[0, 1]",
        "description": "子图 PageRank 最大值（归一化）",
    },
    {
        "factor_id": "graph_momentum_affinity",
        "category": "graph",
        "name": "动量关联度",
        "type": "float",
        "range": "[-1, 1]",
        "description": "与主导动量实体（目标实体）的关联强度，权重占比近似",
    },
    {
        "factor_id": "graph_policy_exposure",
        "category": "graph",
        "name": "政策敞口",
        "type": "float",
        "range": "[0, 1]",
        "description": "政策/监管/央行类实体权重占比",
    },
    {
        "factor_id": "graph_top_entities",
        "category": "graph",
        "name": "核心实体",
        "type": "array",
        "range": "Top 10",
        "description": "子图内按权重排序的核心实体（name/entity_type/weight）",
    },
    {
        "factor_id": "graph_top_events",
        "category": "graph",
        "name": "核心事件",
        "type": "array",
        "range": "Top 5",
        "description": "按 source_id 时间最新的核心事件（source_id/summary）",
    },
]


def get_graph_factor_catalog() -> list[dict[str, str]]:
    """返回图谱因子目录（GF-4）。"""
    return [dict(item) for item in GRAPH_FACTOR_CATALOG]
