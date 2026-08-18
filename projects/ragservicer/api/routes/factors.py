"""Graph factor routes (GF-3 / GF-4).

- GET /factors/graph?symbol=BTC  计算 symbol 的 8 个图谱因子
- GET /factors/catalog           图谱因子目录（含 graph 分类 metadata）

因子端点仅允许服务间透传（require_service）：B 端因子一律走
data-service /factors/graph（dx_* key），不直接持有 ragservicer
因子访问权；ragservicer lr_* key 仅用于文档写入 + 信息读取。
"""
import logging
from flask import request, Blueprint
from api.auth import require_service
from api.code_refactor import handle_errors, build_success, build_error
from api.graph_engine import (
    GraphDataUnavailable,
    compute_graph_factors,
    get_graph_factor_catalog,
)

logger = logging.getLogger("ragservicer.routes.factors")


def register(api: Blueprint):
    @api.route("/factors/graph", methods=["GET"])
    @require_service
    @handle_errors(logger, "Graph factor computation failed")
    def api_graph_factors(_tenant):
        """Compute 8 graph factors for a symbol (case-insensitive)."""
        symbol = (request.args.get("symbol") or "").strip()
        if not symbol:
            return build_error("symbol is required", 400)

        try:
            factors = compute_graph_factors(_tenant, "market", symbol)
        except GraphDataUnavailable as exc:
            logger.warning(f"Graph data unavailable for {_tenant}/market: {exc}")
            return build_error("graph data unavailable", 503)
        return build_success(factors)

    @api.route("/factors/catalog", methods=["GET"])
    @require_service
    @handle_errors(logger, "Fetch factor catalog failed")
    def api_factor_catalog(_tenant):
        """Return the graph-factor catalog entries (GF-4)."""
        return build_success({"factors": get_graph_factor_catalog()})
