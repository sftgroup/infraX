"""Admin routes: tenant management + API key management + runtime config."""
import logging
import os
import threading
from pathlib import Path

from flask import request, Blueprint, jsonify
from api.engine import list_instances, reload_runtime_config
from api.auth import require_admin
from api.tasks import task_stats, list_tasks as list_write_tasks
from tenants import manager as tm
from config import get_config, reload_config
from api.code_refactor import parse_json, handle_errors, build_success, build_error

logger = logging.getLogger("ragservicer.routes.admin")

# ── Runtime config (LLM / Embedding keys) ───────────────

ENV_PATH = Path(__file__).resolve().parents[2] / ".env"

# 并发 PUT 串行化 read-modify-write，避免丢更新（与 data/injector admin 一致）
_env_write_lock = threading.Lock()

# request field → (env var, coerce)
_CFG_FIELDS = {
    "llm": {
        "api_key": ("LLM_BINDING_API_KEY", str),
        "model": ("LLM_MODEL", str),
        "base_url": ("LLM_BINDING_HOST", str),
    },
    "embedding": {
        "api_key": ("EMBEDDING_API_KEY", str),
        "model_name": ("EMBEDDING_MODEL", str),
        "backend": ("EMBEDDING_BACKEND", str),
        "dims": ("EMBEDDING_DIMS", int),
        "max_token_size": ("EMBEDDING_MAX_TOKENS", int),
        "base_url": ("EMBEDDING_BASE_URL", str),
    },
}
_MASK = "********"


def _mask_secret(v: str) -> str:
    if not v:
        return ""
    if len(v) <= 8:
        return _MASK
    return f"{v[:4]}{_MASK}{v[-4:]}"


def _snapshot_config():
    cfg = get_config()
    llm = cfg.llm
    emb = cfg.embedding
    return {
        "llm": {
            "model": llm.model,
            "base_url": llm.base_url,
            "api_key_set": bool(llm.api_key),
            "api_key": _mask_secret(llm.api_key),
        },
        "embedding": {
            "backend": emb.backend,
            "model_name": emb.model_name,
            "dims": emb.dims,
            "max_token_size": emb.max_token_size,
            "base_url": emb.base_url,
            "api_key_set": bool(emb.api_key),
            "api_key": _mask_secret(emb.api_key),
        },
        "env_file": str(ENV_PATH),
    }


def _write_env(updates: dict[str, str]) -> None:
    """Line-level replace-or-append of KEY=VALUE into the .env file."""
    with _env_write_lock:
        if not ENV_PATH.exists():
            ENV_PATH.write_text("")
        lines = ENV_PATH.read_text().splitlines()
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
        ENV_PATH.write_text("\n".join(out) + "\n")


def register(api: Blueprint):
    # ── Instance Info ────────────────────────────────

    @api.route("/instances", methods=["GET"])
    @require_admin
    def api_list_instances():
        return jsonify({"instances": list_instances()})

    # ── 写任务统计（读写分离可观测性） ─────────────────

    @api.route("/admin/tasks", methods=["GET"])
    @require_admin
    @handle_errors(logger, "List write tasks failed", fallback_status=500)
    def api_admin_tasks():
        try:
            limit = max(1, min(200, int(request.args.get("limit", 20))))
        except (TypeError, ValueError):
            return build_error("limit must be an integer", 400)
        return build_success({
            "stats": task_stats(),
            "tasks": list_write_tasks(limit),
        })

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
            return build_error("tenant_id is required", 400)

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
            return build_error(f"Tenant '{tenant_id}' not found", 404)

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

    # ── Runtime Config (LLM / Embedding) ────────────────

    @api.route("/admin/config", methods=["GET"])
    @require_admin
    def api_get_config():
        """Return current LLM/embedding config with masked secrets."""
        return build_success(_snapshot_config())

    @api.route("/admin/config", methods=["PUT"])
    @require_admin
    @handle_errors(logger, "Update config failed", fallback_status=500)
    def api_put_config():
        """Update LLM/embedding config. Hot-applies: writes .env, reloads
        config singleton, and drops cached RAG instances so new requests
        use the new keys — no service restart needed."""
        data = parse_json()
        if not isinstance(data, dict):
            return build_error("config object required", 400)

        updates: dict[str, str] = {}
        for group, fields in _CFG_FIELDS.items():
            payload = data.get(group)
            if not isinstance(payload, dict):
                continue
            for field, (env_var, coerce) in fields.items():
                if field not in payload:
                    continue
                value = payload[field]
                if value is None:
                    continue
                # "masked placeholder" values mean "keep the current secret"
                if field == "api_key" and (value == _MASK or value == ""):
                    continue
                try:
                    updates[env_var] = str(coerce(value))
                except (TypeError, ValueError):
                    return build_error(f"{group}.{field} must be a valid {coerce.__name__}", 400)

        if not updates:
            return build_success(_snapshot_config())

        _write_env(updates)
        for k, v in updates.items():
            os.environ[k] = v
        reload_config()
        reload_runtime_config()
        logger.info(f"Runtime config updated: {', '.join(sorted(updates))}")
        return build_success(_snapshot_config())
