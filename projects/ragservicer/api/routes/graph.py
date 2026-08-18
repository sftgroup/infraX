"""Graph visualization routes (GF-5).

`GET /api/v1/graph/entities?namespace=market` returns ECharts
force-directed graph data (nodes + edges) built from LightRAG's
on-disk storage files (see api.graph_engine).
"""
import logging

from flask import request, Blueprint

from api.auth import require_tenant
from api.code_refactor import handle_errors, build_success, build_error
from api.graph_engine import build_graph_payload

logger = logging.getLogger("ragservicer.routes.graph")


def register(api: Blueprint):
    @api.route("/graph/entities", methods=["GET"])
    @require_tenant
    @handle_errors(logger, "Graph entities failed")
    def api_graph_entities(_tenant):
        namespace = (request.args.get("namespace") or "default").strip() or "default"

        try:
            limit = int(request.args.get("limit", 200))
        except (TypeError, ValueError):
            return build_error("limit must be an integer", 400)
        if limit < 1:
            return build_error("limit must be >= 1", 400)

        symbol = request.args.get("symbol") or None

        payload = build_graph_payload(_tenant, namespace, limit=limit, symbol=symbol)
        if payload is None:
            return build_error("graph data unavailable", 503)
        return build_success(payload)
