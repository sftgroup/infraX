"""Write-path task queue — 读写分离的核心。

设计：
- 写（insert / batch insert / delete）→ 有界队列 + 后台 worker 线程，
  REST 立即返回 202 + task_id，慢注入不再占用请求线程。
- 读（query / retrieve）→ 仍在请求线程直连全局事件循环，不受写任务占坑影响。
- 所有 LightRAG 操作仍在同一个全局事件循环执行（LightRAG 内部的
  asyncio.Lock 绑定单循环，禁止跨循环共享实例）。

任务记录保存在进程内存中，超过 TTL 惰性清理（查询时过滤）。
"""
from __future__ import annotations

import itertools
import logging
import queue
import threading
import time
from typing import Any, Callable

from config import get_config

logger = logging.getLogger("ragservicer.tasks")


def _observe_queue_full() -> None:
    """RWL-4: 记录一次队列满拒绝（/metrics）。可选依赖，失败静默。"""
    try:
        from metrics import WRITE_QUEUE_FULL_TOTAL
        WRITE_QUEUE_FULL_TOTAL.labels(service="ragservicer").inc()
    except Exception:
        pass


def _observe_queue_depth(depth: int) -> None:
    """RWL-4: 更新当前队列深度 Gauge（/metrics）。"""
    try:
        from metrics import WRITE_QUEUE_DEPTH
        WRITE_QUEUE_DEPTH.labels(service="ragservicer").set(depth)
    except Exception:
        pass

# ── 任务状态 ───────────────────────────────────────────
QUEUED = "queued"
RUNNING = "running"
SUCCESS = "success"
FAILED = "failed"


class WriteQueueFull(Exception):
    """写队列已满，应返回 503 让调用方稍后重试。"""


# ── 内部状态（进程内存，线程安全） ─────────────────────
_tasks: dict[str, dict] = {}
_tasks_lock = threading.Lock()
_write_queue: queue.Queue | None = None
_workers: list[threading.Thread] = []
_seq = itertools.count(1)

_MAX_LIST_TASKS = 200


def _now() -> float:
    return time.time()


def _ttl() -> float:
    return float(get_config().rag.task_ttl_seconds)


def init_write_queue() -> None:
    """启动后台写 worker（幂等，多线程安全）。"""
    global _write_queue, _workers
    if _write_queue is not None:
        return
    cfg = get_config().rag
    _write_queue = queue.Queue(maxsize=cfg.task_queue_size)
    for i in range(cfg.write_workers):
        t = threading.Thread(
            target=_worker_loop, daemon=True, name=f"rag-writer-{i}"
        )
        t.start()
        _workers.append(t)
    logger.info(
        "Write queue ready: workers=%d queue_size=%d",
        cfg.write_workers, cfg.task_queue_size,
    )


def _worker_loop() -> None:
    """后台 worker：从队列取任务，在全局事件循环执行，并更新任务状态。"""
    from api.engine import _run_async  # 延迟导入避免循环依赖

    q = _write_queue
    while True:
        item = q.get()
        if item is None:
            break
        task_id, coro_factory = item
        _observe_queue_depth(q.qsize())
        _set_status(task_id, RUNNING)
        try:
            result = _run_async(coro_factory(), timeout=None)
            _set_status(task_id, SUCCESS, result=result)
        except Exception as exc:  # noqa: BLE001
            logger.error("Write task %s failed: %s", task_id, exc, exc_info=True)
            _set_status(task_id, FAILED, error=str(exc) or "task failed")
        finally:
            q.task_done()


# ── 任务记录管理 ───────────────────────────────────────

def submit(coro_factory: Callable[[], Any], *, kind: str,
           tenant: str, namespace: str) -> str:
    """提交一个写任务到队列，立即返回 task_id。

    coro_factory: 无参可调用，返回一个 coroutine（在全局循环中执行）。
    """
    init_write_queue()
    if _write_queue.full():  # type: ignore[union-attr]
        _observe_queue_full()
        raise WriteQueueFull("write queue is full, retry later")

    task_id = f"task_{next(_seq)}"
    now = _now()
    with _tasks_lock:
        _tasks[task_id] = {
            "task_id": task_id,
            "kind": kind,
            "tenant": tenant,
            "namespace": namespace,
            "status": QUEUED,
            "created_at": now,
            "updated_at": now,
            "finished_at": None,
            "error": None,
            "result": None,
        }
    _write_queue.put((task_id, coro_factory))  # type: ignore[union-attr]
    return task_id


def _set_status(task_id: str, status: str,
                result: Any = None, error: str | None = None) -> None:
    with _tasks_lock:
        rec = _tasks.get(task_id)
        if rec is None:
            return
        rec["status"] = status
        rec["updated_at"] = _now()
        if status in (SUCCESS, FAILED):
            rec["finished_at"] = _now()
        if result is not None:
            rec["result"] = result
        if error is not None:
            rec["error"] = error


def _is_expired(rec: dict) -> bool:
    return (_now() - rec["created_at"]) > _ttl()


def get_task(task_id: str) -> dict | None:
    """返回任务详情（已过 TTL 视为不存在）。"""
    with _tasks_lock:
        rec = _tasks.get(task_id)
        if rec is None or _is_expired(rec):
            return None
        return dict(rec)


def list_tasks(limit: int = 20, tenant: str | None = None) -> list[dict]:
    """列出最近任务（新→旧），可选按 tenant 过滤。"""
    with _tasks_lock:
        now = _now()
        items = [
            dict(r) for r in _tasks.values()
            if (now - r["created_at"]) <= _ttl()
            and (tenant is None or r["tenant"] == tenant)
        ]
    items.sort(key=lambda r: r["created_at"], reverse=True)
    return items[:_MAX_LIST_TASKS][:limit]


def task_stats() -> dict:
    """当前任务统计（含队列深度）。"""
    with _tasks_lock:
        counts = {s: 0 for s in (QUEUED, RUNNING, SUCCESS, FAILED)}
        for r in _tasks.values():
            if _is_expired(r):
                continue
            counts[r["status"]] = counts.get(r["status"], 0) + 1
        total = sum(counts.values())
    return {
        "queue_depth": _write_queue.qsize() if _write_queue else 0,
        "total": total,
        "queued": counts[QUEUED],
        "running": counts[RUNNING],
        "success": counts[SUCCESS],
        "failed": counts[FAILED],
    }
