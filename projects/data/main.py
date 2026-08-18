"""
data-service — Unified market data API for all asset classes.

InfraX microservice `infrax-data` (:9112).
Provides REST endpoints for:
  - Historical K-line data (/bars)
  - Technical / external / snapshot factors (/factors/*)
  - Complex snapshots (heatmap, calendar, indices, tvl, volatility) (/snapshots)
  - Database stats (/stats)
  - Health (/health, InfraX standard format)

Configuration: .env file at project root, or environment variables.
"""

import os
import json
import logging
import time
import hmac
import threading
import asyncio

# ── Load .env (must happen before any app imports) ─────────
from pathlib import Path

_env_path = Path(__file__).resolve().parent / ".env"
if _env_path.exists():
    with open(_env_path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, _, val = line.partition("=")
                key, val = key.strip(), val.strip().strip("\"'")
                if key and key not in os.environ:
                    os.environ[key] = val
from fastapi import FastAPI, Query, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from typing import Optional

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))  # .env loaded above
logger = logging.getLogger(__name__)

# 统一鉴权契约（app_auth）：先导入 app.config 触发 sys.path 引导（../shared）
import app.config  # noqa: E402
import app_auth  # noqa: E402
from app import api_keys  # noqa: E402  (多租户 key 签发，导入时幂等建表)

app = FastAPI(
    title="InfraX Data Service",
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,  # "*" 与 credentials=True 是不安全组合（违反 CORS 规范）
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── 统一错误响应体（D2，9.7-7.1-⑥ 关联待办）───────────────────
# 所有非鉴权错误统一包装为 {code, message, data}：
#   - 422 校验错误 / HTTPException / 未捕获异常 → {"code": <status>, "message": ..., "data": null}
# 对齐 ragservicer / ml-service 业务端点结构。
# 鉴权 401 同样统一 {code: 401, message: "unauthorized", data: null}（B 端反馈 P2-6）。

def _error_body(code: int, message: str) -> dict:
    return {"code": code, "message": message, "data": None}


@app.exception_handler(RequestValidationError)
async def _validation_error_handler(request: Request, exc: RequestValidationError):
    errors = [
        {"loc": ".".join(str(p) for p in e.get("loc", [])), "msg": e.get("msg", ""), "type": e.get("type", "")}
        for e in exc.errors()
    ]
    body = _error_body(422, "Validation error")
    body["data"] = errors
    return JSONResponse(status_code=422, content=body)


@app.exception_handler(StarletteHTTPException)
async def _http_error_handler(request: Request, exc: StarletteHTTPException):
    """覆盖 FastAPI/Starlette HTTPException（含 404 路由未匹配）→ 统一 {code, message, data}。"""
    return JSONResponse(status_code=exc.status_code, content=_error_body(exc.status_code, str(exc.detail)))


@app.exception_handler(Exception)
async def _unhandled_error_handler(request: Request, exc: Exception):
    logger.error("Unhandled error on %s: %s", request.url.path, exc, exc_info=True)
    return JSONResponse(status_code=500, content=_error_body(500, str(exc)))


# ── Health ─────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"code": 0, "message": "ok", "data": {"service": "infrax-data", "version": "1.0.0"}}


# ── Access log (every HTTP request) ────────────────────────────

@app.middleware("http")
async def _access_log(request, call_next):
    """统一请求日志：method / path / query / client / status / 耗时。"""
    start = time.monotonic()
    try:
        response = await call_next(request)
    except Exception:
        logger.exception("Request failed: %s %s?%s", request.method, request.url.path, request.url.query)
        raise
    duration_ms = (time.monotonic() - start) * 1000
    client = request.client.host if request.client else "-"
    logger.info(
        "%s %s?%s -> %d (%.1fms) client=%s",
        request.method,
        request.url.path,
        (request.url.query[:200] if request.url.query else ""),
        response.status_code,
        duration_ms,
        client,
    )
    return response


# ── Rate limiting（G-3）────────────────────────────────────────
# 按 client IP 限流（TokenBucket），超限 429 {code,message,data}。
# RATE_LIMIT_ENABLED 默认 true；/health 与 /admin/* 豁免。
from app.rate_limit import rate_limit_middleware  # noqa: E402

app.middleware("http")(rate_limit_middleware)


# ── Prometheus /metrics（G-6）─────────────────────────────────
# 请求指标 + GET /metrics（app_auth 已豁免 /metrics，探针免 key 拉取）。
from metrics import register_fastapi  # noqa: E402

register_fastapi(app, "data")


# ── 可选响应信封（G-2）────────────────────────────────────────
# 默认成功响应保持裸字段（向后兼容）；请求带 ?envelope=1 或
# X-Envelope: 1 时统一包装为 {code, message, data}，对齐 Flask 服务信封。
from envelope import install_envelope_middleware  # noqa: E402

install_envelope_middleware(app)


# ── Business endpoint auth (Bearer / X-API-Key / X-Service-Key) ─
# 业务端点统一鉴权（DS-12，契约见 AITRADER_DATA_SERVICE_REQ.md）：
#   - 配置了 DATA_API_KEY → 要求 Authorization: Bearer 或 X-API-Key 或
#     X-Service-Key 任一匹配，否则 401 {"detail": "unauthorized"}
#   - 未配置 → 保持开放（向后兼容，配置 key 即启用强制校验）
# /health 豁免；/admin/* 沿用 ADMIN_API_KEY 校验。
# 实现复用全平台统一契约 app_auth（projects/shared/app_auth.py）。


def _api_auth_status(request) -> int | None:
    """鉴权结果：None=放行，否则返回 HTTP 状态码（401/403/429）。

    校验顺序：平台 bridge key / 只读监控 key（app_auth 统一契约）→
    签发的多租户 key（api_keys 表，仅存哈希）。任一命中即放行；
    未配置任何 key 时开放（向后兼容）。
    """
    from app.config import DATA_API_KEY, MONITOR_API_KEY
    if app_auth.is_authorized(
        request.headers.get, DATA_API_KEY,
        method=request.method, monitor_key=MONITOR_API_KEY,
    ):
        return None
    key = app_auth.extract_api_key(request.headers.get)
    if not key:
        return 401
    return api_keys.verify(key) or None


@app.middleware("http")
async def _api_auth(request, call_next):
    # B 端反馈（P2-5）：docs/redoc/openapi.json 公开免 key（与 /health /metrics 同级），
    # 便于调用方直接访问 /api/data/docs 与 /api/data/openapi.json 获取文档。
    if not app_auth.is_exempt(
        request.url.path,
        exact={"/health", "/metrics", "/docs", "/redoc", "/openapi.json"},
        # /admin/* 由 ADMIN_API_KEY 校验；/api/v2/data/my-keys* 由钱包签名自校验
        prefixes=("/admin/", "/api/v2/data/my-keys"),
    ):
        status = _api_auth_status(request)
        if status == 401:
            # B 端反馈（P2-6）：鉴权失败统一 {code, message, data}，与平台一致
            return JSONResponse(status_code=401, content={"code": 401, "message": "unauthorized", "data": None})
        if status:
            message = {403: "API key disabled", 429: "Rate limit exceeded"}.get(status, "unauthorized")
            return JSONResponse(status_code=status, content={"code": status, "message": message, "data": None})
    return await call_next(request)


# ═══════════════════════════════════════════════════════════════
#  Data Service — SQLite-backed bars / factors / snapshots
# ═══════════════════════════════════════════════════════════════

# ── Bars (unified OHLCV + indicators + external factors) ──────

@app.get("/bars")
async def get_bars(
    symbol: str = Query(..., description="Symbol, e.g. BTC/USDT"),
    timeframe: str = Query("1m", description="Timeframe: 1m/5m/15m/30m/1h/4h/1d"),
    market_type: Optional[str] = Query(None, pattern="^(spot|swap)$", description="Crypto market type: spot | swap"),
    start: Optional[int] = Query(None, description="Start unix ms"),
    end: Optional[int] = Query(None, description="End unix ms"),
    limit: int = Query(500, ge=1, le=5000),
):
    """Unified bar data: OHLCV + pre-computed indicators + external factors.

    market_type=swap 时 symbol 按 ccxt 惯例 ``BTC/USDT:USDT`` 存储键查询
    （spot/swap 数据互不混淆，DS-8 方案 A）。
    market_type 未传时按 symbol 自动判定：带 ``:quote`` 后缀 → swap，否则 spot
    （B 端反馈：BTC/USDT:USDT 需回显 swap 而非 spot）。
    """
    try:
        from app.enrich import query_bars
        from app.utils.timeutil import normalize_ms
        if market_type is None:
            market_type = "swap" if ":" in symbol else "spot"
        # DQ-3: 入口时间戳精度归一化（秒级 start/end 自动 ×1000）
        bars = query_bars(symbol=symbol, timeframe=timeframe, market_type=market_type,
                          start=normalize_ms(start), end=normalize_ms(end), limit=limit)
        return {"symbol": symbol, "timeframe": timeframe, "market_type": market_type,
                "count": len(bars), "bars": bars}
    except Exception as e:
        logger.error(f"/bars failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ── Ticker (realtime quote, DS-7) ──────────────────────────────

@app.get("/ticker")
async def ticker(
    symbol: str = Query(..., description="Symbol, e.g. BTC/USDT"),
    market_type: Optional[str] = Query(None, pattern="^(spot|swap)$", description="Crypto market type: spot | swap"),
    exchange_id: Optional[str] = Query(None, description="Crypto exchange (default: binance)"),
    market: Optional[str] = Query(None, description="Market hint: crypto/usstock/forex/futures/cnstock/hkstock"),
):
    """Realtime quote aligned with AItrader KlineService.get_realtime_price.

    Returns {symbol, price, change, changePercent, high, low, open, previousClose, ts}.
    Data sources: crypto → ccxt; usstock/forex/futures → yfinance + Twelve Data 备用;
    cnstock/hkstock → Tencent.
    Falls back to latest 1d kline bar when realtime source unavailable (fail-silent).
    market_type 未传时按 symbol 自动判定（带 ``:quote`` 后缀 → swap，B 端反馈修复）。
    """
    try:
        from app.ticker import get_ticker
        if market_type is None:
            market_type = "swap" if ":" in symbol else "spot"
        data = get_ticker(symbol=symbol, market_type=market_type,
                          exchange_id=exchange_id, market=market)
    except Exception as e:
        logger.error(f"/ticker failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    if data is None:
        raise HTTPException(status_code=404, detail=f"No quote data for {symbol}")
    # B 端反馈（P0-2）：回显 market_type，C2 切换依赖它区分 spot/swap（与 /bars 一致）
    data = dict(data)
    data["market_type"] = market_type
    return data


# ── P2 单模型预测历史（ml_predictions 明细，§5.7） ────────────

@app.get("/ml/predictions")
async def ml_predictions(
    model: str = Query(..., pattern="^(bolt|moirai|timesfm)$", description="P2 model: bolt|moirai|timesfm"),
    symbol: str = Query(..., description="Symbol, e.g. BTC or BTC/USDT"),
    start: Optional[int] = Query(None, description="Start unix ms"),
    end: Optional[int] = Query(None, description="End unix ms"),
    limit: int = Query(500, ge=1, le=5000),
):
    """P2 单模型预测历史（明细表 ml_predictions）。

    返回 {model, symbol, count, predictions: [{generated_at, direction, prob_up,
    uncertainty, point_forecast, quantiles}, ...]}，按 generated_at 升序。
    """
    try:
        from app.factors import query_ml_predictions
        rows = query_ml_predictions(model=model, symbol=symbol, start=start, end=end, limit=limit)
    except Exception as e:
        logger.error(f"/ml/predictions failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    if not rows:
        raise HTTPException(status_code=404, detail=f"No predictions for model={model} symbol={symbol}")
    return {"model": model, "symbol": symbol, "count": len(rows), "predictions": rows}


# ── Factors Catalog ────────────────────────────────────────────

@app.get("/factors/catalog")
async def factors_catalog():
    """All available factors for AI strategy building."""
    try:
        from app.factors import get_catalog
        return {"factors": get_catalog()}
    except Exception as e:
        logger.error(f"/factors/catalog failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ── Factors Current ────────────────────────────────────────────

@app.get("/factors/current")
async def factors_current(
    symbols: str = Query("BTC", description="Comma-separated symbols"),
    category: Optional[str] = Query(None, description="Filter: external/sentiment/news/opportunities/heatmap/calendar/snapshot"),
):
    """Latest factor values (for live trading FactorClient).

    Use ?category= to filter by data source:
      - external: fear_greed, vix, dxy, us10y
      - heatmap: crypto heatmap by category
      - calendar: upcoming economic events
      - snapshot: crypto prices, indices, on-chain, defi, volatility, macro, earnings
    """
    try:
        from app.factors import get_current_factors
        sym_list = [s.strip() for s in symbols.split(",") if s.strip()]
        result = get_current_factors(sym_list, category=category)
        # DQ-4: 因子新鲜度元数据（age_ms / fresh）随响应返回
        meta = result.pop("_meta", {})
        response = {"ts": result.pop("_ts", 0), "meta": meta, "factors": result}
        # FF-3.3/3.4: 透传 ml-service 因子工厂激活因子 + 实时值（客户端免复算公式）。
        # 放线程池执行：ml-service /factors/values 会回调 data-service /bars，
        # 同步请求在 async 端点里会阻塞事件循环造成跨服务死锁。
        try:
            from app.ml_client import fetch_factor_factory_activations, fetch_factor_factory_values
            ff = await asyncio.to_thread(fetch_factor_factory_activations)
            if ff:
                vals = await asyncio.to_thread(fetch_factor_factory_values, sym_list)
                if vals:
                    ff["values"] = vals.get("values", {})
                response["ml_factory"] = ff
        except Exception:
            pass
        # GX-1.5: 图谱因子 passthrough（ml-service graph 引擎，60s TTL，fail-silent）
        try:
            from app.ml_client import fetch_graph_catalog, fetch_graph_factors
            gvals = await asyncio.to_thread(fetch_graph_factors, sym_list)
            if gvals and gvals.get("values"):
                response["graph"] = {
                    "updated_at": gvals.get("updated_at", 0),
                    "values": {sym: v for sym, v in gvals["values"].items() if sym in set(sym_list)},
                }
                gc = await asyncio.to_thread(fetch_graph_catalog)
                if gc:
                    response["graph"]["catalog"] = gc
        except Exception:
            pass
        return response
    except Exception as e:
        logger.error(f"/factors/current failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ── Crypto Derivatives（GX-3.5.3 资金费率数据面，db_cache 读取） ──

@app.get("/factors/crypto-derivatives")
async def factors_crypto_derivatives(
    symbols: str = Query("BTC", description="Comma-separated symbols"),
):
    """最新衍生品资金费率/持仓/多空比（db_cache collector:crypto_factors:{sym}）。

    ml-service 图谱引擎 GX-3.5.3 资金费率数据面读取端点：funding_rate /
    open_interest / open_interest_change_24h / long_short_ratio（Coinglass
    主源 + Binance 兜底，ttl 300s）。fail-silent：缓存缺失/DB 不可用 → 空 factors。
    """
    try:
        from app.data_providers.db_cache import db_cache_get
        sym_list = [s.strip() for s in symbols.split(",") if s.strip()]
        factors: dict = {}
        for sym in sym_list:
            base = sym.split("/", 1)[0].split(":", 1)[0].strip().upper()
            if not base:
                continue
            raw = db_cache_get(f"collector:crypto_factors:{base}")
            if not isinstance(raw, dict) or not raw:
                continue
            factors[base] = {
                "funding_rate": raw.get("funding_rate"),
                "open_interest": raw.get("open_interest"),
                "open_interest_change_24h": raw.get("open_interest_change_24h"),
                "long_short_ratio": raw.get("long_short_ratio"),
                "signals": raw.get("signals"),
            }
        return {"ts": int(time.time() * 1000), "factors": factors}
    except Exception as e:
        logger.error(f"/factors/crypto-derivatives failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ── Factors History ────────────────────────────────────────────

@app.get("/factors/history")
async def factors_history(
    symbol: str = Query(..., description="Symbol (e.g. BTC/USDT or BTCUSDT)"),
    timeframe: str = Query("1m", description="Candle timeframe (e.g. 1m, 1h, 4h, 1d)"),
    ids: Optional[str] = Query(None, description="Comma-separated factor ids to include"),
    start: Optional[int] = Query(None, description="Start ts (ms)"),
    end: Optional[int] = Query(None, description="End ts (ms)"),
    limit: int = Query(500, ge=1, le=5000),
):
    """Per-bar factor time series for backtests / factor research.

    Returns technical factors (rsi_14/macd/bb/atr/ma_*) aligned to candle
    timestamps so a consumer can reproduce live factor values bar-by-bar.
    ``ts`` is in milliseconds, matching /bars.
    """
    try:
        from app.factors import get_history_factors
        from app.utils.timeutil import normalize_ms
        id_list = [i.strip() for i in ids.split(",") if i.strip()] if ids else None
        return get_history_factors(
            symbol=symbol,
            timeframe=timeframe,
            ids=id_list,
            # DQ-3: 入口时间戳精度归一化（秒级 start/end 自动 ×1000）
            start=normalize_ms(start),
            end=normalize_ms(end),
            limit=limit,
        )
    except Exception as e:
        logger.error(f"/factors/history failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ── Stats ──────────────────────────────────────────────────────

@app.get("/stats")
async def stats():
    """Database stats: row counts, coverage range."""
    try:
        from app.storage import get_db
        db = get_db()
        kline_count = db.execute("SELECT COUNT(*) FROM kline").fetchone()[0]
        snap_count = db.execute("SELECT COUNT(*) FROM raw_snapshots").fetchone()[0]
        symbol_count = db.execute("SELECT COUNT(DISTINCT symbol) FROM kline").fetchone()[0]
        time_range = db.execute(
            "SELECT MIN(ts), MAX(ts) FROM kline"
        ).fetchone()
        # DQ-6: 数据质量指标（missing_rate / abnormal_bars / source_freshness）
        from app.cleaning import quality_stats
        quality = quality_stats(db)
        return {
            "kline_rows": kline_count,
            "snapshot_rows": snap_count,
            "symbols": symbol_count,
            "time_start": time_range[0],
            "time_end": time_range[1],
            "quality": quality,
        }
    except Exception as e:
        logger.error(f"/stats failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/symbols")
async def symbols(
    timeframe: str = Query("1d", description="Timeframe: 1m/5m/15m/30m/1h/4h/1d"),
    min_bars: int = Query(1, ge=1, description="Minimum bar count per symbol"),
):
    """Symbols with enough bars in a timeframe (ascending by name).

    ml-service 用此端点发现可训练的 symbol（LightGBM 方向预测）。
    """
    try:
        from app.storage import get_db
        db = get_db()
        timeframe = timeframe.strip().lower()  # 存储键小写（1D → 1d），大小写不敏感
        rows = db.execute(
            """SELECT symbol, COUNT(*) AS n FROM kline
               WHERE timeframe = ? GROUP BY symbol HAVING n >= ?""",
            (timeframe, min_bars),
        ).fetchall()
        return {
            "timeframe": timeframe,
            "min_bars": min_bars,
            "symbols": sorted(r["symbol"] for r in rows),
        }
    except Exception as e:
        logger.error(f"/symbols failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/symbols/search")
async def symbols_search(
    keyword: str = Query(..., description="模糊关键字，如 btc / eth/ / apple"),
    market: str = Query("crypto", description="crypto | usstock | forex | futures | cnstock | hkstock"),
    limit: int = Query(20, ge=1, le=100, description="返回条数，默认 20，上限 100"),
):
    """符号模糊搜索（DS-9，P0）。

    对标单体 market.py 符号搜索：ccxt 全量市场（binance spot+swap，quote=USDT
    且 active）4h TTL 缓存 + 种子回退；usstock/forex/futures/cnstock/hkstock
    走在线 lookup（Finnhub/TwelveData/AkShare）+ 种子回退（DS-11 全市场覆盖）。
    """
    try:
        from app.symbol_search import search_symbols as _search

        return {"keyword": keyword, "symbols": _search(keyword, market, limit)}
    except Exception as e:
        logger.error(f"/symbols/search failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/symbol/resolve")
async def symbol_resolve(
    symbol: str = Query(..., description="符号关键字，如 BTC / BTC/USDT / EURUSD=X / apple"),
    market: str = Query("crypto", description="crypto | usstock | forex | futures | cnstock | hkstock"),
):
    """符号解析（DS-4）：单符号 → 标准交易对。

    契约（AITRADER_DATA_SERVICE_REQ.md DS-4）：
        GET /symbol/resolve?symbol=BTC → {"query": "BTC", "resolved": "BTCUSDT"}
    解析失败返回 404。全市场覆盖（DS-11）：crypto 精确解析（binance spot 优先）；
    美股/外汇/期货/A股/港股 → 种子精确匹配 + 在线 lookup（Finnhub/TwelveData/AkShare）。
    """
    try:
        from app.symbol_search import resolve_symbol as _resolve

        resolved = _resolve(symbol, market)
        if not resolved:
            raise HTTPException(status_code=404, detail=f"Symbol '{symbol}' not resolvable")
        return {"query": symbol, "resolved": resolved, "market": market}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"/symbol/resolve failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# DS-5 券商市场策略（静态配置，契约见 AITRADER_DATA_SERVICE_REQ.md DS-5）
_BROKER_MARKET_POLICY = {
    "crypto": {
        "exchanges": [
            "Binance", "OKX", "Bybit", "Gate", "Kucoin", "Kraken",
            "HTX", "Bitget", "Deepcoin", "Coinbase",
        ],
        "default": "Binance",
    }
}


@app.get("/policy/broker-market")
async def policy_broker_market():
    """券商市场策略（DS-5）。

    契约（AITRADER_DATA_SERVICE_REQ.md DS-5）：
        GET /policy/broker-market
          → { "crypto": { "exchanges": [...], "default": "Binance" } }
    静态配置（crypto 主交易市场）；多市场扩展待 DS-11 决策。
    """
    return _BROKER_MARKET_POLICY


# ── Snapshots (complex data: heatmap, calendar, indices, etc.) ─

@app.get("/snapshots")
async def snapshots(
    type: Optional[str] = Query(None, description="Data type: heatmap/calendar/crypto_prices/indices/tvl/volatility/us_indicators/earnings/onchain"),
    provider: Optional[str] = Query(None, description="Provider filter (GX-3.4/3.5): moomoo_f10 等按标的落库的 provider，返回 {data_type: {symbol: payload}}"),
):
    """Return latest complex snapshot data.

    Use ?type= to filter by data type:
      - heatmap: crypto market heatmap by category
      - calendar: upcoming economic events (Finnhub or FOMC static)
      - crypto_prices: current prices from CoinGecko
      - indices: global stock indices
      - tvl: DeFi total value locked by chain
      - volatility: VXN/GVZ volatility indices
      - us_indicators: FRED macro indicators (CPI, GDP, etc.)
      - earnings: upcoming earnings reports
      - onchain: aggregate BTC on-chain data (btc_difficulty/btc_transfers/btc_hashrate, G-4)
    Use ?provider= to filter by provider (moomoo_f10: mm_f10/mm_short_capital per symbol,
    for ml-service graph engine GX-3.4/GX-3.5).
    """
    try:
        from app.factors import get_snapshots
        result = get_snapshots(type, provider=provider)
        return {"ts": result.pop("_ts", 0), "snapshots": result}
    except Exception as e:
        logger.error(f"/snapshots failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ── Macro history (FRED 观测值序列，1 年回填，供宏观趋势/ML 特征) ──

@app.get("/macro/history")
async def macro_history(
    series: Optional[str] = Query(None, description="Comma-separated FRED series ids (default: all)"),
    start: Optional[str] = Query(None, description="Start date YYYY-MM-DD"),
    end: Optional[str] = Query(None, description="End date YYYY-MM-DD"),
    limit: int = Query(5000, ge=1, le=50000),
):
    """Return FRED macro observation history grouped by series.

    ``series`` filters by FRED series id（CPIAUCSL/PAYEMS/FEDFUNDS...），
    返回的键为展示名（CPI/NFP/Fed Funds Rate，与 us_indicators 对齐）。
    """
    try:
        from app.factors import get_macro_history
        series_ids = [s.strip() for s in series.split(",") if s.strip()] if series else None
        return get_macro_history(series_ids=series_ids, start_date=start, end_date=end, limit=limit)
    except Exception as e:
        logger.error(f"/macro/history failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ── Admin Config (data-source API keys, hot-reload) ──────────

_ENV_PATH = Path(__file__).resolve().parent / ".env"

# 序列化 .env 的 read-modify-write，避免并发 PUT 丢更新
_env_write_lock = threading.Lock()

# 数据源 API key 变量（多 key 用逗号分隔，轮询取用）
_DATA_KEY_FIELDS = [
    "FRED_API_KEY", "NEWSAPI_API_KEY", "ADANOS_API_KEY", "FINNHUB_API_KEY",
    "TIINGO_API_KEY", "TWELVE_DATA_API_KEY", "ALPHA_VANTAGE_KEY",
    "COINGECKO_API_KEY", "CRYPTOCOMPARE_API_KEY", "FIRECRAWL_API_KEY",
    "TUSHARE_TOKEN",
]
_MASK = "********"


def _mask_secret(v: str) -> str:
    if not v:
        return ""
    if len(v) <= 8:
        return _MASK
    return f"{v[:4]}{_MASK}{v[-4:]}"


def _admin_authorized(request) -> bool:
    """校验 Bearer ADMIN_API_KEY。"""
    from app.config import ADMIN_API_KEY
    if not ADMIN_API_KEY:
        return False
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return False
    return hmac.compare_digest(auth[7:], ADMIN_API_KEY)


def _write_env_file(updates: dict[str, str]) -> None:
    """行级 replace-or-append 写 .env（与 ragservicer admin 一致）。

    加锁 + 原子写（临时文件 + os.replace）：
    - 并发 PUT 串行化 read-modify-write，避免丢更新
    - 写入中途进程崩溃不会损坏 .env（替换是原子的）
    """
    with _env_write_lock:
        if not _ENV_PATH.exists():
            _ENV_PATH.write_text("")
        lines = _ENV_PATH.read_text().splitlines()
        remaining = set(updates)
        out = []
        for line in lines:
            if not line.strip() or line.lstrip().startswith("#") or "=" not in line:
                out.append(line)
                continue
            key = line.split("=", 1)[0].strip()
            if key in updates:
                out.append(f"{key}={updates[key]}")
                remaining.discard(key)
            else:
                out.append(line)
        for key in remaining:
            out.append(f"{key}={updates[key]}")
        content = "\n".join(out) + "\n"
        tmp = _ENV_PATH.with_suffix(_ENV_PATH.suffix + ".tmp")
        tmp.write_text(content)
        os.replace(tmp, _ENV_PATH)


def _data_config_snapshot() -> dict:
    from app.config import APIKeys
    keys = {}
    for name in _DATA_KEY_FIELDS:
        all_keys = APIKeys.all(name)
        keys[name] = {
            "set": bool(all_keys),
            "key_count": len(all_keys),
            "keys": [_mask_secret(k) for k in all_keys],
        }
    return {
        "keys": keys,
        "env_file": str(_ENV_PATH),
        "hot_reload": True,
    }


@app.get("/admin/config")
async def admin_get_config(request: Request):
    if not _admin_authorized(request):
        raise HTTPException(status_code=401, detail="Missing or invalid admin key")
    return {"code": 0, "message": "ok", "data": _data_config_snapshot()}


@app.put("/admin/config")
async def admin_put_config(request: Request):
    if not _admin_authorized(request):
        raise HTTPException(status_code=401, detail="Missing or invalid admin key")
    body = await request.json()
    payload = body.get("keys") if isinstance(body, dict) else None
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="config.keys object required")

    updates: dict[str, str] = {}
    from app.config import APIKeys
    for name, value in payload.items():
        if name not in _DATA_KEY_FIELDS:
            continue
        if value is None:
            continue
        # 掩码占位 = 保持不变；列表/逗号串 → 多 key 池
        if isinstance(value, list):
            joined = ",".join(str(v).strip() for v in value if str(v).strip())
        else:
            s = str(value).strip()
            if s == _MASK:
                continue
            joined = s
        updates[name] = joined

    if updates:
        _write_env_file(updates)
        for k, v in updates.items():
            os.environ[k] = v
        APIKeys.reload()
        logger.info("Admin config updated: %s", ", ".join(sorted(updates)))
    return {"code": 0, "message": "ok", "data": _data_config_snapshot()}


# ── Admin status (数据源状态监控，9.3 待办) ──────────────────
# 返回：采集器运行状态 + 熔断器状态 + 各数据源最近落库时间 + key 配置概览。
# 鉴权与 /admin/config 一致（Bearer ADMIN_API_KEY）。


def _collector_status() -> list[dict]:
    """采集器运行状态：running 标志 + 线程存活 + 数据源注册时间。"""
    out = []
    now = time.time()
    for name, c in _COLLECTORS.items():
        running = bool(getattr(c, "_running", False))
        thread = getattr(c, "_thread", None)
        out.append({
            "name": name,
            "running": running,
            "thread_alive": bool(thread and thread.is_alive()),
            "thread_name": thread.name if thread else "",
        })
    out.sort(key=lambda x: x["name"])
    return out


def _circuit_breaker_status() -> dict:
    """熔断器状态：各数据源熔断/半开/正常 + 失败次数 + 最后错误。"""
    try:
        from app.data_sources.circuit_breaker import get_realtime_circuit_breaker
        return get_realtime_circuit_breaker().get_status()
    except Exception as e:
        logger.error("circuit_breaker status failed: %s", e)
        return {}


def _db_freshness() -> dict:
    """数据新鲜度：raw_snapshots 按 provider/data_type 最近落库 + kline 各 timeframe 覆盖。"""
    from app.storage import get_db
    db = get_db()
    result = {"snapshots": {}, "kline": {}}
    try:
        rows = db.execute(
            "SELECT provider, data_type, MAX(fetched_at) AS latest "
            "FROM raw_snapshots GROUP BY provider, data_type"
        ).fetchall()
        for r in rows:
            key = f"{r['provider']}/{r['data_type']}"
            result["snapshots"][key] = {"latest_fetched_ms": int(r["latest"])}
    except Exception as e:
        logger.error("snapshot freshness query failed: %s", e)
    try:
        rows = db.execute(
            "SELECT timeframe, COUNT(*) AS n, MIN(ts) AS t0, MAX(ts) AS t1 "
            "FROM kline GROUP BY timeframe"
        ).fetchall()
        for r in rows:
            result["kline"][r["timeframe"]] = {
                "rows": r["n"],
                "ts_start": r["t0"],
                "ts_end": r["t1"],
            }
    except Exception as e:
        logger.error("kline freshness query failed: %s", e)
    return result


@app.get("/admin/status")
async def admin_status(request: Request):
    if not _admin_authorized(request):
        raise HTTPException(status_code=401, detail="Missing or invalid admin key")
    data = {
        "collectors": _collector_status(),
        "circuit_breakers": _circuit_breaker_status(),
        "freshness": _db_freshness(),
        "keys": _data_config_snapshot(),
        "ts": int(time.time() * 1000),
    }
    return {"code": 0, "message": "ok", "data": data}


# ── Admin symbols (交易对热管理，9.3 待办) ──────────────────
# 支持动态添加/移除/全量替换交易对（无需重启）：
#   - crypto/swap → 更新 .env KL_SYMBOLS/KL_TIMEFRAMES/KL_SWAP_* + 运行时 set_runtime_symbols()
#   - us_stocks/forex/futures/cn_stocks/hk_stocks → 更新 data_config.json multi_kline.<market>
#     + kline_store.reload_multi_config()（下轮采集生效）
# 鉴权与 /admin/config 一致（Bearer ADMIN_API_KEY）。
# body: {"market": "crypto|swap|us_stocks|forex|futures|cn_stocks|hk_stocks",
#        "action": "add|remove|set", "symbols": [...], "timeframes": [...]}

_DATA_CONFIG_PATH = os.getenv("DATA_CONFIG_PATH", "data_config.json")
_MULTI_MARKETS = {"us_stocks", "forex", "futures", "cn_stocks", "hk_stocks"}


def _read_data_config() -> dict:
    try:
        return json.loads(Path(_DATA_CONFIG_PATH).read_text())
    except Exception:
        return {}


def _write_data_config(config: dict) -> None:
    tmp = Path(_DATA_CONFIG_PATH).with_suffix(".json.tmp")
    tmp.write_text(json.dumps(config, ensure_ascii=False, indent=2))
    os.replace(tmp, _DATA_CONFIG_PATH)


def _symbols_current(market: str) -> tuple[list, list]:
    """当前交易对/周期（crypto 系读 os.environ，multi 系读 data_config.json）。"""
    if market == "crypto":
        syms = [s.strip() for s in os.environ.get("KL_SYMBOLS", "").split(",") if s.strip()]
        tfs = [t.strip() for t in os.environ.get("KL_TIMEFRAMES", "").split(",") if t.strip()]
        return syms, tfs
    if market == "swap":
        syms = [s.strip() for s in os.environ.get("KL_SWAP_SYMBOLS", "").split(",") if s.strip()]
        tfs = [t.strip() for t in os.environ.get("KL_SWAP_TIMEFRAMES", "").split(",") if t.strip()]
        return syms, tfs
    # multi 市场：data_config.json multi_kline.<market>.symbols
    cfg = _read_data_config()
    mk = (cfg.get("multi_kline") or {}).get(market) or {}
    syms = [s["symbol"] for s in (mk.get("symbols") or [])]
    tfs = list(mk.get("timeframes") or [])
    return syms, tfs


def _apply_symbol_changes(market: str, action: str, symbols: list, timeframes: list) -> tuple[list, list]:
    """计算变更后的交易对/周期列表。"""
    cur_syms, cur_tfs = _symbols_current(market)
    if action == "add":
        out_syms = list(cur_syms)
        for s in symbols:
            if s not in out_syms:
                out_syms.append(s)
        out_tfs = list(cur_tfs)
        for t in timeframes:
            if t not in out_tfs:
                out_tfs.append(t)
    elif action == "remove":
        rm = set(symbols)
        out_syms = [s for s in cur_syms if s not in rm]
        out_tfs = [t for t in cur_tfs if t not in set(timeframes)]
    elif action == "set":
        out_syms = list(symbols)
        out_tfs = list(timeframes) if timeframes else cur_tfs
    else:
        raise HTTPException(status_code=400, detail=f"action must be add|remove|set, got {action!r}")
    return out_syms, out_tfs


def _persist_crypto(market: str, symbols: list, timeframes: list) -> None:
    """crypto/swap → 写 .env + os.environ + kline_store 运行时列表。"""
    from app.kline_store import set_runtime_symbols
    if market == "crypto":
        updates = {"KL_SYMBOLS": ",".join(symbols)}
        if timeframes:
            updates["KL_TIMEFRAMES"] = ",".join(timeframes)
        _write_env_file(updates)
        for k, v in updates.items():
            os.environ[k] = v
        set_runtime_symbols(symbols=symbols, timeframes=(timeframes or None))
    else:  # swap
        updates = {"KL_SWAP_SYMBOLS": ",".join(symbols)}
        if timeframes:
            updates["KL_SWAP_TIMEFRAMES"] = ",".join(timeframes)
        _write_env_file(updates)
        for k, v in updates.items():
            os.environ[k] = v
        set_runtime_symbols(swap_symbols=symbols, swap_timeframes=(timeframes or None))
    logger.info("Admin symbols updated %s: %s @ %s", market, symbols, timeframes)


def _persist_multi(market: str, symbols: list, timeframes: list) -> None:
    """multi 市场 → 更新 data_config.json multi_kline.<market> + 失效缓存。"""
    from app.kline_store import get_kline_store
    cfg = _read_data_config()
    mk = cfg.setdefault("multi_kline", {}).setdefault(market, {})
    merged = list(symbols)
    # 保留 name 字段（新 symbol 用自身作 name）
    new_symbols = []
    for s in merged:
        existing = next((x for x in (mk.get("symbols") or []) if x["symbol"] == s), None)
        new_symbols.append(existing or {"symbol": s, "name": s})
    mk["symbols"] = new_symbols
    if timeframes:
        mk["timeframes"] = list(timeframes)
    cfg["multi_kline"][market] = mk
    _write_data_config(cfg)
    try:
        get_kline_store().reload_multi_config()
    except Exception as e:
        logger.warning("reload_multi_config failed: %s", e)
    logger.info("Admin symbols updated %s: %s @ %s", market, merged, timeframes)


@app.put("/admin/symbols")
async def admin_put_symbols(request: Request):
    if not _admin_authorized(request):
        raise HTTPException(status_code=401, detail="Missing or invalid admin key")
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON body")
    market = (body.get("market") or "").strip().lower()
    action = (body.get("action") or "add").strip().lower()
    symbols = [str(s).strip() for s in (body.get("symbols") or []) if str(s).strip()]
    timeframes = [str(t).strip() for t in (body.get("timeframes") or []) if str(t).strip()]
    if not market or market not in ({"crypto", "swap"} | _MULTI_MARKETS):
        raise HTTPException(status_code=400, detail=f"market must be one of crypto|swap|{','.join(sorted(_MULTI_MARKETS))}")
    if not symbols:
        raise HTTPException(status_code=400, detail="symbols required")
    new_syms, new_tfs = _apply_symbol_changes(market, action, symbols, timeframes)
    if market in ("crypto", "swap"):
        _persist_crypto(market, new_syms, new_tfs)
    else:
        _persist_multi(market, new_syms, new_tfs)
    return {"code": 0, "message": "ok", "data": {
        "market": market, "action": action,
        "symbols": new_syms, "timeframes": new_tfs,
    }}


# ── Admin API keys（多租户 key 签发，B 端管理）─────────────────
# 复用旧栈 collector api_keys 模式（label / rate_limit / enabled /
# 用量跟踪 / 掩码列表 / 轮换），仅存 SHA-256 哈希不存明文。
# 签发 key 以 dx_ 开头，与 bridge key 等价可访问全部业务端点，
# 携带方式三 header 任一（Bearer / X-API-Key / X-Service-Key）。
# 完整 key 仅在创建/轮换响应返回一次。鉴权同 /admin/config（Bearer ADMIN_API_KEY）。


@app.get("/admin/api-keys")
async def admin_list_api_keys(request: Request):
    if not _admin_authorized(request):
        raise HTTPException(status_code=401, detail="Missing or invalid admin key")
    return {"code": 0, "message": "ok", "data": api_keys.list_keys()}


@app.post("/admin/api-keys")
async def admin_create_api_key(request: Request):
    if not _admin_authorized(request):
        raise HTTPException(status_code=401, detail="Missing or invalid admin key")
    body = await request.json()
    label = (body.get("label") or "").strip()
    if not label:
        raise HTTPException(status_code=400, detail="label required")
    scope = str(body.get("scope") or "data").strip()
    if scope not in api_keys.PREFIX_BY_SCOPE:
        raise HTTPException(
            status_code=400,
            detail=f"scope must be one of {sorted(api_keys.PREFIX_BY_SCOPE)}",
        )
    rate_limit = body.get("rate_limit")
    if rate_limit in (None, ""):
        rate_limit = None
    else:
        try:
            rate_limit = int(rate_limit)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="rate_limit must be an integer")
    raw, row = api_keys.create_key(label=label, rate_limit=rate_limit, created_by="admin", scope=scope)
    row["api_key"] = raw  # 完整 key 仅此一次可见
    logger.info("Admin api-key created: id=%s label=%s scope=%s", row["id"], label, scope)
    return {"code": 0, "message": "ok", "data": row}


@app.post("/api-keys/verify")
async def verify_api_key(request: Request):
    """校验外部签发 key（scope=mcp/payment/vault/mpc）。供各服务入站鉴权调用。

    该端点为业务端点（非 /admin/*），由 _api_auth 中间件统一鉴权
    （DATA_API_KEY / monitor / 签发的 dx_ key 任一放行），避免 ADMIN_API_KEY
    跨服务扩散。返回 0/200 → 有效；401 无效 / 403 禁用 / 429 限流。
    """
    body = await request.json() or {}
    api_key = str(body.get("api_key") or "").strip()
    scope = str(body.get("scope") or "mcp").strip().lower()
    if scope not in api_keys.PREFIX_BY_SCOPE:
        scope = "mcp"
    status = api_keys.verify(api_key, scope=scope)
    if status == 0:
        return {"code": 0, "message": "ok", "data": {"valid": True, "scope": scope}}
    message = {403: "API key disabled", 429: "Rate limit exceeded"}.get(status, "unauthorized")
    raise HTTPException(status_code=status, detail=message)


@app.patch("/admin/api-keys/{key_id}")
async def admin_update_api_key(key_id: int, request: Request):
    if not _admin_authorized(request):
        raise HTTPException(status_code=401, detail="Missing or invalid admin key")
    body = await request.json()
    label = body.get("label")
    enabled = body.get("enabled")
    rate_limit = body.get("rate_limit")
    if rate_limit not in (None, ""):
        try:
            rate_limit = int(rate_limit)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="rate_limit must be an integer")
    ok = api_keys.update_key(
        key_id,
        label=str(label).strip() if label is not None else None,
        enabled=enabled if enabled is not None else None,
        rate_limit=rate_limit if rate_limit is not None else None,
    )
    if not ok:
        raise HTTPException(status_code=404, detail="api key not found")
    return {"code": 0, "message": "ok", "data": {"updated": True}}


@app.post("/admin/api-keys/{key_id}/rotate")
async def admin_rotate_api_key(key_id: int, request: Request):
    if not _admin_authorized(request):
        raise HTTPException(status_code=401, detail="Missing or invalid admin key")
    raw = api_keys.rotate_key(key_id)
    if not raw:
        raise HTTPException(status_code=404, detail="api key not found")
    logger.info("Admin api-key rotated: id=%s", key_id)
    return {"code": 0, "message": "ok", "data": {"id": key_id, "api_key": raw}}


@app.delete("/admin/api-keys/{key_id}")
async def admin_delete_api_key(key_id: int, request: Request):
    if not _admin_authorized(request):
        raise HTTPException(status_code=401, detail="Missing or invalid admin key")
    ok = api_keys.delete_key(key_id)
    if not ok:
        raise HTTPException(status_code=404, detail="api key not found")
    logger.info("Admin api-key deleted: id=%s", key_id)
    return {"code": 0, "message": "ok", "data": {"deleted": True}}   # noqa: E501


# ═══════════════════════════════════════════════════════════════
#  B-11-3 用户级 key（/api/v2/data/my-keys）— web 门户"我的 keys"
#  鉴权：钱包签名（x-wallet-address + x-wallet-signature +
#  x-wallet-timestamp，EIP-191 "InfraX auth: <ts>"，24h TTL，waas 同款）。
#  owner 归属校验：仅可管理本人签发的 key。
# ═══════════════════════════════════════════════════════════════

def _wallet_owner(request: Request) -> str:
    from app import wallet_auth
    address = wallet_auth.verify_wallet_signature(dict(request.headers))
    if not address:
        raise HTTPException(status_code=401, detail="unauthorized")
    return address


@app.get("/api/v2/data/my-keys")
async def my_keys_list(request: Request):
    owner = _wallet_owner(request)
    keys = api_keys.list_by_owner(owner)
    return {"code": 0, "message": "ok", "data": {"owner": owner, "keys": keys}}


@app.post("/api/v2/data/my-keys")
async def my_keys_create(request: Request):
    owner = _wallet_owner(request)
    body = await request.json()
    label = (body.get("label") or "").strip()
    if not label:
        raise HTTPException(status_code=400, detail="label required")
    scope = str(body.get("scope") or "data").strip()
    if scope not in api_keys.PREFIX_BY_SCOPE:
        raise HTTPException(status_code=400, detail=f"scope must be one of {sorted(api_keys.PREFIX_BY_SCOPE)}")
    rate_limit = body.get("rate_limit")
    if rate_limit in (None, ""):
        rate_limit = None
    else:
        try:
            rate_limit = int(rate_limit)
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="rate_limit must be an integer")
    raw, row = api_keys.create_key(label=label, rate_limit=rate_limit, created_by=owner, scope=scope, owner=owner)
    row["api_key"] = raw  # 完整 key 仅此一次可见
    logger.info("User api-key created: owner=%s label=%s scope=%s", owner, label, scope)
    return {"code": 0, "message": "ok", "data": row}


@app.post("/api/v2/data/my-keys/{key_id}/rotate")
async def my_keys_rotate(key_id: int, request: Request):
    owner = _wallet_owner(request)
    if api_keys.get_owner_of(key_id) != owner:
        raise HTTPException(status_code=404, detail="api key not found")
    raw = api_keys.rotate_key(key_id)
    if not raw:
        raise HTTPException(status_code=404, detail="api key not found")
    logger.info("User api-key rotated: owner=%s id=%s", owner, key_id)
    return {"code": 0, "message": "ok", "data": {"id": key_id, "api_key": raw}}


@app.delete("/api/v2/data/my-keys/{key_id}")
async def my_keys_delete(key_id: int, request: Request):
    owner = _wallet_owner(request)
    if api_keys.get_owner_of(key_id) != owner:
        raise HTTPException(status_code=404, detail="api key not found")
    ok = api_keys.delete_key(key_id)
    if not ok:
        raise HTTPException(status_code=404, detail="api key not found")
    logger.info("User api-key deleted: owner=%s id=%s", owner, key_id)
    return {"code": 0, "message": "ok", "data": {"deleted": True}}


# ── Startup ────────────────────────────────────────────────────

# 采集器实例注册表（/admin/status 查询运行状态用）
_COLLECTORS: dict[str, object] = {}

@app.on_event("startup")
async def _startup():
    from app.storage import init_db
    init_db()
    from app.kline_store import get_kline_store
    get_kline_store().start()
    from app.collectors import (
        ExternalFactorCollector, CalendarCollector, SnapshotCollector, HeatmapCollector,
        NewsCollector, SentimentCollector, AdanosCollector, OpportunityCollector,
        FinbertSentimentCollector, TreeMlCollector, ConsensusCollector, P2MlCollector,
        GlobalMarketCollector, OnchainCollector, OkxChainosCollector, MacroHistoryCollector,
        MoomooMacroCollector, MoomooExtraCollector, CryptoFactorsCollector,
    )
    _collectors = [
        ("external_factors", ExternalFactorCollector()),
        ("calendar", CalendarCollector()),
        ("snapshots", SnapshotCollector()),
        ("macro_history", MacroHistoryCollector()),
        ("moomoo_macro", MoomooMacroCollector()),
        ("moomoo_extra", MoomooExtraCollector()),
        ("crypto_factors", CryptoFactorsCollector()),
        ("heatmap", HeatmapCollector()),
        ("news", NewsCollector()),
        ("sentiment", SentimentCollector()),
        ("adanos", AdanosCollector()),
        ("opportunities", OpportunityCollector()),
        ("finbert_sentiment", FinbertSentimentCollector()),
        ("tree_ml", TreeMlCollector()),
        ("consensus_ml", ConsensusCollector()),
        ("p2_ml", P2MlCollector()),
        ("global_market", GlobalMarketCollector()),
        ("onchain", OnchainCollector()),
        ("okx_chainos", OkxChainosCollector()),
    ]
    for name, c in _collectors:
        _COLLECTORS[name] = c
        c.start()
    logger.info("InfraX Data Service startup complete")


# ── Entry ──────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    from app.config import DATA_SERVICE_PORT
    uvicorn.run(app, host="0.0.0.0", port=DATA_SERVICE_PORT)
