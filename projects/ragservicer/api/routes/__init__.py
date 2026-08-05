"""
Route registry — aggregate all route modules under one Blueprint.
"""
from flask import Blueprint, jsonify
from api.engine import list_instances
from api.code_refactor import build_success

api = Blueprint("api", __name__, url_prefix="/api/v1")


# ── Health ───────────────────────────────────────────────

@api.route("/health")
def health():
    return build_success({
        "service": "infrax-ragservicer",
        "instances": len(list_instances()),
    })


# ── OpenAPI 文档（G-9）────────────────────────────────
# 手写 OpenAPI 3.0 spec（api/openapi.py），无鉴权装饰器 → 天然公开。

@api.route("/openapi.json")
def openapi_json():
    from api.openapi import build_openapi
    return jsonify(build_openapi())


# ── Register sub-routes ─────────────────────────────────

def _register_all():
    from . import documents, query, admin, legacy
    documents.register(api)
    query.register(api)
    admin.register(api)
    legacy.register(api)


_register_all()
