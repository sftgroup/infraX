"""Document CRUD routes.

读写分离：写（insert/batch/delete）默认走后台队列异步执行，
请求立即返回 202 + task_id，慢注入不再占用请求线程、不阻塞查询。
显式传入 `"async": false` 或 `?sync=1` 可回退到同步执行（兼容旧调用方）。
"""
import logging
from flask import request, Blueprint
from api.engine import (
    insert_document as eng_insert,
    insert_documents_batch,
    delete_document,
    list_documents,
    submit_insert_document,
    submit_insert_documents_batch,
    submit_delete_document,
)
from api.auth import require_tenant
from api.code_refactor import parse_json, Guard, handle_errors, build_success, build_error
from api.tasks import get_task, WriteQueueFull

logger = logging.getLogger("ragservicer.routes.documents")


def _want_async() -> bool:
    """默认异步（走写队列）；`?sync=1` 或 body `"async": false` 走同步。"""
    if request.args.get("sync", "") in ("1", "true"):
        return False
    data = parse_json()
    return data.get("async", True) is not False


def _submit_or_error(submit_fn, *args):
    """提交写任务；队列满时返回 503 错误响应。"""
    try:
        return None, submit_fn(*args)
    except WriteQueueFull as exc:
        return build_error(str(exc), 503), None


def register(api: Blueprint):
    @api.route("/namespaces/<namespace>/documents", methods=["POST"])
    @require_tenant
    @handle_errors(logger, "Insert failed")
    def api_insert_document(namespace, _tenant):
        data = parse_json()
        text = data.get("text", "")
        doc_id = data.get("doc_id", data.get("file_name", "document.txt"))

        if not text.strip():
            return build_error("text is required", 400)

        if _want_async():
            err, task_id = _submit_or_error(submit_insert_document, _tenant, namespace, text, doc_id)
            if err:
                return err
            return build_success({
                "task_id": task_id,
                "status": "queued",
                "doc_id": doc_id,
            }, status=202)

        result = eng_insert(_tenant, namespace, text, doc_id)
        return build_success(result, status=201)

    @api.route("/namespaces/<namespace>/documents/batch", methods=["POST"])
    @require_tenant
    @handle_errors(logger, "Batch insert failed")
    def api_insert_documents_batch(namespace, _tenant):
        data = parse_json()
        documents = data.get("documents", [])
        if not documents:
            return build_error("documents array is required", 400)

        # Validate each document has a "text" field
        for i, doc in enumerate(documents):
            if not isinstance(doc, dict) or not str(doc.get("text", "")).strip():
                return build_error(f"documents[{i}].text is required", 400)

        if _want_async():
            err, task_id = _submit_or_error(submit_insert_documents_batch, _tenant, namespace, documents)
            if err:
                return err
            return build_success({
                "task_id": task_id,
                "status": "queued",
                "count": len(documents),
            }, status=202)

        result = insert_documents_batch(_tenant, namespace, documents)
        return build_success(result, status=201)

    @api.route("/namespaces/<namespace>/documents", methods=["GET"])
    @require_tenant
    @handle_errors(logger, "List documents failed")
    def api_list_documents(namespace, _tenant):
        try:
            page = max(1, int(request.args.get("page", 1)))
        except (TypeError, ValueError):
            return build_error("page must be an integer", 400)
        try:
            limit = max(1, min(100, int(request.args.get("limit", 20))))
        except (TypeError, ValueError):
            return build_error("limit must be an integer", 400)

        result = list_documents(_tenant, namespace, page, limit)
        return build_success(result)

    @api.route("/namespaces/<namespace>/documents/<doc_id>", methods=["DELETE"])
    @require_tenant
    @handle_errors(logger, "Delete failed")
    def api_delete_document(namespace, doc_id, _tenant):
        if _want_async():
            err, task_id = _submit_or_error(submit_delete_document, _tenant, namespace, doc_id)
            if err:
                return err
            return build_success({
                "task_id": task_id,
                "status": "queued",
                "doc_id": doc_id,
            }, status=202)

        result = delete_document(_tenant, namespace, doc_id)
        return build_success(result)

    # ── 写任务状态查询（读写分离：提交后轮询此接口） ──

    @api.route("/namespaces/<namespace>/tasks/<task_id>", methods=["GET"])
    @require_tenant
    @handle_errors(logger, "Get task failed")
    def api_get_task(namespace, task_id, _tenant):
        task = get_task(task_id)
        if task is None or task["tenant"] != _tenant:
            return build_error("task not found", 404)
        return build_success(task)
