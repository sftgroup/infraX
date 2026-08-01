"""Backward-compatibility routes (old /v1/bots/<bot_id>/... paths).

╔══════════════════════════════════════════════════════════════╗
║ ⚠️  Marked for removal in v3.0.                             ║
║     New integrations → /api/v1/namespaces/{ns}/documents    ║
║     These routes map bot_id → tenant_id=bot_id,             ║
║     namespace=bot_id.                                       ║
║                                                             ║
║     Auth: Uses bot_id directly as tenant (no API key        ║
║     required — this is intentional for backward compat).    ║
║     An admin_api_key header can optionally gate access.     ║
╚══════════════════════════════════════════════════════════════╝
"""
import logging
from flask import request, jsonify, Blueprint
from api.engine import (
    insert_document as eng_insert,
    insert_documents_batch,
    delete_document,
    query as rag_query,
)
from api.code_refactor import parse_json, handle_errors, build_success, Guard
from config import get_config

logger = logging.getLogger("ragservicer.routes.legacy")


def _check_legacy_gate():
    """If ADMIN_API_KEY is configured, require it for legacy routes as well."""
    admin_key = get_config().server.admin_api_key
    if admin_key:
        auth = request.headers.get("Authorization", "")
        if auth != f"Bearer {admin_key}":
            return False
    return True


def register(api: Blueprint):
    @api.route("/v1/bots/<bot_id>/documents", methods=["POST"])
    @handle_errors(logger, "Legacy insert failed")
    def legacy_insert(bot_id):
        if not _check_legacy_gate():
            return jsonify({"error": "Admin access required for legacy routes"}), 403

        data = parse_json()
        text = data.get("text", "")
        doc_id = data.get("doc_id", data.get("file_name", "document.txt"))
        if not text.strip():
            return jsonify({"error": "text is required"}), 400

        result = eng_insert(bot_id, bot_id, text, doc_id)
        return build_success(result, status=201)

    @api.route("/v1/bots/<bot_id>/query", methods=["POST"])
    @handle_errors(logger, "Legacy query failed")
    def legacy_query(bot_id):
        if not _check_legacy_gate():
            return jsonify({"error": "Admin access required for legacy routes"}), 403

        data = parse_json()
        Guard(data).require("query").check_mode("mode")
        result = rag_query(bot_id, bot_id, data["query"], data.get("mode", "mix"))
        return build_success(result)

    @api.route("/v1/bots/<bot_id>/documents/batch", methods=["POST"])
    @handle_errors(logger, "Legacy batch insert failed")
    def legacy_batch(bot_id):
        if not _check_legacy_gate():
            return jsonify({"error": "Admin access required for legacy routes"}), 403

        data = parse_json()
        documents = data.get("documents", [])
        if not documents:
            return jsonify({"error": "documents array is required"}), 400

        for i, doc in enumerate(documents):
            if not isinstance(doc, dict) or not str(doc.get("text", "")).strip():
                return jsonify({"error": f"documents[{i}].text is required"}), 400

        result = insert_documents_batch(bot_id, bot_id, documents)
        return build_success(result, status=201)
