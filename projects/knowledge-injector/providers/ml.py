"""Kronos 金融 K 线基础模型 — 波动率/路径预测（真实实现）。

Kronos（shiyu-coder/Kronos，MIT）：首个面向金融 K 线（OHLCV）的开源基础模型，
在 45+ 全球交易所数据上预训练（AAAI 2026）。默认使用 Kronos-mini（4.1M 参数，
CPU 可推理，约 0.4s/次）。

启用步骤（部署机）：
  1. pip install torch --index-url https://download.pytorch.org/whl/cpu
     pip install transformers huggingface-hub
  2. git clone https://github.com/shiyu-coder/Kronos /opt/Kronos
  3. systemd 单元加 Environment="PYTHONPATH=/opt/Kronos"（或 export PYTHONPATH）
  4. .env 置 KRONOS_ENABLED=true（可选 KRONOS_MODEL/KRONOS_LOOKBACK/KRONOS_PRED_LEN/
     KRONOS_SAMPLE_COUNT）

行为约定：
  - 未启用 / 依赖缺失 / 历史 K 线不足时返回 None（**不产生任何模拟数据**，
    避免污染 RAG）。ml_predictions 默认不在注入列表，启用真实模型后需手动加回。
  - 数据来源：data-service /bars（BTC/ETH 日线，复用已有采集）→ yfinance 回退
    （SPY/QQQ 等 data-service 未覆盖标的）。
  - 推理：KronosPredictor 对最近 kronos_lookback 根日线做多路径采样
    （kronos_sample_count 条），由路径离散度推导 volatility_score /
    direction_consensus / uncertainty。
"""
from __future__ import annotations

import logging
import threading
from typing import Any

import numpy as np
import pandas as pd

from config import SETTINGS
from providers.data_service import fetch_klines as fetch_klines_ds

logger = logging.getLogger(__name__)

# 目标资产
_TARGETS = ["BTC", "ETH", "SPY", "QQQ"]

# data-service kline 表 symbol 映射
_SYMBOL_MAP = {"BTC": "BTC/USDT", "ETH": "ETH/USDT"}

# 波动率档位阈值（volatility_score ∈ [0, 1]）
_VOL_LEVELS = [
    (0.25, "very_low"),
    (0.40, "low"),
    (0.55, "moderate"),
    (0.70, "high"),
    (float("inf"), "very_high"),
]

# ── 预测器单例（懒加载） ───────────────────────────────────

_predictor: Any = None
_predictor_lock = threading.Lock()
_predictor_failed = False


def _load_predictor():
    """懒加载 KronosPredictor（需 KRONOS_ENABLED + torch + Kronos 源码）。

    首次失败后记 flag 不再重试（避免每次注入周期反复 import 报错）；
    服务重启（或环境就绪后重启）即可重新加载。
    """
    global _predictor, _predictor_failed
    if _predictor is not None or _predictor_failed:
        return _predictor
    if not SETTINGS.kronos_enabled:
        return None
    with _predictor_lock:
        if _predictor is not None or _predictor_failed:
            return _predictor
        try:
            # shiyu-coder/Kronos：PYTHONPATH 指向克隆目录后 import model
            from model import Kronos, KronosPredictor, KronosTokenizer

            model_name = SETTINGS.kronos_model
            tokenizer_name = (
                "NeoQuasar/Kronos-Tokenizer-2k" if "mini" in model_name
                else "NeoQuasar/Kronos-Tokenizer-base"
            )
            max_context = 2048 if "mini" in model_name else 512
            tokenizer = KronosTokenizer.from_pretrained(tokenizer_name)
            model = Kronos.from_pretrained(model_name)
            _predictor = KronosPredictor(model, tokenizer, max_context=max_context)
            logger.info("Kronos predictor loaded: %s", model_name)
        except Exception as exc:  # ImportError / HF 下载失败 / OOM 等
            _predictor_failed = True
            logger.warning("Kronos 加载失败（真实预测未启用）: %s", exc)
    return _predictor


# ── 数据获取 ──────────────────────────────────────────────


def _fetch_klines(symbol: str) -> list[dict]:
    """拉取日线（升序）：data-service /bars 优先 → yfinance 回退。"""
    ds_sym = _SYMBOL_MAP.get(symbol, symbol)
    rows = fetch_klines_ds(ds_sym, timeframe="1d", limit=SETTINGS.kronos_lookback + 60)
    if rows:
        return rows
    try:
        import yfinance as yf

        df = yf.Ticker(symbol).history(period="2y", interval="1d")
        if df is not None and not df.empty:
            out = []
            for t_idx, row in df.iterrows():
                out.append({
                    "ts": int(t_idx.timestamp() * 1000),
                    "open": float(row["Open"]), "high": float(row["High"]),
                    "low": float(row["Low"]), "close": float(row["Close"]),
                    "volume": float(row.get("Volume", 0) or 0),
                })
            return out
    except Exception as exc:
        logger.debug("yfinance %s 回退失败: %s", symbol, exc)
    return []


# ── 纯函数统计（可单测） ───────────────────────────────────


def _vol_level(score: float) -> str:
    for threshold, label in _VOL_LEVELS:
        if score < threshold:
            return label
    return "very_high"


def _path_stats(paths: list[np.ndarray], last_close: float) -> dict[str, Any]:
    """由多路径预测计算波动率统计（纯函数）。

    paths: 每项为预测 close 序列（长度 = pred_len）的 ndarray。
    volatility_score: 路径期末收益的跨路径标准差 ×3，clip 到 [0,1]。
    direction_consensus: 看涨路径占比偏离 0.5 的 2 倍（0=随机, 1=完全一致）。
    """
    if not paths or last_close <= 0:
        return {}
    arr = np.asarray(paths, dtype=float)  # (N, pred_len)
    rets = arr[:, -1] / last_close - 1.0
    vol_score = float(np.clip(float(np.std(rets)) * 3.0, 0.0, 1.0))
    up = float(np.mean(rets > 0))
    consensus = float(np.clip(2.0 * abs(up - 0.5), 0.0, 1.0))
    return {
        "volatility_score": round(vol_score, 4),
        "volatility_level": _vol_level(vol_score),
        "direction_consensus": round(consensus, 4),
        "uncertainty": "low" if vol_score < 0.4 else ("moderate" if vol_score < 0.6 else "high"),
    }


# ── 主入口 ────────────────────────────────────────────────


def predict_volatility(symbol: str) -> dict[str, Any] | None:
    """Kronos 真实波动率预测；未启用/依赖缺失/数据不足返回 None。"""
    predictor = _load_predictor()
    if predictor is None:
        return None

    klines = _fetch_klines(symbol)
    lookback = SETTINGS.kronos_lookback
    if len(klines) < lookback:
        logger.warning("Kronos: %s 历史K线不足（%d < %d）", symbol, len(klines), lookback)
        return None

    hist = klines[-lookback:]
    df = pd.DataFrame(hist)[["ts", "open", "high", "low", "close"]].copy()
    for col in ("volume", "amount"):  # 可选列，缺省补 0
        if col not in df.columns:
            df[col] = 0.0
    x_ts = pd.to_datetime(df["ts"], unit="ms")

    # 未来时间戳：按历史中位日线间隔外推
    gaps = np.diff([b["ts"] for b in hist])
    step = int(np.median(gaps)) if len(gaps) else 86400000
    last_ts = int(hist[-1]["ts"])
    y_ts = pd.to_datetime(
        [last_ts + step * (i + 1) for i in range(SETTINGS.kronos_pred_len)], unit="ms"
    )

    last_close = float(hist[-1]["close"])
    paths: list[np.ndarray] = []
    for _ in range(max(1, SETTINGS.kronos_sample_count)):
        try:
            pred = predictor.predict(
                df=df, x_timestamp=x_ts, y_timestamp=y_ts,
                pred_len=SETTINGS.kronos_pred_len,
                T=1.0, top_p=0.9, sample_count=1,
            )
            paths.append(pred["close"].to_numpy(dtype=float))
        except Exception as exc:
            logger.warning("Kronos %s predict 失败: %s", symbol, exc)
    if not paths:
        return None

    stats = _path_stats(paths, last_close)
    if not stats:
        return None
    stats.update({
        "symbol": symbol,
        "model": SETTINGS.kronos_model.split("/")[-1],
        "lookback": lookback,
        "pred_len": SETTINGS.kronos_pred_len,
        "last_close": round(last_close, 6),
    })
    return stats


def predict_all_volatility() -> list[dict[str, Any]]:
    """预测所有目标资产的波动率（逐项 fail-silent）。"""
    results: list[dict[str, Any]] = []
    for sym in _TARGETS:
        try:
            pred = predict_volatility(sym)
            if pred:
                results.append(pred)
        except Exception:
            logger.debug("Kronos volatility predict failed for %s", sym, exc_info=True)
    return results
