"""Configuration — pydantic-settings, env-var driven.

All settings have safe defaults.  No missing env var crashes the service.
"""
import os
from dataclasses import dataclass, field

# Auto-load .env file if present
try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))
except Exception:
    pass


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

