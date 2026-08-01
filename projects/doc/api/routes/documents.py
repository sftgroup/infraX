"""Document CRUD routes."""
import logging
from flask import request, jsonify, Blueprint
from api.engine import insert_document as eng_insert, insert_documents_batch, delete_document
from api.auth import require_tenant
from api.code_refactor import parse_json, Guard, handle_errors, build_success

logger = logging.getLogger("doc.routes.documents")


def register(api: Blueprint):
    @api.route("/namespaces/<namespace>/documents", methods=["POST"])
    @require_tenant
    @handle_errors(logger, "Insert failed")
    def api_insert_document(namespace, _tenant):
        data = parse_json()
        text = data.get("text", "")
        doc_id = data.get("doc_id", data.get("file_name", "document.txt"))

        if not text.strip():
            return jsonify({"error": "text is required"}), 400

        result = eng_insert(_tenant, namespace, text, doc_id)
        return build_success(result, status=201)

    @api.route("/namespaces/<namespace>/documents/batch", methods=["POST"])
    @require_tenant
    @handle_errors(logger, "Batch insert failed")
    def api_insert_documents_batch(namespace, _tenant):
        data = parse_json()
        documents = data.get("documents", [])
        if not documents:
            return jsonify({"error": "documents array is required"}), 400

        # Validate each document has a "text" field
        for i, doc in enumerate(documents):
            if not isinstance(doc, dict) or not str(doc.get("text", "")).strip():
                return jsonify({"error": f"documents[{i}].text is required"}), 400

        result = insert_documents_batch(_tenant, namespace, documents)
        return build_success(result, status=201)

    @api.route("/namespaces/<namespace>/documents/<doc_id>", methods=["DELETE"])
    @require_tenant
    @handle_errors(logger, "Delete failed")
    def api_delete_document(namespace, doc_id, _tenant):
        result = delete_document(_tenant, namespace, doc_id)
        return build_success(result)
