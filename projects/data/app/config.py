"""
data-service configuration.
Reads from environment variables (set via .env file or system env).
No hardcoded IPs, credentials, or API keys in defaults.
"""

import os

# ── Database ───────────────────────────────────────────────────

DATABASE_URL = os.getenv("DATABASE_URL", "")
REDIS_URL = os.getenv("REDIS_URL", "")

DB_POOL_MIN = int(os.getenv("DB_POOL_MIN", "2"))
DB_POOL_MAX = int(os.getenv("DB_POOL_MAX", "20"))

# ── API Keys ───────────────────────────────────────────────────

COINGECKO_API_KEY = os.getenv("COINGECKO_API_KEY", "")
FINNHUB_API_KEY = os.getenv("FINNHUB_API_KEY", "")
TIINGO_API_KEY = os.getenv("TIINGO_API_KEY", "")
ALPHA_VANTAGE_KEY = os.getenv("ALPHA_VANTAGE_KEY", "")
TWELVE_DATA_API_KEY = os.getenv("TWELVE_DATA_API_KEY", "")
CRYPTOCOMPARE_API_KEY = os.getenv("CRYPTOCOMPARE_API_KEY", "")

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
