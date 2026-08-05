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
import logging
import time
import hmac
import threading

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
# 注：鉴权 401 仍返回 app_auth.UNAUTHORIZED（{"detail": "unauthorized"}，契约固定，
#     由 _api_auth 中间件直接返回，不经过下述 handler）。

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


# ── Business endpoint auth (Bearer / X-API-Key / X-Service-Key) ─
# 业务端点统一鉴权（DS-12，契约见 AITRADER_DATA_SERVICE_REQ.md）：
#   - 配置了 DATA_API_KEY → 要求 Authorization: Bearer 或 X-API-Key 或
#     X-Service-Key 任一匹配，否则 401 {"detail": "unauthorized"}
#   - 未配置 → 保持开放（向后兼容，配置 key 即启用强制校验）
# /health 豁免；/admin/* 沿用 ADMIN_API_KEY 校验。
# 实现复用全平台统一契约 app_auth（projects/shared/app_auth.py）。


def _api_authorized(request) -> bool:
    from app.config import DATA_API_KEY
    return app_auth.is_authorized(request.headers.get, DATA_API_KEY)


@app.middleware("http")
async def _api_auth(request, call_next):
    if not app_auth.is_exempt(request.url.path, prefixes=("/admin/",)):
        if not _api_authorized(request):
            return JSONResponse(
                status_code=401,
                content=app_auth.UNAUTHORIZED,
            )
    return await call_next(request)


# ═══════════════════════════════════════════════════════════════
#  Data Service — SQLite-backed bars / factors / snapshots
# ═══════════════════════════════════════════════════════════════

# ── Bars (unified OHLCV + indicators + external factors) ──────

@app.get("/bars")
async def get_bars(
    symbol: str = Query(..., description="Symbol, e.g. BTC/USDT"),
    timeframe: str = Query("1m", description="Timeframe: 1m/5m/15m/30m/1h/4h/1d"),
    market_type: str = Query("spot", pattern="^(spot|swap)$", description="Crypto market type: spot | swap"),
    start: Optional[int] = Query(None, description="Start unix ms"),
    end: Optional[int] = Query(None, description="End unix ms"),
    limit: int = Query(500, ge=1, le=5000),
):
    """Unified bar data: OHLCV + pre-computed indicators + external factors.

    market_type=swap 时 symbol 按 ccxt 惯例 ``BTC/USDT:USDT`` 存储键查询
    （spot/swap 数据互不混淆，DS-8 方案 A）。
    """
    try:
        from app.enrich import query_bars
        bars = query_bars(symbol=symbol, timeframe=timeframe, market_type=market_type,
                          start=start, end=end, limit=limit)
        return {"symbol": symbol, "timeframe": timeframe, "market_type": market_type,
                "count": len(bars), "bars": bars}
    except Exception as e:
        logger.error(f"/bars failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ── Ticker (realtime quote, DS-7) ──────────────────────────────

@app.get("/ticker")
async def ticker(
    symbol: str = Query(..., description="Symbol, e.g. BTC/USDT"),
    market_type: str = Query("spot", pattern="^(spot|swap)$", description="Crypto market type: spot | swap"),
    exchange_id: Optional[str] = Query(None, description="Crypto exchange (default: binance)"),
    market: Optional[str] = Query(None, description="Market hint: crypto/usstock/forex/futures/cnstock/hkstock"),
):
    """Realtime quote aligned with AItrader KlineService.get_realtime_price.

    Returns {symbol, price, change, changePercent, high, low, open, previousClose, ts}.
    Data sources: crypto → ccxt; usstock/forex/futures → yfinance; cnstock/hkstock → Tencent.
    Falls back to latest 1d kline bar when realtime source unavailable (fail-silent).
    """
    try:
        from app.ticker import get_ticker
        data = get_ticker(symbol=symbol, market_type=market_type,
                          exchange_id=exchange_id, market=market)
    except Exception as e:
        logger.error(f"/ticker failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    if data is None:
        raise HTTPException(status_code=404, detail=f"No quote data for {symbol}")
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
        response = {"ts": result.pop("_ts", 0), "factors": result}
        return response
    except Exception as e:
        logger.error(f"/factors/current failed: {e}")
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
        id_list = [i.strip() for i in ids.split(",") if i.strip()] if ids else None
        return get_history_factors(
            symbol=symbol,
            timeframe=timeframe,
            ids=id_list,
            start=start,
            end=end,
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
        return {
            "kline_rows": kline_count,
            "snapshot_rows": snap_count,
            "symbols": symbol_count,
            "time_start": time_range[0],
            "time_end": time_range[1],
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
    keyword: str = Query(..., description="模糊关键字，如 btc / eth/"),
    market: str = Query("crypto", description="crypto | usstock | forex | futures"),
    limit: int = Query(20, ge=1, le=100, description="返回条数，默认 20，上限 100"),
):
    """符号模糊搜索（DS-9，P0）。

    对标单体 market.py 符号搜索：ccxt 全量市场（binance spot+swap，quote=USDT
    且 active）4h TTL 缓存 + 种子回退；usstock/forex/futures 走本地种子。
    """
    try:
        from app.symbol_search import search_symbols as _search

        return {"keyword": keyword, "symbols": _search(keyword, market, limit)}
    except Exception as e:
        logger.error(f"/symbols/search failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/symbol/resolve")
async def symbol_resolve(
    symbol: str = Query(..., description="符号关键字，如 BTC / BTC/USDT / EURUSD=X"),
    market: str = Query("crypto", description="crypto | usstock | forex | futures"),
):
    """符号解析（DS-4）：单符号 → 标准交易对。

    契约（AITRADER_DATA_SERVICE_REQ.md DS-4）：
        GET /symbol/resolve?symbol=BTC → {"query": "BTC", "resolved": "BTCUSDT"}
    解析失败返回 404。全市场覆盖范围（美股/外汇/期货/A股/港股）待 DS-11 决策；
    本期 crypto 精确解析（binance spot 优先）+ 非 crypto 种子直通。
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


# ── Snapshots (complex data: heatmap, calendar, indices, etc.) ─

@app.get("/snapshots")
async def snapshots(
    type: Optional[str] = Query(None, description="Data type: heatmap/calendar/crypto_prices/indices/tvl/volatility/us_indicators/earnings"),
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
    """
    try:
        from app.factors import get_snapshots
        result = get_snapshots(type)
        return {"ts": result.pop("_ts", 0), "snapshots": result}
    except Exception as e:
        logger.error(f"/snapshots failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# ── Admin Config (data-source API keys, hot-reload) ──────────

_ENV_PATH = Path(__file__).resolve().parent / ".env"

# 序列化 .env 的 read-modify-write，避免并发 PUT 丢更新
_env_write_lock = threading.Lock()

# 数据源 API key 变量（多 key 用逗号分隔，轮询取用）
_DATA_KEY_FIELDS = [
    "FRED_API_KEY", "NEWSAPI_API_KEY", "ADANOS_API_KEY", "FINNHUB_API_KEY",
    "TIINGO_API_KEY", "TWELVE_DATA_API_KEY", "ALPHA_VANTAGE_KEY",
    "COINGECKO_API_KEY", "CRYPTOCOMPARE_API_KEY",
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


# ── Startup ────────────────────────────────────────────────────

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
        GlobalMarketCollector,
    )
    ExternalFactorCollector().start()
    CalendarCollector().start()
    SnapshotCollector().start()
    HeatmapCollector().start()
    NewsCollector().start()
    SentimentCollector().start()
    AdanosCollector().start()
    OpportunityCollector().start()
    FinbertSentimentCollector().start()
    TreeMlCollector().start()
    ConsensusCollector().start()
    P2MlCollector().start()
    GlobalMarketCollector().start()
    logger.info("InfraX Data Service startup complete")


# ── Entry ──────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    from app.config import DATA_SERVICE_PORT
    uvicorn.run(app, host="0.0.0.0", port=DATA_SERVICE_PORT)
