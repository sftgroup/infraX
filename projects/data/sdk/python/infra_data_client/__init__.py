"""
InfraX data-service 官方 Python SDK（DS-14）

Usage:
    from infra_data_client import InfraDataClient

    client = InfraDataClient(
        base_url="http://127.0.0.1:9112",
        api_key="infrax-bridge-...",   # X-Service-Key 自动携带（DS-12 契约）
        verify=False,                  # 当前生产证书不可信时可关（B 端决策）
    )
    bars = client.get_bars("BTC/USDT", timeframe="1h", limit=10)
    factors = client.get_current_factors("BTC,ETH")

设计对齐 DS-14 要求 + 既有 lightrag_client 先例：
  - 鉴权内置：api_key → X-Service-Key 请求头，调用方零配置
  - TLS 可配置：verify 参数（默认 True）
  - 限流配套：429 自动重试/退避（Retry-After 优先，指数退避兜底）
  - fail-silent：默认返回 None/空值不抛错，业务不中断；fail_silent=False 抛 InfraDataError
  - 时间单位归一化：start/end 秒↔毫秒自动识别换算
  - 类型注解：方法与返回类型标注
"""
from __future__ import annotations

import time
from typing import Any, Optional, Union

import requests
import urllib3

__version__ = "0.3.0"

# 平台统一鉴权头（data-service 接受 X-Service-Key / Bearer / X-API-Key 任一）
_API_KEY_HEADER = "X-Service-Key"

# 429 重试上限保护（Retry-After 恶意/异常大值时封顶）
_MAX_RETRY_AFTER = 60


class InfraDataError(Exception):
    """API 层失败（连接错误 / HTTP 非 2xx）。fail_silent=False 时抛出。"""

    def __init__(self, status: int, message: str):
        self.status = status
        self.message = message
        super().__init__(f"[{status}] {message}")


def _to_ms(ts: Optional[Union[int, float]]) -> Optional[int]:
    """秒↔毫秒归一化：>= 10^12 视为毫秒原样返回；否则按秒转毫秒。"""
    if ts is None:
        return None
    ts = int(ts)
    if abs(ts) >= 10**12:
        return ts
    return ts * 1000


class InfraDataClient:
    def __init__(
        self,
        base_url: str,
        api_key: Optional[str] = None,
        verify: bool = True,
        timeout: float = 30.0,
        max_retries: int = 3,
        retry_backoff: float = 1.0,
        fail_silent: bool = True,
    ):
        """
        base_url      data-service 根地址，如 http://127.0.0.1:9112（生产经 nginx 前缀如
                      https://host/api/data 亦可，SDK 只做路径拼接）
        api_key       X-Service-Key 值；None 时按服务端配置可能 401（无鉴权环境可留空）
        verify        TLS 校验；生产证书暂不可信时传 False
        timeout       单请求超时（秒）
        max_retries   429 最大重试次数（0 = 不重试）
        retry_backoff 429 退避基数（秒，指数：backoff * 2**attempt；Retry-After 头优先）
        fail_silent   网络/HTTP 错误时返回 None 不抛错（True，默认）；False 抛 InfraDataError
        """
        self.base_url = str(base_url).rstrip("/")
        self.verify = verify
        self.timeout = timeout
        self.max_retries = max_retries
        self.retry_backoff = retry_backoff
        self.fail_silent = fail_silent

        self._session = requests.Session()
        self._session.verify = verify
        self._session.headers.update({"Content-Type": "application/json"})
        if api_key:
            self._session.headers[_API_KEY_HEADER] = api_key
        if not verify:
            urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

    # ── HTTP 核心 ─────────────────────────────────────────

    def _extract_message(self, resp: requests.Response) -> str:
        try:
            body = resp.json()
        except ValueError:
            return f"HTTP {resp.status_code}"
        if isinstance(body, dict):
            msg = body.get("message")
            if msg:
                return str(msg)
            detail = body.get("detail")
            if detail:
                return str(detail)
        return f"HTTP {resp.status_code}"

    def _request(
        self,
        method: str,
        path: str,
        params: Optional[dict] = None,
        **kwargs: Any,
    ) -> Any:
        """发送请求。成功返回响应体（envelope=1 时解包 data）；失败按 fail_silent
        返回 None 或抛 InfraDataError。429 自动重试。"""
        url = f"{self.base_url}{path}"
        attempt = 0
        while True:
            try:
                resp = self._session.request(method, url, params=params, timeout=self.timeout, **kwargs)
            except requests.RequestException as exc:
                if self.fail_silent:
                    return None
                raise InfraDataError(0, f"CONNECTION_ERROR: {exc}") from exc

            if resp.status_code == 429 and attempt < self.max_retries:
                retry_after = resp.headers.get("Retry-After")
                try:
                    delay = min(float(retry_after), _MAX_RETRY_AFTER)
                except (TypeError, ValueError):
                    delay = self.retry_backoff * (2**attempt)
                time.sleep(delay)
                attempt += 1
                continue

            if not resp.ok:
                if self.fail_silent:
                    return None
                raise InfraDataError(resp.status_code, self._extract_message(resp))

            try:
                body = resp.json()
            except ValueError:
                body = {}
            # 统一信封（?envelope=1 或后续版本默认信封）兼容解包
            if isinstance(body, dict) and body.get("code") == 0 and "data" in body:
                return body["data"]
            return body

    # ── Bars（K 线）───────────────────────────────────────

    def get_bars(
        self,
        symbol: str,
        timeframe: str = "1m",
        market_type: Optional[str] = None,
        start: Optional[Union[int, float]] = None,
        end: Optional[Union[int, float]] = None,
        limit: int = 500,
    ) -> Optional[dict]:
        """OHLCV + 指标 + 外部因子 K 线（服务端按 ts 升序）。

        market_type: spot | swap（None 自动判定：symbol 含 ``:`` → swap）
        start/end: 秒或毫秒均可，SDK 自动归一化为毫秒
        返回 {symbol, timeframe, market_type, count, bars:[{ts, open, high, low,
        close, volume, rsi_14, ...}]}
        """
        params = {
            "symbol": symbol,
            "timeframe": timeframe,
            "limit": limit,
        }
        if market_type is not None:
            params["market_type"] = market_type
        if start is not None:
            params["start"] = _to_ms(start)
        if end is not None:
            params["end"] = _to_ms(end)
        return self._request("GET", "/bars", params=params)

    # ── Factors ───────────────────────────────────────────

    def get_factor_catalog(self) -> Optional[list]:
        """全部可用因子目录（含 DS-13 ML 因子 category="ml"）。

        返回 [{id, name, category, type, range}, ...]（已解包 factors 列表）。
        """
        body = self._request("GET", "/factors/catalog")
        if body is None:
            return None
        return body.get("factors") if isinstance(body, dict) else body

    def _current_factors_body(
        self, symbols: Union[str, list] = "BTC", category: Optional[str] = None
    ) -> Optional[dict]:
        """`GET /factors/current` 完整响应体（含 ml_factory，FF-3.3/3.4）。"""
        if isinstance(symbols, (list, tuple)):
            symbols = ",".join(str(s) for s in symbols)
        params: dict[str, Any] = {"symbols": symbols}
        if category is not None:
            params["category"] = category
        body = self._request("GET", "/factors/current", params=params)
        return body if isinstance(body, dict) else None

    def get_current_factors(
        self,
        symbols: Union[str, list] = "BTC",
        category: Optional[str] = None,
    ) -> Optional[dict]:
        """最新因子值（实盘/AI 分析用）。

        symbols: "BTC,ETH" 或 ["BTC", "ETH"]
        category: external/sentiment/news/opportunities/heatmap/calendar/snapshot/ml 等
        返回 {SYMBOL: {fid: val}, "_complex": {...}}（裁剪了 meta/ml_factory；
        需要完整响应含因子工厂 ml_factory 时用 get_current_factors_full）
        """
        body = self._current_factors_body(symbols, category)
        if body is None:
            return None
        return body.get("factors") if "factors" in body else body

    def get_current_factors_full(
        self,
        symbols: Union[str, list] = "BTC",
        category: Optional[str] = None,
    ) -> Optional[dict]:
        """最新因子**完整响应**（与 /factors/current 原样一致，FF-3.4）。

        返回 {ts, meta, factors: {SYMBOL: {fid: val}}, ml_factory?}——
        ml_factory = {updated_at, factors: [key...], values: {SYMBOL: {key: val}}}
        （因子工厂激活因子列表 + ml-service 算好的实时值，客户端直接取用免复算公式）。
        """
        return self._current_factors_body(symbols, category)

    def get_ml_factory(self, symbols: Union[str, list] = "BTC") -> Optional[dict]:
        """因子工厂激活因子列表 + 实时值（FF-3.3/3.4，ml_factory 字段）。

        返回 {updated_at, factors: [key...], values: {SYMBOL: {key: val}}} 或 None
        （fail-silent：服务不可用 / 响应无 ml_factory 时返回 None）。
        示例：mf["factors"]、mf["values"]["BTC/USDT"]["ret_1"]。
        """
        body = self._current_factors_body(symbols)
        if body is None:
            return None
        return body.get("ml_factory")

    def get_history_factors(
        self,
        symbol: str,
        timeframe: str = "1m",
        ids: Optional[Union[str, list]] = None,
        start: Optional[Union[int, float]] = None,
        end: Optional[Union[int, float]] = None,
        limit: int = 500,
    ) -> Optional[dict]:
        """逐 bar 因子历史（回测用，asof 对齐无未来函数）。

        symbol 需为交易对形式（如 BTC/USDT 或 BTCUSDT；裸符号如 BTC 服务端不匹配）。
        ids: "rsi_14,ma_5" 或 ["rsi_14", "ma_5"]（None = 全部）
        start/end: 秒或毫秒均可，自动归一化为毫秒
        返回 {symbol, timeframe, count, series: [{ts, <fid>: val, ...}, ...]}
        """
        if isinstance(ids, (list, tuple)):
            ids = ",".join(str(i) for i in ids)
        params: dict[str, Any] = {
            "symbol": symbol,
            "timeframe": timeframe,
            "limit": limit,
        }
        if ids is not None:
            params["ids"] = ids
        if start is not None:
            params["start"] = _to_ms(start)
        if end is not None:
            params["end"] = _to_ms(end)
        return self._request("GET", "/factors/history", params=params)

    # ── Snapshots（复杂快照）──────────────────────────────

    def get_snapshots(self, snapshot_type: Optional[str] = None) -> Optional[dict]:
        """板块快照（heatmap/calendar/crypto_prices/indices/tvl/volatility/
        us_indicators/earnings/onchain/commodities/forex_pairs/market_overview）。

        返回 {ts, snapshots: {<type>: ...}}
        """
        params = {}
        if snapshot_type is not None:
            params["type"] = snapshot_type
        return self._request("GET", "/snapshots", params=params)

    # ── Ticker（实时报价）─────────────────────────────────

    def get_ticker(
        self,
        symbol: str,
        market_type: Optional[str] = None,
        exchange_id: Optional[str] = None,
        market: Optional[str] = None,
    ) -> Optional[dict]:
        """实时报价（持仓现价/告警轮询）。

        market_type: spot | swap（None 自动判定）
        exchange_id: 默认 binance
        market: crypto/usstock/forex/futures/cnstock/hkstock
        返回 {symbol, price, change, changePercent, high, low, open,
        previousClose, ts, market_type}；无数据 404 → None（fail_silent）
        """
        params: dict[str, Any] = {"symbol": symbol}
        if market_type is not None:
            params["market_type"] = market_type
        if exchange_id is not None:
            params["exchange_id"] = exchange_id
        if market is not None:
            params["market"] = market
        return self._request("GET", "/ticker", params=params)

    # ── Symbols ───────────────────────────────────────────

    def resolve_symbol(self, symbol: str, market: str = "crypto") -> Optional[dict]:
        """符号解析：BTC → {query: "BTC", resolved: "BTCUSDT", market: "crypto"}。

        未解析 404 → None（fail_silent）。
        """
        return self._request(
            "GET", "/symbol/resolve", params={"symbol": symbol, "market": market}
        )

    def search_symbols(self, keyword: str, market: str = "crypto", limit: int = 20) -> Optional[dict]:
        """符号模糊搜索（添加自选/搜索交易对）。

        market: crypto/usstock/forex/futures/cnstock/hkstock
        返回 {keyword, symbols: [{symbol, market, market_type, exchange, active}, ...]}
        """
        return self._request(
            "GET",
            "/symbols/search",
            params={"keyword": keyword, "market": market, "limit": limit},
        )

    # ── ML 预测（快照，P2 模型）───────────────────────────

    def get_ml_predictions(
        self,
        model: str,
        symbol: str,
        start: Optional[Union[int, float]] = None,
        end: Optional[Union[int, float]] = None,
        limit: int = 500,
    ) -> Optional[dict]:
        """P2 单模型预测历史（**data 侧采集快照，优先路径**，30min 落库稳定可查）。

        model: bolt | moirai | timesfm（正则校验，其他值 422）
        symbol: BTC / BTC/USDT / EURUSD=X 等（服务端归一化，大小写不敏感）
        start/end: 秒或毫秒均可，自动归一化为毫秒
        返回 {model, symbol, count, predictions:[{generated_at, direction,
        prob_up, uncertainty, point_forecast, quantiles}, ...]}（generated_at 升序）；
        该符号尚无快照 → 404 → None（fail_silent）。

        实时性优先时请直连 ml-service `/ml/*`（缓存 miss 返回 data=null，
        需按 TTL 轮询，见 examples/ml_predictions_integration.py）。
        """
        params: dict[str, Any] = {"model": model, "symbol": symbol, "limit": limit}
        if start is not None:
            params["start"] = _to_ms(start)
        if end is not None:
            params["end"] = _to_ms(end)
        return self._request("GET", "/ml/predictions", params=params)

    # ── Policy / Stats / Health ───────────────────────────

    def get_broker_market_policy(self) -> Optional[dict]:
        """券商市场策略：{crypto: {exchanges: [...], default: "Binance"}}。"""
        return self._request("GET", "/policy/broker-market")

    def get_stats(self) -> Optional[dict]:
        """数据库统计：{kline_rows, snapshot_rows, symbols, time_start, time_end}。"""
        return self._request("GET", "/stats")

    def health(self) -> Optional[dict]:
        """健康检查（免鉴权）。返回 {code, message, data:{service, version}}。"""
        return self._request("GET", "/health")

    # ── Session ───────────────────────────────────────────

    def close(self) -> None:
        """关闭底层连接池。"""
        self._session.close()

    def __enter__(self) -> "InfraDataClient":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()
