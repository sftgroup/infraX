"""异步结果计算 + 周期预热（ml-service）。

背景：重计算端点（volatility/tree/bolt/moirai/timesfm）在 miss 缓存时若在
请求线程内同步执行分钟级推理，会占满 FastAPI worker 线程池——连 /health
这类轻端点也排队超时（此前 /ml/volatility 全量预测曾把服务拖死）。

本模块把「计算」移到后台 daemon 线程：

  - AsyncCacheRunner.get(key, compute)：命中返回缓存值；miss 触发后台
    计算并立即返回 None（幂等：同 key 已在计算则跳过），请求不阻塞。
  - prewarm_loop：启动 delay 后周期检查各 key，缓存缺失/过期时后台刷新，
    保证缓存常满、请求几乎总是命中。

后台计算复用 TTLCache.get_or_compute（per-key 锁 + 命中/耗时统计，
None 结果不缓存）。计算在独立线程执行，与请求线程池解耦。
"""
from __future__ import annotations

import logging
import threading
import time
from typing import Any, Callable, Dict

logger = logging.getLogger(__name__)


class AsyncCacheRunner:
    """TTLCache 的异步封装：计算放后台线程，请求永不因重计算而阻塞。

    自 GP-2 起支持任务（job）语义：
      - trigger() 新启动后台计算时返回 job_id（同 key 已在计算则返回 None）；
      - active_job_id(key) / get_job_status(job_id) 供端点透传构建进度；
      - 端点冷态可返回 202 + job_id，客户端轮询 /ml/graph/jobs/{job_id}。
    """

    _JOB_KEEP_MAX = 100  # 任务记录保留上限（超限淘汰最早完成的任务，防内存膨胀）

    def __init__(self, cache, ttl: float) -> None:
        self._cache = cache
        self._ttl = ttl
        self._running: set[str] = set()
        self._jobs: dict[str, dict] = {}    # job_id → {key, status, started_at, ...}
        self._key_job: dict[str, str] = {}  # key → 当前运行中 job_id
        self._lock = threading.Lock()

    def get(self, key: str, compute: Callable[[], Any]) -> Any:
        """SWR（stale-while-revalidate）读取。

        命中返回新鲜缓存；缓存缺失/过期时先取旧值（stale）返回（volatility
        等分钟级重算的慢变预测可接受陈旧结果，避免重算窗口内端点长时间
        null），同时触发后台刷新（防重入，请求不阻塞）。从未缓存过才返回
        None。
        """
        stale = self._cache.peek_stale(key)  # 先取旧值（含过期，不淘汰）
        value = self._cache.peek(key)
        if value is not None:
            self._cache.bump(key, hits=1)
            return value
        self.trigger(key, compute)
        if stale is not None:
            self._cache.bump(key, stale=1)
        return stale

    def trigger(self, key: str, compute: Callable[[], Any]) -> str | None:
        """确保后台计算已启动。新启动返回 job_id；同 key 已在计算返回 None。"""
        with self._lock:
            if key in self._running:
                return None
            self._running.add(key)
            job_id = f"{key}-{int(time.time() * 1000)}"
            self._jobs[job_id] = {
                "job_id": job_id,
                "key": key,
                "status": "running",
                "started_at": int(time.time() * 1000),
                "finished_at": None,
                "duration_ms": None,
                "error": None,
            }
            self._key_job[key] = job_id
            self._trim_jobs_locked()
        t = threading.Thread(
            target=self._run, args=(key, compute), name=f"compute-{key}", daemon=True
        )
        t.start()
        return job_id

    def active_job_id(self, key: str) -> str | None:
        """返回 key 当前运行中的 job_id（未运行返回 None）。"""
        with self._lock:
            return self._key_job.get(key)

    def get_job_status(self, job_id: str) -> dict | None:
        """查询任务状态（running/success/error + 起止时间/耗时）。不存在返回 None。"""
        with self._lock:
            job = self._jobs.get(job_id)
            return dict(job) if job else None

    def need_refresh(self, key: str) -> bool:
        """缓存缺失或过期 → 需要刷新（供预热循环判断）。"""
        return self._cache.peek(key) is None

    def running_keys(self) -> list[str]:
        with self._lock:
            return sorted(self._running)

    def _trim_jobs_locked(self) -> None:
        """保留上限内最新任务；超限时淘汰最早完成（非 running）的任务。"""
        if len(self._jobs) <= self._JOB_KEEP_MAX:
            return
        finished = sorted(
            (j for j in self._jobs.values() if j["status"] != "running"),
            key=lambda j: (j["finished_at"] or j["started_at"]),
        )
        for j in finished[: len(self._jobs) - self._JOB_KEEP_MAX]:
            self._jobs.pop(j["job_id"], None)

    def _run(self, key: str, compute: Callable[[], Any]) -> None:
        started = time.monotonic()
        status, error = "success", None
        try:
            # 复用 TTLCache 的 per-key 锁 + 统计；None 结果不缓存
            self._cache.get_or_compute(key, compute, self._ttl)
        except Exception as exc:
            status, error = "error", str(exc)
            logger.warning("background compute %s failed: %s", key, exc)
        finally:
            with self._lock:
                self._running.discard(key)
                job_id = self._key_job.pop(key, None)
                if job_id and job_id in self._jobs:
                    self._jobs[job_id].update({
                        "status": status,
                        "finished_at": int(time.time() * 1000),
                        "duration_ms": int((time.monotonic() - started) * 1000),
                        "error": error,
                    })


def prewarm_loop(
    runner: AsyncCacheRunner,
    tasks: Dict[str, Callable[[], Any]],
    delay: float,
    interval: float,
) -> None:
    """周期串行检查各 key，缓存缺失/过期时后台刷新（防重入，不阻塞请求）。

    tasks 为 {缓存 key: compute} 映射；delay/interval 秒。
    各 key 计算在独立后台线程并行执行（计算与请求解耦，资源竞争仅拖慢
    预测本身，不影响 HTTP 响应）。
    """
    time.sleep(max(0.0, delay))
    while True:
        for key, compute in tasks.items():
            try:
                if runner.need_refresh(key):
                    runner.trigger(key, compute)
            except Exception as exc:  # 单 key 异常不影响循环
                logger.warning("prewarm check %s failed: %s", key, exc)
        time.sleep(max(0.0, interval))
