"""ml-service — 独立模型推理服务（FastAPI :9120）。

承载三个真实模型（懒加载，无模拟回退）：
  GET  /ml/tree_predictions   LightGBM 方向预测（训练+预测）
  POST /ml/sentiment          FinBERT 文本情绪（新闻文章 → 聚合情绪）
  GET  /ml/volatility         Kronos 波动率预测（多路径采样）

数据来源：data-service /bars + /symbols（HTTP）。
模型不可用 / 依赖缺失 / 数据不足时返回 data=null（fail-silent），
不产生任何模拟数据。

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
        exact={"/health", "/docs", "/redoc", "/openapi.json"},
    ):
        if not _authorized(request):
            return JSONResponse(
                status_code=401,
                content=app_auth.UNAUTHORIZED,
            )
    return await call_next(request)


# ── Health ─────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"code": 0, "message": "ok", "data": {"service": "infrax-ml-service", "version": "1.0.0"}}


# ── LightGBM 方向预测 ──────────────────────────────────────

@app.get("/ml/tree_predictions")
async def tree_predictions():
    """训练（如需）+ 预测全部 symbol → 方向/概率/机会评分/波动率档位。

    返回 data: {"generated_at", "model": {...}, "predictions": [...]} 或 null。
    """
    try:
        from app.analytics import tree_models as tm
        payload = tm.predict_payload()
        return {"code": 0, "message": "ok", "data": payload}
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
async def volatility():
    """对目标资产做 Kronos 多路径波动率预测。

    返回 data: [{symbol, volatility_score, volatility_level,
                 direction_consensus, uncertainty, last_close}, ...] 或 null。
    """
    try:
        from app.providers import kronos
        results = kronos.predict_all_volatility()
        return {"code": 0, "message": "ok", "data": results or None}
    except Exception as exc:
        logger.warning("volatility failed: %s", exc)
        return {"code": 0, "message": "ok", "data": None}


# ── Cross-model consensus ─────────────────────────────────

@app.get("/ml/consensus")
async def consensus():
    """跨模型信号共识聚合（tree + Kronos + FinBERT）。

    确定性规则：consensus_score（方向一致度）/ divergence / risk_flag。
    三路信号全部不可用时返回 data=null（fail-silent）。
    """
    try:
        from app.analytics import consensus as cs
        payload = cs.build_consensus()
        return {"code": 0, "message": "ok", "data": payload}
    except Exception as exc:
        logger.warning("consensus failed: %s", exc)
        return {"code": 0, "message": "ok", "data": None}


# ── P2 时序基础模型（Bolt / Moirai / TimesFM） ─────────────

@app.get("/ml/bolt")
async def bolt_predictions():
    """Chronos-Bolt 单变量概率基线（分位数预测）。

    返回 data: [{symbol, point_forecast, quantiles{0.1/0.5/0.9},
                 direction, prob_up, uncertainty}, ...] 或 null。
    """
    try:
        from app.providers import chronos_bolt
        results = chronos_bolt.predict_all()
        return {"code": 0, "message": "ok", "data": results or None}
    except Exception as exc:
        logger.warning("bolt failed: %s", exc)
        return {"code": 0, "message": "ok", "data": None}


@app.get("/ml/moirai")
async def moirai_predictions():
    """Moirai 2.0 多变量跨资产联动预测（全部资产一批喂入）。

    返回 data: [{symbol, point_forecast, quantiles{0.1/0.5/0.9},
                 direction, prob_up, uncertainty, linked_symbols}, ...] 或 null。
    """
    try:
        from app.providers import moirai2
        results = moirai2.predict_all()
        return {"code": 0, "message": "ok", "data": results or None}
    except Exception as exc:
        logger.warning("moirai failed: %s", exc)
        return {"code": 0, "message": "ok", "data": None}


@app.get("/ml/timesfm")
async def timesfm_predictions():
    """TimesFM 2.5 长上下文点预测 + 置信区间。

    返回 data: [{symbol, point_forecast, quantiles{min/max},
                 direction, prob_up, uncertainty}, ...] 或 null。
    """
    try:
        from app.providers import timesfm25
        results = timesfm25.predict_all()
        return {"code": 0, "message": "ok", "data": results or None}
    except Exception as exc:
        logger.warning("timesfm failed: %s", exc)
        return {"code": 0, "message": "ok", "data": None}


# ── Entry ──────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=config.ML_SERVICE_PORT)
