"""ml-service — 独立模型推理服务（FastAPI :9120）。

承载六个真实模型（懒加载，无模拟回退）：
  GET  /ml/tree_predictions   LightGBM 方向预测（训练+预测）
  POST /ml/sentiment          FinBERT 文本情绪（新闻文章 → 聚合情绪）
  GET  /ml/volatility         Kronos 波动率预测（多路径采样）
  GET  /ml/bolt               Chronos-Bolt 单变量概率预测（P2）
  GET  /ml/moirai             Moirai 2.0 多变量跨资产预测（P2）
  GET  /ml/timesfm            TimesFM 2.5 长上下文点预测（P2）
  GET  /ml/consensus          跨模型信号共识聚合
  GET  /ml/macro_features     FRED 宏观特征 + DXY/VIX/US10Y 快照

数据来源：data-service /bars + /symbols（HTTP）。
模型不可用 / 依赖缺失 / 数据不足时返回 data=null（fail-silent），
不产生任何模拟数据。

重计算端点统一走 TTL 缓存 + 异步后台计算 + 周期预热（app.async_cache）：
缓存 miss 时请求立即返回 data=null，不阻塞请求线程池。

启用（部署机）：
  1. pip install -r requirements.txt
     pip install torch --index-url https://download.pytorch.org/whl/cpu
     git clone https://github.com/shiyu-coder/Kronos /home/ubuntu/Kronos
  2. .env 置 DATA_SERVICE_URL + 各 *_ENABLED=true
  3. systemd 单元加 Environment="PYTHONPATH=/home/ubuntu/Kronos"
"""
from __future__ import annotations

import logging
import os
import threading
import time
from pathlib import Path

# ── Load .env（须在任何 app import 前） ──────────────────
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

from fastapi import FastAPI, Request  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402

import config  # noqa: E402
import app_auth  # noqa: E402

logging.basicConfig(level=config.LOG_LEVEL)
logger = logging.getLogger(__name__)

app = FastAPI(
    title="InfraX ML Service",
    version="1.0.0",
    docs_url="/docs",
    redoc_url="/redoc",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── 鉴权（可选）：配置 ML_API_KEY 后强制 Bearer / X-API-Key / X-Service-Key ──
# 统一契约（app_auth）：/health、/docs、/redoc、/openapi.json 豁免；
# 401 响应体统一 {"detail": "unauthorized"}。

def _authorized(request: Request) -> bool:
    return app_auth.is_authorized(
        request.headers.get, config.ML_API_KEY,
        method=request.method, monitor_key=config.MONITOR_API_KEY,
    )


@app.middleware("http")
async def _api_auth(request: Request, call_next):
    if not app_auth.is_exempt(
        request.url.path,
        exact={"/health", "/docs", "/redoc", "/openapi.json", "/metrics",
               "/ml/cache/stats"},
    ):
        if not _authorized(request):
            return JSONResponse(
                status_code=401,
                content=app_auth.UNAUTHORIZED,
            )
    return await call_next(request)


# ── Prometheus /metrics（G-6）─────────────────────────────────
# 请求指标 + GET /metrics（app_auth 已豁免 /metrics，探针免 key 拉取）。
from metrics import register_fastapi  # noqa: E402

register_fastapi(app, "ml")


# ── 可选响应信封（G-2）────────────────────────────────────────
# 默认成功响应保持裸字段（向后兼容）；请求带 ?envelope=1 或
# X-Envelope: 1 时统一包装为 {code, message, data}，对齐 Flask 服务信封。
from envelope import install_envelope_middleware  # noqa: E402

install_envelope_middleware(app)


# ── Health ─────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"code": 0, "message": "ok", "data": {"service": "infrax-ml-service", "version": "1.0.0"}}


# ── 端点结果缓存（ML_CACHE_TTL_SEC，默认 30min） ────────────
# 重计算端点 TTL 缓存：TTL 内命中秒回，不重算分钟级推理；
# compute 返回 None（fail-silent）时不缓存，下次请求重试。

from app.cache import TTLCache  # noqa: E402

_endpoint_cache = TTLCache()


def _cached(key: str, compute):
    """端点 TTL 缓存：命中秒回；未命中计算并缓存（None 不缓存）。"""
    return _endpoint_cache.get_or_compute(key, compute, config.ML_CACHE_TTL_SEC)


def _wrap_results(results, score_key: str):
    """裸数组 → dict + 聚合指标（对齐 tree_predictions 结构）。

    结构：{"generated_at", "n_symbols", "model", "avg_<score_key>", "symbols"}。
    结果为空（None/[]）返回 None（fail-silent）。
    """
    if not results:
        return None
    scores = [r[score_key] for r in results if isinstance(r.get(score_key), (int, float))]
    return {
        "generated_at": int(time.time() * 1000),
        "n_symbols": len(results),
        "model": next((r.get("model") for r in results if r.get("model")), None),
        "avg_" + score_key: round(sum(scores) / len(scores), 4) if scores else None,
        "symbols": results,
    }


# ── 异步计算 + 预热（app.async_cache） ────────────────────
# 重计算端点（tree/volatility/bolt/moirai/timesfm）统一走 AsyncCacheRunner：
# miss 缓存时在后台 daemon 线程计算，请求立即返回（不阻塞 worker 线程池，
# 避免全量预测拖死 /health 等轻端点）；预热线程周期刷新缓存（启动 delay
# 后开始，缓存缺失/过期才触发），保证缓存常满、请求几乎总是命中。
from app.async_cache import AsyncCacheRunner, prewarm_loop  # noqa: E402

_async_runner = AsyncCacheRunner(_endpoint_cache, config.ML_CACHE_TTL_SEC)


def _compute_tree():
    from app.analytics import tree_models as tm
    return tm.predict_payload()


def _compute_volatility():
    from app.providers import kronos
    return kronos.predict_all_volatility()


def _compute_bolt():
    from app.providers import chronos_bolt
    return chronos_bolt.predict_all()


def _compute_moirai():
    from app.providers import moirai2
    return moirai2.predict_all()


def _compute_timesfm():
    from app.providers import timesfm25
    return timesfm25.predict_all()


def _compute_consensus():
    from app.analytics import consensus as cs
    return cs.build_consensus()


# 预热任务表：全部重计算端点（启用与否由 compute 内部 fail-silent 决定）
_PRECOMPUTE: dict = {
    "tree_predictions": _compute_tree,
    "volatility": _compute_volatility,
    "bolt": _compute_bolt,
    "moirai": _compute_moirai,
    "timesfm": _compute_timesfm,
    "consensus": _compute_consensus,
}

# R4-3.2：预热表从 provider registry 遍历生成（新 provider 注册即自动纳入预热）
from app.providers.base import get_registry as _get_provider_registry  # noqa: E402

for _pkey, _pcls in _get_provider_registry().items():
    if _pkey not in _PRECOMPUTE and hasattr(_pcls, "predict_all"):
        _PRECOMPUTE[_pkey] = _pcls.predict_all


def _mount_provider_endpoints() -> None:
    """R4-3.1：遍历 provider registry 动态挂载 GET /ml/{key}。

    已存在手写端点（tree/volatility/bolt/moirai/timesfm/consensus 等）保持
    不动（向后兼容）；新 provider 注册即自动获得标准端点（_wrap_results 包装）。
    """
    handled = set(_PRECOMPUTE) | {"sentiment", "macro_features"}
    score_default = "score"

    for key, pcls in _get_provider_registry().items():
        if key in handled or not hasattr(pcls, "predict_all"):
            continue

        def _make(key=key, pcls=pcls, score_default=score_default):
            def handler():
                try:
                    results = pcls.predict_all()
                    return {"code": 0, "message": "ok",
                            "data": _wrap_results(results, score_default)}
                except Exception as exc:
                    logger.warning("%s failed: %s", key, exc)
                    return {"code": 0, "message": "ok", "data": None}
            return handler

        app.add_api_route(f"/ml/{key}", _make(), methods=["GET"])
        logger.info("ml-service: mounted dynamic provider endpoint /ml/%s", key)


_mount_provider_endpoints()


@app.on_event("startup")
def _start_prewarm() -> None:
    """启动预热线程：delay 后开始周期检查，缓存缺失/过期时后台刷新。"""
    if not config.ML_PREWARM_ENABLED:
        logger.info("ml-service prewarm disabled (ML_PREWARM_ENABLED=false)")
        return
    t = threading.Thread(
        target=prewarm_loop,
        args=(_async_runner, _PRECOMPUTE,
              config.ML_PREWARM_DELAY_SEC, config.ML_PREWARM_INTERVAL_SEC),
        name="ml-prewarm",
        daemon=True,
    )
    t.start()
    logger.info(
        "ml-service prewarm started (delay=%.0fs interval=%.0fs, tasks=%s)",
        config.ML_PREWARM_DELAY_SEC, config.ML_PREWARM_INTERVAL_SEC,
        sorted(_PRECOMPUTE),
    )


# ── 缓存统计（与 /metrics 同级豁免鉴权，监控探针免 key 拉取） ──────

@app.get("/ml/cache/stats")
async def cache_stats():
    """端点结果缓存统计：总量（命中/未命中/过期/计算次数/累计耗时）+ 各端点明细。

    明细含 last_compute_ms（该端点最近一次全量预测耗时，毫秒）、
    last_compute_at、cached/expires_in（当前缓存状态）。
    """
    return {"code": 0, "message": "ok", "data": _endpoint_cache.stats()}


# ── LightGBM 方向预测 ──────────────────────────────────────

@app.get("/ml/tree_predictions")
def tree_predictions():
    """训练（如需）+ 预测全部 symbol → 方向/概率/机会评分/波动率档位。

    返回 data: {"generated_at", "model": {...}, "predictions": [...]} 或 null。
    数据可用时附带 macro_context（FRED 宏观特征，仅新增字段，向后兼容）。
    缓存 miss 时后台计算并立即返回 null（预热线程保证缓存常满）。
    """
    try:
        payload = _async_runner.get("tree_predictions", _compute_tree)
        if isinstance(payload, dict):
            try:
                from app import macro_features as mf
                ctx = mf.compute_macro_features()
                if ctx:
                    payload["macro_context"] = ctx
            except Exception:
                pass
        return {"code": 0, "message": "ok", "data": payload or None}
    except Exception as exc:
        logger.warning("tree_predictions failed: %s", exc)
        return {"code": 0, "message": "ok", "data": None}


# ── FinBERT 文本情绪 ───────────────────────────────────────

@app.post("/ml/sentiment")
async def sentiment(request: Request):
    """对新闻文章做 FinBERT 分类与聚合。

    body: {"articles": [{"title"/"headline", "snippet"/"summary", "sentiment"?}, ...]}
    返回 data: 聚合情绪统计 或 null（模型不可用/无可分类文本）。
    """
    try:
        body = await request.json()
    except Exception:
        return JSONResponse(status_code=400, content={"code": 400, "message": "invalid JSON", "data": None})
    articles = (body or {}).get("articles")
    if not isinstance(articles, list):
        return {"code": 0, "message": "ok", "data": None}
    try:
        from app.analytics import sentiment_llm as sl
        result = sl.analyze_articles(articles)
        return {"code": 0, "message": "ok", "data": result}
    except Exception as exc:
        logger.warning("sentiment failed: %s", exc)
        return {"code": 0, "message": "ok", "data": None}


# ── Kronos 波动率预测 ──────────────────────────────────────

@app.get("/ml/volatility")
def volatility():
    """对目标资产做 Kronos 多路径波动率预测。

    返回 data: {"generated_at", "n_symbols", "model", "avg_volatility_score",
                "symbols": [{symbol, volatility_score, volatility_level,
                             direction_consensus, uncertainty, last_close}, ...]}
    或 null。缓存 miss 时后台计算并立即返回 null（异步，不阻塞请求线程）。
    """
    try:
        results = _async_runner.get("volatility", _compute_volatility)
        return {"code": 0, "message": "ok", "data": _wrap_results(results, "volatility_score")}
    except Exception as exc:
        logger.warning("volatility failed: %s", exc)
        return {"code": 0, "message": "ok", "data": None}


# ── Cross-model consensus ─────────────────────────────────

@app.get("/ml/consensus")
def consensus():
    """跨模型信号共识聚合（tree + Kronos + FinBERT + P2）。

    确定性规则：consensus_score（方向一致度）/ divergence / risk_flag。
    三路信号全部不可用时返回 data=null（fail-silent）。
    缓存 miss 时后台计算并立即返回 null（异步，不阻塞事件循环/请求线程）。
    """
    try:
        payload = _async_runner.get("consensus", _compute_consensus)
        return {"code": 0, "message": "ok", "data": payload}
    except Exception as exc:
        logger.warning("consensus failed: %s", exc)
        return {"code": 0, "message": "ok", "data": None}


# ── 因子工厂（需求5 R5-2.4 / 需求6 FF-3、FF-4） ─────────────
# 挖掘任务：start（结构化 spec）/ mine（自然语言→LLM 解析）/ status / result /
# list / cancel；因子目录：catalog / current / activate|deactivate。
# 端点均需鉴权（ML_API_KEY，统一中间件已覆盖；自然语言入口缺 LLM key 时 400）。

from pydantic import BaseModel as _BaseModel  # noqa: E402


class _MineRequest(_BaseModel):
    preferences: dict = {}
    constraints: dict = {}
    intent: str | None = None


@app.post("/factor-factory/start")
def factor_start(req: _MineRequest):
    """创建挖掘任务（结构化 preferences/constraints）→ 入队执行。

    body: {"preferences": {...}, "constraints": {...}}（字段见 JobSpec schema）。
    偏好/硬限制冲突时返回 400 + conflicts（不静默）；成功返回 {job_id, status}。
    """
    try:
        from app.factorengine.job import build_spec
        spec, conflicts = build_spec(req.preferences, req.constraints)
        if conflicts:
            return JSONResponse(status_code=400, content={
                "code": 400, "message": "偏好与硬限制冲突", "data": {"conflicts": conflicts}})
        from app.factorengine.jobs import start_job
        job = start_job(spec)
        return {"code": 0, "message": "ok",
                "data": {"job_id": job["job_id"], "status": job["status"]}}
    except Exception as exc:
        logger.warning("factor start failed: %s", exc)
        return JSONResponse(status_code=400, content={
            "code": 400, "message": str(exc), "data": None})


@app.post("/factor-factory/mine")
def factor_mine(req: _MineRequest):
    """自然语言挖掘入口（R5-4）：LLM 意图解析 → 建任务。

    body: {"preferences": {...}, "constraints": {...}, "intent": "自然语言描述"}。
    intent 优先走 LLM 解析（缺 LLM key → 400 提示）；否则用结构化字段。
    """
    intent = req.intent
    try:
        from app.factorengine.job import build_spec
        if intent:
            from app.factorengine.intent import parse_intent
            parsed = parse_intent(str(intent))
            spec, conflicts = build_spec(parsed["preferences"], parsed["constraints"])
        else:
            spec, conflicts = build_spec(req.preferences, req.constraints)
        if conflicts:
            return JSONResponse(status_code=400, content={
                "code": 400, "message": "偏好与硬限制冲突", "data": {"conflicts": conflicts}})
        from app.factorengine.jobs import start_job
        job = start_job(spec)
        return {"code": 0, "message": "ok",
                "data": {"job_id": job["job_id"], "status": job["status"]}}
    except Exception as exc:
        logger.warning("factor mine failed: %s", exc)
        return JSONResponse(status_code=400, content={
            "code": 400, "message": str(exc), "data": None})


@app.get("/factor-factory/status")
def factor_status(job_id: str):
    """任务状态（含 stage 细分：pool/eval/select/persist）。"""
    from app.factorengine.jobs import job_status
    job = job_status(job_id)
    if job is None:
        return {"code": 0, "message": "ok", "data": None}
    return {"code": 0, "message": "ok", "data": {
        "job_id": job["job_id"], "status": job["status"], "stage": job.get("stage"),
        "error": job.get("error"), "created_at": job.get("created_at"),
        "updated_at": job.get("updated_at")}}


@app.get("/factor-factory/result")
def factor_result(job_id: str):
    """任务结果：合格因子列表（IC/ICIR/独立度）+ 统计。"""
    from app.factorengine.jobs import get_store
    store = get_store()
    job = store.get(job_id)
    if job is None:
        return {"code": 0, "message": "ok", "data": None}
    results = store.results(job_id)
    return {"code": 0, "message": "ok", "data": {
        "job_id": job_id, "status": job["status"],
        "stats": (job.get("result") or {}).get("stats"),
        "factors": results}}


@app.get("/factor-factory/list")
def factor_list(limit: int = 50):
    """最近任务列表。"""
    from app.factorengine.jobs import list_jobs
    return {"code": 0, "message": "ok", "data": list_jobs(limit)}


@app.post("/factor-factory/cancel")
def factor_cancel(job_id: str):
    """取消任务（排队/运行中可取消）。"""
    from app.factorengine.jobs import cancel_job
    ok = cancel_job(job_id)
    return {"code": 0, "message": "ok", "data": {"cancelled": ok}}


@app.get("/factors/catalog")
def factor_catalog():
    """因子目录（全部/按状态）。"""
    from app.factorengine.catalog import get_catalog
    return {"code": 0, "message": "ok", "data": get_catalog().list()}


@app.get("/factors/current")
def factors_current():
    """当前激活因子（FF-3.3：data-service /factors/current 的数据源）。"""
    from app.factorengine.catalog import get_catalog
    store = get_catalog()
    return {"code": 0, "message": "ok", "data": {
        "updated_at": _now_ms(), "factors": store.active_keys()}}


@app.post("/factors/{factor_key}/activate")
def factor_activate(factor_key: str):
    from app.factorengine.catalog import get_catalog
    ok = get_catalog().set_status(factor_key, "active")
    return {"code": 0, "message": "ok", "data": {"updated": ok}}


@app.post("/factors/{factor_key}/deactivate")
def factor_deactivate(factor_key: str):
    from app.factorengine.catalog import get_catalog
    ok = get_catalog().set_status(factor_key, "inactive")
    return {"code": 0, "message": "ok", "data": {"updated": ok}}


def _now_ms() -> int:
    import time
    return int(time.time() * 1000)


# ── 宏观特征（FRED 历史趋势 + DXY/VIX/US10Y） ─────────────

@app.get("/ml/macro_features")
def macro_features_endpoint():
    """宏观环境特征：FRED 系列派生特征（latest/chg_30d/chg_90d/trend/percentile）
    + DXY/VIX/US10Y 最新快照。TTL 缓存，宏观数据未就绪时返回 null。
    """
    try:
        def _compute():
            from app import macro_features as mf
            return mf.compute_macro_features()

        features = _cached("macro_features", _compute)
        return {"code": 0, "message": "ok", "data": features or None}
    except Exception as exc:
        logger.warning("macro_features failed: %s", exc)
        return {"code": 0, "message": "ok", "data": None}


# ── P2 时序基础模型（Bolt / Moirai / TimesFM） ─────────────

@app.get("/ml/bolt")
def bolt_predictions():
    """Chronos-Bolt 单变量概率基线（分位数预测）。

    返回 data: {"generated_at", "n_symbols", "model", "avg_prob_up",
                "symbols": [{symbol, point_forecast, quantiles{0.1/0.5/0.9},
                             direction, prob_up, uncertainty}, ...]} 或 null。
    """
    try:
        results = _async_runner.get("bolt", _compute_bolt)
        return {"code": 0, "message": "ok", "data": _wrap_results(results, "prob_up")}
    except Exception as exc:
        logger.warning("bolt failed: %s", exc)
        return {"code": 0, "message": "ok", "data": None}


@app.get("/ml/moirai")
def moirai_predictions():
    """Moirai 2.0 多变量跨资产联动预测（全部资产一批喂入）。

    返回 data: {"generated_at", "n_symbols", "model", "avg_prob_up",
                "symbols": [{symbol, point_forecast, quantiles{0.1/0.5/0.9},
                             direction, prob_up, uncertainty, linked_symbols}, ...]}
    或 null。
    """
    try:
        results = _async_runner.get("moirai", _compute_moirai)
        return {"code": 0, "message": "ok", "data": _wrap_results(results, "prob_up")}
    except Exception as exc:
        logger.warning("moirai failed: %s", exc)
        return {"code": 0, "message": "ok", "data": None}


@app.get("/ml/timesfm")
def timesfm_predictions():
    """TimesFM 2.5 长上下文点预测 + 置信区间。

    返回 data: {"generated_at", "n_symbols", "model", "avg_prob_up",
                "symbols": [{symbol, point_forecast, quantiles{min/max},
                             direction, prob_up, uncertainty}, ...]} 或 null。
    """
    try:
        results = _async_runner.get("timesfm", _compute_timesfm)
        return {"code": 0, "message": "ok", "data": _wrap_results(results, "prob_up")}
    except Exception as exc:
        logger.warning("timesfm failed: %s", exc)
        return {"code": 0, "message": "ok", "data": None}


# ── Entry ──────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=config.ML_SERVICE_PORT)
