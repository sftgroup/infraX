"""挖掘任务状态机 + 持久化 + 执行器（需求5 R5-2）。

存储：默认 SQLite（标准库 sqlite3，零外部依赖，生产立即可用）；
FACTOR_DB_PATH 可指向自定义文件。PostgreSQL 支持为后续可选项
（psycopg2 依赖，见 tasklist FF-3 备注）。

状态机：CREATED→PARSED→QUEUED→RUNNING(POOL→EVAL→SELECT→PERSIST)→
        COMPLETED / FAILED / CANCELLED / TIMEOUT
执行：单 worker 线程池（小内存机防并发挤爆）；重启后未完成 job 标 FAILED
（部分结果保留）。
"""
from __future__ import annotations

import json
import logging
import os
import sqlite3
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Optional

import config
from app.factorengine.job import JobSpec, now_ms, spec_to_dict

logger = logging.getLogger(__name__)

# 状态机中间态（RUNNING 内细分阶段，progress 字段记录）
STAGES = ("pool", "eval", "select", "persist")


class JobStatus(str, Enum):
    CREATED = "CREATED"
    PARSED = "PARSED"
    QUEUED = "QUEUED"
    RUNNING = "RUNNING"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"
    TIMEOUT = "TIMEOUT"


_DDL = """
CREATE TABLE IF NOT EXISTS factor_jobs (
    job_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    stage TEXT,
    spec_json TEXT NOT NULL,
    preferences_json TEXT,
    constraints_json TEXT,
    result_json TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS factor_results (
    job_id TEXT NOT NULL,
    factor_key TEXT NOT NULL,
    ic REAL, icir REAL, ic_std REAL,
    monotonicity REAL, independence REAL,
    passed INTEGER DEFAULT 0,
    detail_json TEXT,
    PRIMARY KEY (job_id, factor_key)
);
"""


class JobStore:
    """SQLite 任务存储（线程安全：单连接 + 锁）。"""

    def __init__(self, path: str | None = None) -> None:
        self.path = path or config.FACTOR_DB_PATH
        self._lock = threading.Lock()
        os.makedirs(os.path.dirname(os.path.abspath(self.path)), exist_ok=True)
        self._conn = sqlite3.connect(self.path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        with self._lock:
            self._conn.executescript(_DDL)
            self._conn.commit()

    def create(self, spec: JobSpec) -> dict[str, Any]:
        job_id = _new_id()
        now = now_ms()
        with self._lock:
            self._conn.execute(
                "INSERT INTO factor_jobs (job_id, status, spec_json, preferences_json, "
                "constraints_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (job_id, JobStatus.CREATED.value, json.dumps(spec_to_dict(spec), ensure_ascii=False),
                 json.dumps(spec.preferences.model_dump(), ensure_ascii=False),
                 json.dumps(spec.constraints.model_dump(), ensure_ascii=False), now, now),
            )
            self._conn.commit()
        return self.get(job_id)  # type: ignore[return-value]

    def update(self, job_id: str, status: JobStatus | None = None,
               stage: str | None = None, error: str | None = None,
               result: Any | None = None) -> None:
        with self._lock:
            sets, vals = [], []
            if status is not None:
                sets.append("status = ?")
                vals.append(status.value)
            if stage is not None:
                sets.append("stage = ?")
                vals.append(stage)
            if error is not None:
                sets.append("error = ?")
                vals.append(error)
            if result is not None:
                sets.append("result_json = ?")
                vals.append(json.dumps(result, ensure_ascii=False, default=str))
            sets.append("updated_at = ?")
            vals.append(now_ms())
            vals.append(job_id)
            self._conn.execute(
                f"UPDATE factor_jobs SET {', '.join(sets)} WHERE job_id = ?", vals)
            self._conn.commit()

    def get(self, job_id: str) -> Optional[dict[str, Any]]:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM factor_jobs WHERE job_id = ?", (job_id,)).fetchone()
        if row is None:
            return None
        return _row_to_dict(row)

    def list(self, limit: int = 50) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT job_id, status, stage, created_at, updated_at, error "
                "FROM factor_jobs ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()
        return [_row_to_dict(r) for r in rows]

    def save_results(self, job_id: str, results: list[dict[str, Any]]) -> None:
        with self._lock:
            for r in results:
                self._conn.execute(
                    "INSERT OR REPLACE INTO factor_results (job_id, factor_key, ic, icir, ic_std, "
                    "monotonicity, independence, passed, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    (job_id, r["factor_key"], r.get("ic"), r.get("icir"), r.get("ic_std"),
                     r.get("monotonicity"), r.get("independence"),
                     1 if r.get("passed") else 0, json.dumps(r.get("detail", {}), ensure_ascii=False, default=str)),
                )
            self._conn.commit()

    def results(self, job_id: str) -> list[dict[str, Any]]:
        with self._lock:
            rows = self._conn.execute(
                "SELECT factor_key, ic, icir, ic_std, monotonicity, independence, passed "
                "FROM factor_results WHERE job_id = ? ORDER BY ic DESC", (job_id,)).fetchall()
        return [_row_to_dict(r) for r in rows]

    # 重启恢复：未完成 job 标 FAILED（部分结果保留）
    def recover(self) -> None:
        with self._lock:
            self._conn.execute(
                "UPDATE factor_jobs SET status = ?, error = ?, updated_at = ? "
                "WHERE status IN (?, ?, ?)",
                (JobStatus.FAILED.value, "service restarted mid-run",
                 now_ms(), JobStatus.QUEUED.value, JobStatus.RUNNING.value, JobStatus.PARSED.value))
            self._conn.commit()


def _row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    d = dict(row)
    for k in ("spec_json", "preferences_json", "constraints_json", "result_json"):
        if d.get(k):
            try:
                d[k.replace("_json", "")] = json.loads(d[k])
            except (json.JSONDecodeError, TypeError):
                pass
    return d


def _new_id() -> str:
    import uuid
    return f"ff_{time.strftime('%Y%m%d')}_{uuid.uuid4().hex[:12]}"


# ── 执行器（单 worker） ─────────────────────────────────────

_store: Optional[JobStore] = None
_store_lock = threading.Lock()
_executor: Optional[ThreadPoolExecutor] = None
_cancelled: set[str] = set()


def get_store() -> JobStore:
    global _store
    if _store is None:
        with _store_lock:
            if _store is None:
                _store = JobStore()
                _store.recover()
    return _store


def _ensure_executor() -> ThreadPoolExecutor:
    global _executor
    if _executor is None:
        with _store_lock:
            if _executor is None:
                _executor = ThreadPoolExecutor(
                    max_workers=max(1, config.FACTOR_MINER_WORKERS),
                    thread_name_prefix="factor-miner")
    return _executor


def start_job(spec: JobSpec) -> dict[str, Any]:
    """创建并排队任务（CREATED→PARSED→QUEUED），返回 job 记录。"""
    store = get_store()
    job = store.create(spec)
    job_id = job["job_id"]
    store.update(job_id, status=JobStatus.PARSED)
    # 硬限制不可被偏好覆盖：偏好/限制冲突在 spec 校验时已提示
    store.update(job_id, status=JobStatus.QUEUED)

    from app.factorengine.runner import run_mine
    _ensure_executor().submit(_run_wrapper, job_id, spec)
    return store.get(job_id)  # type: ignore[return-value]


def _run_wrapper(job_id: str, spec: JobSpec) -> None:
    """后台执行；超时/异常 → 状态机终态；支持 cancel 检查。"""
    store = get_store()
    if job_id in _cancelled:
        _cancelled.discard(job_id)
        store.update(job_id, status=JobStatus.CANCELLED)
        return
    store.update(job_id, status=JobStatus.RUNNING, stage="pool")
    started = time.monotonic()
    timeout_sec = spec.constraints.max_runtime_min * 60

    def progress(stage: str) -> bool:
        """每阶段回调：更新 stage；超时 → TIMEOUT 并终止。"""
        if job_id in _cancelled:
            return False
        if time.monotonic() - started > timeout_sec:
            store.update(job_id, status=JobStatus.TIMEOUT, stage=stage)
            return False
        store.update(job_id, status=JobStatus.RUNNING, stage=stage)
        return True

    try:
        from app.factorengine.runner import run_mine
        result = run_mine(spec, progress=progress)
        if result is None:
            # 超时/取消由 progress 落终态；其余 None（无标的/无K线/候选为空）标记 FAILED，
            # 避免 job 永久停在 RUNNING。
            job = store.get(job_id)
            if job is not None and job["status"] == JobStatus.RUNNING.value:
                store.update(job_id, status=JobStatus.FAILED,
                             error="无可用数据：asset_pool 无有效标的或 K 线不足（见日志）")
            return
        store.save_results(job_id, result["results"])
        # FF-3.1：passed 因子自动登记进 catalog（inactive，待激活）
        from app.factorengine.catalog import register_qualified
        register_qualified(job_id, result["results"])
        # FF-4.3 自动闭环：合格因子自动激活（进 /factors/current 与模型特征）
        # + 置模型过期（下次预测自动用含新因子的特征重训）。开关默认开启。
        activated = 0
        if config.FACTOR_MINER_AUTO_ACTIVATE:
            from app.factorengine.catalog import auto_activate
            activated = auto_activate(job_id, result["results"])
        if config.FACTOR_MINER_AUTO_RETRAIN and activated:
            from app.analytics.tree_models import invalidate_models
            invalidate_models()
        store.update(job_id, status=JobStatus.COMPLETED, stage="persist",
                     result={"selected": result["selected"],
                             "stats": result["stats"],
                             "factors": result["results"]})
    except Exception as exc:
        logger.exception("[%s] mine failed", job_id)
        store.update(job_id, status=JobStatus.FAILED, error=str(exc))


def cancel_job(job_id: str) -> bool:
    """取消任务（排队/运行中均终止；终态无效）。"""
    store = get_store()
    job = store.get(job_id)
    if job is None:
        return False
    if job["status"] not in (JobStatus.QUEUED.value, JobStatus.RUNNING.value,
                             JobStatus.PARSED.value, JobStatus.CREATED.value):
        return False
    _cancelled.add(job_id)
    store.update(job_id, status=JobStatus.CANCELLED, error="cancelled by user")
    return True


def job_status(job_id: str) -> Optional[dict[str, Any]]:
    return get_store().get(job_id)


def list_jobs(limit: int = 50) -> list[dict[str, Any]]:
    return get_store().list(limit)
