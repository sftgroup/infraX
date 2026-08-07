"""ml-service 进程内 TTL 结果缓存 + 统计。

单进程 uvicorn，dict + 时间戳即可。FastAPI 的同步计算在 worker 线程池
执行，同一端点并发请求可能同时进入（如 tree/consensus 双 collector 同时
触发），用 per-key 锁保证同一 key 只计算一次；不同 key 互不阻塞可并行
（bolt/timesfm/moirai 并发拉取时各自计算）。

统计（GET /ml/cache/stats 暴露，供监控脚本拉取）：
  - total：hits / misses / expired / computes / compute_ms（累计计算耗时）
  - keys：各端点明细，含最近一次计算耗时 last_compute_ms、计算时间
    last_compute_at、当前缓存剩余 expires_in、是否缓存 cached

用法：
    cache = TTLCache()
    value = cache.get_or_compute("tree_predictions", compute_fn, ttl=1800)
"""
from __future__ import annotations

import threading
import time
from typing import Any, Callable


class TTLCache:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        # key -> (expire_monotonic, value, set_unix_ts)
        self._data: dict[str, tuple[float, Any, int]] = {}
        self._key_locks: dict[str, threading.Lock] = {}
        self._stats: dict[str, Any] = {
            "total": {"hits": 0, "misses": 0, "expired": 0, "computes": 0, "compute_ms": 0.0},
            "keys": {},
        }

    def get_or_compute(self, key: str, compute: Callable[[], Any], ttl: float) -> Any:
        """TTL 内命中直接返回缓存；未命中则加 per-key 锁计算并缓存。

        compute 返回 None（不可用/fail-silent）时不缓存，下次请求重试。
        """
        value, hit = self._peek(key)
        if hit:
            self._bump(key, hits=1)
            return value
        with self._lock_for(key):
            value, hit = self._peek(key)
            if hit:
                self._bump(key, hits=1)
                return value
            self._bump(key, misses=1)
            t0 = time.monotonic()
            value = compute()
            ms = (time.monotonic() - t0) * 1000.0
            if value is not None:
                self._set(key, value, ttl)
                self._record_compute(key, ms)
        return value

    def peek(self, key: str) -> Any:
        """TTL 内命中返回缓存值，否则 None（不修改命中/未命中统计）。

        供异步 runner 与预热循环判断缓存是否新鲜。
        """
        value, hit = self._peek(key)
        return value if hit else None

    def bump(self, key: str, **fields: int) -> None:
        """递增缓存统计字段（hits/misses 等）。"""
        self._bump(key, **fields)

    def clear(self) -> None:
        """清空全部缓存（如符号池变更后调用）。"""
        with self._lock:
            self._data.clear()

    def stats(self) -> dict[str, Any]:
        """缓存统计快照：total + keys 明细（含缓存条目实时状态）。"""
        with self._lock:
            now = time.monotonic()
            keys: dict[str, dict] = {}
            for k, (expire_at, _v, set_at) in self._data.items():
                st = dict(self._stats["keys"].get(k, {}))
                st.update({"cached": True, "cached_at": set_at,
                           "expires_in": round(expire_at - now, 1)})
                keys[k] = st
            for k, st in self._stats["keys"].items():
                if k not in keys:
                    keys[k] = dict(st)
            return {"total": dict(self._stats["total"]), "keys": keys}

    # ── 内部 ────────────────────────────────────────────

    def _peek(self, key: str) -> tuple[Any, bool]:
        with self._lock:
            item = self._data.get(key)
            if item is None:
                return None, False
            expire_at, value, _ = item
            if time.monotonic() < expire_at:
                return value, True
            self._data.pop(key, None)
            self._stats["total"]["expired"] += 1
            k = self._stats["keys"].setdefault(key, {})
            k["expired"] = k.get("expired", 0) + 1
        return None, False

    def _set(self, key: str, value: Any, ttl: float) -> None:
        with self._lock:
            self._data[key] = (time.monotonic() + ttl, value, int(time.time()))

    def _bump(self, key: str, **fields: int) -> None:
        with self._lock:
            t = self._stats["total"]
            k = self._stats["keys"].setdefault(key, {})
            for name, n in fields.items():
                t[name] = t.get(name, 0) + n
                k[name] = k.get(name, 0) + n

    def _record_compute(self, key: str, ms: float) -> None:
        with self._lock:
            t = self._stats["total"]
            t["computes"] += 1
            t["compute_ms"] += ms
            k = self._stats["keys"].setdefault(key, {})
            k["computes"] = k.get("computes", 0) + 1
            k["last_compute_ms"] = round(ms, 1)
            k["last_compute_at"] = int(time.time())
            k["total_compute_ms"] = k.get("total_compute_ms", 0.0) + ms

    def _lock_for(self, key: str) -> threading.Lock:
        with self._lock:
            lock = self._key_locks.get(key)
            if lock is None:
                lock = threading.Lock()
                self._key_locks[key] = lock
            return lock
