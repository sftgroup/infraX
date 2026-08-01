"""Admin routes: tenant management + API key management."""
import logging
from flask import request, jsonify, Blueprint
from api.engine import list_instances
from api.auth import require_admin
from tenants import manager as tm
from api.code_refactor import parse_json, handle_errors, build_success

logger = logging.getLogger("ragservicer.routes.admin")


def register(api: Blueprint):
    # ── Instance Info ────────────────────────────────

    @api.route("/instances", methods=["GET"])
    @require_admin
    def api_list_instances():
        return jsonify({"instances": list_instances()})

    # ── Tenant CRUD ───────────────────────────────────

    @api.route("/tenants", methods=["POST"])
    @require_admin
    @handle_errors(logger, "Create tenant failed", fallback_status=500)
    def api_create_tenant():
        data = parse_json()
        tenant_id = data.get("tenant_id", "")
        name = data.get("name", tenant_id)
        desc = data.get("description", "")

        if not tenant_id:
            return jsonify({"error": "tenant_id is required"}), 400

        result = tm.create_tenant(tenant_id, name, desc)
        return build_success(result, status=201)

    @api.route("/tenants", methods=["GET"])
    @require_admin
    def api_list_tenants():
        return jsonify({"tenants": tm.list_tenants()})

    @api.route("/tenants/<tenant_id>", methods=["DELETE"])
    @require_admin
    @handle_errors(logger, "Delete tenant failed", fallback_status=500)
    def api_delete_tenant(tenant_id):
        tm.delete_tenant(tenant_id)
        return build_success()

    # ── API Key Management ────────────────────────────

    @api.route("/tenants/<tenant_id>/keys", methods=["POST"])
    @require_admin
    @handle_errors(logger, "Generate key failed", fallback_status=500)
    def api_generate_key(tenant_id):
        data = parse_json()
        name = data.get("name", "default")
        expires_days = int(data.get("expires_days", 0))

        t = tm.get_tenant(tenant_id)
        if not t:
            return jsonify({"error": f"Tenant '{tenant_id}' not found"}), 404

        key_info = tm.generate_api_key(tenant_id, name, expires_days)
        return build_success(key_info, status=201)

    @api.route("/tenants/<tenant_id>/keys", methods=["GET"])
    @require_admin
    def api_list_keys(tenant_id):
        return jsonify({"keys": tm.list_api_keys(tenant_id)})

    @api.route("/keys/<key_id>/revoke", methods=["POST"])
    @require_admin
    @handle_errors(logger, "Revoke key failed", fallback_status=500)
    def api_revoke_key(key_id):
        tm.revoke_api_key(key_id)
        return build_success()
