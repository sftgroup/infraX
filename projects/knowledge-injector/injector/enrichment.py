"""numpy 因子算子库 — 供 textify 调用。

纯函数，无 IO，无外部依赖（仅 numpy）。
每个函数对一维/二维 numpy array 做滚动计算。

用法:
    from injector.enrichment import ts_slope, ts_zscore, rsi, ath_distance

设计原则:
    - 输入: numpy array, 参数明确
    - 输出: numpy array 或标量
    - 不修改输入 array
    - 窗口不足时返回 NaN
"""
from __future__ import annotations

from typing import Optional

import numpy as np


# ─── 滚动统计 ───────────────────────────────────────


def ts_mean(arr: np.ndarray, window: int) -> np.ndarray:
    """滚动均值。"""
    if len(arr) < window or window < 1:
        return np.full_like(arr, np.nan)
    result = np.full(len(arr), np.nan)
    for i in range(window - 1, len(arr)):
        result[i] = np.nanmean(arr[i - window + 1 : i + 1])
    return result


def ts_std(arr: np.ndarray, window: int, ddof: int = 0) -> np.ndarray:
    """滚动标准差。"""
    if len(arr) < window or window < 1:
        return np.full_like(arr, np.nan)
    result = np.full(len(arr), np.nan)
    for i in range(window - 1, len(arr)):
        result[i] = np.nanstd(arr[i - window + 1 : i + 1], ddof=ddof)
    return result


def ts_slope(arr: np.ndarray, window: int) -> np.ndarray:
    """滚动线性回归斜率。

    用于判断趋势方向（正 = 上升，负 = 下降）。
    """
    if len(arr) < window or window < 2:
        return np.full_like(arr, np.nan)
    result = np.full(len(arr), np.nan)
    x = np.arange(window, dtype=float)
    for i in range(window - 1, len(arr)):
        y = arr[i - window + 1 : i + 1]
        mask = ~np.isnan(y)
        if mask.sum() < 2:
            continue
        # least-squares: slope = (n*sum(xy) - sum(x)*sum(y)) / (n*sum(x^2) - sum(x)^2)
        n = float(mask.sum())
        sx = x[mask].sum()
        sy = y[mask].sum()
        sxy = (x[mask] * y[mask]).sum()
        sx2 = (x[mask] ** 2).sum()
        denom = n * sx2 - sx * sx
        if abs(denom) < 1e-12:
            continue
        result[i] = (n * sxy - sx * sy) / denom
    return result


def ts_delta(arr: np.ndarray, period: int = 1) -> np.ndarray:
    """差值变化（arr[t] - arr[t-period]）。"""
    if len(arr) < period + 1:
        return np.full_like(arr, np.nan)
    result = np.full(len(arr), np.nan)
    result[period:] = arr[period:] - arr[:-period]
    return result


def ts_rank(arr: np.ndarray, window: int) -> np.ndarray:
    """滚动百分位排名（0~1）。"""
    if len(arr) < window or window < 2:
        return np.full_like(arr, np.nan)
    result = np.full(len(arr), np.nan)
    for i in range(window - 1, len(arr)):
        window_data = arr[i - window + 1 : i + 1]
        valid = window_data[~np.isnan(window_data)]
        if len(valid) < 2:
            continue
        current = arr[i]
        if np.isnan(current):
            continue
        # 百分位 = 小于当前值的个数 / (总数 - 1)
        rank = np.sum(valid < current) / (len(valid) - 1)
        result[i] = rank
    return result


def ts_zscore(arr: np.ndarray, window: int) -> np.ndarray:
    """滚动 z-score 标准化。"""
    mean = ts_mean(arr, window)
    std = ts_std(arr, window, ddof=1)
    # 避免除以 0
    std_safe = np.where(np.abs(std) < 1e-12, np.nan, std)
    return (arr - mean) / std_safe


def ts_quantile(arr: np.ndarray, window: int, q: float) -> np.ndarray:
    """滚动分位数（0~1）。"""
    if len(arr) < window or window < 1:
        return np.full_like(arr, np.nan)
    result = np.full(len(arr), np.nan)
    for i in range(window - 1, len(arr)):
        result[i] = np.nanquantile(arr[i - window + 1 : i + 1], q)
    return result


def ts_corr(arr1: np.ndarray, arr2: np.ndarray, window: int) -> np.ndarray:
    """滚动相关系数。"""
    n = min(len(arr1), len(arr2))
    if n < window or window < 2:
        return np.full(n, np.nan)
    result = np.full(n, np.nan)
    for i in range(window - 1, n):
        a = arr1[i - window + 1 : i + 1]
        b = arr2[i - window + 1 : i + 1]
        mask = ~(np.isnan(a) | np.isnan(b))
        if mask.sum() < 2:
            continue
        corr = np.corrcoef(a[mask], b[mask])
        if corr.shape == (2, 2):
            result[i] = corr[0, 1]
    return result


def ts_decay_linear(arr: np.ndarray, window: int) -> np.ndarray:
    """线性衰减加权均值（最近权重最高）。"""
    if len(arr) < window or window < 1:
        return np.full_like(arr, np.nan)
    weights = np.arange(1, window + 1, dtype=float)
    weights /= weights.sum()
    result = np.full(len(arr), np.nan)
    for i in range(window - 1, len(arr)):
        segment = arr[i - window + 1 : i + 1]
        mask = ~np.isnan(segment)
        if mask.sum() < 1:
            continue
        result[i] = np.nansum(segment * weights) / weights[mask].sum()
    return result


# ─── TA-Lib 替代 ────────────────────────────────────


def rsi(arr: np.ndarray, period: int = 14) -> np.ndarray:
    """相对强弱指标 RSI。"""
    if len(arr) < period + 1:
        return np.full_like(arr, np.nan)
    diff = np.diff(arr)
    gains = np.where(diff > 0, diff, 0.0)
    losses = np.where(diff < 0, -diff, 0.0)
    avg_gain = np.full(len(arr), np.nan)
    avg_loss = np.full(len(arr), np.nan)
    avg_gain[period] = np.mean(gains[:period])
    avg_loss[period] = np.mean(losses[:period])
    for i in range(period + 1, len(arr)):
        avg_gain[i] = (avg_gain[i - 1] * (period - 1) + gains[i - 1]) / period
        avg_loss[i] = (avg_loss[i - 1] * (period - 1) + losses[i - 1]) / period
    rs = avg_gain / np.where(avg_loss < 1e-12, np.nan, avg_loss)
    rsi_vals = 100 - (100 / (1 + rs))
    # 当 avg_loss ≈ 0 时 RSI 应为 100（无亏损）
    rsi_vals = np.where(avg_loss < 1e-12, 100.0, rsi_vals)
    return rsi_vals


def atr(
    high: np.ndarray,
    low: np.ndarray,
    close: np.ndarray,
    period: int = 14,
) -> np.ndarray:
    """平均真实波幅 ATR。"""
    n = min(len(high), len(low), len(close))
    if n < period + 1:
        return np.full(n, np.nan)
    tr = np.full(n, np.nan)
    for i in range(1, n):
        hl = high[i] - low[i]
        hc = abs(high[i] - close[i - 1])
        lc = abs(low[i] - close[i - 1])
        tr[i] = max(hl, hc, lc)
    atr_vals = np.full(n, np.nan)
    atr_vals[period] = np.nanmean(tr[1 : period + 1])
    for i in range(period + 1, n):
        atr_vals[i] = (atr_vals[i - 1] * (period - 1) + tr[i]) / period
    return atr_vals


# ─── 标量计算（供 textify 单点调用） ────────────────


def price_percentile(price: float, history: np.ndarray) -> float:
    """价格在历史数据中的百分位。"""
    if len(history) < 2:
        return 0.5
    valid = history[~np.isnan(history)]
    if len(valid) < 2:
        return 0.5
    return float(np.sum(valid < price) / (len(valid) - 1))


def ath_distance(price: float, history: np.ndarray) -> float:
    """距历史最高点的百分比（负值 = 低于 ATH）。"""
    ath = np.nanmax(history)
    if np.isnan(ath) or ath <= 0:
        return 0.0
    return (price - ath) / ath * 100


def z_score(value: float, population: np.ndarray) -> float:
    """单值在总体中的 z-score。"""
    valid = population[~np.isnan(population)]
    if len(valid) < 2:
        return 0.0
    mean = float(np.mean(valid))
    std = float(np.std(valid, ddof=1))
    if std < 1e-12:
        return 0.0
    return (value - mean) / std


# ─── MACD ────────────────────────────────────────────


def macd(
    close: np.ndarray,
    fast: int = 12,
    slow: int = 26,
    signal: int = 9,
) -> dict[str, np.ndarray]:
    """MACD 指标。

    返回 {"macd_line": ..., "signal_line": ..., "histogram": ...}。
    """
    n = len(close)
    nan_arr = np.full(n, np.nan)
    if n < slow + signal:
        return {"macd_line": nan_arr, "signal_line": nan_arr, "histogram": nan_arr}

    # EMA 计算（从第一个有效值开始）
    def _ema(arr: np.ndarray, period: int) -> np.ndarray:
        result = np.full(len(arr), np.nan)
        # 找到第一个非 NaN 的位置
        valid_start = None
        for i in range(len(arr)):
            if not np.isnan(arr[i]):
                valid_start = i
                break
        if valid_start is None or valid_start + period > len(arr):
            return result
        # 初始均值用第一个有效窗口
        init_end = valid_start + period
        result[init_end - 1] = np.mean(arr[valid_start:init_end])
        multiplier = 2 / (period + 1)
        for i in range(init_end, len(arr)):
            if np.isnan(arr[i]) or np.isnan(result[i - 1]):
                continue
            result[i] = (arr[i] - result[i - 1]) * multiplier + result[i - 1]
        return result

    ema_fast = _ema(close, fast)
    ema_slow = _ema(close, slow)
    macd_line = ema_fast - ema_slow
    signal_line = _ema(macd_line, signal)
    histogram = macd_line - signal_line

    return {"macd_line": macd_line, "signal_line": signal_line, "histogram": histogram}


# ─── Bollinger Bands ─────────────────────────────────


def bollinger_bands(
    close: np.ndarray,
    period: int = 20,
    num_std: float = 2.0,
) -> dict[str, np.ndarray]:
    """布林带。

    返回 {"upper": ..., "middle": ..., "lower": ..., "bandwidth": ..., "percent_b": ...}。
    """
    n = len(close)
    nan_arr = np.full(n, np.nan)
    if n < period:
        return {"upper": nan_arr, "middle": nan_arr, "lower": nan_arr,
                "bandwidth": nan_arr, "percent_b": nan_arr}

    middle = ts_mean(close, period)
    std = ts_std(close, period, ddof=1)
    upper = middle + num_std * std
    lower = middle - num_std * std
    bandwidth = (upper - lower) / np.where(middle < 1e-12, np.nan, middle)
    percent_b = (close - lower) / np.where((upper - lower) < 1e-12, np.nan, upper - lower)

    return {"upper": upper, "middle": middle, "lower": lower,
            "bandwidth": bandwidth, "percent_b": percent_b}


# ─── 趋势/动量 标量判断 ──────────────────────────────


def trend_direction(close: np.ndarray, window: int = 20) -> str:
    """判断趋势方向：rising / falling / flat。"""
    if len(close) < window:
        return "insufficient_data"
    slope = float(ts_slope(close, window)[-1])
    mean_val = float(np.nanmean(close[-window:]))
    if np.isnan(slope) or mean_val < 1e-12:
        return "flat"
    slope_pct = slope / mean_val * 100
    if slope_pct > 0.5:
        return "rising"
    elif slope_pct < -0.5:
        return "falling"
    return "flat"


def momentum_phase(close: np.ndarray, window: int = 20) -> str:
    """判断动量阶段：accelerating / decelerating / steady。"""
    if len(close) < window + 5:
        return "insufficient_data"
    recent_slope = float(ts_slope(close[-window:], 5)[-1])
    full_slope = float(ts_slope(close, window)[-1])
    if np.isnan(recent_slope) or np.isnan(full_slope):
        return "steady"
    if abs(full_slope) < 1e-9:
        return "steady"
    ratio = recent_slope / full_slope
    if ratio > 1.3:
        return "accelerating"
    elif ratio < 0.7:
        return "decelerating"
    return "steady"


def rsi_signal(value: float) -> str:
    """RSI 信号解读。"""
    if np.isnan(value):
        return "unknown"
    if value >= 70:
        return "overbought"
    elif value <= 30:
        return "oversold"
    return "neutral"


def volatility_level(close: np.ndarray, window: int = 20) -> str:
    """判断当前波动率水平。"""
    if len(close) < window * 2:
        return "insufficient_data"
    current_vol = float(np.nanstd(close[-window:]) / np.nanmean(close[-window:]) * 100)
    hist_vol = []
    for i in range(window, len(close) - window + 1):
        seg = close[i:i + window]
        hist_vol.append(float(np.nanstd(seg) / np.nanmean(seg) * 100))
    if len(hist_vol) < 2:
        return "normal"
    pctile = price_percentile(current_vol, np.array(hist_vol))
    if pctile > 0.8:
        return "very_high"
    elif pctile > 0.6:
        return "high"
    elif pctile > 0.4:
        return "normal"
    elif pctile > 0.2:
        return "low"
    return "very_low"
