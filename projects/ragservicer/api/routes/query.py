"""RAG query routes."""
import logging
from flask import request, jsonify, Blueprint
from api.engine import query as rag_query, retrieve as rag_retrieve
from api.auth import require_tenant
from api.code_refactor import parse_json, Guard, handle_errors, build_success

logger = logging.getLogger("ragservicer.routes.query")


def register(api: Blueprint):
    @api.route("/namespaces/<namespace>/query", methods=["POST"])
    @require_tenant
    @handle_errors(logger, "Query failed")
    def api_query(namespace, _tenant):
        """Retrieve context only — no LLM answer generation."""
        data = parse_json()
        Guard(data).require("query").check_mode("mode")
        result = rag_query(_tenant, namespace, data["query"], data.get("mode", "mix"))
        return build_success(result)

    @api.route("/namespaces/<namespace>/retrieve", methods=["POST"])
    @require_tenant
    @handle_errors(logger, "Retrieve failed")
    def api_retrieve(namespace, _tenant):
        """Retrieve relevant context only — no LLM answer generation.
           Caller uses their own LLM with the returned context."""
        data = parse_json()
        Guard(data).require("query").check_mode("mode")

        top_k = data.get("top_k")
        if top_k is not None:
            try:
                top_k = int(top_k)
                if top_k < 1:
                    return jsonify({"error": "top_k must be >= 1"}), 400
            except (TypeError, ValueError):
                return jsonify({"error": "top_k must be an integer"}), 400

        result = rag_retrieve(_tenant, namespace, data["query"], data.get("mode", "mix"), top_k)
        return build_success(result)
