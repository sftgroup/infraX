"""API endpoint URLs for all data collectors.

All URLs have env-var overrides with sensible defaults.
No URL should be hardcoded in collector modules anymore.
"""

import os

# ── Crypto ─────────────────────────────────────────────────

COINGECKO_SIMPLE_PRICE_URL = os.getenv(
    "COINGECKO_SIMPLE_PRICE_URL",
    "https://api.coingecko.com/api/v3/simple/price",
)

COINGECKO_MARKETS_URL = os.getenv(
    "COINGECKO_MARKETS_URL",
    "https://api.coingecko.com/api/v3/coins/markets",
)

COINGECKO_BASE_URL = os.getenv(
    "COINGECKO_BASE_URL",
    "https://api.coingecko.com/api/v3",
)

# ── Blockchain / On-chain ──────────────────────────────────

BLOCKCHAIN_INFO_DIFFICULTY_URL = os.getenv(
    "BLOCKCHAIN_INFO_DIFFICULTY_URL",
    "https://blockchain.info/q/getdifficulty",
)

BLOCKCHAIN_INFO_LATEST_BLOCK_URL = os.getenv(
    "BLOCKCHAIN_INFO_LATEST_BLOCK_URL",
    "https://blockchain.info/latestblock",
)

# 巨鲸地址余额查询（blockchain.info 公开 API，无需 Key）
BLOCKCHAIN_INFO_BALANCE_URL = os.getenv(
    "BLOCKCHAIN_INFO_BALANCE_URL",
    "https://blockchain.info/q/addressbalance",
)

# ── DeFi ───────────────────────────────────────────────────

DEFILLAMA_CHAINS_URL = os.getenv(
    "DEFILLAMA_CHAINS_URL",
    "https://api.llama.fi/v2/chains",
)

# ── Macro (FRED) ───────────────────────────────────────────

FRED_OBSERVATIONS_URL = os.getenv(
    "FRED_OBSERVATIONS_URL",
    "https://api.stlouisfed.org/fred/series/observations",
)

# ── Finnhub ────────────────────────────────────────────────

FINNHUB_EARNINGS_URL = os.getenv(
    "FINNHUB_EARNINGS_URL",
    "https://finnhub.io/api/v1/stock/earnings",
)

FINNHUB_CALENDAR_URL = os.getenv(
    "FINNHUB_CALENDAR_URL",
    "https://finnhub.io/api/v1/calendar/economic",
)

FINNHUB_PROFILE_URL = os.getenv(
    "FINNHUB_PROFILE_URL",
    "https://finnhub.io/api/v1/stock/profile2",
)

# ── Sentiment ──────────────────────────────────────────────

ALTERNATIVE_ME_FNG_URL = os.getenv(
    "ALTERNATIVE_ME_FNG_URL",
    "https://api.alternative.me/fng/?limit=1",
)

# ── Derivatives / Binance ──────────────────────────────────

BINANCE_FAPI_FUNDING_RATE_URL = os.getenv(
    "BINANCE_FAPI_FUNDING_RATE_URL",
    "https://fapi.binance.com/fapi/v1/fundingRate",
)

BINANCE_FAPI_OPEN_INTEREST_URL = os.getenv(
    "BINANCE_FAPI_OPEN_INTEREST_URL",
    "https://fapi.binance.com/futures/data/openInterestHist",
)

BINANCE_FAPI_LONG_SHORT_RATIO_URL = os.getenv(
    "BINANCE_FAPI_LONG_SHORT_RATIO_URL",
    "https://fapi.binance.com/futures/data/globalLongShortAccountRatio",
)

# ── Third-party data providers ─────────────────────────────

COINGLASS_API_BASE = os.getenv(
    "COINGLASS_API_BASE",
    "https://open-api-v4.coinglass.com",
)

CRYPTOQUANT_API_BASE = os.getenv(
    "CRYPTOQUANT_API_BASE",
    "https://api.cryptoquant.com",
)

# ── Timeouts (env-configurable) ────────────────────────────

COLLECTOR_HTTP_TIMEOUT = int(os.getenv("COLLECTOR_HTTP_TIMEOUT", "15"))
COLLECTOR_HTTP_TIMEOUT_SHORT = int(os.getenv("COLLECTOR_HTTP_TIMEOUT_SHORT", "10"))
