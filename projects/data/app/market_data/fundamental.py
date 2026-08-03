"""
市场数据采集服务 - AI分析专用

设计理念：
1. 数据为王 - 先把数据获取做好、做稳定
2. 统一数据源 - 完全复用 DataSourceFactory 和 kline_service
3. 复用全球金融板块 - 宏观数据、情绪数据复用 global_market.py 的缓存
4. 快速稳定 - 不依赖慢速外部服务（如Jina Reader）

数据源映射：
- 价格/K线: DataSourceFactory (已验证，与K线模块、自选列表一致)
- 宏观数据: 复用 global_market.py (VIX, DXY, TNX, Fear&Greed等，带缓存)
- 新闻: Finnhub API (结构化数据，无需深度阅读)
- 基本面: Finnhub (美股) / 固定描述 (加密)
"""

import time
from typing import Dict, List, Any, Optional
from datetime import datetime, timedelta
from concurrent.futures import ThreadPoolExecutor, as_completed, TimeoutError

import yfinance as yf
import pandas as pd
import requests

from app.data_sources import DataSourceFactory
from app.kline_service import KlineService
from app.data_providers.db_cache import db_cache_get, db_cache_set
from app.data_providers.db_persist import db_data_save
from app.utils.logger import get_logger
from app.config import APIKeys

logger = get_logger(__name__)

class MarketDataCollector:
    """See __init__.py for full class definition."""

def _get_fundamental(self, market: str, symbol: str) -> Optional[Dict[str, Any]]:
    """获取基本面数据"""
    try:
        if market == 'USStock':
            return self._get_us_fundamental(symbol)
        if market in ('CNStock', 'HKStock'):
            return self._get_cn_hk_fundamental(market, symbol)
    except Exception as e:
        logger.warning(f"Fundamental data fetch failed for {market}:{symbol}: {e}")
    return None

def _get_cn_hk_fundamental(self, market: str, symbol: str) -> Optional[Dict[str, Any]]:
    """
    CN/HK fundamentals — multi-tier:
      Tier 1: Twelve Data /statistics (globally stable, paid)
      Tier 2: AkShare / Eastmoney (fragile overseas)
      Tier 3: AkShare financial statements (revenue growth, debt, FCF)
      + Tencent quote for live price fields
    """
    try:
        from app.data_sources.tencent import (
            normalize_cn_code,
            normalize_hk_code,
            fetch_quote,
            parse_quote_to_ticker,
        )
        from app.data_sources.cn_hk_fundamentals import (
            fetch_twelvedata_fundamental,
            fetch_twelvedata_statements,
            fetch_twelvedata_earnings,
            fetch_cn_fundamental_akshare,
            fetch_hk_fundamental_akshare,
            fetch_cn_financial_indicators,
            fetch_cn_financial_statements,
            fetch_hk_financial_indicators,
            fetch_hk_financial_statements,
        )

        code = normalize_cn_code(symbol) if market == 'CNStock' else normalize_hk_code(symbol)
        is_hk = market == 'HKStock'

        parts = fetch_quote(code)
        t = parse_quote_to_ticker(parts) if parts else {}
        result: Dict[str, Any] = {
            "pe_ratio": None,
            "pb_ratio": None,
            "ps_ratio": None,
            "market_cap": None,
            "dividend_yield": None,
            "beta": None,
            "52w_high": None,
            "52w_low": None,
            "roe": None,
            "eps": None,
            "revenue_growth": None,
            "profit_margin": None,
            "debt_to_equity": None,
            "current_ratio": None,
            "free_cash_flow": None,
            "last": t.get("last"),
            "previous_close": t.get("previousClose"),
            "change_percent": t.get("changePercent"),
            "source": "tencent_quote",
        }

        # Tier 1: Twelve Data
        td = {}
        try:
            td = fetch_twelvedata_fundamental(code, is_hk)
        except Exception as e:
            logger.debug("TwelveData fundamental failed %s:%s: %s", market, symbol, e)

        if td:
            result["source"] = "tencent_quote+twelvedata"
            for k, v in td.items():
                if k == "source":
                    continue
                if v is not None:
                    result[k] = v

        # Tier 2: AkShare valuation (fill any remaining None fields)
        has_valuation = result.get("pe_ratio") is not None or result.get("pb_ratio") is not None
        if not has_valuation:
            try:
                ak_data = fetch_cn_fundamental_akshare(code) if not is_hk else fetch_hk_fundamental_akshare(code)
            except Exception as e:
                logger.debug("AkShare CN/HK fundamental failed %s:%s: %s", market, symbol, e)
                ak_data = {}
            if ak_data:
                if "twelvedata" not in result.get("source", ""):
                    result["source"] = "tencent_quote+akshare_em"
                else:
                    result["source"] += "+akshare_em"
                for k, v in ak_data.items():
                    if k == "source":
                        continue
                    if v is not None and result.get(k) is None:
                        result[k] = v

        # Tier 3: Twelve Data financial statements (globally stable, priority for overseas)
        _growth_keys = ("revenue_growth", "debt_to_equity", "current_ratio", "free_cash_flow")
        needs_financials = any(result.get(k) is None for k in _growth_keys)
        has_statements = "financial_statements" in result
        if needs_financials or not has_statements:
            try:
                td_stmts = fetch_twelvedata_statements(code, is_hk)
            except Exception as e:
                logger.debug("TwelveData statements failed %s:%s: %s", market, symbol, e)
                td_stmts = {}
            if td_stmts:
                stmts_obj = td_stmts.pop("financial_statements", None)
                if stmts_obj and not has_statements:
                    result["financial_statements"] = stmts_obj
                    result["source"] += "+twelvedata_stmts"
                for k, v in td_stmts.items():
                    if v is not None and result.get(k) is None:
                        result[k] = v
                filled_td = sum(1 for k in _growth_keys if result.get(k) is not None)
                logger.info("TwelveData statements for %s:%s: %d/%d growth keys filled",
                            market, symbol, filled_td, len(_growth_keys))

        # Tier 4: AkShare financial indicators (fallback for domestic servers)
        needs_financials = any(result.get(k) is None for k in _growth_keys)
        if needs_financials:
            try:
                if is_hk:
                    fin_data = fetch_hk_financial_indicators(code)
                else:
                    fin_data = fetch_cn_financial_indicators(code)
            except Exception as e:
                logger.debug("AkShare CN/HK financial indicators failed %s:%s: %s", market, symbol, e)
                fin_data = {}
            if fin_data:
                result["source"] += "+akshare_financials"
                for k, v in fin_data.items():
                    if v is not None and result.get(k) is None:
                        result[k] = v
                filled = sum(1 for k in _growth_keys if result.get(k) is not None)
                logger.info("CN/HK AkShare financial indicators for %s:%s: %d/%d growth keys filled",
                            market, symbol, filled, len(_growth_keys))

        # Tier 5: Structured financial statements via AkShare (if Twelve Data didn't fill)
        if "financial_statements" not in result:
            try:
                if is_hk:
                    stmts = fetch_hk_financial_statements(code)
                else:
                    stmts = fetch_cn_financial_statements(code)
                if stmts:
                    result["financial_statements"] = stmts
                    result["source"] += "+akshare_stmts"
                    logger.debug("CN/HK financial statements (AkShare) for %s: %s", symbol, list(stmts.keys()))
            except Exception as e:
                logger.debug("CN/HK financial statements (AkShare) failed %s: %s", symbol, e)

        # Tier 6: Earnings data (quarterly EPS history) — Twelve Data /earnings
        if "earnings" not in result:
            try:
                td_earnings = fetch_twelvedata_earnings(code, is_hk)
                if td_earnings:
                    result["earnings"] = td_earnings
                    result["source"] += "+twelvedata_earnings"
            except Exception as e:
                logger.debug("TwelveData earnings failed %s:%s: %s", market, symbol, e)

        # Fallback: build earnings from financial_statements if /earnings failed
        if "earnings" not in result and "financial_statements" in result:
            result["earnings"] = self._build_earnings_from_statements(result["financial_statements"])

        if not parts and not td and not has_valuation:
            return None
        return result
    except Exception as e:
        logger.debug(f"CN/HK fundamental failed: {market}:{symbol}: {e}")
        return None

@staticmethod
def _build_earnings_from_statements(stmts: Dict[str, Any]) -> Dict[str, Any]:
    """Construct an 'earnings' dict from structured financial_statements for CN/HK."""
    earnings: Dict[str, Any] = {}

    inc = stmts.get("income_statement") or {}
    latest_date = inc.get("latest_date")
    revenue = inc.get("total_revenue")
    net_income = inc.get("net_income")
    eps = inc.get("eps_diluted")

    if latest_date or revenue or net_income:
        earnings["quarterly"] = {
            "latest_quarter": latest_date,
            "revenue": revenue,
            "earnings": net_income,
        }
        earnings["history"] = [{
            "date": latest_date or "N/A",
            "eps_actual": eps,
            "eps_estimate": None,
            "surprise": None,
        }]

    cf = stmts.get("cash_flow") or {}
    bs = stmts.get("balance_sheet") or {}
    if cf or bs:
        summary_parts = []
        if cf.get("operating_cash_flow") is not None:
            summary_parts.append(f"Operating CF: {cf['operating_cash_flow']:,.0f}")
        if cf.get("free_cash_flow") is not None:
            summary_parts.append(f"FCF: {cf['free_cash_flow']:,.0f}")
        if bs.get("total_assets") is not None:
            summary_parts.append(f"Total Assets: {bs['total_assets']:,.0f}")
        if summary_parts:
            earnings["financial_summary"] = "; ".join(summary_parts)

    return earnings if earnings else {}

def _get_us_fundamental(self, symbol: str) -> Optional[Dict[str, Any]]:
    """
    美股基本面 - Finnhub + yfinance
    包括：基础财务指标 + 财报数据（资产负债表、利润表、现金流量表）
    """
    result = {}
    
    # === 1. 基础财务指标 (Finnhub) ===
    if self._finnhub_client:
        try:
            metrics = self._finnhub_client.company_basic_financials(symbol, 'all')
            if metrics and metrics.get('metric'):
                m = metrics['metric']
                result.update({
                    'pe_ratio': m.get('peBasicExclExtraTTM'),
                    'pb_ratio': m.get('pbQuarterly'),
                    'ps_ratio': m.get('psTTM'),
                    'market_cap': m.get('marketCapitalization'),
                    'dividend_yield': m.get('dividendYieldIndicatedAnnual'),
                    'beta': m.get('beta'),
                    '52w_high': m.get('52WeekHigh'),
                    '52w_low': m.get('52WeekLow'),
                    'roe': m.get('roeTTM'),
                    'eps': m.get('epsBasicExclExtraItemsTTM'),
                    'revenue_growth': m.get('revenueGrowthTTMYoy'),
                    'profit_margin': m.get('netProfitMarginTTM'),
                    'debt_to_equity': m.get('totalDebtToEquityQuarterly'),
                    'current_ratio': m.get('currentRatioQuarterly'),
                    'quick_ratio': m.get('quickRatioQuarterly'),
                })
        except Exception as e:
            logger.debug(f"Finnhub fundamental failed for {symbol}: {e}")
    
    # === 2. yfinance 补充基础指标 ===
    try:
        ticker = yf.Ticker(symbol)
        info = ticker.info or {}
        
        # 补充缺失的基础指标
        if not result.get('pe_ratio'):
            result['pe_ratio'] = info.get('trailingPE') or info.get('forwardPE')
        if not result.get('pb_ratio'):
            result['pb_ratio'] = info.get('priceToBook')
        if not result.get('market_cap'):
            result['market_cap'] = info.get('marketCap')
        if not result.get('dividend_yield'):
            result['dividend_yield'] = info.get('dividendYield')
        if not result.get('beta'):
            result['beta'] = info.get('beta')
        if not result.get('52w_high'):
            result['52w_high'] = info.get('fiftyTwoWeekHigh')
        if not result.get('52w_low'):
            result['52w_low'] = info.get('fiftyTwoWeekLow')
        if not result.get('roe'):
            result['roe'] = info.get('returnOnEquity')
        if not result.get('eps'):
            result['eps'] = info.get('trailingEps')
        
        # 补充更多财务指标
        result.update({
            'revenue': info.get('totalRevenue'),
            'gross_profit': info.get('grossProfits'),
            'operating_margin': info.get('operatingMargins'),
            'profit_margin': result.get('profit_margin') or info.get('profitMargins'),
            'ebitda': info.get('ebitda'),
            'debt': info.get('totalDebt'),
            'cash': info.get('totalCash'),
            'free_cash_flow': info.get('freeCashflow'),
            'operating_cash_flow': info.get('operatingCashflow'),
            'book_value': info.get('bookValue'),
            'enterprise_value': info.get('enterpriseValue'),
        })
    except Exception as e:
        logger.debug(f"yfinance fundamental failed for {symbol}: {e}")
    
    # === 3. 获取财报数据（资产负债表、利润表、现金流量表）===
    financial_statements = self._get_financial_statements(symbol)
    if financial_statements:
        result['financial_statements'] = financial_statements
    
    # === 4. 获取盈利报告（Earnings）===
    earnings_data = self._get_earnings_data(symbol)
    if earnings_data:
        result['earnings'] = earnings_data
    
    return result if result else None

def _get_financial_statements(self, symbol: str) -> Optional[Dict[str, Any]]:
    """
    获取财务报表数据（资产负债表、利润表、现金流量表）
    
    使用 yfinance 获取，包含最近几个季度的数据
    """
    try:
        ticker = yf.Ticker(symbol)
        statements = {}
        
        # 资产负债表 (Balance Sheet)
        try:
            balance_sheet = ticker.balance_sheet
            if balance_sheet is not None and not balance_sheet.empty:
                # 获取最近4个季度
                latest_quarters = balance_sheet.columns[:4] if len(balance_sheet.columns) >= 4 else balance_sheet.columns
                statements['balance_sheet'] = {
                    'latest_date': str(latest_quarters[0]) if len(latest_quarters) > 0 else None,
                    'total_assets': float(balance_sheet.loc['Total Assets', latest_quarters[0]]) if 'Total Assets' in balance_sheet.index and len(latest_quarters) > 0 else None,
                    'total_liabilities': float(balance_sheet.loc['Total Liab', latest_quarters[0]]) if 'Total Liab' in balance_sheet.index and len(latest_quarters) > 0 else None,
                    'total_equity': float(balance_sheet.loc['Stockholders Equity', latest_quarters[0]]) if 'Stockholders Equity' in balance_sheet.index and len(latest_quarters) > 0 else None,
                    'cash': float(balance_sheet.loc['Cash', latest_quarters[0]]) if 'Cash' in balance_sheet.index and len(latest_quarters) > 0 else None,
                    'debt': float(balance_sheet.loc['Total Debt', latest_quarters[0]]) if 'Total Debt' in balance_sheet.index and len(latest_quarters) > 0 else None,
                    'current_assets': float(balance_sheet.loc['Current Assets', latest_quarters[0]]) if 'Current Assets' in balance_sheet.index and len(latest_quarters) > 0 else None,
                    'current_liabilities': float(balance_sheet.loc['Current Liabilities', latest_quarters[0]]) if 'Current Liabilities' in balance_sheet.index and len(latest_quarters) > 0 else None,
                }
        except Exception as e:
            logger.debug(f"Balance sheet fetch failed for {symbol}: {e}")
        
        # 利润表 (Income Statement)
        try:
            income_stmt = ticker.financials
            if income_stmt is not None and not income_stmt.empty:
                latest_quarters = income_stmt.columns[:4] if len(income_stmt.columns) >= 4 else income_stmt.columns
                statements['income_statement'] = {
                    'latest_date': str(latest_quarters[0]) if len(latest_quarters) > 0 else None,
                    'total_revenue': float(income_stmt.loc['Total Revenue', latest_quarters[0]]) if 'Total Revenue' in income_stmt.index and len(latest_quarters) > 0 else None,
                    'gross_profit': float(income_stmt.loc['Gross Profit', latest_quarters[0]]) if 'Gross Profit' in income_stmt.index and len(latest_quarters) > 0 else None,
                    'operating_income': float(income_stmt.loc['Operating Income', latest_quarters[0]]) if 'Operating Income' in income_stmt.index and len(latest_quarters) > 0 else None,
                    'net_income': float(income_stmt.loc['Net Income', latest_quarters[0]]) if 'Net Income' in income_stmt.index and len(latest_quarters) > 0 else None,
                    'eps': float(income_stmt.loc['Basic EPS', latest_quarters[0]]) if 'Basic EPS' in income_stmt.index and len(latest_quarters) > 0 else None,
                }
        except Exception as e:
            logger.debug(f"Income statement fetch failed for {symbol}: {e}")
        
        # 现金流量表 (Cash Flow Statement)
        try:
            cashflow = ticker.cashflow
            if cashflow is not None and not cashflow.empty:
                latest_quarters = cashflow.columns[:4] if len(cashflow.columns) >= 4 else cashflow.columns
                statements['cash_flow'] = {
                    'latest_date': str(latest_quarters[0]) if len(latest_quarters) > 0 else None,
                    'operating_cash_flow': float(cashflow.loc['Operating Cash Flow', latest_quarters[0]]) if 'Operating Cash Flow' in cashflow.index and len(latest_quarters) > 0 else None,
                    'investing_cash_flow': float(cashflow.loc['Capital Expenditure', latest_quarters[0]]) if 'Capital Expenditure' in cashflow.index and len(latest_quarters) > 0 else None,
                    'financing_cash_flow': float(cashflow.loc['Financing Cash Flow', latest_quarters[0]]) if 'Financing Cash Flow' in cashflow.index and len(latest_quarters) > 0 else None,
                    'free_cash_flow': float(cashflow.loc['Free Cash Flow', latest_quarters[0]]) if 'Free Cash Flow' in cashflow.index and len(latest_quarters) > 0 else None,
                }
        except Exception as e:
            logger.debug(f"Cash flow statement fetch failed for {symbol}: {e}")
        
        return statements if statements else None
        
    except Exception as e:
        logger.debug(f"Financial statements fetch failed for {symbol}: {e}")
        return None

def _get_earnings_data(self, symbol: str) -> Optional[Dict[str, Any]]:
    """
    获取盈利报告数据（Earnings）

    使用 quarterly_income_stmt 替代已弃用的 Ticker.earnings / quarterly_earnings，
    历史季度摘要从利润表推导；盈利日历仍用 ticker.calendar（若可用）。
    """
    def _pick_float(stmt: pd.DataFrame, row_names: tuple, col) -> Optional[float]:
        for name in row_names:
            if name in stmt.index:
                raw = stmt.loc[name, col]
                if raw is None or (isinstance(raw, float) and pd.isna(raw)):
                    continue
                try:
                    return float(raw)
                except (TypeError, ValueError):
                    continue
        return None

    try:
        ticker = yf.Ticker(symbol)
        earnings_data: Dict[str, Any] = {}

        # 季度利润表（yfinance 推荐路径，避免 fundamentals.Ticker.earnings 弃用告警）
        try:
            q_inc = ticker.quarterly_income_stmt
            if q_inc is not None and not q_inc.empty and len(q_inc.columns) > 0:
                cols = list(q_inc.columns)[:4]
                latest_q = cols[0]

                rev = _pick_float(
                    q_inc,
                    ("Total Revenue", "Revenue", "Total Revenues", "Net Sales"),
                    latest_q,
                )
                ni = _pick_float(
                    q_inc,
                    (
                        "Net Income",
                        "Net Income Common Stockholders",
                        "Net Income Continuous Operations",
                        "Net Income Including Noncontrolling Interests",
                    ),
                    latest_q,
                )
                earnings_data["quarterly"] = {
                    "latest_quarter": str(latest_q),
                    "revenue": rev,
                    "earnings": ni,
                }

                # 最近若干季度 EPS（来自利润表行，非一致预期）
                earnings_data["history"] = []
                for col in cols:
                    eps = _pick_float(q_inc, ("Diluted EPS", "Basic EPS"), col)
                    earnings_data["history"].append({
                        "date": str(col),
                        "eps_actual": eps,
                        "eps_estimate": None,
                        "surprise": None,
                    })
        except Exception as e:
            logger.debug(f"Quarterly income statement (earnings) fetch failed for {symbol}: {e}")

        # 盈利日历（未来盈利日期与一致预期）
        try:
            earnings_calendar = ticker.calendar
            if earnings_calendar is not None and not earnings_calendar.empty:
                idx0 = earnings_calendar.index[0]
                earnings_data["upcoming"] = {
                    "next_earnings_date": str(idx0),
                    "eps_estimate": float(earnings_calendar.loc[idx0, "Earnings Estimate"])
                    if "Earnings Estimate" in earnings_calendar.columns
                    else None,
                    "revenue_estimate": float(earnings_calendar.loc[idx0, "Revenue Estimate"])
                    if "Revenue Estimate" in earnings_calendar.columns
                    else None,
                }
        except Exception as e:
            logger.debug(f"Earnings calendar fetch failed for {symbol}: {e}")

        return earnings_data if earnings_data else None

    except Exception as e:
        logger.debug(f"Earnings data fetch failed for {symbol}: {e}")
        return None

def _get_company(self, market: str, symbol: str) -> Optional[Dict[str, Any]]:
    """获取公司信息"""
    try:
        if market == 'USStock' and self._finnhub_client:
            profile = self._finnhub_client.company_profile2(symbol=symbol)
            if profile:
                return {
                    'name': profile.get('name'),
                    'industry': profile.get('finnhubIndustry'),
                    'country': profile.get('country'),
                    'exchange': profile.get('exchange'),
                    'ipo_date': profile.get('ipo'),
                    'market_cap': profile.get('marketCapitalization'),
                    'website': profile.get('weburl'),
                }
        if market in ('CNStock', 'HKStock'):
            return self._get_cn_hk_company(market, symbol)
        
    except Exception as e:
        logger.debug(f"Company info fetch failed for {market}:{symbol}: {e}")
    
    return None

def _get_cn_hk_company(self, market: str, symbol: str) -> Optional[Dict[str, Any]]:
    """
    CN/HK company info — multi-tier:
      Tier 1: Twelve Data /profile (globally stable)
      Tier 2: AkShare / Eastmoney (fragile overseas)
      + Tencent quote for Chinese name
    """
    try:
        from app.data_sources.tencent import (
            normalize_cn_code,
            normalize_hk_code,
            fetch_quote,
        )
        from app.data_sources.cn_hk_fundamentals import (
            fetch_twelvedata_profile,
            fetch_cn_company_extras,
            fetch_hk_company_extras,
        )

        code = normalize_cn_code(symbol) if market == 'CNStock' else normalize_hk_code(symbol)
        is_hk = market == 'HKStock'

        parts = fetch_quote(code)
        cn_name = ""
        if parts:
            cn_name = (parts[1] or "").strip() if len(parts) > 1 else ""

        row: Dict[str, Any] = {
            "name": cn_name or code,
            "country": "CN" if market == "CNStock" else "HK",
            "exchange": "SSE/SZSE" if market == "CNStock" else "HKEX",
            "symbol": code,
            "source": "tencent_quote",
        }

        # Tier 1: Twelve Data /profile
        td_profile = {}
        try:
            td_profile = fetch_twelvedata_profile(code, is_hk)
        except Exception as e:
            logger.debug("TwelveData profile failed %s:%s: %s", market, symbol, e)

        if td_profile:
            row["source"] = "tencent_quote+twelvedata"
            for k in ("industry", "sector", "website", "description", "employees", "full_name"):
                v = td_profile.get(k)
                if v is not None:
                    row[k] = v
            if not cn_name and td_profile.get("name"):
                row["name"] = td_profile["name"]

        # Tier 2: AkShare (fill remaining gaps)
        if not row.get("industry"):
            try:
                ex = fetch_cn_company_extras(code) if not is_hk else fetch_hk_company_extras(code)
            except Exception:
                ex = {}
            if ex:
                if "twelvedata" not in row.get("source", ""):
                    row["source"] = "tencent_quote+akshare_em"
                else:
                    row["source"] += "+akshare_em"
                for k in ("industry", "ipo_date", "website", "full_name"):
                    if ex.get(k) and not row.get(k):
                        row[k] = ex[k]

        if not parts and not td_profile and not row.get("industry"):
            return None
        return row
    except Exception:
        return None

# ==================== 宏观数据 (复用全球金融板块) ====================


def _attach_methods(cls):
    cls._get_fundamental = _get_fundamental
    cls._get_cn_hk_fundamental = _get_cn_hk_fundamental
    cls._build_earnings_from_statements = _build_earnings_from_statements
    cls._get_us_fundamental = _get_us_fundamental
    cls._get_financial_statements = _get_financial_statements
    cls._get_earnings_data = _get_earnings_data
    cls._get_company = _get_company
    cls._get_cn_hk_company = _get_cn_hk_company
