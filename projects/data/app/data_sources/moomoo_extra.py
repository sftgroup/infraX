"""moomoo 扩展数据获取封装（MM-5/8/11~15，P2 增量数据）。

复用 moomoo.py 的连接单例（_get_ctx / _reset_ctx）与工具函数
（_to_code / _f / _get），按 tasklist §9.14 各子任务提供 fetch 函数：

  - MM-5  新闻          fetch_search_news（get_search_news，免 key）
  - MM-8  资金流/自选池  fetch_capital_flow / fetch_stock_basicinfo
  - MM-11 F10           fetch_financials / fetch_research_consensus / fetch_valuation
  - MM-12 卖空/机构等    fetch_short_interest / fetch_daily_short_volume /
                        fetch_institution_holdings / fetch_insider_trades / fetch_ark_holdings
  - MM-13 日历           fetch_economic_calendar（earnings/economic 权限见生产 MM-13.1 验证）
  - MM-14 热力/榜单      fetch_heat_map / fetch_hot_list / fetch_top_movers（榜单权限见生产验证）
  - MM-15 板块/产业链    fetch_plate_list / fetch_industrial_chains

设计（对齐 MOOMOO_DATA_INTEGRATION.md §4.2/§4.3 fail-silent 原则）：
  - 每个 fetch 独立 try/except，SDK 缺失 / OpenD 断连 / 无功能权限（ret!=0）→
    返回空结构，由调用方 collector 决定是否落库，B 端零感知；
  - 数值 NaN/NaT 统一转 None（raw_snapshots JSON 序列化安全）；
  - 本机实测：资金流/新闻/基础信息/卖空/机构/内部人/ARK/经济日历/热力/板块/产业链
    可用；榜单/earnings ret=-1（功能权限待生产机 MM-13.1/14.1 验证）。
"""
from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from app.data_sources.moomoo import (
    MOOMOO_ENABLED,
    _ctx_ready,
    _f,
    _get,
    _get_ctx,
    _parse_time_key,
    _reset_ctx,
    _to_code,
)
from app.utils.logger import get_logger

logger = get_logger(__name__)

# 榜单/earnings 功能权限探测（本机 ret=-1 → 置 False 跳过重试，生产验证后可开）
_HOT_AVAILABLE = False
_F10_AVAILABLE = False


def _clean_row(row) -> dict:
    """单行 dict 清洗：numpy 标量 → python 标量，NaN/NaT → None。"""
    d = {}
    for k in (row.keys() if hasattr(row, "keys") else []):
        v = row[k]
        if v is None:
            d[k] = None
            continue
        if hasattr(v, "__class__") and v.__class__.__module__ == "numpy":
            # np.float64 / np.int64 / np.nan / np.datetime64
            s = str(v)
            if s in ("nan", "NaT", "inf", "-inf"):
                d[k] = None
            else:
                d[k] = v.item() if hasattr(v, "item") else v
        elif isinstance(v, (dict, list, tuple)):
            d[k] = v
        else:
            d[k] = v
    return d


def _df_records(data, limit: Optional[int] = None) -> list[dict]:
    """moomoo 返回 → dict 列表（NaN/NaT → None，超长截断）。

    兼容三类形态：DataFrame（多数端点）、dict（valuation/consensus 等
    单对象端点，MM-11 实测返回 dict 而非 DataFrame）、list[dict]。
    """
    if data is None:
        return []
    try:
        if isinstance(data, dict):
            out = [_clean_row(data)]
        elif isinstance(data, list):
            out = [_clean_row(r) for r in data]
        else:
            n = len(data)
            if limit:
                n = min(n, limit)
            out = []
            for i in range(n):
                row = data.iloc[i] if hasattr(data, "iloc") else data[i]
                out.append(_clean_row(row))
        if limit and len(out) > limit:
            out = out[:limit]
        return out
    except Exception as exc:
        logger.debug("moomoo df_records failed: %s", exc)
        return []


def _df_cols(data) -> list[str]:
    try:
        if hasattr(data, "columns"):
            return [str(c) for c in data.columns]
    except Exception:
        pass
    return []


def _call(fn, label: str):
    """统一调用包装：ret!=0 / 空 → 返回 (None, None)；异常 fail-silent。

    兼容 2/3/4 元组返回（部分接口带 page_req_key/next_key）。
    """
    if not MOOMOO_ENABLED:
        return None, None
    try:
        ctx = _get_ctx()
        if ctx is None:
            return None, None
        r = fn(ctx)
        if isinstance(r, tuple):
            ret = r[0] if len(r) > 0 else -1
            data = r[1] if len(r) > 1 else None
        else:
            ret, data = -1, r
        if ret is not None and ret != 0:
            logger.debug("moomoo %s ret=%s（功能权限或参数）", label, ret)
            # 连接已断（未就绪）→ 丢弃死连接，下次 _get_ctx 走 TCP 预检/冷却快速失败，
            # 避免每次调用都等 _sync_query_connect_timeout（MM-10.1 降级快速回退）
            if not _ctx_ready(ctx):
                _reset_ctx()
            return None, None
        if data is None:
            return None, None
        return ret, data
    except NotImplementedError:
        return None, None
    except Exception as exc:
        logger.debug("moomoo %s failed: %s", label, exc)
        _reset_ctx()
        return None, None


# ── MM-5 新闻 ───────────────────────────────────────────────

def fetch_search_news(
    keyword: str,
    max_count: int = 20,
    sub_type: str = "ALL",
) -> list[dict]:
    """get_search_news：按关键词抓新闻（免 key，Moomoo News/MT Newswires/Benzinga）。

    返回统一结构 [{title, url, source, publish_time(ISO), news_sub_type,
    view_count, related_securities}]。
    """
    try:
        ret, data = _call(lambda c: c.get_search_news(keyword, max_count, sub_type), "news")
        if data is None:
            return []
        out = []
        for r in _df_records(data, max_count):
            ts = _parse_time_key(_get(r, "publish_time"), "US")
            out.append({
                "title": str(_get(r, "title") or "").strip(),
                "url": str(_get(r, "url") or "").strip(),
                "source": str(_get(r, "source") or ""),
                "publish_time": (datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()
                                 if ts else str(_get(r, "publish_time") or "")),
                "news_sub_type": str(_get(r, "news_sub_type") or ""),
                "view_count": _f(_get(r, "view_count")),
                "related_securities": str(_get(r, "related_securities") or ""),
                "keyword": keyword,
            })
        return [n for n in out if n["title"] and n["url"]]
    except Exception as exc:
        logger.debug("moomoo fetch_search_news %s failed: %s", keyword, exc)
        return []


# ── MM-8 资金流 / 自选池 ────────────────────────────────────

def fetch_capital_flow(symbol: str, market: Optional[str] = None) -> list[dict]:
    """get_capital_flow：分钟级资金流（super/big/mid/sml 主力净流入）。"""
    try:
        code = _to_code(symbol, market)
        ret, data = _call(lambda c: c.get_capital_flow(code, "INTRADAY"), "capital_flow")
        if data is None:
            return []
        out = []
        for r in _df_records(data):
            ts = _parse_time_key(_get(r, "capital_flow_item_time"), code.split(".", 1)[0])
            out.append({
                "time": ts,
                "in_flow": _f(_get(r, "in_flow")),
                "super_in_flow": _f(_get(r, "super_in_flow")),
                "big_in_flow": _f(_get(r, "big_in_flow")),
                "mid_in_flow": _f(_get(r, "mid_in_flow")),
                "sml_in_flow": _f(_get(r, "sml_in_flow")),
                "main_in_flow": _f(_get(r, "main_in_flow")),
            })
        # 逆序为时间升序（moomoo 返回最新在前）
        out.sort(key=lambda x: (x["time"] is None, x["time"] or 0))
        return out
    except Exception as exc:
        logger.debug("moomoo fetch_capital_flow %s failed: %s", symbol, exc)
        return []


def fetch_stock_basicinfo(market: str = "US", max_count: int = 3000) -> list[dict]:
    """get_stock_basicinfo：市场股票列表（MM-8.2 美股自选池候选）。"""
    try:
        ret, data = _call(lambda c: c.get_stock_basicinfo(market, "STOCK"), "stock_basicinfo")
        if data is None:
            return []
        out = []
        for r in _df_records(data, max_count):
            out.append({
                "code": str(_get(r, "code") or ""),
                "name": str(_get(r, "name") or ""),
                "stock_type": str(_get(r, "stock_type") or ""),
                "stock_child_type": str(_get(r, "stock_child_type") or ""),
                "listing_date": str(_get(r, "listing_date") or ""),
                "lot_size": _f(_get(r, "lot_size")),
            })
        return [x for x in out if x["code"]]
    except Exception as exc:
        logger.debug("moomoo fetch_stock_basicinfo failed: %s", exc)
        return []


# ── MM-11 F10（financials/评级/估值；本地 ret=0 空，权限待生产验证） ──

def fetch_financials(code: str, num: int = 4) -> list[dict]:
    """get_financials_statements：财务报表（income/balance/cashflow 尝试全枚举）。

    MM-11 生产实测：返回 {next_key, structure_list, report_list}（dict 而非
    DataFrame）；report_list 每项含 period 元信息 + item_list（field_id → value），
    structure_list 提供 field_id → display_name 映射，合并为可读 items。
    """
    try:
        ctx = _get_ctx()
        if ctx is None:
            return []
        results = []
        for ftype in (None, "INCOME_STATEMENT", "BALANCE_SHEET", "CASH_FLOW"):
            try:
                kwargs = {"num": num}
                if ftype:
                    kwargs["financial_type"] = ftype
                r = ctx.get_financials_statements(code, **kwargs)
                ret = r[0] if isinstance(r, tuple) and len(r) > 0 else -1
                data = r[1] if isinstance(r, tuple) and len(r) > 1 else r
                if ret != 0 or not isinstance(data, dict):
                    continue
                name_map = {
                    str(s.get("field_id")): str(s.get("display_name") or "")
                    for s in (data.get("structure_list") or [])
                    if isinstance(s, dict)
                }
                for rep in (data.get("report_list") or []):
                    if not isinstance(rep, dict):
                        continue
                    rec = {k: v for k, v in rep.items() if k not in ("item_list", "structure_list")}
                    rec["_financial_type"] = ftype or "DEFAULT"
                    item_list = rep.get("item_list") or []
                    items: dict = {}
                    for it in item_list:
                        if not isinstance(it, dict):
                            continue
                        fid = str(it.get("field_id") or it.get("id") or "")
                        if not fid:
                            continue
                        key = name_map.get(fid) or fid
                        items[key] = _clean_row(it).get("value", it.get("value"))
                    if items:
                        rec["items"] = items
                    results.append(rec)
            except Exception:
                continue
        return results
    except Exception as exc:
        logger.debug("moomoo fetch_financials %s failed: %s", code, exc)
        return []


def fetch_research_consensus(code: str) -> Optional[dict]:
    """get_research_analyst_consensus：分析师一致评级/目标价。"""
    try:
        ret, data = _call(lambda c: c.get_research_analyst_consensus(code), "research_consensus")
        if data is None or len(data) == 0:
            return None
        recs = _df_records(data, 1)
        return recs[0] if recs else None
    except Exception as exc:
        logger.debug("moomoo fetch_research_consensus %s failed: %s", code, exc)
        return None


def fetch_valuation(code: str) -> list[dict]:
    """get_valuation_detail：估值指标（PE/PB 等）。"""
    try:
        ret, data = _call(lambda c: c.get_valuation_detail(code), "valuation")
        if data is None:
            return []
        return _df_records(data)
    except Exception as exc:
        logger.debug("moomoo fetch_valuation %s failed: %s", code, exc)
        return []


# ── MM-12 卖空/机构/内部人/ARK ─────────────────────────────

def fetch_short_interest(code: str, num: int = 10) -> list[dict]:
    """get_short_interest：卖空兴趣（shares_short/short_percent/days_to_cover）。"""
    try:
        ctx = _get_ctx()
        if ctx is None:
            return []
        ret, data, _ = ctx.get_short_interest(code, num=num)
        if ret != 0 or data is None:
            return []
        out = []
        for r in _df_records(data, num):
            out.append({
                "date": str(_get(r, "timestamp_str") or _get(r, "timestamp") or ""),
                "shares_short": _f(_get(r, "shares_short")),
                "short_percent": _f(_get(r, "short_percent")),
                "days_to_cover": _f(_get(r, "days_to_cover")),
                "avg_daily_share_volume": _f(_get(r, "avg_daily_share_volume")),
                "close_price": _f(_get(r, "close_price")),
            })
        return out
    except Exception as exc:
        logger.debug("moomoo fetch_short_interest %s failed: %s", code, exc)
        return []


def fetch_daily_short_volume(code: str, num: int = 10) -> list[dict]:
    """get_daily_short_volume：每日卖空成交量。"""
    try:
        ctx = _get_ctx()
        if ctx is None:
            return []
        ret, data, _ = ctx.get_daily_short_volume(code, num=num)
        if ret != 0 or data is None:
            return []
        out = []
        for r in _df_records(data, num):
            out.append({
                "date": str(_get(r, "timestamp_str") or _get(r, "timestamp") or ""),
                "total_shares_short": _f(_get(r, "total_shares_short")),
                "short_percent": _f(_get(r, "short_percent")),
                "volume": _f(_get(r, "volume")),
                "daily_trade_avg_ratio": _f(_get(r, "daily_trade_avg_ratio")),
            })
        return out
    except Exception as exc:
        logger.debug("moomoo fetch_daily_short_volume %s failed: %s", code, exc)
        return []


def fetch_institution_holdings(market: str = "US", count: int = 20) -> list[dict]:
    """get_institution_list：机构持仓列表（position_value/change）。"""
    try:
        ret, data = _call(lambda c: c.get_institution_list(market, count=count), "institution_list")
        if data is None:
            return []
        out = []
        for r in _df_records(data, count):
            out.append({
                "institution_id": str(_get(r, "institution_id") or ""),
                "institution_name": str(_get(r, "institution_name") or ""),
                "position_value": _f(_get(r, "position_value")),
                "position_value_change": _f(_get(r, "position_value_change")),
                "position_count": _f(_get(r, "position_count")),
                "position_count_change": _f(_get(r, "position_count_change")),
                "disclosure_date": str(_get(r, "disclosure_date") or ""),
                "currency": str(_get(r, "currency") or ""),
            })
        return [x for x in out if x["institution_id"]]
    except Exception as exc:
        logger.debug("moomoo fetch_institution_holdings failed: %s", exc)
        return []


def fetch_insider_trades(code: str, num: int = 10) -> list[dict]:
    """get_insider_trade_list：内部人交易。"""
    try:
        ret, data = _call(lambda c: c.get_insider_trade_list(code, num=num), "insider_trade")
        if data is None:
            return []
        out = []
        for r in _df_records(data, num):
            out.append({
                "name": str(_get(r, "name") or ""),
                "title": str(_get(r, "title") or ""),
                "transaction_type": str(_get(r, "transaction_type") or ""),
                "trade_shares": _f(_get(r, "trade_shares")),
                "min_trade_date": str(_get(r, "min_trade_date_str") or _get(r, "min_trade_date") or ""),
                "min_price": _f(_get(r, "min_price")),
                "max_price": _f(_get(r, "max_price")),
                "security_holder_quantity": _f(_get(r, "security_holder_quantity")),
            })
        return out
    except Exception as exc:
        logger.debug("moomoo fetch_insider_trades %s failed: %s", code, exc)
        return []


def fetch_ark_holdings(count: int = 20) -> list[dict]:
    """get_ark_fund_holding：ARK 基金持仓。"""
    try:
        ret, data = _call(lambda c: c.get_ark_fund_holding(count=count), "ark_fund_holding")
        if data is None:
            return []
        out = []
        for r in _df_records(data, count):
            out.append({
                "security": str(_get(r, "security") or ""),
                "name": str(_get(r, "name") or ""),
                "shares": _f(_get(r, "shares")),
                "shares_change": _f(_get(r, "shares_change")),
                "market_value": _f(_get(r, "market_value")),
                "weight": _f(_get(r, "weight")),
                "weight_change": _f(_get(r, "weight_change")),
            })
        return [x for x in out if x["security"]]
    except Exception as exc:
        logger.debug("moomoo fetch_ark_holdings failed: %s", exc)
        return []


# ── MM-13 日历（economic_calendar 可用；earnings 权限待生产验证） ──

def fetch_economic_calendar(
    begin_date: Optional[str] = None,
    end_date: Optional[str] = None,
    days: int = 7,
) -> list[dict]:
    """get_economic_calendar：经济日历（title/star/previous/consensus/actual）。"""
    try:
        end = end_date or datetime.now(timezone.utc).date().isoformat()
        begin = begin_date or (datetime.now(timezone.utc).date() - timedelta(days=days)).isoformat()
        ret, data = _call(lambda c: c.get_economic_calendar(begin, end), "economic_calendar")
        if data is None:
            return []
        out = []
        for r in _df_records(data):
            out.append({
                "title": str(_get(r, "title") or ""),
                "time": str(_get(r, "timestamp") or ""),
                "country": str(_get(r, "country") or ""),
                "star": str(_get(r, "star") or ""),
                "previous": _f(_get(r, "previous")),
                "consensus": _f(_get(r, "consensus")),
                "actual": _f(_get(r, "actual")),
            })
        return [x for x in out if x["title"]]
    except Exception as exc:
        logger.debug("moomoo fetch_economic_calendar failed: %s", exc)
        return []


# ── MM-14 热力/榜单（heat_map 可用；榜单权限待生产验证） ────

def fetch_heat_map(market: str = "US", count: int = 30) -> list[dict]:
    """get_heat_map_data：板块热力图（change_rate/pe_avg/rise_fall_count）。"""
    try:
        ret, data = _call(lambda c: c.get_heat_map_data(market, count=count), "heat_map")
        if data is None:
            return []
        out = []
        for r in _df_records(data, count):
            out.append({
                "plate": str(_get(r, "plate") or ""),
                "plate_name": str(_get(r, "plate_name") or ""),
                "cur_price": _f(_get(r, "cur_price")),
                "change_rate": _f(_get(r, "change_rate")),
                "turnover": _f(_get(r, "turnover")),
                "market_val": _f(_get(r, "market_val")),
                "pe_avg": _f(_get(r, "pe_avg")),
                "rise_count": _f(_get(r, "rise_count")),
                "fall_count": _f(_get(r, "fall_count")),
                "equal_count": _f(_get(r, "equal_count")),
                "leader_stock": str(_get(r, "leader_stock") or ""),
                "description": str(_get(r, "description") or ""),
            })
        return [x for x in out if x["plate"]]
    except Exception as exc:
        logger.debug("moomoo fetch_heat_map failed: %s", exc)
        return []


def fetch_hot_list(market: str = "US", count: int = 20) -> list[dict]:
    """get_hot_list：热门榜（本机无功能权限 ret=-1，fail-silent 返回空）。"""
    if not _HOT_AVAILABLE:
        return []
    try:
        import moomoo as m

        ret, data = _call(
            lambda c: c.get_hot_list(
                m.Market.US, sort_field=m.HotListSortField.TRADE_HEAT,
                sort_dir=m.SortDir.DESCEND, count=count,
            ),
            "hot_list",
        )
        if data is None:
            return []
        return _df_records(data, count)
    except Exception as exc:
        logger.debug("moomoo fetch_hot_list failed: %s", exc)
        return []


# ── MM-15 板块/产业链（stock_screen 复杂 request 待生产验证） ──

def fetch_plate_list(market: str = "US", plate_class: str = "INDUSTRY") -> list[dict]:
    """get_plate_list：板块列表（code/plate_name/plate_id）。"""
    try:
        ret, data = _call(lambda c: c.get_plate_list(market, plate_class), "plate_list")
        if data is None:
            return []
        return _df_records(data)
    except Exception as exc:
        logger.debug("moomoo fetch_plate_list failed: %s", exc)
        return []


def fetch_industrial_chains(market: str = "US", count: int = 20) -> list[dict]:
    """get_industrial_chain_list：产业链列表。"""
    try:
        ret, data = _call(
            lambda c: c.get_industrial_chain_list(market, count=count), "industrial_chain_list"
        )
        if data is None:
            return []
        out = []
        for r in _df_records(data, count):
            out.append({
                "chain_id": str(_get(r, "chain_id") or ""),
                "chain_type": str(_get(r, "chain_type") or ""),
                "name": str(_get(r, "name") or ""),
                "detail": str(_get(r, "detail") or ""),
                "market_cap": _f(_get(r, "market_cap")),
                "stocks_num": _f(_get(r, "stocks_num")),
            })
        return [x for x in out if x["chain_id"]]
    except Exception as exc:
        logger.debug("moomoo fetch_industrial_chains failed: %s", exc)
        return []


# ── MM-10.2 额度监控 ─────────────────────────────────────────

# 告警阈值：使用率达到 90%（订阅/历史K线 1000 额度）即告警
_QUOTA_ALERT_RATIO = 0.9


def fetch_quota_status() -> Optional[dict]:
    """订阅/历史K线额度监控（MM-10.2）。

    查询 `get_history_kl_quota(get_detail=True)`（历史K线：已用/剩余 + 30 天明细）
    与 `query_subscription`（订阅：used/remain）→ 统一结构，并标记超限告警：
      {history_kl: {used, remain, limit, detail_count, alert},
       subscription: {used, remain, limit, alert}, at, alert: bool}
    任一端点失败 fail-silent → 返回 None。
    """
    try:
        ctx = _get_ctx()
        if ctx is None:
            return None
        out: dict = {"at": int(time.time() * 1000), "alert": False}
        # 历史K线额度：get_history_kl_quota 返回 (ret, (used, remain, detail_list))
        try:
            r = ctx.get_history_kl_quota(get_detail=True)
            data_q = r[1] if (isinstance(r, tuple) and len(r) >= 2) else None
            if isinstance(data_q, (tuple, list)) and len(data_q) >= 2:
                used, remain = data_q[0], data_q[1]
                detail = data_q[2] if len(data_q) >= 3 else []
            else:
                used = remain = None
                detail = []
            limit = (used + remain) if used is not None and remain is not None else None
            hist = {"used": used, "remain": remain, "limit": limit,
                    "detail_count": len(detail) if detail else 0}
            hist["alert"] = bool(limit and used is not None and (used / limit) >= _QUOTA_ALERT_RATIO)
            out["history_kl"] = hist
        except Exception as exc:
            logger.debug("moomoo get_history_kl_quota failed: %s", exc)
        # 订阅额度：query_subscription 返回 dict（total_used/remain）
        try:
            r2 = ctx.query_subscription()
            if isinstance(r2, dict):
                used2 = r2.get("total_used")
                remain2 = r2.get("remain")
            elif isinstance(r2, tuple):
                used2, remain2 = (r2[1].get("total_used"), r2[1].get("remain")) if len(r2) > 1 else (None, None)
            else:
                used2 = remain2 = None
            limit2 = (used2 + remain2) if used2 is not None and remain2 is not None else None
            sub = {"used": used2, "remain": remain2, "limit": limit2,
                   "option_remain": r2.get("option_remain_quota") if isinstance(r2, dict) else None}
            sub["alert"] = bool(limit2 and used2 is not None and (used2 / limit2) >= _QUOTA_ALERT_RATIO)
            out["subscription"] = sub
        except Exception as exc:
            logger.debug("moomoo query_subscription failed: %s", exc)
        out["alert"] = bool(out.get("history_kl", {}).get("alert")
                            or out.get("subscription", {}).get("alert"))
        if not out.get("history_kl") and not out.get("subscription"):
            return None
        if out["alert"]:
            logger.warning("moomoo quota alert: %s", out)
        return out
    except Exception as exc:
        logger.debug("moomoo fetch_quota_status failed: %s", exc)
        return None
