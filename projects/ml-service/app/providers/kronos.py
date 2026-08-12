"""Kronos 金融 K 线基础模型 — 波动率/路径预测（真实实现）。

Kronos（shiyu-coder/Kronos，MIT）：首个面向金融 K 线（OHLCV）的开源基础模型，
在 45+ 全球交易所数据上预训练（AAAI 2026）。默认使用 Kronos-mini（4.1M 参数，
CPU 可推理，约 0.4s/次）。

归属：ml-service 推理层（独立服务）。数据经 data_client 走 data-service /bars
（BTC/ETH 日线，复用已有采集）→ yfinance 回退（SPY/QQQ 等 data-service 未覆盖标的）。

行为约定：
  - 未启用 / 依赖缺失 / 历史 K 线不足时返回 None（**不产生任何模拟数据**）。
  - 推理：KronosPredictor 对最近 kronos_lookback 根日线做多路径采样
    （kronos_sample_count 条），由路径离散度推导 volatility_score /
    direction_consensus / uncertainty。
"""
from __future__ import annotations

import logging
from typing import Any

import numpy as np
import pandas as pd

import config
from app import data_client
from app.providers.base import ModelProvider

logger = logging.getLogger(__name__)

# 目标资产（核心回退集；默认符号池由 get_target_symbols() 从 data-service 动态拉取）
_TARGETS = ["BTC", "ETH", "SPY", "QQQ"]


def dedupe_symbols(symbols: list[str]) -> list[str]:
    """去除重复永续合约（保持原顺序）。

    规则：凡符号带 `:` 且其前缀（`:` 之前的部分）也存在于池中，视为
    同一标的的永续/合约变体（如 BTC/USDT:USDT ↔ BTC/USDT），剔除变体。
    无现货对标的永续（前缀不在池中）保留。
    """
    present = set(symbols)
    out: list[str] = []
    for sym in symbols:
        if ":" in sym and sym.split(":", 1)[0] in present:
            continue
        out.append(sym)
    return out


def get_target_symbols() -> list[str]:
    """动态目标符号池（覆盖传统资产 1D + 加密资产，与 tree 模型对齐）。

    优先级：P2_TARGET_SYMBOLS 显式覆盖 → data-service /symbols（timeframe=1d
    且 bar 数达标，2026-08-07 起改为动态，覆盖美股/期货/外汇/A股/港股 + crypto）
    → 失败回退核心 _TARGETS。任一路径均做永续去重（dedupe_symbols）。
    """
    explicit = config.P2_TARGET_SYMBOLS
    if explicit:
        syms = [s.strip() for s in explicit.split(",") if s.strip()]
        return dedupe_symbols(syms)
    try:
        syms = data_client.fetch_symbols(timeframe="1d", min_bars=config.TREE_ML_MIN_BARS)
        if syms:
            return dedupe_symbols(syms)
        logger.debug("Kronos get_target_symbols: data-service /symbols empty, fallback")
    except Exception as exc:
        logger.debug("Kronos get_target_symbols failed, fallback: %s", exc)
    return dedupe_symbols(_TARGETS)

# 波动率档位阈值（volatility_score ∈ [0, 1]）
_VOL_LEVELS = [
    (0.25, "very_low"),
    (0.40, "low"),
    (0.55, "moderate"),
    (0.70, "high"),
    (float("inf"), "very_high"),
]

# ── 预测器单例（懒加载由基类统一管理） ─────────────────────

class KronosProvider(ModelProvider):
    """Kronos 波动率预测 provider（需求4 R4-1：继承基类，仅保留加载逻辑）。

    加载约定与旧 _load_predictor 完全一致：需 KRONOS_ENABLED + torch +
    Kronos 源码（PYTHONPATH 指向克隆目录）；首次失败置 flag 不重试（重启可重载）。
    """

    model_key = "volatility"
    enabled_attr = "KRONOS_ENABLED"

    def _do_load(self) -> Any:
        # shiyu-coder/Kronos：PYTHONPATH 指向克隆目录后 import model
        from model import Kronos, KronosPredictor, KronosTokenizer

        model_name = config.KRONOS_MODEL
        tokenizer_name = (
            "NeoQuasar/Kronos-Tokenizer-2k" if "mini" in model_name
            else "NeoQuasar/Kronos-Tokenizer-base"
        )
        max_context = 2048 if "mini" in model_name else 512
        tokenizer = KronosTokenizer.from_pretrained(tokenizer_name)
        model = Kronos.from_pretrained(model_name)
        return KronosPredictor(model, tokenizer, max_context=max_context)


# ── 数据获取 ──────────────────────────────────────────────


def _fetch_klines(symbol: str) -> list[dict]:
    """拉取日线（升序）：data-service /bars 优先 → yfinance 回退。

    data-service 内 crypto 符号为交易所对格式（BTC/USDT），目标符号为裸
    代号（BTC）时先尝试别名候选再回退 yfinance。
    """
    candidates = [symbol]
    if "/" not in symbol:
        candidates += [f"{symbol}/USDT", f"{symbol}USDT"]
    for cand in candidates:
        rows = data_client.fetch_bars(cand, timeframe="1d", limit=config.KRONOS_LOOKBACK + 60)
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
    predictor = KronosProvider.get()
    if predictor is None:
        return None

    klines = _fetch_klines(symbol)
    lookback = config.KRONOS_LOOKBACK
    if len(klines) < lookback:
        logger.warning("Kronos: %s 历史K线不足（%d < %d）", symbol, len(klines), lookback)
        return None

    hist = klines[-lookback:]
    df = pd.DataFrame(hist)[["ts", "open", "high", "low", "close"]].copy()
    for col in ("volume", "amount"):  # 可选列，缺省补 0
        if col not in df.columns:
            df[col] = 0.0
    # Kronos 的 calc_time_stamps 使用 .dt 访问器 → 需 Series，不能是 DatetimeIndex
    x_ts = pd.Series(pd.to_datetime(df["ts"], unit="ms").values)

    # 未来时间戳：按历史中位日线间隔外推
    gaps = np.diff([b["ts"] for b in hist])
    step = int(np.median(gaps)) if len(gaps) else 86400000
    last_ts = int(hist[-1]["ts"])
    y_ts = pd.Series(pd.to_datetime(
        [last_ts + step * (i + 1) for i in range(config.KRONOS_PRED_LEN)], unit="ms"
    ))

    last_close = float(hist[-1]["close"])
    paths: list[np.ndarray] = []
    for _ in range(max(1, config.KRONOS_SAMPLE_COUNT)):
        try:
            pred = predictor.predict(
                df=df, x_timestamp=x_ts, y_timestamp=y_ts,
                pred_len=config.KRONOS_PRED_LEN,
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
        "model": config.KRONOS_MODEL.split("/")[-1],
        "lookback": lookback,
        "pred_len": config.KRONOS_PRED_LEN,
        "last_close": round(last_close, 6),
    })
    return stats


def predict_all_volatility() -> list[dict[str, Any]]:
    """预测所有目标资产的波动率（逐项 fail-silent）。"""
    results: list[dict[str, Any]] = []
    for sym in get_target_symbols():
        try:
            pred = predict_volatility(sym)
            if pred:
                results.append(pred)
        except Exception:
            logger.debug("Kronos volatility predict failed for %s", sym, exc_info=True)
    return results
