"""ModelProvider 基类 + 注册表（需求4 R4-1/R4-2）。

统一「懒加载单例 + 失败 flag + 线程锁 + Device 参数化 + GPU→CPU 回落」，
消除 4 个 provider（kronos/chronos_bolt/moirai2/timesfm25）的样板重复。

接入约定（新模型零复制接入）：
  1. 继承 ModelProvider，声明 model_key / enabled_attr
  2. 实现 _do_load() 返回模型实例（设备参数经 self.device_kwargs() 解析）
  3. 若加载 API 与默认 device_map 不同（如 Moirai 用 map_location），覆写 device_kwargs()
注册即被 registry 收录（main.py 据此动态挂载端点 + 纳入预热表）。

Device 语义（R4-2）：
  - config.DEVICE（env DEVICE，默认 cpu）；GPU 目标不可用（驱动缺失/显存不足）
    时自动回落 cpu（fail-open），避免 provider 永久失败；回落发生在 _lock 内，
    与正常加载互斥，回落成功后按 cpu 缓存实例。
"""
from __future__ import annotations

import logging
import threading
from typing import Any, ClassVar, Generic, TypeVar

import config

logger = logging.getLogger(__name__)

T = TypeVar("T")

_REGISTRY: dict[str, type["ModelProvider"]] = {}


def get_registry() -> dict[str, type["ModelProvider"]]:
    """全部已注册 provider（model_key → 类）。"""
    return dict(_REGISTRY)


class ModelProvider(Generic[T]):
    """模型 Provider 基类：get() 提供线程安全懒加载单例。"""

    model_key: ClassVar[str] = ""       # 注册名（= 端点名，如 "volatility"）
    enabled_attr: ClassVar[str] = ""    # config 开关属性名（如 "KRONOS_ENABLED"）

    _instance: ClassVar[Any] = None
    _failed: ClassVar[bool] = False
    _lock: ClassVar[Any] = None

    def __init_subclass__(cls, **kwargs: Any) -> None:
        super().__init_subclass__(**kwargs)
        if cls.model_key and cls.model_key not in _REGISTRY:
            _REGISTRY[cls.model_key] = cls
            cls._lock = threading.Lock()

    # ── 子类实现点 ──────────────────────────────────────────
    def _do_load(self) -> T:
        """真实加载模型；抛异常视为加载失败。"""
        raise NotImplementedError

    def device_kwargs(self) -> dict[str, Any]:
        """加载 API 的设备参数（默认 device_map；map_location 类覆写）。"""
        return {"device_map": config.DEVICE}

    # ── 通用能力 ────────────────────────────────────────────
    @classmethod
    def enabled(cls) -> bool:
        return bool(getattr(config, cls.enabled_attr, False))

    @classmethod
    def get(cls) -> T | None:
        """懒加载单例：未启用/加载失败返回 None（失败置 flag 不重试，重启可重载）。"""
        if cls._instance is not None or cls._failed:
            return cls._instance
        if not cls.enabled():
            return None
        with cls._lock:
            if cls._instance is not None or cls._failed:
                return cls._instance
            try:
                cls._instance = cls()._do_load()
                logger.info("[%s] provider loaded (device=%s)", cls.model_key, config.DEVICE)
            except Exception as exc:
                if not cls._try_cpu_fallback(exc):
                    cls._failed = True
                    logger.warning("[%s] 加载失败（真实预测未启用）: %s", cls.model_key, exc)
        return cls._instance

    @classmethod
    def _try_cpu_fallback(cls, exc: Exception) -> bool:
        """DEVICE 非 cpu 且首次加载失败 → 以 cpu 重试一次；成功返回 True。

        锁内执行：失败时改 config.DEVICE → 重载 → 恢复；回落成功按 cpu 缓存。
        仅首次加载失败路径触发，频率极低，不影响正常请求。
        """
        if config.DEVICE == "cpu" or cls._instance is not None:
            return False
        orig = config.DEVICE
        try:
            config.DEVICE = "cpu"
            cls._instance = cls()._do_load()
            logger.info("[%s] provider loaded (cpu fallback; %s 不可用: %s)",
                        cls.model_key, orig, exc)
            return True
        except Exception:
            return False
        finally:
            config.DEVICE = orig
