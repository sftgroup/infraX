"""
data-service configuration.
Reads from environment variables (set via .env file or system env).
No hardcoded IPs, credentials, or API keys in defaults.
"""

import os
import threading

# ── Database ───────────────────────────────────────────────────

DATABASE_URL = os.getenv("DATABASE_URL", "")
REDIS_URL = os.getenv("REDIS_URL", "")

DB_POOL_MIN = int(os.getenv("DB_POOL_MIN", "2"))
DB_POOL_MAX = int(os.getenv("DB_POOL_MAX", "20"))

# ── API Keys ───────────────────────────────────────────────────
# 支持多 key 轮询：KEY_NAME=key1,key2,key3（逗号分隔），采集器运行时通过
# APIKeys.rotate(name) 轮询取用；管理后台 PUT /admin/config 可热更新。

COINGECKO_API_KEY = os.getenv("COINGECKO_API_KEY", "")
FINNHUB_API_KEY = os.getenv("FINNHUB_API_KEY", "")
TIINGO_API_KEY = os.getenv("TIINGO_API_KEY", "")
ALPHA_VANTAGE_KEY = os.getenv("ALPHA_VANTAGE_KEY", "")
TWELVE_DATA_API_KEY = os.getenv("TWELVE_DATA_API_KEY", "")
CRYPTOCOMPARE_API_KEY = os.getenv("CRYPTOCOMPARE_API_KEY", "")
NEWSAPI_API_KEY = os.getenv("NEWSAPI_API_KEY", "")
ADANOS_API_KEY = os.getenv("ADANOS_API_KEY", "")

# 管理后台鉴权（PUT/GET /admin/config 需 Bearer ADMIN_API_KEY）
ADMIN_API_KEY = os.getenv("ADMIN_API_KEY", "")

# 业务端点鉴权（/bars /factors/* /snapshots /stats；Bearer 或 X-API-Key）。
# 兼容回退链与 ragservicer/injector 一致：RAGSERVICER_API_KEY → DOC_API_KEY → LIGHTRAG_API_KEY。
# 未配置任何 key 时保持开放（向后兼容）；配置后强制校验。
DATA_API_KEY = os.getenv(
    "DATA_API_KEY",
    os.getenv("RAGSERVICER_API_KEY", os.getenv("DOC_API_KEY", os.getenv("LIGHTRAG_API_KEY", ""))),
)

# ── Caching ────────────────────────────────────────────────────

CACHE_TTL_SHORT = int(os.getenv("CACHE_TTL_SHORT", "60"))
CACHE_TTL_MEDIUM = int(os.getenv("CACHE_TTL_MEDIUM", "300"))
CACHE_TTL_LONG = int(os.getenv("CACHE_TTL_LONG", "3600"))

REDIS_KEY_PREFIX = os.getenv("REDIS_KEY_PREFIX", "ds:")

# ── Service ────────────────────────────────────────────────────

DATA_SERVICE_PORT = int(os.getenv("DATA_SERVICE_PORT", "9112"))
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO")

# ── Rate Limiting ──────────────────────────────────────────────

RATE_LIMIT_ENABLED = os.getenv("RATE_LIMIT_ENABLED", "true").lower() == "true"
RATE_LIMIT_RPM = int(os.getenv("RATE_LIMIT_RPM", "60"))

# ── Data Service (SQLite-backed bars / factors) ───────────────

DATA_DB_PATH = os.getenv("DATA_DB_PATH", "data/data.db")
KL_SYMBOLS = os.getenv("KL_SYMBOLS", "BTC/USDT,ETH/USDT,SOL/USDT")
KL_TIMEFRAMES = os.getenv("KL_TIMEFRAMES", "1m")  # comma-separated, e.g. "1m,5m,15m,1h,4h,1D"
KL_FETCH_LIMIT = int(os.getenv("KL_FETCH_LIMIT", "500"))
KL_INTERVAL_SEC = int(os.getenv("KL_INTERVAL_SEC", "300"))
KL_EXCHANGE = os.getenv("KL_EXCHANGE", "binance")
LIGHTRAG_URL = os.getenv("LIGHTRAG_URL", "")

# ── Data config ───────────────────────────────────────────────

DATA_CONFIG_PATH = os.getenv("DATA_CONFIG_PATH", "data_config.json")


# ── Config classes (data_sources compatibility, env-only) ─────
# The data_sources/* modules import these from app.config (they were split out
# of the monolith's app/config/ package). Here they are kept lightweight and
# read directly from env vars — no addon-config loader, matching this
# service's flat env-based config style.

def _resolve_proxy() -> str:
    """Proxy chain: PROXY_URL first, then standard proxy env vars."""
    proxy_url = (os.getenv("PROXY_URL") or "").strip()
    if proxy_url:
        return proxy_url
    for key in ("HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY"):
        value = (os.getenv(key) or "").strip()
        if value:
            return value
    return ""


class APIKeys:
    """API 密钥配置类（data_sources 兼容）。

    支持多 key 轮询：env 值以逗号分隔（``FINNHUB_API_KEY=k1,k2``），
    调用 ``APIKeys.rotate(name)`` 线程安全地轮询取下一个 key。
    运行时从 ``os.environ`` 读取，因此管理后台热更新无需重启。
    """

    FINNHUB_API_KEY = FINNHUB_API_KEY
    TIINGO_API_KEY = TIINGO_API_KEY
    TWELVE_DATA_API_KEY = TWELVE_DATA_API_KEY
    ALPHA_VANTAGE_API_KEY = ALPHA_VANTAGE_KEY
    NEWSAPI_API_KEY = NEWSAPI_API_KEY
    ADANOS_API_KEY = ADANOS_API_KEY

    _lock = threading.Lock()
    _counters: dict[str, int] = {}

    @classmethod
    def _parse(cls, key_name: str) -> list[str]:
        raw = os.environ.get(key_name, "") or ""
        return [k.strip() for k in raw.split(",") if k.strip()]

    @classmethod
    def all(cls, key_name: str) -> list[str]:
        """返回某个 key 变量配置的全部 key（逗号分隔解析）。"""
        return cls._parse(key_name)

    @classmethod
    def rotate(cls, key_name: str, default: str = "") -> str:
        """Round-robin 轮询取下一个 key。未配置返回 default。"""
        keys = cls._parse(key_name)
        if not keys:
            return default
        with cls._lock:
            idx = cls._counters.get(key_name, 0)
            cls._counters[key_name] = idx + 1
        return keys[idx % len(keys)]

    @classmethod
    def get(cls, key_name: str, default: str = "") -> str:
        """Get an API key by name (falls back to the env var)."""
        value = getattr(cls, key_name, None)
        if value:
            return str(value)
        return os.getenv(key_name, default)

    @classmethod
    def is_configured(cls, key_name: str) -> bool:
        """Check whether an API key is configured."""
        return bool(cls._parse(key_name))

    @classmethod
    def reload(cls) -> None:
        """重置轮询计数（管理后台热更新后调用）。"""
        with cls._lock:
            cls._counters.clear()


class CCXTConfig:
    """CCXT 加密货币数据源配置（env-only）。"""

    TIMEFRAME_MAP = {
        '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m',
        '1H': '1h', '4H': '4h', '1D': '1d', '1W': '1w',
    }
    DEFAULT_EXCHANGE = os.getenv("CCXT_DEFAULT_EXCHANGE", "binance")
    TIMEOUT = int(os.getenv("CCXT_TIMEOUT", "10000"))
    ENABLE_RATE_LIMIT = os.getenv("CCXT_ENABLE_RATE_LIMIT", "true").lower() == "true"
    PROXY = _resolve_proxy()


class TiingoConfig:
    """Tiingo 数据源配置（env-only）。"""

    BASE_URL = os.getenv("TIINGO_BASE_URL", "https://api.tiingo.com/tiingo")
    TIMEOUT = int(os.getenv("TIINGO_TIMEOUT", "10"))


class YFinanceConfig:
    """Yahoo Finance 数据源配置（env-only）。"""

    TIMEOUT = int(os.getenv("YFINANCE_TIMEOUT", "30"))
    INTERVAL_MAP = {
        '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m',
        '1H': '1h', '4H': '4h', '1D': '1d', '1W': '1wk',
    }
