"""
市场数据采集服务 - AI分析专用

设计理念：
1. 数据为王 - 先把数据获取做好、做稳定
2. 统一数据源 - 完全复用 DataSourceFactory 和 kline_service
3. 复用全球金融板块 - 宏观数据、情绪数据复用 global_market.py 的缓存
4. 快速稳定 - 不依赖慢速外部服务（如Jina Reader）

数据源映射：
- 价格/K线: DataSourceFactory (已验证，与K线模块、自选列表一致)
- 宏观数据: 复用 global_market.py (VIX, DXY, TNX, Fear&Greed等，带缓存)
- 新闻: Finnhub API (结构化数据，无需深度阅读)
- 基本面: Finnhub (美股) / 固定描述 (加密)
"""

import time
from typing import Dict, List, Any, Optional
from datetime import datetime, timedelta
from concurrent.futures import ThreadPoolExecutor, as_completed, TimeoutError

import yfinance as yf
import pandas as pd
import requests

from app.data_sources import DataSourceFactory
from app.kline_service import KlineService
from app.data_providers.db_cache import db_cache_get, db_cache_set
from app.data_providers.db_persist import db_data_save
from app.utils.logger import get_logger
from app.config import APIKeys

logger = get_logger(__name__)

class MarketDataCollector:
    """See __init__.py for full class definition."""

def _calculate_indicators(self, klines: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    计算技术指标 (本地计算，无外部依赖)
    
    返回格式符合前端 FastAnalysisReport.vue 的期望。
    口径说明（与常见行情终端对齐）：
    - RSI(14)：Wilder 平滑（首段均幅为前 14 期简单平均，其后递推）。
    - MACD：收盘 EMA12/EMA26（首值=前 N 日 SMA），信号线=MACD 的 EMA9（SMA 种子）。
    - MA：SMA。枢轴：上一根 K 的 H/L/C。摆动高低：近 20 根 H/L 窗口极值。
    - 布林：20 收盘 SMA ± 2×总体标准差。ATR(14)：Wilder（首 ATR=前 14 期 TR 简单平均，其后递推）。
    """
    if not klines or len(klines) < 5:
        return {}
    
    try:
        closes = [float(k.get('close', 0)) for k in klines]
        highs = [float(k.get('high', 0)) for k in klines]
        lows = [float(k.get('low', 0)) for k in klines]
        volumes = [float(k.get('volume', 0)) for k in klines]
        
        if not closes:
            return {}
        
        current_price = closes[-1]
        indicators = {}
        
        # ========== RSI ==========
        if len(closes) >= 15:
            rsi_value = self._calc_rsi(closes, 14)
            if rsi_value < 30:
                rsi_signal = "oversold"
            elif rsi_value > 70:
                rsi_signal = "overbought"
            else:
                rsi_signal = "neutral"
            indicators['rsi'] = {
                'value': round(rsi_value, 2),
                'signal': rsi_signal,
            }
        
        # ========== MACD（SMA 种子 EMA，与常见终端一致）==========
        if len(closes) >= 34:
            macd_raw = self._calc_macd(closes)
            macd_val = macd_raw.get('MACD', 0)
            macd_sig = macd_raw.get('MACD_signal', 0)
            macd_hist = macd_raw.get('MACD_histogram', 0)
            
            if macd_val > macd_sig and macd_hist > 0:
                macd_signal = "bullish"
                macd_trend = "golden_cross" if macd_hist > 0 else "bullish"
            elif macd_val < macd_sig and macd_hist < 0:
                macd_signal = "bearish"
                macd_trend = "death_cross" if macd_hist < 0 else "bearish"
            else:
                macd_signal = "neutral"
                macd_trend = "consolidating"
            
            indicators['macd'] = {
                'value': round(macd_val, 6),
                'signal_line': round(macd_sig, 6),
                'histogram': round(macd_hist, 6),
                'signal': macd_signal,
                'trend': macd_trend,
            }
        
        # ========== 移动平均线 ==========
        ma5 = sum(closes[-5:]) / 5 if len(closes) >= 5 else current_price
        ma10 = sum(closes[-10:]) / 10 if len(closes) >= 10 else current_price
        ma20 = sum(closes[-20:]) / 20 if len(closes) >= 20 else current_price
        
        if current_price > ma5 > ma10 > ma20:
            ma_trend = "strong_uptrend"
        elif current_price > ma20:
            ma_trend = "uptrend"
        elif current_price < ma5 < ma10 < ma20:
            ma_trend = "strong_downtrend"
        elif current_price < ma20:
            ma_trend = "downtrend"
        else:
            ma_trend = "sideways"
        
        indicators['moving_averages'] = {
            'ma5': round(ma5, 6),
            'ma10': round(ma10, 6),
            'ma20': round(ma20, 6),
            'trend': ma_trend,
        }

        # 先算布林带，供下方合成支撑/阻力使用（键名 BB_upper / BB_lower）
        bb_for_levels: Dict[str, Any] = {}
        if len(closes) >= 20:
            bb_for_levels = self._calc_bollinger(closes, 20, 2) or {}
        
        # ========== 支撑/阻力位 (多种方法综合) ==========
        # 方法1: 枢轴点 (Pivot Points) - 使用前一日数据
        if len(klines) >= 2:
            prev_high = float(klines[-2].get('high', highs[-2]) if len(highs) >= 2 else current_price * 1.02)
            prev_low = float(klines[-2].get('low', lows[-2]) if len(lows) >= 2 else current_price * 0.98)
            prev_close = float(klines[-2].get('close', closes[-2]) if len(closes) >= 2 else current_price)
            
            pivot = (prev_high + prev_low + prev_close) / 3
            r1 = 2 * pivot - prev_low  # 阻力位1
            s1 = 2 * pivot - prev_high  # 支撑位1
            r2 = pivot + (prev_high - prev_low)  # 阻力位2
            s2 = pivot - (prev_high - prev_low)  # 支撑位2
        else:
            pivot = current_price
            r1 = r2 = current_price * 1.02
            s1 = s2 = current_price * 0.98
        
        # 方法2: 近期高低点
        recent_highs = highs[-20:] if len(highs) >= 20 else highs
        recent_lows = lows[-20:] if len(lows) >= 20 else lows
        swing_high = max(recent_highs) if recent_highs else current_price * 1.05
        swing_low = min(recent_lows) if recent_lows else current_price * 0.95
        
        # 方法3: 布林上下轨（与 _calc_bollinger 返回字段一致）
        bb_upper = bb_for_levels.get('BB_upper', swing_high)
        bb_lower = bb_for_levels.get('BB_lower', swing_low)
        
        # 综合取值: 取多种方法的平均/加权
        resistance = round((r1 + swing_high + bb_upper) / 3, 6)
        support = round((s1 + swing_low + bb_lower) / 3, 6)
        
        indicators['levels'] = {
            'support': support,
            'resistance': resistance,
            'pivot': round(pivot, 6),
            's1': round(s1, 6),
            'r1': round(r1, 6),
            's2': round(s2, 6),
            'r2': round(r2, 6),
            'swing_high': round(swing_high, 6),
            'swing_low': round(swing_low, 6),
            'method': 'pivot_swing_bb_avg'  # 标注计算方法
        }
        
        # ========== ATR 和波动率（Wilder ATR，全序列递推至最新一根）==========
        atr = 0.0
        if len(klines) >= 14:
            atr = float(self._calc_atr_wilder(klines, period=14))
            volatility_pct = (atr / current_price * 100) if current_price > 0 else 0
            
            if volatility_pct > 5:
                volatility_level = "high"
            elif volatility_pct > 2:
                volatility_level = "medium"
            else:
                volatility_level = "low"
        else:
            volatility_level = "unknown"
            volatility_pct = 0
        
        indicators['volatility'] = {
            'level': volatility_level,
            'pct': round(volatility_pct, 2),
            'atr': round(atr, 6),  # 添加 ATR 绝对值
        }
        
        # ========== 止盈止损建议 (基于 ATR 和支撑/阻力) ==========
        # 止损: 基于 2x ATR 或支撑位，取更保守的
        atr_stop_loss = current_price - (2 * atr) if atr > 0 else current_price * 0.95
        support_stop = indicators['levels']['support']
        suggested_stop_loss = max(atr_stop_loss, support_stop * 0.99)  # 略低于支撑位
        
        # 止盈: 基于 3x ATR 或阻力位，考虑风险回报比
        atr_take_profit = current_price + (3 * atr) if atr > 0 else current_price * 1.05
        resistance_tp = indicators['levels']['resistance']
        suggested_take_profit = min(atr_take_profit, resistance_tp * 1.01)  # 略高于阻力位
        
        # 风险回报比
        risk = current_price - suggested_stop_loss
        reward = suggested_take_profit - current_price
        risk_reward_ratio = round(reward / risk, 2) if risk > 0 else 0
        
        indicators['trading_levels'] = {
            'suggested_stop_loss': round(suggested_stop_loss, 6),
            'suggested_take_profit': round(suggested_take_profit, 6),
            'risk_reward_ratio': risk_reward_ratio,
            'atr_multiplier_sl': 2.0,  # 止损使用 2x ATR
            'atr_multiplier_tp': 3.0,  # 止盈使用 3x ATR
            'method': 'atr_support_resistance'
        }
        
        # ========== 布林带 (附加，与 bb_for_levels 同一次计算) ==========
        if bb_for_levels:
            indicators['bollinger'] = bb_for_levels
        
        # ========== 成交量 (附加) ==========
        if len(volumes) >= 20:
            avg_vol = sum(volumes[-20:]) / 20
            indicators['volume_ratio'] = round(volumes[-1] / avg_vol, 2) if avg_vol > 0 else 1.0
        
        # ========== 价格位置 (附加) ==========
        if len(closes) >= 20:
            high_20 = max(highs[-20:])
            low_20 = min(lows[-20:])
            if high_20 > low_20:
                indicators['price_position'] = round((current_price - low_20) / (high_20 - low_20) * 100, 1)
            else:
                indicators['price_position'] = 50.0
        
        # ========== 整体趋势 (附加) ==========
        indicators['trend'] = ma_trend
        indicators['current_price'] = round(current_price, 6)
        
        return indicators
        
    except Exception as e:
        logger.warning(f"Indicator calculation failed: {e}")
        return {}

def _calc_rsi(self, closes: List[float], period: int = 14) -> float:
    """Wilder RSI：首段均幅为前 period 期涨跌简单平均，之后按 Wilder 平滑递推。"""
    if len(closes) < period + 1:
        return 50.0

    deltas = [closes[i] - closes[i - 1] for i in range(1, len(closes))]
    gains = [d if d > 0 else 0.0 for d in deltas]
    losses = [-d if d < 0 else 0.0 for d in deltas]

    if len(gains) < period:
        return 50.0

    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period

    for i in range(period, len(gains)):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period

    if avg_loss == 0:
        return 100.0

    rs = avg_gain / avg_loss
    return round(100.0 - (100.0 / (1.0 + rs)), 2)

def _ema_series_sma_seed(self, data: List[float], period: int) -> List[Optional[float]]:
    """
    标准 EMA：首值 = 前 period 根简单平均（SMA），之后 EMA_t = (P_t - EMA_{t-1}) * k + EMA_{t-1}，k=2/(period+1)。
    前 period-1 根无定义，返回 None。
    """
    n = len(data)
    out: List[Optional[float]] = [None] * n
    if n < period:
        return out
    k = 2.0 / (period + 1)
    out[period - 1] = sum(data[:period]) / period
    for i in range(period, n):
        prev = out[i - 1]
        if prev is None:
            break
        out[i] = (data[i] - prev) * k + prev
    return out

def _calc_macd(self, closes: List[float]) -> Dict[str, float]:
    """
    MACD(12,26,9)：DIF = EMA12(close) − EMA26(close)，DEA = EMA9(DIF)，柱 = DIF − DEA。
    各 EMA 均采用 SMA 种子；DIF 自第 26 根 K 起有定义，信号线对 DIF 子序列再算 EMA9。
    """
    n = len(closes)
    ema12 = self._ema_series_sma_seed(closes, 12)
    ema26 = self._ema_series_sma_seed(closes, 26)
    if n < 26 or ema12[-1] is None or ema26[-1] is None:
        return {'MACD': 0.0, 'MACD_signal': 0.0, 'MACD_histogram': 0.0}

    macd_sub: List[float] = []
    for i in range(25, n):
        v12 = ema12[i]
        v26 = ema26[i]
        if v12 is not None and v26 is not None:
            macd_sub.append(v12 - v26)

    if not macd_sub:
        return {'MACD': 0.0, 'MACD_signal': 0.0, 'MACD_histogram': 0.0}

    sig_series = self._ema_series_sma_seed(macd_sub, 9)
    last_macd = macd_sub[-1]
    last_sig = sig_series[-1]
    if last_sig is None:
        last_sig = last_macd

    return {
        'MACD': round(last_macd, 6),
        'MACD_signal': round(last_sig, 6),
        'MACD_histogram': round(last_macd - last_sig, 6),
    }

def _true_ranges(self, klines: List[Dict[str, Any]]) -> List[float]:
    """每根 K 的 True Range（首根仅 H−L）。"""
    trs: List[float] = []
    for i, k in enumerate(klines):
        h = float(k.get('high', 0))
        l = float(k.get('low', 0))
        if h <= 0 or l <= 0:
            trs.append(0.0)
            continue
        if i == 0:
            trs.append(h - l)
        else:
            pc = float(klines[i - 1].get('close', 0))
            trs.append(max(h - l, abs(h - pc), abs(l - pc)))
    return trs

def _calc_atr_wilder(self, klines: List[Dict[str, Any]], period: int = 14) -> float:
    """Wilder ATR：首 ATR = 前 period 期 TR 简单平均，之后 ATR_t = (ATR_{t-1}*(period-1)+TR_t)/period。"""
    trs = self._true_ranges(klines)
    if len(trs) < period:
        return 0.0
    atr = sum(trs[:period]) / period
    for i in range(period, len(trs)):
        atr = (atr * (period - 1) + trs[i]) / period
    return atr

def _calc_bollinger(self, closes: List[float], period: int = 20, std_dev: int = 2) -> Dict[str, float]:
    """布林带：中轨为 period 收盘 SMA，σ 为总体标准差（方差/period），上下轨=中轨±std_dev×σ。"""
    if len(closes) < period:
        return {}
    
    recent = closes[-period:]
    middle = sum(recent) / period
    
    variance = sum((x - middle) ** 2 for x in recent) / period
    std = variance ** 0.5
    
    return {
        'BB_upper': round(middle + std_dev * std, 4),
        'BB_middle': round(middle, 4),
        'BB_lower': round(middle - std_dev * std, 4),
        'BB_width': round((std_dev * std * 2) / middle * 100, 2) if middle > 0 else 0
    }

# ==================== 基本面数据 ====================


def _attach_methods(cls):
    cls._calculate_indicators = _calculate_indicators
    cls._calc_rsi = _calc_rsi
    cls._ema_series_sma_seed = _ema_series_sma_seed
    cls._calc_macd = _calc_macd
    cls._true_ranges = _true_ranges
    cls._calc_atr_wilder = _calc_atr_wilder
    cls._calc_bollinger = _calc_bollinger
