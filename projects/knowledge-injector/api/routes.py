"""REST API 路由。

可选模块，不启动也不影响注入器运行。
"""
from __future__ import annotations

import logging
import time

from flask import Flask, g, jsonify, request

logger = logging.getLogger(__name__)

# 启动时间
_START_TIME = time.time()


def _uptime() -> str:
    secs = int(time.time() - _START_TIME)
    h, m = divmod(secs, 3600), 60
    return f"{h[0]}h {h[1] // 60}m" if isinstance(h, tuple) else f"{secs // 3600}h {(secs % 3600) // 60}m"


def create_app() -> Flask:
    """创建 Flask 应用。"""
    from injector.worker import GraphInjector
    from injector.client import LightRAGClient
    from injector.stats import STATS

    app = Flask(__name__)
    injector = GraphInjector(LightRAGClient())

    # ─── 请求日志（统一） ──────────────────────────────

    @app.before_request
    def _log_request():
        g._req_start = time.monotonic()
        logger.info("→ %s %s (body=%s)", request.method, request.path,
                    (request.get_data(cache=True)[:200].decode("utf-8", "replace") if request.data else ""))

    @app.after_request
    def _log_response(response):
        duration_ms = (time.monotonic() - g.get("_req_start", time.monotonic())) * 1000
        logger.info("← %s %s -> %d (%.1fms)", request.method, request.path,
                    response.status_code, duration_ms)
        return response

    # ─── 注入器列表 ────────────────────────────────

    _ALL_INJECTORS = [
        "macro", "sentiment", "crypto_overview",
        "volatility", "news_sentiment", "major_events",
        "onchain", "defi_tvl", "macro_trend",
        "fred_economics", "earnings_index", "evm",
        "global_macro", "indices", "tech_analysis",
        "ml_predictions",
    ]

    def _injector_methods() -> list[str]:
        """返回实际存在的注入器。"""
        return [n for n in _ALL_INJECTORS if hasattr(injector, f"inject_{n}")]

    # ─── Health ─────────────────────────────────

    @app.route("/health")
    def health():
        return jsonify({
            "code": 0,
            "message": "ok",
            "data": {
                "service": "infrax-knowledge-injector",
                "lightrag_enabled": injector.enabled,
                "uptime": _uptime(),
                "injector_count": len(_injector_methods()),
                "version": "1.0.0",
            },
        })

    # ─── Inject ─────────────────────────────────

    @app.route("/inject/<source>", methods=["POST"])
    def inject(source: str):
        """手动触发指定类型注入。"""
        method = getattr(injector, f"inject_{source}", None)
        if not method:
            return jsonify({"error": f"unknown source: {source}"}), 400
        t0 = time.monotonic()
        ok = method()
        duration_ms = (time.monotonic() - t0) * 1000
        STATS.record(source, ok, duration_ms)
        return jsonify({"success": ok, "duration_ms": round(duration_ms, 1)})

    @app.route("/inject/all", methods=["POST"])
    def inject_all():
        """触发全量注入。"""
        results = injector.inject_all()
        return jsonify(results)

    # ─── Parsed inject (configurable parsing layer) ───

    @app.route("/inject/parsed", methods=["POST"])
    def inject_parsed():
        """按 YAML 规则拉取并解析注入（source: infrax_dc / infrax_collector）。

        body: {"source": "infrax_dc", "limit": 100, "dry_run": false}
        """
        body = request.get_json(silent=True) or {}
        source = body.get("source", "")
        limit = int(body.get("limit", 100))
        dry_run = bool(body.get("dry_run", False))
        if source not in ("infrax_dc", "infrax_collector"):
            return jsonify({"error": "source must be infrax_dc or infrax_collector"}), 400

        if dry_run:
            from injector.worker import GraphInjector
            inj = GraphInjector(dry_run=True)
        else:
            inj = injector
        results = inj.inject_parsed(source, limit=limit)
        return jsonify({
            "success": True,
            "source": source,
            "dry_run": dry_run,
            "count": len(results),
            "results": results,
        })

    # ─── Query ──────────────────────────────────

    @app.route("/query", methods=["POST"])
    def query():
        """查询知识图谱。"""
        body = request.get_json(silent=True) or {}
        q = body.get("query", "")
        top_k = body.get("top_k", 5)
        if not q:
            return jsonify({"error": "query is required"}), 400
        results = injector._client.query(q, top_k=top_k)
        return jsonify({"results": results, "count": len(results)})

    # ─── Status / Injectors / Stats ────────────────

    @app.route("/status")
    def status():
        return jsonify({
            "lightrag_enabled": injector.enabled,
            "injectors": _injector_methods(),
        })

    @app.route("/injectors")
    def injectors():
        """列出所有注入器及状态。"""
        return jsonify({
            "injectors": _injector_methods(),
            "count": len(_injector_methods()),
        })

    @app.route("/stats")
    def stats():
        """注入统计汇总。"""
        return jsonify(STATS.summary())

    @app.route("/stats/recent")
    def stats_recent():
        """最近注入记录。"""
        limit = request.args.get("limit", 20, type=int)
        return jsonify(STATS.recent(limit=min(limit, 100)))

    return app
