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
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from typing import Optional

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))  # .env loaded above
logger = logging.getLogger(__name__)

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


# ── Business endpoint auth (Bearer / X-API-Key) ────────────────
# 业务端点（/bars /factors/* /snapshots /stats）统一鉴权：
#   - 配置了 DATA_API_KEY → 要求 Authorization: Bearer 或 X-API-Key 匹配，否则 401
#   - 未配置 → 保持开放（向后兼容，配置 key 即启用强制校验）
# /health 与 /admin/* 不受影响（后者沿用 ADMIN_API_KEY 校验）。

_PUBLIC_PATHS = {"/health", "/docs", "/redoc", "/openapi.json"}


def _api_authorized(request) -> bool:
    from app.config import DATA_API_KEY
    if not DATA_API_KEY:
        return True
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return hmac.compare_digest(auth[7:], DATA_API_KEY)
    api_key = request.headers.get("X-API-Key", "")
    if api_key:
        return hmac.compare_digest(api_key, DATA_API_KEY)
    return False


@app.middleware("http")
async def _api_auth(request, call_next):
    if request.url.path not in _PUBLIC_PATHS and not request.url.path.startswith("/admin/"):
        if not _api_authorized(request):
            return JSONResponse(
                status_code=401,
                content={"code": 401, "message": "Missing or invalid API key", "data": None},
            )
    return await call_next(request)


# ═══════════════════════════════════════════════════════════════
#  Data Service — SQLite-backed bars / factors / snapshots
# ═══════════════════════════════════════════════════════════════

# ── Bars (unified OHLCV + indicators + external factors) ──────

@app.get("/bars")
async def get_bars(
    symbol: str = Query(..., description="Symbol, e.g. BTC/USDT"),
    timeframe: str = Query("1m", description="Timeframe: 1m/5m/15m/1h/4h/1D"),
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
    category: Optional[str] = Query(None, description="Filter: external/heatmap/calendar/snapshot"),
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
    timeframe: str = Query("1d", description="Timeframe: 1m/5m/15m/1h/4h/1D"),
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
        FinbertSentimentCollector, TreeMlCollector, ConsensusCollector,
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
    logger.info("InfraX Data Service startup complete")


# ── Entry ──────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    from app.config import DATA_SERVICE_PORT
    uvicorn.run(app, host="0.0.0.0", port=DATA_SERVICE_PORT)
