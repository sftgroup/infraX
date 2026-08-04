"""Financial news and economic calendar data providers.

DB-cached multi-source news with crypto support.
"""
from __future__ import annotations

import os
import random
import requests
from datetime import datetime, timedelta
from typing import Any, Dict, List

from app.utils.logger import get_logger
from app.config import APIKeys

logger = get_logger(__name__)

# ── NewsAPI ───────────────────────────────────────────────────────────────

NEWSAPI_BASE = "https://newsapi.org/v2"

_API_LANG_MAP = {
    "en": "en", "cn": "zh", "ja": "ja", "ko": "ko",
    "de": "de", "fr": "fr", "ar": "ar", "th": "th", "vi": "vi",
}

_FALLBACK_QUERIES: dict[str, list[str]] = {
    "en": [
        "stock market news today", "cryptocurrency bitcoin news",
        "forex market analysis", "federal reserve interest rate",
        "global economic outlook", "S&P 500 market update",
        "earnings report today", "commodity prices",
    ],
    "cn": [
        "加密货币新闻", "美联储利率", "美股市场最新消息",
        "外汇市场分析", "全球经济数据", "期货市场动态",
        "A股行情", "港股市场",
    ],
    "ja": [
        "株式市場 ニュース", "仮想通貨 ニュース",
        "米国株 最新情報", "外国為替 分析",
        "日本銀行 金利", "経済指標 カレンダー",
    ],
    "ko": [
        "주식 시장 뉴스", "암호화폐 뉴스",
        "미국 증시 최신", "외환 시장 분석",
        "한국은행 금리", "경제 지표",
    ],
    "de": [
        "Aktienmarkt Nachrichten", "Kryptowährung News",
        "US-Börse aktuell", "Devisenmarkt Analyse",
        "EZB Leitzins", "Wirtschaftsdaten",
    ],
    "fr": [
        "actualités boursières", "cryptomonnaie actualités",
        "marché américain", "analyse forex",
        "BCE taux directeur", "indicateurs économiques",
    ],
    "ar": [
        "أخبار سوق الأسهم", "أخبار العملات الرقمية",
        "الاحتياطي الفيدرالي", "تحليل سوق الصرف",
        "البيانات الاقتصادية", "أسعار النفط",
    ],
    "th": [
        "ข่าวหุ้น", "ข่าวคริปโตเคอเรนซี",
        "ตลาดหุ้นสหรัฐ", "วิเคราะห์ฟอเร็กซ์",
        "อัตราดอกเบี้ยธนาคารกลาง", "ข้อมูลเศรษฐกิจ",
    ],
    "vi": [
        "tin tức thị trường chứng khoán", "tin tức tiền điện tử",
        "thị trường Mỹ mới nhất", "phân tích ngoại hối",
        "lãi suất ngân hàng trung ương", "dữ liệu kinh tế",
    ],
}

# ── DB cache ──────────────────────────────────────────────────────────────

_CACHE_TTL_MINUTES = 720         # 12h cache for free-tier (was 6h)
_CACHE_MAX_DAYS = 30              # auto-purge older than this

_PAGE_SIZE_DEFAULT = 20          # default news items per page
_PAGE_SIZE_MAX = 100             # maximum allowed page size
_DB_POOL = None                  # lazy-init connection


def _get_db():
    """Lazy-init a persistent DB connection."""
    global _DB_POOL
    if _DB_POOL is None:
        try:
            import psycopg2
            dsn = os.getenv("DATABASE_URL", "")
            if dsn:
                _DB_POOL = psycopg2.connect(dsn)
                _DB_POOL.autocommit = True
                _ensure_table(_DB_POOL)
        except Exception as e:
            logger.warning("News DB unavailable, using in-memory-only: %s", e)
    return _DB_POOL


def _ensure_table(conn):
    """Create qd_news_cache if not exists."""
    conn.cursor().execute("""
        CREATE TABLE IF NOT EXISTS qd_news_cache (
            id SERIAL PRIMARY KEY,
            category VARCHAR(30) NOT NULL DEFAULT 'business',
            lang VARCHAR(5) NOT NULL,
            title TEXT NOT NULL,
            link TEXT NOT NULL,
            snippet TEXT,
            source_name VARCHAR(200),
            published_at TIMESTAMP,
            fetched_at TIMESTAMP DEFAULT NOW(),
            UNIQUE(category, link)
        );
        CREATE INDEX IF NOT EXISTS idx_nc_cat_lang ON qd_news_cache(category, lang);
        CREATE INDEX IF NOT EXISTS idx_nc_fetched ON qd_news_cache(fetched_at);
    """)


def _news_from_db(category: str, lang: str,
                   max_minutes: int = _CACHE_TTL_MINUTES,
                   page: int = 1,
                   page_size: int = _PAGE_SIZE_DEFAULT
                   ) -> Dict[str, List[Dict[str, Any]]]:
    """Read news from DB cache. Returns empty dict if stale or absent.

    When cache is fresh, returns dict with keys:
        "articles" — dict of lang→articles
        "total"    — total matching rows
        "page"     — current page
        "page_size" — page size
    """
    conn = _get_db()
    if not conn:
        return {}

    try:
        cur = conn.cursor()
        # Determine if we have fresh data for this category+lang
        if lang == "all":
            cur.execute("""
                SELECT fetched_at FROM qd_news_cache
                WHERE category = %s
                ORDER BY fetched_at DESC LIMIT 1
            """, (category,))
        else:
            cur.execute("""
                SELECT fetched_at FROM qd_news_cache
                WHERE category = %s AND lang = %s
                ORDER BY fetched_at DESC LIMIT 1
            """, (category, lang))

        row = cur.fetchone()
        if not row:
            return {}

        fetched_at = row[0]
        if isinstance(fetched_at, datetime):
            age = datetime.now() - fetched_at
            if age.total_seconds() > max_minutes * 60:
                logger.info("DB cache stale for %s/%s (age=%.0fm)",
                            category, lang, age.total_seconds() / 60)
                return {}

        # Count total
        if lang == "all":
            cur.execute("""
                SELECT COUNT(*) FROM qd_news_cache WHERE category = %s
            """, (category,))
        else:
            cur.execute("""
                SELECT COUNT(*) FROM qd_news_cache WHERE category = %s AND lang = %s
            """, (category, lang))
        total = cur.fetchone()[0] or 0

        # Read cached articles with pagination
        offset = (page - 1) * page_size
        if lang == "all":
            cur.execute("""
                SELECT lang, title, link, snippet, source_name, published_at
                FROM qd_news_cache WHERE category = %s
                ORDER BY published_at DESC NULLS LAST, fetched_at DESC
                LIMIT %s OFFSET %s
            """, (category, page_size, offset))
        else:
            cur.execute("""
                SELECT lang, title, link, snippet, source_name, published_at
                FROM qd_news_cache WHERE category = %s AND lang = %s
                ORDER BY published_at DESC NULLS LAST, fetched_at DESC
                LIMIT %s OFFSET %s
            """, (category, lang, page_size, offset))

        result: Dict[str, List[Dict[str, Any]]] = {}
        for row in cur.fetchall():
            l = row[0]
            pub = row[5]
            pub_str = pub.isoformat() if isinstance(pub, datetime) else (pub or "")
            item = {
                "title": row[1],
                "link": row[2],
                "snippet": row[3] or "",
                "source": row[4] or "",
                "published": pub_str,
                "category": category,
                "lang": l,
            }
            result.setdefault(l, []).append(item)

        log_info = {k: len(v) for k, v in result.items()}
        logger.info("DB cache HIT for %s/%s (page=%d, size=%d, total=%d): %s",
                    category, lang, page, page_size, total, log_info)
        return {"articles": result, "total": total, "page": page, "page_size": page_size}
    except Exception as e:
        logger.warning("DB cache READ error: %s", e)
        return {}


def _news_save_to_db(category: str, items: List[Dict[str, Any]]):
    """Save news items to DB cache (upsert by category+link)."""
    conn = _get_db()
    if not conn or not items:
        return

    try:
        cur = conn.cursor()
        now = datetime.now()
        for it in items:
            pub = None
            if it.get("published"):
                try:
                    pub = datetime.fromisoformat(
                        it["published"].replace("Z", "+00:00")
                    )
                except Exception:
                    pub = now
            try:
                cur.execute("""
                    INSERT INTO qd_news_cache
                        (category, lang, title, link, snippet,
                         source_name, published_at, fetched_at)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (category, link) DO UPDATE SET
                        title=EXCLUDED.title,
                        snippet=EXCLUDED.snippet,
                        source_name=EXCLUDED.source_name,
                        published_at=EXCLUDED.published_at,
                        fetched_at=EXCLUDED.fetched_at
                """, (
                    category, it.get("lang", "en"),
                    it.get("title", ""), it.get("link", ""),
                    it.get("snippet", ""), it.get("source", ""),
                    pub or now, now,
                ))
            except Exception:
                pass
        logger.info("DB cache SAVED %d items for category=%s", len(items), category)
    except Exception as e:
        logger.warning("DB cache WRITE error: %s", e)


def _purge_old_news():
    """Remove news older than _CACHE_MAX_DAYS."""
    conn = _get_db()
    if not conn:
        return
    try:
        cur = conn.cursor()
        cutoff = datetime.now() - timedelta(days=_CACHE_MAX_DAYS)
        cur.execute("DELETE FROM qd_news_cache WHERE fetched_at < %s", (cutoff,))
        deleted = cur.rowcount
        if deleted:
            logger.info("Purged %d old news rows", deleted)
    except Exception as e:
        logger.warning("News purge error: %s", e)


# ── NewsAPI fetchers ─────────────────────────────────────────────────────

def _get_api_key() -> str:
    """Read API key from the rotation pool (multi-key round-robin)."""
    return APIKeys.rotate("NEWSAPI_API_KEY")


def _article_to_dict(art: dict, category: str, lang: str) -> dict:
    """Convert raw NewsAPI article to unified dict."""
    return {
        "title": (art.get("title") or "").strip(),
        "link": (art.get("url") or "").strip(),
        "snippet": (art.get("description") or "").strip(),
        "source": (art.get("source") or {}).get("name", ""),
        "published": (art.get("publishedAt") or ""),
        "category": category,
        "lang": lang,
    }


def _fetch_newsapi_business(lang: str) -> Dict[str, List[Dict[str, Any]]]:
    """Fetch business news from NewsAPI top-headlines (category=business)."""
    api_key = _get_api_key()
    if not api_key:
        return {}

    result: Dict[str, List[Dict[str, Any]]] = {}
    langs_to_query = ["en", "cn", "ja", "ko", "de", "fr", "ar", "th", "vi"]

    if lang == "all":
        targets = langs_to_query
    else:
        targets = [lang] if lang in langs_to_query else ["en"]

    for l in targets:
        api_lang = _API_LANG_MAP.get(l, "en")
        try:
            resp = requests.get(
                f"{NEWSAPI_BASE}/top-headlines",
                params={
                    "apiKey": api_key,
                    "language": api_lang,
                    "category": "business",
                    "pageSize": 20,  # ← was 10, now more
                },
                timeout=8,
            )
            if resp.status_code == 200:
                articles = resp.json().get("articles", [])
                items = [_article_to_dict(a, "business", l)
                         for a in articles
                         if (a.get("title") or "").strip()
                         and (a.get("url") or "").strip()]
                if items:
                    result[l] = items
                    _news_save_to_db("business", items)
            elif resp.status_code == 429:
                logger.warning("NewsAPI quota exceeded for lang=%s", l)
            else:
                logger.warning("NewsAPI returned %s for lang=%s: %s",
                               resp.status_code, l, resp.text[:200])
        except Exception as e:
            logger.error("NewsAPI business request failed for lang=%s: %s", l, e)

    return result


def _fetch_newsapi_crypto(lang: str) -> Dict[str, List[Dict[str, Any]]]:
    """Fetch cryptocurrency news from NewsAPI everything endpoint."""
    api_key = _get_api_key()
    if not api_key:
        return {}

    result: Dict[str, List[Dict[str, Any]]] = {}

    # Crypto queries per language
    crypto_keywords = {
        "en": "cryptocurrency OR bitcoin OR ethereum OR crypto OR blockchain",
        "cn": "加密货币 比特币 以太坊 区块链 数字货币",
        "ja": "暗号通貨 ビットコイン イーサリアム 仮想通貨",
        "ko": "암호화폐 비트코인 이더리움 블록체인",
        "de": "Kryptowährung Bitcoin Ethereum Crypto Blockchain",
        "fr": "cryptomonnaie bitcoin ethereum crypto blockchain",
        "ar": "العملات الرقمية البيتكوين الإيثيريوم بلوكتشين",
        "th": "คริปโตเคอเรนซี บิทคอยน์ อีเธอร์เรียม บล็อกเชน",
        "vi": "tiền điện tử bitcoin ethereum blockchain crypto",
    }

    langs_to_query = ["en", "cn", "ja", "ko", "de", "fr", "ar", "th", "vi"]
    if lang == "all":
        targets = langs_to_query
    else:
        targets = [lang] if lang in langs_to_query else ["en"]

    for l in targets:
        api_lang = _API_LANG_MAP.get(l, "en")
        query = crypto_keywords.get(l, crypto_keywords["en"])
        try:
            resp = requests.get(
                f"{NEWSAPI_BASE}/everything",
                params={
                    "apiKey": api_key,
                    "q": query,
                    "language": api_lang,
                    "sortBy": "publishedAt",
                    "pageSize": 10,
                },
                timeout=10,
            )
            if resp.status_code == 200:
                articles = resp.json().get("articles", [])
                items = [_article_to_dict(a, "crypto", l)
                         for a in articles
                         if (a.get("title") or "").strip()
                         and (a.get("url") or "").strip()]
                if items:
                    result[l] = items
                    _news_save_to_db("crypto", items)
            elif resp.status_code == 429:
                logger.warning("NewsAPI quota exceeded for crypto lang=%s", l)
            else:
                logger.warning("NewsAPI crypto returned %s for lang=%s: %s",
                               resp.status_code, l, resp.text[:200])
        except Exception as e:
            logger.error("NewsAPI crypto request failed for lang=%s: %s", l, e)

    return result


# ── Fallback: SearchService ──────────────────────────────────────────────

def _fetch_via_search_service(lang: str) -> Dict[str, List[Dict[str, Any]]]:
    """Fallback: use SearchService (DuckDuckGo) for news."""
    import time as _t
    result: Dict[str, List[Dict[str, Any]]] = {}

    try:
        from app.services.search import SearchService
        search = SearchService()

        lang_groups = ["en", "cn", "ja", "ko", "de", "fr", "ar", "th", "vi"]
        if lang != "all":
            lang_groups = [lang] if lang in lang_groups else ["en"]

        for lg in lang_groups:
            queries = _FALLBACK_QUERIES.get(lg, _FALLBACK_QUERIES["en"])
            items = []
            for qi, query in enumerate(queries):
                if qi > 0:
                    _t.sleep(0.6)  # stagger DuckDuckGo requests to avoid rate limiting
                try:
                    results = search.search(query, num_results=4, date_restrict="d1")
                    for r in results:
                        items.append({
                            "title": r.get("title", ""),
                            "link": r.get("link", ""),
                            "snippet": r.get("snippet", ""),
                            "source": r.get("source", ""),
                            "published": r.get("published", ""),
                            "category": query,
                            "lang": lg,
                        })
                except Exception:
                    pass
            if items:
                seen = set()
                unique = []
                for news in items:
                    link = news.get("link", "")
                    if link and link not in seen:
                        seen.add(link)
                        unique.append(news)
                result[lg] = unique[:12]
            if lg != lang_groups[-1]:
                _t.sleep(1.0)  # extra delay between language batches

    except Exception as e:
        logger.error("SearchService fallback failed: %s", e)

    return result


# ── Main entry ───────────────────────────────────────────────────────────

def fetch_financial_news(lang: str = "all", category: str = "all",
                         page: int = 1,
                         page_size: int = _PAGE_SIZE_DEFAULT
                         ) -> Dict[str, Any]:
    """Fetch financial news: DB → NewsAPI(business + crypto) → SearchService.

    Args:
        lang: Language filter — ``"all"``, ``"en"``, ``"cn"``, etc.
        category: Category filter — ``"all"``, ``"business"``, ``"crypto"``.
        page: Page number (1-based) for DB cache pagination.
        page_size: Items per page.

    Returns:
        Dict with keys: ``articles`` (dict by lang), ``total``, ``page``, ``page_size``.
    """
    total = 0

    # Determine which categories to fetch
    categories_to_fetch = []
    if category == "all":
        categories_to_fetch = ["business", "crypto"]
    else:
        categories_to_fetch = [category]

    # Try DB cache first for each category
    cached = {}
    needs_refresh = {}
    db_pagination = {"total": 0, "page": page, "page_size": page_size}
    for cat in categories_to_fetch:
        res = _news_from_db(cat, lang, page=1, page_size=99999)
        if res and res.get("articles"):
            arts = res["articles"]
            for l, items in arts.items():
                cached.setdefault(l, []).extend(items)
            db_pagination["total"] += res.get("total", 0)
        else:
            needs_refresh[cat] = True

    # If we have fresh cached data, return it (with global pagination)
    have_all = all(len(cached.get(l, [])) > 0
                   for l in (langs_to_query if lang == "all" else [lang]))
    if not needs_refresh and have_all:
        lang_order = ["en", "cn", "ja", "ko", "de", "fr", "ar", "th", "vi"]
        all_items = []
        for l in lang_order:
            if l in cached:
                all_items.extend(cached[l])
        offset = (page - 1) * page_size
        paged = all_items[offset:offset + page_size]
        paged_cached: Dict[str, List[Dict[str, Any]]] = {}
        for item in paged:
            l = item.get("lang", "en")
            paged_cached.setdefault(l, []).append(item)
        _purge_old_news()
        return {
            "articles": paged_cached,
            "total": db_pagination["total"],
            "page": page,
            "page_size": page_size,
        }

    # Fetch from NewsAPI for stale/missing categories
    api_key = _get_api_key()
    if api_key:
        for cat in (needs_refresh if needs_refresh else categories_to_fetch):
            if cat == "business":
                res = _fetch_newsapi_business(lang)
                for l, items in res.items():
                    cached.setdefault(l, []).extend(items)
            elif cat == "crypto":
                res = _fetch_newsapi_crypto(lang)
                for l, items in res.items():
                    cached.setdefault(l, []).extend(items)

    # Fallback: if still empty, try SearchService
    total = sum(len(v) for v in cached.values())
    if total == 0:
        logger.info("NewsAPI returned no data, falling back to SearchService")
        res = _fetch_via_search_service(lang)
        for l, items in res.items():
            cached.setdefault(l, []).extend(items)
        total = sum(len(v) for v in cached.values())

    # After fresh fetches, use flat total (DB pagination may be stale from cache miss)
    if total > db_pagination["total"]:
        db_pagination["total"] = total

    # If still no data from any source, fall back to stale DB cache
    if total == 0 and needs_refresh:
        logger.info("All news sources failed, falling back to stale DB cache")
        for cat in categories_to_fetch:
            res = _news_from_db(cat, lang, max_minutes=99999, page=1, page_size=99999)
            if res and res.get("articles"):
                arts = res["articles"]
                for l, items in arts.items():
                    cached.setdefault(l, []).extend(items)
                db_pagination["total"] += res.get("total", 0)
        total = sum(len(v) for v in cached.values())
        if total > db_pagination["total"]:
            db_pagination["total"] = total

    # Global pagination: flatten, slice, regroup across all categories/langs
    lang_order = ["en", "cn", "ja", "ko", "de", "fr", "ar", "th", "vi"]
    all_items = []
    for l in lang_order:
        if l in cached:
            all_items.extend(cached[l])
        elif l in (langs_to_query if lang == "all" else [lang]):
            pass
    global_total = len(all_items)

    offset = (page - 1) * page_size
    paged = all_items[offset:offset + page_size]

    paged_cached: Dict[str, List[Dict[str, Any]]] = {}
    for item in paged:
        l = item.get("lang", "en")
        paged_cached.setdefault(l, []).append(item)

    _purge_old_news()
    return {
        "articles": paged_cached,
        "total": db_pagination["total"] or global_total,
        "page": page,
        "page_size": page_size,
    }


langs_to_query = ["en", "cn", "ja", "ko", "de", "fr", "ar", "th", "vi"]


# ── Economic calendar (template) ─────────────────────────────────────────

_SAMPLE_EVENTS = [
    {"name": "美国非农就业数据", "name_en": "US Non-Farm Payrolls", "country": "US", "importance": "high", "forecast": "180K", "previous": "175K", "impact_if_above": "bullish", "impact_if_below": "bearish", "impact_desc": "高于预期利多美元/美股，低于预期利空", "impact_desc_en": "Above forecast: bullish USD/stocks; Below: bearish"},
    {"name": "美联储利率决议", "name_en": "Fed Interest Rate Decision", "country": "US", "importance": "high", "forecast": "5.25%", "previous": "5.25%", "impact_if_above": "bearish", "impact_if_below": "bullish", "impact_desc": "加息利空股市/加密货币，降息利多", "impact_desc_en": "Rate hike: bearish stocks/crypto; Cut: bullish"},
    {"name": "美国CPI月率", "name_en": "US CPI m/m", "country": "US", "importance": "high", "forecast": "0.3%", "previous": "0.4%", "impact_if_above": "bearish", "impact_if_below": "bullish", "impact_desc": "CPI高于预期增加加息预期，利空股市", "impact_desc_en": "Higher CPI increases rate hike expectations, bearish stocks"},
    {"name": "欧洲央行利率决议", "name_en": "ECB Interest Rate Decision", "country": "EU", "importance": "high", "forecast": "4.50%", "previous": "4.50%", "impact_if_above": "bearish", "impact_if_below": "bullish", "impact_desc": "加息利空欧股，利多欧元", "impact_desc_en": "Rate hike: bearish EU stocks, bullish EUR"},
    {"name": "日本央行利率决议", "name_en": "BoJ Interest Rate Decision", "country": "JP", "importance": "high", "forecast": "0.10%", "previous": "0.10%", "impact_if_above": "bullish", "impact_if_below": "bearish", "impact_desc": "加息预期利多日元，利空日股", "impact_desc_en": "Rate hike expectation: bullish JPY, bearish Nikkei"},
    {"name": "美国初请失业金人数", "name_en": "US Initial Jobless Claims", "country": "US", "importance": "medium", "forecast": "215K", "previous": "212K", "impact_if_above": "bearish", "impact_if_below": "bullish", "impact_desc": "失业人数上升利空美元，利多黄金", "impact_desc_en": "Rising claims: bearish USD, bullish gold"},
    {"name": "英国央行利率决议", "name_en": "BoE Interest Rate Decision", "country": "UK", "importance": "high", "forecast": "5.25%", "previous": "5.25%", "impact_if_above": "bullish", "impact_if_below": "bearish", "impact_desc": "加息利多英镑，利空英股", "impact_desc_en": "Rate hike: bullish GBP, bearish UK stocks"},
    {"name": "美国零售销售月率", "name_en": "US Retail Sales m/m", "country": "US", "importance": "medium", "forecast": "0.4%", "previous": "0.6%", "impact_if_above": "bullish", "impact_if_below": "bearish", "impact_desc": "零售数据强劲利多美元和美股", "impact_desc_en": "Strong retail: bullish USD and stocks"},
    {"name": "OPEC月度报告", "name_en": "OPEC Monthly Report", "country": "INTL", "importance": "medium", "forecast": "-", "previous": "-", "impact_if_above": "bullish", "impact_if_below": "bearish", "impact_desc": "减产预期利多原油，增产预期利空", "impact_desc_en": "Production cut: bullish oil; Increase: bearish"},
    {"name": "比特币减半预期", "name_en": "Bitcoin Halving Outlook", "country": "INTL", "importance": "high", "forecast": "-", "previous": "-", "impact_if_above": "bullish", "impact_if_below": "bearish", "impact_desc": "减半预期通常利多比特币和整个加密货币市场", "impact_desc_en": "Halving expectations are typically bullish for BTC and crypto market"},
    {"name": "加密货币ETF资金流", "name_en": "Crypto ETF Flow Data", "country": "US", "importance": "medium", "forecast": "Net Positive", "previous": "Net Positive", "impact_if_above": "bullish", "impact_if_below": "bearish", "impact_desc": "ETF资金持续流入利多加密货币，流出利空", "impact_desc_en": "Sustained ETF inflows bullish for crypto, outflows bearish"},
    {"name": "加密货币监管动态", "name_en": "Crypto Regulation Update", "country": "INTL", "importance": "medium", "forecast": "-", "previous": "-", "impact_if_above": "bullish", "impact_if_below": "bearish", "impact_desc": "利好监管利多市场，严监管利空", "impact_desc_en": "Favorable regulation bullish, strict regulation bearish"},
]

# Add crypto category tag
for evt in _SAMPLE_EVENTS:
    if "比特币" in evt["name"] or "加密" in evt["name"] or "crypto" in evt["name"].lower() or "Crypto" in evt.get("name_en", ""):
        evt["category"] = "crypto"
    else:
        evt["category"] = "macro"


def get_economic_calendar() -> List[Dict[str, Any]]:
    """Generate economic calendar events with impact indicators."""
    today = datetime.now()
    events = []

    for i, evt in enumerate(_SAMPLE_EVENTS):
        days_offset = i % 14 - 6
        event_date = today + timedelta(days=days_offset)
        hour = (8 + (i * 3)) % 24

        is_released = event_date.date() < today.date() or (
            event_date.date() == today.date() and hour < today.hour
        )

        actual_value = None
        actual_impact = None
        expected_impact = evt["impact_if_above"]

        if is_released:
            forecast_num = "".join(filter(lambda x: x.isdigit() or x == ".", evt["forecast"]))
            if forecast_num:
                try:
                    base = float(forecast_num)
                    variation = random.uniform(-0.15, 0.15)
                    actual_num = base * (1 + variation)
                    if "K" in evt["forecast"]:
                        actual_value = f"{actual_num:.0f}K"
                    elif "%" in evt["forecast"]:
                        actual_value = f"{actual_num:.2f}%"
                    else:
                        actual_value = f"{actual_num:.2f}"
                    if actual_num > base:
                        actual_impact = evt["impact_if_above"]
                    elif actual_num < base:
                        actual_impact = evt["impact_if_below"]
                    else:
                        actual_impact = "neutral"
                except Exception:
                    actual_value = evt["forecast"]
                    actual_impact = "neutral"
            else:
                actual_value = evt["forecast"]
                actual_impact = "neutral"

        events.append({
            "id": i + 1,
            "name": evt["name"], "name_en": evt["name_en"],
            "country": evt["country"],
            "date": event_date.strftime("%Y-%m-%d"),
            "time": f"{hour:02d}:30",
            "importance": evt["importance"],
            "category": evt.get("category", "macro"),
            "actual": actual_value, "forecast": evt["forecast"], "previous": evt["previous"],
            "impact_if_above": evt["impact_if_above"], "impact_if_below": evt["impact_if_below"],
            "impact_desc": evt["impact_desc"], "impact_desc_en": evt["impact_desc_en"],
            "expected_impact": expected_impact, "actual_impact": actual_impact,
            "is_released": is_released,
        })

    events.sort(key=lambda x: (x["date"], x["time"]))
    return events
