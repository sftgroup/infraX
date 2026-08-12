"""
data-service configuration.
Reads from environment variables (set via .env file or system env).
No hardcoded IPs, credentials, or API keys in defaults.
"""

import os
import threading

# ── 统一鉴权契约（app_auth）─────────────────────────────────
# 优先加载仓库级共享实现（../shared，systemd/本地 git checkout 路径）；
# Docker 构建无共享目录时回退到项目根同名副本。必须在 import app_auth 前执行。
import sys as _sys
from pathlib import Path as _Path

_SHARED_DIR: _Path | None = None
_p = _Path(__file__).resolve().parent
for _ in range(3):  # 上溯最多 3 层找 shared/（本文件在 app/ 子目录）
    if (_p / "shared").is_dir():
        _SHARED_DIR = _p / "shared"
        break
    _p = _p.parent
if _SHARED_DIR is not None:
    _sys.path.insert(0, str(_SHARED_DIR))

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
FRED_API_KEY = os.getenv("FRED_API_KEY", "")
# Tushare（HTTP POST + token，非 API key 格式；白名单见 main.py _DATA_KEY_FIELDS）
TUSHARE_TOKEN = os.getenv("TUSHARE_TOKEN", "")

# 管理后台鉴权（PUT/GET /admin/config 需 Bearer ADMIN_API_KEY）
ADMIN_API_KEY = os.getenv("ADMIN_API_KEY", "")

# 业务端点鉴权（/bars /factors/* /snapshots /stats；Bearer 或 X-API-Key 或
# X-Service-Key，统一契约见 app_auth）。收敛为平台 bridge key：
# RAGSERVICER_API_KEY → DOC_API_KEY → LIGHTRAG_API_KEY 回退链。
# 未配置任何 key 时保持开放（向后兼容）；配置后强制校验。
DATA_API_KEY = os.getenv(
    "DATA_API_KEY",
    os.getenv("RAGSERVICER_API_KEY", os.getenv("DOC_API_KEY", os.getenv("LIGHTRAG_API_KEY", ""))),
)

# G-7: 监控只读 key（仅允许 GET/HEAD/OPTIONS 读操作，与 bridge key 权限解耦）
MONITOR_API_KEY = os.getenv("MONITOR_API_KEY", "")

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
# swap 合约采集（DS-8）：独立开关/标的/周期，存储键 base/quote:quote（如 BTC/USDT:USDT）
KL_SWAP_ENABLED = os.getenv("KL_SWAP_ENABLED", "false").lower() == "true"
KL_SWAP_SYMBOLS = os.getenv("KL_SWAP_SYMBOLS", "")
KL_SWAP_TIMEFRAMES = os.getenv("KL_SWAP_TIMEFRAMES", "1m")
KL_FETCH_LIMIT = int(os.getenv("KL_FETCH_LIMIT", "500"))
KL_INTERVAL_SEC = int(os.getenv("KL_INTERVAL_SEC", "300"))
# 多市场（美股/外汇/期货/A股/港股）采集独立周期：这些市场仅 1d 日线，且
# Twelve Data 免费 tier 限 8 次/分钟 ~800 credits/天（每 5 分钟拉 6 对外汇
# 会超额 429）。默认 30 分钟（约 96 次/天），可经 KL_MULTI_INTERVAL_SEC 覆盖。
KL_MULTI_INTERVAL_SEC = int(os.getenv("KL_MULTI_INTERVAL_SEC", "1800"))
KL_EXCHANGE = os.getenv("KL_EXCHANGE", "binance")
# 历史深度回填目标（天），JSON：{"1m":30,"1d":1095}；未配置按默认表
# （1m≥30d；5m/15m/30m≥180d；1h/4h≥365d；1d≥1095d=3y，对齐 B 端验收标准）
KL_BACKFILL_DAYS = os.getenv("KL_BACKFILL_DAYS", "")
LIGHTRAG_URL = os.getenv("LIGHTRAG_URL", "")

# ── ML 推理联动（模型已拆分到独立 ml-service，如 /ml/tree_predictions） ──
ML_SERVICE_URL = os.getenv("ML_SERVICE_URL", "")  # 未配置则 ML 类 collector 空转
ML_API_KEY = os.getenv("ML_API_KEY", "")           # ml-service 自身鉴权（可选）

# ── P2 单模型快照落库（§5.7）：30min 拉 bolt/moirai/timesfm → ml_predictions ──
P2_COLLECT_ENABLED = os.getenv("P2_COLLECT_ENABLED", "true").lower() == "true"
P2_COLLECT_INTERVAL_SEC = int(os.getenv("P2_COLLECT_INTERVAL_SEC", "1800"))
P2_RETENTION_DAYS = int(os.getenv("P2_RETENTION_DAYS", "90"))

# ── 全局市场快照（DS-10）：commodities / forex_pairs 30min、market_overview 15min ──
GLOBAL_MARKET_COLLECT_ENABLED = os.getenv("GLOBAL_MARKET_COLLECT_ENABLED", "true").lower() == "true"
GLOBAL_MARKET_COLLECT_INTERVAL_SEC = int(os.getenv("GLOBAL_MARKET_COLLECT_INTERVAL_SEC", "900"))

# ── 旧栈 collector 合并（rawdata 位点 + OKX ChainOS 行情）────────────────
# COLLECTOR_URL: 旧栈 collector 服务（Express :9101），http://43.163.105.172:9101
# COLLECTOR_API_KEY: 旧栈 api_keys 表签发的只读 key（X-API-Key header，非 Bearer）
COLLECTOR_URL = os.getenv("COLLECTOR_URL", "")
COLLECTOR_API_KEY = os.getenv("COLLECTOR_API_KEY", "")

# 链上扫描位点聚合快照（onchain_checkpoints）：每链已扫高度/事件数/状态/最近抓取时间
ONCHAIN_COLLECT_ENABLED = os.getenv("ONCHAIN_COLLECT_ENABLED", "true").lower() == "true"
ONCHAIN_COLLECT_INTERVAL_SEC = int(os.getenv("ONCHAIN_COLLECT_INTERVAL_SEC", "60"))

# OKX ChainOS 行情快照（okx_hot_tokens / okx_index_prices）：web3.okx.com 官方 v6
OKX_CHAINOS_COLLECT_ENABLED = os.getenv("OKX_CHAINOS_COLLECT_ENABLED", "true").lower() == "true"
OKX_CHAINOS_COLLECT_INTERVAL_SEC = int(os.getenv("OKX_CHAINOS_COLLECT_INTERVAL_SEC", "60"))
# 链 ID：Ethereum=1, BSC=56, Base=8453（v6 官方链 ID，字符串）
OKX_CHAINS = os.getenv("OKX_CHAINS", "1,56,8453")
OKX_HOT_LIMIT = int(os.getenv("OKX_HOT_LIMIT", "10"))       # 每链热门代币数
OKX_INDEX_TOKENS = int(os.getenv("OKX_INDEX_TOKENS", "3"))  # 每链补指数价格的头部代币数

# DQ-7: okx candles 快照（经旧栈 /api/v2/data/market/candles 拉取头部代币 K 线）
OKX_CANDLE_ENABLED = os.getenv("OKX_CANDLE_ENABLED", "true").lower() == "true"
OKX_CANDLE_TOKENS = int(os.getenv("OKX_CANDLE_TOKENS", "3"))  # 每链补 candles 的头部代币数
OKX_CANDLE_PERIOD = os.getenv("OKX_CANDLE_PERIOD", "15m")
OKX_CANDLE_LIMIT = int(os.getenv("OKX_CANDLE_LIMIT", "50"))   # 每代币拉取的 K 线根数

# ── 数据质量 / 清洗（DQ-1 / DQ-4 / DQ-6）──────────────────────
# DQ-1: 异常 bar 处理策略（drop=剔除 / mark=保留并打 is_abnormal 标记）与规则开关。
# 默认 mark：外汇等无成交量品种（FX spot 正常无量）不应被静默剔除，打标让消费方自行过滤。
CLEAN_MODE = os.getenv("CLEAN_MODE", "mark").strip().lower()
CLEAN_ZERO_VOLUME = os.getenv("CLEAN_ZERO_VOLUME", "true").lower() == "true"
CLEAN_NONPOSITIVE_PRICE = os.getenv("CLEAN_NONPOSITIVE_PRICE", "true").lower() == "true"
CLEAN_MAX_JUMP_PCT = float(os.getenv("CLEAN_MAX_JUMP_PCT", "0.3"))  # 相邻 bar 价格突变阈值（0.3=30%）
# DQ-4: 因子新鲜度阈值（毫秒），超过则 /factors/current 标记 fresh:false
FRESHNESS_MS = int(os.getenv("FRESHNESS_MS", "600000"))
# DQ-2: /factors/history 缺值因子列前值填充开关（ffill，false 则返回 null 占位）
FACTORS_FFILL = os.getenv("FACTORS_FFILL", "true").lower() == "true"

# ── moomoo OpenAPI（MM-1~MM-5，OpenD 本地网关）────────────────
# OpenD 为 moomoo 平台账号登录的行情网关（127.0.0.1:11111），SDK 未安装 /
# OpenD 未启动 / 无权限时全部 moomoo 路径 fail-silent 回退现有源（B 端零感知）。
MOOMOO_ENABLED = os.getenv("MOOMOO_ENABLED", "true").lower() == "true"
MOOMOO_HOST = os.getenv("MOOMOO_HOST", "127.0.0.1")
MOOMOO_PORT = int(os.getenv("MOOMOO_PORT", "11111"))

# 宏观采集（MM-4）：region 逗号分隔；周期 6h 对齐 FRED 采集器
MOOMOO_MACRO_ENABLED = os.getenv("MOOMOO_MACRO_ENABLED", "true").lower() == "true"
MOOMOO_MACRO_REGIONS = os.getenv("MOOMOO_MACRO_REGIONS", "US,HK")
MOOMOO_MACRO_INTERVAL_SEC = int(os.getenv("MOOMOO_MACRO_INTERVAL_SEC", str(6 * 3600)))
# 首次回填 / 周期刷新的观测条数（get_macro_indicator_history max_count）
MOOMOO_MACRO_BACKFILL = int(os.getenv("MOOMOO_MACRO_BACKFILL", "400"))
MOOMOO_MACRO_REFRESH = int(os.getenv("MOOMOO_MACRO_REFRESH", "90"))
# MM-8/11~15 增量数据（资金流/F10/卖空/热力/板块等）总开关
MOOMOO_EXTRA_ENABLED = os.getenv("MOOMOO_EXTRA_ENABLED", "true").lower() == "true"

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
    TUSHARE_TOKEN = TUSHARE_TOKEN

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
