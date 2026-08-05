"""Configuration — pydantic-settings, env-var driven.

All settings have safe defaults.  No missing env var crashes the service.
"""
import os
import threading
from dataclasses import dataclass, field

# Auto-load .env file if present
try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))
except Exception:
    pass

# ── 统一鉴权契约（app_auth）─────────────────────────────────
# 优先加载仓库级共享实现（../shared，systemd/本地 git checkout 路径）；
# Docker 构建无共享目录时回退到项目根同名副本。必须在 import app_auth 前执行。
import sys as _sys
from pathlib import Path as _Path

_SHARED_DIR = _Path(__file__).resolve().parents[1] / "shared"
if _SHARED_DIR.is_dir():
    _sys.path.insert(0, str(_SHARED_DIR))


# ── 多 key 轮询池 ─────────────────────────────────────────────
# 数据源 API key 支持逗号分隔多 key（如 FINNHUB_API_KEY=k1,k2），
# providers 通过 rotate_key(name) 线程安全轮询取用。
# 管理后台 PUT /admin/config 更新 .env + os.environ 后调用 reset_key_pools()。

_key_lock = threading.Lock()
_key_counters: dict[str, int] = {}


def all_keys(name: str) -> list[str]:
    """返回某 env 变量配置的全部 key（逗号分隔解析，去除空值）。"""
    raw = os.environ.get(name, "") or ""
    return [k.strip() for k in raw.split(",") if k.strip()]


def rotate_key(name: str) -> str:
    """Round-robin 轮询取下一个 key；未配置返回空串。"""
    keys = all_keys(name)
    if not keys:
        return ""
    with _key_lock:
        idx = _key_counters.get(name, 0)
        _key_counters[name] = idx + 1
    return keys[idx % len(keys)]


def reset_key_pools() -> None:
    """重置轮询计数（管理后台热更新后调用）。"""
    with _key_lock:
        _key_counters.clear()


@dataclass
class Settings:
    # ── LightRAG (InfraX RAGservicer) ──
    # 兼容回退链：RAGSERVICER_URL → DOC_URL → LIGHTRAG_URL
    lightrag_url: str = field(
        default_factory=lambda: os.getenv(
            "RAGSERVICER_URL",
            os.getenv("DOC_URL", os.getenv("LIGHTRAG_URL", "")),
        )
    )
    # 鉴权：RAGSERVICER_API_KEY → DOC_API_KEY → LIGHTRAG_API_KEY
    ragservicer_api_key: str = field(
        default_factory=lambda: os.getenv(
            "RAGSERVICER_API_KEY",
            os.getenv("DOC_API_KEY", os.getenv("LIGHTRAG_API_KEY", "")),
        )
    )
    # 默认注入目标 namespace（内置注入器默认走 market）
    default_namespace: str = field(
        default_factory=lambda: os.getenv("DEFAULT_NAMESPACE", "market")
    )

    # 本服务业务端点鉴权（/inject/*、/query、/status、/stats 等）。
    # 独立 env INJECTOR_API_KEY；未设置时回退到 bridge key（RAGSERVICER_API_KEY），
    # 未配置任何 key 时保持开放（向后兼容）。配置后强制校验。
    injector_api_key: str = field(
        default_factory=lambda: os.getenv("INJECTOR_API_KEY", "")
    )

    # ── DC / Collector 数据源（raw data 注入） ──
    dc_url: str = field(default_factory=lambda: os.getenv("DC_URL", ""))
    dc_api_key: str = field(default_factory=lambda: os.getenv("DC_API_KEY", ""))
    collector_url: str = field(default_factory=lambda: os.getenv("COLLECTOR_URL", ""))
    collector_api_key: str = field(default_factory=lambda: os.getenv("COLLECTOR_API_KEY", ""))

    # ── data-service 联动（sentiment_score 等聚合因子） ──
    data_service_url: str = field(default_factory=lambda: os.getenv("DATA_SERVICE_URL", ""))

    # ── ml-service 联动（Kronos 波动率预测，已拆分独立服务） ──
    ml_service_url: str = field(default_factory=lambda: os.getenv("ML_SERVICE_URL", ""))
    ml_api_key: str = field(default_factory=lambda: os.getenv("ML_API_KEY", ""))

    # ── 管理后台鉴权（GET/PUT /admin/config 需 Bearer ADMIN_API_KEY） ──
    admin_api_key: str = field(default_factory=lambda: os.getenv("ADMIN_API_KEY", ""))

    # ── G-7: 监控只读 key（仅允许 GET/HEAD/OPTIONS 读操作，与 bridge key 解耦） ──
    monitor_api_key: str = field(default_factory=lambda: os.getenv("MONITOR_API_KEY", ""))

    # ── Injection schedule ──
    injector_interval_sec: int = int(os.getenv("INJECTOR_INTERVAL_SEC", "21600"))
    injector_startup_delay: int = int(os.getenv("INJECTOR_STARTUP_DELAY", "120"))

    # ── API Keys (empty = skip that data source) ──
    fred_api_key: str = field(
        default_factory=lambda: os.getenv("FRED_API_KEY", "")
    )
    etherscan_api_key: str = field(
        default_factory=lambda: os.getenv("ETHERSCAN_API_KEY", "")
    )
    finnhub_api_key: str = field(
        default_factory=lambda: os.getenv("FINNHUB_API_KEY", "")
    )
    tushare_api_key: str = field(
        default_factory=lambda: os.getenv("TUSHARE_API_KEY", "")
    )

    # ── API server ──
    host: str = field(default_factory=lambda: os.getenv("HOST", "0.0.0.0"))
    port: int = int(os.getenv("PORT", "9113"))

    @property
    def lightrag_enabled(self) -> bool:
        return bool(self.lightrag_url)


SETTINGS = Settings()

