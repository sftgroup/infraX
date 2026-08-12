"""
moomoo OpenAPI 数据源（MM-1，MooMoo 行情强化）

经本地 OpenD 网关（127.0.0.1:11111，moomoo 平台账号登录）提供：
  - 美股/港股历史 K 线（request_history_kline，免订阅，US LV3 / HK LV1）
  - 美股/港股实时快照（get_market_snapshot，免订阅）

设计（对齐 docs/MOOMOO_DATA_INTEGRATION.md §4.2）：
  - 实现 BaseDataSource 契约（get_kline 返回 Unix 秒 OHLCV dict；get_ticker 返回
    ticker 形状 dict），调用方契约不变；
  - 符号映射：AAPL → US.AAPL、00700 → HK.00700、CC.BTCUSD 原样透传；
  - timeframe 映射：1m/3m/5m/15m/30m/1H→K_60M/1D→K_DAY/1W→K_WEEK，
    4H 无原生周期 → 4×K_60M 聚合；
  - 时区：moomoo time_key 为交易所本地时区（美股美东、港股北京），转 UTC Unix 秒
    对齐 kline 表 ts；
  - 连接池：模块级懒加载单例 OpenQuoteContext + 断连自动重连（失败冷却）；
  - fail-silent：SDK 未安装 / OpenD 未启动 / 权限不足 → 返回空（调用方回退现有源）；
  - 短 TTL 缓存（ticker）。

验证：本地 py_compile + 开发机直连 OpenD 冒烟；集成验收在生产机
（43.163.105.172）执行（见 MOOMOO_DATA_INTEGRATION.md §6）。
"""
from __future__ import annotations

import logging
import threading
import time
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from app.config import MOOMOO_ENABLED, MOOMOO_HOST, MOOMOO_PORT
from app.data_sources.base import BaseDataSource
from app.utils.logger import get_logger

logger = get_logger(__name__)

# ── SDK 懒加载（fail-silent：未安装不阻塞） ─────────────────
_sdk: Any = None
_sdk_checked = False

# ── OpenD 连接（懒加载单例 + 失败冷却重连） ────────────────
_ctx: Any = None
_ctx_lock = threading.Lock()
_ctx_failed_until = 0.0  # 失败冷却（monotonic 秒），避免 OpenD 断连时高频重连
_CONNECT_COOLDOWN_SEC = 30

# ── ticker 短 TTL 缓存 ──────────────────────────────────────
_TICKER_TTL_SEC = 10
_ticker_cache: dict[str, tuple[float, Optional[dict]]] = {}
_ticker_cache_lock = threading.Lock()

# ── 符号 / 周期 / 时区映射 ─────────────────────────────────
_MARKET_PREFIX = {
    "us": "US", "usstock": "US", "us_stocks": "US", "stock": "US",
    "hk": "HK", "hkstock": "HK", "hk_stocks": "HK",
    "crypto": "CC", "cc": "CC", "cryptocurrency": "CC",
}

# infraX timeframe（大小写不敏感）→ moomoo K 线周期（字符串，实测可用）
# 4h 无原生周期：映射 K_60M 后由 _AGG_MAP 聚合 4×60m
_TF_MAP = {
    "1m": "K_1M", "3m": "K_3M", "5m": "K_5M",
    "15m": "K_15M", "30m": "K_30M",
    "1h": "K_60M", "4h": "K_60M", "1d": "K_DAY", "1w": "K_WEEK",
}
# 无原生周期 → (聚合源秒数, 聚合根数)：4h = 4×K_60M
_TF_SECONDS = {"1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800,
               "1h": 3600, "4h": 14400, "1d": 86400, "1w": 604800}
_AGG_MAP = {"4h": (3600, 4)}

try:
    from zoneinfo import ZoneInfo
    _TZ_MAP = {"US": ZoneInfo("America/New_York"), "HK": ZoneInfo("Asia/Shanghai")}
except Exception:  # zoneinfo 不可用（罕见）→ 固定偏移降级
    _TZ_MAP = {"US": timezone(timedelta(hours=-4)), "HK": timezone(timedelta(hours=8))}


def _moomoo_sdk():
    """moomoo SDK 懒加载（一次性检查，未安装置 flag 不再重试）。"""
    global _sdk, _sdk_checked
    if _sdk_checked:
        return _sdk
    try:
        import moomoo as _m
        _sdk = _m
        logger.info("moomoo SDK available (v%s)", getattr(_m, "__version__", "?"))
    except Exception as exc:
        _sdk = None
        logger.debug("moomoo SDK not installed: %s", exc)
    _sdk_checked = True
    return _sdk


def _get_ctx():
    """懒加载 OpenQuoteContext 单例；OpenD 不可用时冷却重连。"""
    global _ctx, _ctx_failed_until
    now = time.monotonic()
    if _ctx_failed_until > now:
        return None
    if _ctx is not None:
        return _ctx
    with _ctx_lock:
        if _ctx is None and _ctx_failed_until <= now:
            try:
                sdk = _moomoo_sdk()
                if sdk is None:
                    _ctx_failed_until = now + _CONNECT_COOLDOWN_SEC
                    return None
                _ctx = sdk.OpenQuoteContext(host=MOOMOO_HOST, port=MOOMOO_PORT)
                logger.info("moomoo OpenD connected: %s:%s", MOOMOO_HOST, MOOMOO_PORT)
            except Exception as exc:
                _ctx = None
                _ctx_failed_until = now + _CONNECT_COOLDOWN_SEC
                logger.warning("moomoo OpenD connect failed: %s", exc)
    return _ctx


def _reset_ctx():
    """SDK 调用异常时重置连接（下次调用自动重连）。"""
    global _ctx
    with _ctx_lock:
        if _ctx is not None:
            try:
                _ctx.close()
            except Exception:
                pass
            _ctx = None


def _market_prefix(market: Optional[str]) -> Optional[str]:
    m = str(market or "").strip().lower()
    return _MARKET_PREFIX.get(m)


def _infer_market(symbol: str) -> str:
    """裸符号 → 市场前缀：5 位数字 → HK，其余（含带前缀）→ 原前缀或 US。"""
    s = (symbol or "").strip()
    if "." in s and s.split(".", 1)[0].upper() in ("US", "HK", "CC"):
        return s.split(".", 1)[0].upper()
    if s.isdigit() and len(s) == 5:
        return "HK"
    return "US"


def _to_code(symbol: str, market: Optional[str] = None) -> str:
    """符号 → moomoo 代码（AAPL → US.AAPL、00700 → HK.00700、US.AAPL 原样）。"""
    s = (symbol or "").strip()
    if "." in s and s.split(".", 1)[0].upper() in ("US", "HK", "CC"):
        return s
    prefix = _market_prefix(market) or _infer_market(s)
    if prefix == "CC":
        return f"CC.{s}"
    return f"{prefix}.{s}"


def _f(v) -> Optional[float]:
    try:
        if v is None or v == "N/A":
            return None
        f = float(v)
        return None if f != f else f  # NaN → None
    except (TypeError, ValueError):
        return None


def _get(row, key):
    try:
        if isinstance(row, dict):
            return row.get(key)
        return row[key]
    except Exception:
        return None


def _parse_time_key(time_key, market: str) -> Optional[int]:
    """moomoo time_key（交易所本地时区 yyyy-MM-dd HH:mm:ss）→ UTC 秒。

    US 为美东（America/New_York，含夏令时），HK 为北京（Asia/Shanghai）。
    """
    try:
        # 快照 update_time 可能带毫秒（US 实测 '2026-08-11 23:12:01.845'）
        s = str(time_key).strip()
        fmt = "%Y-%m-%d %H:%M:%S.%f" if "." in s else "%Y-%m-%d %H:%M:%S"
        dt = datetime.strptime(s, fmt)
        tz = _TZ_MAP.get(market, _TZ_MAP["US"])
        return int(dt.replace(tzinfo=tz).timestamp())
    except Exception:
        return None


def _kline_records(data, market: str) -> list[dict]:
    """moomoo K 线 DataFrame → [{time(UTC 秒), open, high, low, close, volume}]。"""
    records: list[dict] = []
    try:
        n = len(data)
        for i in range(n):
            row = data.iloc[i] if hasattr(data, "iloc") else data[i]
            ts = _parse_time_key(_get(row, "time_key"), market)
            if ts is None:
                continue
            records.append({
                "time": ts,
                "open": _f(_get(row, "open")),
                "high": _f(_get(row, "high")),
                "low": _f(_get(row, "low")),
                "close": _f(_get(row, "close")),
                "volume": _f(_get(row, "volume")) or 0.0,
            })
    except Exception as exc:
        logger.debug("moomoo kline records parse failed: %s", exc)
    return records


def _merge_every_n(bars: list[dict], n: int) -> list[dict]:
    """相邻 n 根合并（4h = 4×60m），时间取首根，high/low 取极值。"""
    if n <= 1 or len(bars) < n:
        return bars
    out = []
    for i in range(0, len(bars) - len(bars) % n, n):
        chunk = bars[i:i + n]
        out.append({
            "time": chunk[0]["time"],
            "open": chunk[0]["open"],
            "high": max(b["high"] for b in chunk),
            "low": min(b["low"] for b in chunk),
            "close": chunk[-1]["close"],
            "volume": round(sum(b["volume"] for b in chunk), 2),
        })
    return out


class MoomooDataSource(BaseDataSource):
    """moomoo OpenAPI 数据源（MM-1）。

    get_kline：历史 K 线（免订阅，走 history kline 额度）；get_ticker：实时快照。
    任一步骤失败（SDK 缺失 / OpenD 断连 / 无权限 / 空数据）均 fail-silent
    返回空 / 抛 NotImplementedError，由调用方回退现有源。
    """

    name = "moomoo/OpenD"

    def __init__(self, market: Optional[str] = None):
        self.market = market  # usstock / hkstock / US / HK ...（符号前缀推断兜底）

    # ── K 线 ─────────────────────────────────────────────────

    def get_kline(
        self,
        symbol: str,
        timeframe: str,
        limit: int,
        before_time: Optional[int] = None,
        after_time: Optional[int] = None,
    ) -> list[dict]:
        if not MOOMOO_ENABLED:
            return []
        sdk = _moomoo_sdk()
        if sdk is None:
            return []
        code = _to_code(symbol, self.market)
        market = code.split(".", 1)[0].upper()
        tf_key = str(timeframe or "").strip().lower()
        ktype = _TF_MAP.get(tf_key)
        if ktype is None:
            logger.debug("moomoo unsupported timeframe %r", timeframe)
            return []
        agg_n = _AGG_MAP.get(tf_key, (0, 1))[1]
        need = max(int(limit) * agg_n, 1)

        # 时间范围（对齐 BaseDataSource.calculate_time_range 语义，4h 用原生秒）
        span = _TF_SECONDS.get(tf_key, 86400) * need * 1.2
        if before_time:
            end_dt = datetime.fromtimestamp(int(before_time), tz=timezone.utc)
            start_dt = end_dt - timedelta(seconds=span)
        else:
            end_dt = datetime.now(timezone.utc)
            start_dt = end_dt - timedelta(seconds=span)
        if after_time is not None:
            floor_dt = datetime.fromtimestamp(int(after_time), tz=timezone.utc)
            if floor_dt < start_dt:
                start_dt = floor_dt
        start_s = start_dt.strftime("%Y-%m-%d")
        end_s = end_dt.strftime("%Y-%m-%d")

        try:
            ctx = _get_ctx()
            if ctx is None:
                return []
            max_count = min(need, 1000)
            ret, data, page_req_key = ctx.request_history_kline(
                code, start=start_s, end=end_s, ktype=ktype, max_count=max_count,
            )
            if ret != sdk.RET_OK:
                logger.debug("moomoo kline %s %s ret=%s %s", code, tf_key, ret, data)
                return []
            frames = _kline_records(data, market)
            # 分页续拉（历史 K 线最多 1000 根/页，page_req_key 非 None 表示有后续）
            while page_req_key is not None and len(frames) < need:
                ret, data, page_req_key = ctx.request_history_kline(
                    code, start=start_s, end=end_s, ktype=ktype,
                    max_count=max_count, page_req_key=page_req_key,
                )
                if ret != sdk.RET_OK:
                    break
                more = _kline_records(data, market)
                if not more:
                    break
                frames.extend(more)
            if not frames:
                return []
            # 去重（分页边界可能重叠）→ 时间升序 → 4h 聚合
            dedup: dict[int, dict] = {}
            for f in frames:
                dedup[f["time"]] = f
            frames = sorted(dedup.values(), key=lambda x: x["time"])
            if agg_n > 1:
                frames = _merge_every_n(frames, agg_n)
            klines = self.filter_and_limit(
                frames, int(limit), before_time, after_time,
                truncate=(after_time is None),
            )
            self.log_result(symbol, klines, tf_key)
            return klines
        except Exception as exc:
            logger.debug("moomoo kline %s %s failed: %s", code, tf_key, exc)
            _reset_ctx()
            return []

    # ── ticker（实时快照） ───────────────────────────────────

    def get_ticker(self, symbol: str) -> dict:
        if not MOOMOO_ENABLED:
            raise NotImplementedError("moomoo disabled")
        sdk = _moomoo_sdk()
        if sdk is None:
            raise NotImplementedError("moomoo SDK unavailable")
        code = _to_code(symbol, self.market)
        market = code.split(".", 1)[0].upper()

        now = time.time()
        with _ticker_cache_lock:
            hit = _ticker_cache.get(code)
            if hit and now - hit[0] < _TICKER_TTL_SEC:
                return hit[1]

        try:
            ctx = _get_ctx()
            if ctx is None:
                raise NotImplementedError("moomoo OpenD unavailable")
            ret, snap = ctx.get_market_snapshot([code])
            if ret != sdk.RET_OK or snap is None or len(snap) == 0:
                logger.debug("moomoo snapshot %s ret=%s", code, ret)
                raise NotImplementedError("moomoo snapshot empty")
            row = snap.iloc[0] if hasattr(snap, "iloc") else snap[0]
            last = _f(_get(row, "last_price"))
            if last is None or last == 0:
                raise NotImplementedError("moomoo snapshot no last_price")
            prev_close = _f(_get(row, "prev_close_price"))
            change = _f(_get(row, "change")) or _f(_get(row, "change_val"))
            if change is None and prev_close:
                change = round(last - prev_close, 4)
            change_pct = _f(_get(row, "change_rate")) or _f(_get(row, "change_pct"))
            if change_pct is None and prev_close:
                change_pct = round((last - prev_close) / prev_close * 100, 4) if prev_close else 0.0
            update_ts = _parse_time_key(_get(row, "update_time"), market)
            result = {
                "symbol": symbol,
                "last": last,
                "price": last,
                "change": change if change is not None else 0.0,
                "changePercent": change_pct if change_pct is not None else 0.0,
                "high": _f(_get(row, "high_price")) or last,
                "low": _f(_get(row, "low_price")) or last,
                "open": _f(_get(row, "open_price")) or last,
                "previousClose": prev_close if prev_close is not None else 0.0,
                "volume": _f(_get(row, "volume")) or 0.0,
                "ts": (update_ts * 1000) if update_ts else int(now * 1000),
                "source": "moomoo",
            }
            with _ticker_cache_lock:
                _ticker_cache[code] = (now, result)
            return result
        except NotImplementedError:
            raise
        except Exception as exc:
            logger.debug("moomoo ticker %s failed: %s", code, exc)
            _reset_ctx()
            raise NotImplementedError("moomoo ticker unavailable") from exc


# ── 便捷函数（kline_store / ticker 调用，失败返回空，fail-silent） ──

def fetch_kline_rows(
    symbol: str,
    timeframe: str,
    limit: int,
    market: Optional[str] = None,
    before_time: Optional[int] = None,
    after_time: Optional[int] = None,
) -> list[tuple]:
    """kline_store._collect_multi_market 用：moomoo K 线 → [(ts_ms, o, h, l, c, v)]。

    返回 ms 时间戳（对齐 kline 表 ts 与 ccxt/yfinance 采集路径），失败返回 []。
    """
    try:
        ds = MoomooDataSource(market=market)
        klines = ds.get_kline(symbol, timeframe, limit, before_time, after_time)
        return [
            (int(k["time"]) * 1000, k["open"], k["high"], k["low"], k["close"], k["volume"])
            for k in klines
            if k.get("time") and k.get("close") is not None
        ]
    except Exception as exc:
        logger.debug("moomoo fetch_kline_rows %s %s skipped: %s", symbol, timeframe, exc)
        return []


def get_moomoo_ticker(symbol: str, market: Optional[str] = None) -> Optional[dict]:
    """ticker.py 用：moomoo 实时快照 → ticker 形状 dict；失败返回 None（走回退链）。"""
    try:
        ds = MoomooDataSource(market=market)
        t = ds.get_ticker(symbol)
        if not t or not t.get("price"):
            return None
        return t
    except NotImplementedError:
        return None
    except Exception as exc:
        logger.debug("moomoo get_moomoo_ticker %s skipped: %s", symbol, exc)
        return None
