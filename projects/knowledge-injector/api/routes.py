"""REST API 路由。

可选模块，不启动也不影响注入器运行。
"""
from __future__ import annotations

import hmac
import logging
import os
import threading
import time
from pathlib import Path

from flask import Flask, g, jsonify, request

# 统一鉴权契约（app_auth）：import config 先触发 sys.path 引导（../shared）
import config  # noqa: E402
import app_auth  # noqa: E402

logger = logging.getLogger(__name__)

# 序列化 .env 的 read-modify-write，避免并发 PUT 丢更新（模块级，跨请求共享）
_env_write_lock = threading.Lock()

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

    # ─── 业务端点鉴权（/inject/*、/query、/status、/stats 等） ───
    # 统一契约（app_auth）：配置了 key（INJECTOR_API_KEY 或回退
    # RAGSERVICER_API_KEY）则强制 Bearer / X-API-Key / X-Service-Key 任一
    # 匹配校验；未配置保持开放（向后兼容）。/health 与 /admin/* 除外
    # （admin 沿用 ADMIN_API_KEY）。统一 401 响应 {"detail": "unauthorized"}。

    @app.before_request
    def _require_api_key():
        if app_auth.is_exempt(request.path, prefixes=("/admin/",)):
            return None
        key = config.SETTINGS.injector_api_key or config.SETTINGS.ragservicer_api_key
        if not app_auth.is_authorized(request.headers.get, key):
            return jsonify(app_auth.UNAUTHORIZED), 401
        return None

    # ─── 注入器列表 ────────────────────────────────

    _ALL_INJECTORS = [
        "macro", "sentiment", "crypto_overview",
        "volatility", "news_sentiment", "major_events",
        "onchain", "defi_tvl", "macro_trend",
        "fred_economics", "earnings_index", "evm",
        "global_macro", "indices", "tech_analysis",
        "tree_ml", "consensus", "p2_predictions",
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
        namespace = body.get("namespace")  # 可选：默认走 SETTINGS.default_namespace（market）
        if not q:
            return jsonify({"error": "query is required"}), 400
        results = injector._client.query(q, top_k=top_k, namespace=namespace)
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

    # ─── Admin Config (data-source API keys, hot-reload) ──────

    _INJECTOR_KEY_FIELDS = [
        "FRED_API_KEY", "ETHERSCAN_API_KEY", "FINNHUB_API_KEY",
        "TUSHARE_API_KEY", "NEWSAPI_KEY",
    ]
    _MASK = "********"
    _ENV_PATH = Path(__file__).resolve().parents[1] / ".env"

    def _mask_secret(v: str) -> str:
        if not v:
            return ""
        if len(v) <= 8:
            return _MASK
        return f"{v[:4]}{_MASK}{v[-4:]}"

    def _admin_authorized() -> bool:
        from config import SETTINGS
        if not SETTINGS.admin_api_key:
            return False
        auth = request.headers.get("Authorization", "")
        if not auth.startswith("Bearer "):
            return False
        return hmac.compare_digest(auth[7:], SETTINGS.admin_api_key)

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

    def _key_snapshot() -> dict:
        from config import all_keys
        keys = {}
        for name in _INJECTOR_KEY_FIELDS:
            pool = all_keys(name)
            keys[name] = {
                "set": bool(pool),
                "key_count": len(pool),
                "keys": [_mask_secret(k) for k in pool],
            }
        return {"keys": keys, "env_file": str(_ENV_PATH), "hot_reload": True}

    @app.route("/admin/config", methods=["GET"])
    def admin_get_config():
        if not _admin_authorized():
            return jsonify({"code": 401, "message": "Missing or invalid admin key", "data": None}), 401
        return jsonify({"code": 0, "message": "ok", "data": _key_snapshot()})

    @app.route("/admin/config", methods=["PUT"])
    def admin_put_config():
        if not _admin_authorized():
            return jsonify({"code": 401, "message": "Missing or invalid admin key", "data": None}), 401
        body = request.get_json(silent=True) or {}
        payload = body.get("keys") if isinstance(body, dict) else None
        if not isinstance(payload, dict):
            return jsonify({"code": 400, "message": "config.keys object required", "data": None}), 400

        from config import reset_key_pools
        updates: dict[str, str] = {}
        for name, value in payload.items():
            if name not in _INJECTOR_KEY_FIELDS:
                continue
            if value is None:
                continue
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
            reset_key_pools()
            logger.info("Admin config updated: %s", ", ".join(sorted(updates)))
        return jsonify({"code": 0, "message": "ok", "data": _key_snapshot()})

    return app
