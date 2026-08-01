"""
Route registry — aggregate all route modules under one Blueprint.
"""
from flask import Blueprint, jsonify
from api.engine import list_instances

api = Blueprint("api", __name__, url_prefix="/api/v1")


# ── Health ───────────────────────────────────────────────

@api.route("/health")
def health():
    return jsonify({
        "status": "ok",
        "service": "infrax-ragservicer",
        "instances": len(list_instances()),
    })


# ── Register sub-routes ─────────────────────────────────

def _register_all():
    from . import documents, query, admin, legacy
    documents.register(api)
    query.register(api)
    admin.register(api)
    legacy.register(api)


_register_all()
