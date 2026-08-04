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

    # ── DC / Collector 数据源（raw data 注入） ──
    dc_url: str = field(default_factory=lambda: os.getenv("DC_URL", ""))
    dc_api_key: str = field(default_factory=lambda: os.getenv("DC_API_KEY", ""))
    collector_url: str = field(default_factory=lambda: os.getenv("COLLECTOR_URL", ""))
    collector_api_key: str = field(default_factory=lambda: os.getenv("COLLECTOR_API_KEY", ""))

    # ── data-service 联动（sentiment_score 等聚合因子） ──
    data_service_url: str = field(default_factory=lambda: os.getenv("DATA_SERVICE_URL", ""))

    # ── 管理后台鉴权（GET/PUT /admin/config 需 Bearer ADMIN_API_KEY） ──
    admin_api_key: str = field(default_factory=lambda: os.getenv("ADMIN_API_KEY", ""))

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

