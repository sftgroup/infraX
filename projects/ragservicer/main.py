#!/usr/bin/env python3
"""
InfraX RAGservicer — Main Entry Point.
Starts REST API + optional MCP STDIO server.
(Formerly LightRAG Microservice / Doc Service)
"""
import sys
import logging
import threading
from pathlib import Path

from dotenv import load_dotenv
load_dotenv(Path(__file__).parent / ".env", override=False)

sys.path.insert(0, str(Path(__file__).parent))

# ── Config (must be first after path setup) ────────────────
from config import load_config
cfg = load_config()

logging.basicConfig(
    level=getattr(logging, cfg.log_level),
    format="[RAGservicer] %(levelname)s %(name)s %(message)s"
)
logger = logging.getLogger("ragservicer.main")

# ── Imports ────────────────────────────────────────────────
from api.engine import start_event_loop, list_instances
from api.adapters import load_embedding_model
from api.routes import api            # Blueprint from routes/__init__.py
from mcp_server.server import run_mcp_server


def main():
    logger.info("=" * 60)
    logger.info("  InfraX RAGservicer v2.0.0")
    logger.info("=" * 60)

    # Tenant DB
    from tenants import manager as tm
    tm.init_db()
    logger.info(f"Tenant DB ready: {cfg.tenant.db_path}")

    # Seed a default API key for internal use (aiservicer bridge)
    if not tm.list_api_keys("default"):
        try:
            key_info = tm.generate_api_key("default", "aiservicer-internal", 0)
            logger.info(f"Generated default API key: {key_info['key']}")
        except Exception as e:
            logger.warning(f"Cannot generate default API key: {e}")

    admin_ok = bool(cfg.server.admin_api_key)
    logger.info(f"API Key auth: {'enabled' if admin_ok else 'DISABLED — set ADMIN_API_KEY'}")
    if not cfg.llm.api_key:
        logger.warning("LLM API key not set — queries will fail")

    # Async event loop
    loop_thread = threading.Thread(target=start_event_loop, daemon=True, name="lightrag-loop")
    loop_thread.start()
    logger.info("Started async event loop")

    # 写路径后台队列（读写分离：注入异步化，不占用请求线程）
    from api.tasks import init_write_queue
    init_write_queue()

    # Embedding model
    load_embedding_model()

    # MCP (background thread)
    if cfg.server.mcp_enabled:
        mcp_thread = threading.Thread(target=run_mcp_server, daemon=True, name="ragservicer-mcp")
        mcp_thread.start()
        logger.info("MCP server started on STDIO")

    # REST API
    from flask import Flask
    app = Flask(__name__)

    # Attach middleware
    from api.middleware import rate_limit_middleware, audit_log_middleware
    app.before_request(rate_limit_middleware)
    app.after_request(audit_log_middleware)

    app.register_blueprint(api)

    # G-1: 404 统一 JSON 信封（Flask 默认返回 HTML）
    from api.code_refactor import build_error
    @app.errorhandler(404)
    def _not_found(_e):
        return build_error("Not Found", 404)

    # G-6: Prometheus /metrics（/metrics 由 app_auth 豁免，探针免 key 拉取）
    from metrics import register_flask
    register_flask(app, "ragservicer")

    # Register tenant context on Flask g (fixes g.tenant_id never being set)
    from api.code_refactor import register_tenant_on_g
    app.before_request(register_tenant_on_g)

    logger.info(f"REST API starting on http://{cfg.server.host}:{cfg.server.port}")
    logger.info(f"  Health check: GET /api/v1/health")
    logger.info(f"  Insert: POST /api/v1/namespaces/{{ns}}/documents")
    logger.info(f"  Query:  POST /api/v1/namespaces/{{ns}}/query")
    logger.info(f"  Tenants: GET /api/v1/tenants (admin)")

    app.run(host=cfg.server.host, port=cfg.server.port, debug=False)


if __name__ == "__main__":
    main()
