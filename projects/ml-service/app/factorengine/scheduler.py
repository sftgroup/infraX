"""定时挖掘调度（需求6 FF-4.1）。

进程内 daemon 线程（仿 async_cache.prewarm_loop）：启动 delay 后每
interval 触发一次 start_job（入同一单 worker 池执行）。负载控制：
  - 已有 QUEUED/RUNNING 任务（含手动任务）→ 跳过本 tick，不叠加
  - 距上次终态任务不足 interval → 跳过（重启后不立即重复跑）
  - interval 下限 1h（防误配高频空转）；spec 上限约束在 env 侧保守配置

默认 spec 来源（二选一，INTENT 优先）：
  - FACTOR_MINER_SCHEDULE_INTENT：自然语言 → LLM 意图解析（R5-4）
  - FACTOR_MINER_SCHEDULE_SPEC：结构化 JSON {"preferences": {...}, "constraints": {...}}
未启用 / 两者均未配置 / 解析失败 → 线程不启动（fail-silent，日志告警）。
"""
from __future__ import annotations

import json
import logging
import threading
import time
from typing import Any, Optional

import config
from app.factorengine.job import JobSpec, build_spec
from app.factorengine.jobs import JobStatus

logger = logging.getLogger(__name__)

_MIN_INTERVAL_S = 3600.0  # interval 下限 1h（负载护栏）

_TERMINAL_STATUSES = {
    JobStatus.COMPLETED.value, JobStatus.FAILED.value,
    JobStatus.CANCELLED.value, JobStatus.TIMEOUT.value,
}
_ACTIVE_STATUSES = {JobStatus.QUEUED.value, JobStatus.RUNNING.value}


def _active_job_exists(store: Any) -> bool:
    """存在活跃任务（排队/运行中）→ 跳过，避免与手动任务叠加。"""
    for j in store.list(limit=50):
        if j["status"] in _ACTIVE_STATUSES:
            return True
    return False


def _last_terminal_ts(store: Any) -> Optional[int]:
    """最近一次终态任务的 updated_at（毫秒）；无终态任务返回 None。"""
    ts = [j.get("updated_at") or j.get("created_at") or 0
          for j in store.list(limit=50) if j["status"] in _TERMINAL_STATUSES]
    return max(ts) if ts else None


def should_run(store: Any, interval_s: float) -> bool:
    """本 tick 是否触发挖掘：无活跃任务 + 距上次终态 ≥ interval（或从未跑过）。"""
    if _active_job_exists(store):
        return False
    last = _last_terminal_ts(store)
    if last is None:
        return True
    return int(time.time() * 1000) - last >= interval_s * 1000


def build_default_spec() -> tuple[JobSpec, list[str]]:
    """构造调度用 JobSpec：INTENT（LLM 解析）优先，否则 SPEC JSON。"""
    if config.FACTOR_MINER_SCHEDULE_INTENT:
        from app.factorengine.intent import parse_intent
        parsed = parse_intent(config.FACTOR_MINER_SCHEDULE_INTENT)
        return build_spec(parsed["preferences"], parsed["constraints"])
    spec_json = json.loads(config.FACTOR_MINER_SCHEDULE_SPEC)
    return build_spec(spec_json.get("preferences") or {},
                      spec_json.get("constraints") or {})


def miner_schedule_loop(interval_s: float, delay_s: float) -> None:
    """调度循环：构造/触发单次异常仅告警，不中断后续 tick。"""
    from app.factorengine.jobs import get_store, start_job

    try:
        spec, conflicts = build_default_spec()
    except Exception as exc:
        logger.warning("factor miner scheduler disabled: 默认 spec 构造失败: %s", exc)
        return
    if conflicts:
        logger.warning("factor miner scheduler disabled: 默认 spec 冲突: %s", conflicts)
        return
    logger.info("factor miner scheduler started (interval=%.0fs delay=%.0fs, spec ok)",
                interval_s, delay_s)
    time.sleep(max(0.0, delay_s))
    while True:
        try:
            store = get_store()
            if not should_run(store, interval_s):
                logger.info("factor miner: 活跃任务或距上次终态不足 interval，跳过本 tick")
            else:
                job = start_job(spec)
                logger.info("factor miner: 触发定时挖掘 job=%s", job["job_id"])
        except Exception as exc:
            logger.warning("factor miner tick failed: %s", exc)
        time.sleep(max(0.0, interval_s))


def start_miner_scheduler() -> Optional[threading.Thread]:
    """启动调度线程；未启用/配置缺失/解析失败返回 None（fail-silent）。"""
    if not config.FACTOR_MINER_SCHEDULE_ENABLED:
        return None
    interval_s = max(_MIN_INTERVAL_S, config.FACTOR_MINER_SCHEDULE_INTERVAL_H * 3600.0)
    delay_s = max(0.0, config.FACTOR_MINER_SCHEDULE_DELAY_S)
    if not (config.FACTOR_MINER_SCHEDULE_INTENT or config.FACTOR_MINER_SCHEDULE_SPEC):
        logger.warning("factor miner scheduler enabled but SPEC/INTENT 均未配置，调度未启动")
        return None
    t = threading.Thread(target=miner_schedule_loop, args=(interval_s, delay_s),
                         name="factor-miner-scheduler", daemon=True)
    t.start()
    return t
