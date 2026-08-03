"""注入统计跟踪器。

记录每次注入的结果（成功/失败/耗时），供 API 查询。
线程安全，内存存储（重启丢失，适合调试用）。
"""
from __future__ import annotations

import time
import threading
from typing import Any


class InjectionStats:
    """线程安全的注入统计。"""

    def __init__(self):
        self._lock = threading.Lock()
        self._history: list[dict[str, Any]] = []
        self._max_history = 500

    def record(
        self,
        injector_name: str,
        success: bool,
        duration_ms: float,
        error: str | None = None,
    ) -> None:
        """记录一次注入结果。"""
        record = {
            "injector": injector_name,
            "success": success,
            "duration_ms": round(duration_ms, 1),
            "error": error or (None if success else "unknown"),
            "timestamp": time.time(),
        }
        with self._lock:
            self._history.append(record)
            if len(self._history) > self._max_history:
                self._history = self._history[-self._max_history // 2 :]

    def summary(self) -> dict[str, Any]:
        """获取统计数据。"""
        with self._lock:
            total = len(self._history)
            if total == 0:
                return {"total_runs": 0, "injectors": {}}

            by_injector: dict[str, dict] = {}
            for rec in self._history:
                name = rec["injector"]
                if name not in by_injector:
                    by_injector[name] = {
                        "total": 0, "success": 0, "failure": 0,
                        "total_duration_ms": 0.0, "last_run": 0, "last_success": 0,
                    }
                d = by_injector[name]
                d["total"] += 1
                d["total_duration_ms"] += rec["duration_ms"]
                if rec["success"]:
                    d["success"] += 1
                    d["last_success"] = rec["timestamp"]
                else:
                    d["failure"] += 1
                d["last_run"] = rec["timestamp"]

            # 计算平均值
            for name, d in by_injector.items():
                d["avg_duration_ms"] = round(d["total_duration_ms"] / d["total"], 1) if d["total"] > 0 else 0
                d["success_rate"] = round(d["success"] / d["total"] * 100, 1) if d["total"] > 0 else 0
                del d["total_duration_ms"]

            return {
                "total_runs": total,
                "injectors": by_injector,
            }

    def recent(self, limit: int = 20) -> list[dict[str, Any]]:
        """获取最近的注入记录。"""
        with self._lock:
            return list(reversed(self._history[-limit:]))


# 全局单例
STATS = InjectionStats()
