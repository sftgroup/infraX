"""Tree ML — LightGBM 方向预测（P1，真实训练，无模拟回退）。

从 kline 表读日线历史（含技术指标列 rsi_14/macd/bb/atr/ma_*），
构造特征 + 未来 horizon 日收益方向标签（三分类 up/flat/down），
训练 LightGBM 分类器。对每个 symbol 最新特征预测：

    direction（prob_up/prob_flat/prob_down）+ 机会评分（0-100）
    + 波动率档位（基于该 symbol 历史 vol_20 分位数）

结果存快照（provider="ml", data_type="tree_predictions"），由
TreeMlCollector 调度。TREE_ML_ENABLED=false（默认）时完全不产生
任何数据/不写快照；模型文件存 projects/data/models/（joblib）。

2C4G 可行性：样本量 = Σ(各 symbol 日线有效行数)，当前数千行 ×
约 30 特征，LightGBM CPU 秒级训练、内存几十 MB，无 GPU 需求。

归属：算法层（app/analytics/），collector 只负责调度与落库。
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any, Optional

import numpy as np
import pandas as pd

from app.storage import get_db

logger = __import__("logging").getLogger(__name__)

# ── 配置（环境变量） ──────────────────────────────────────────

DIR_UP = 2
DIR_FLAT = 1
DIR_DOWN = 0
_DIR_NAME = {DIR_UP: "up", DIR_FLAT: "flat", DIR_DOWN: "down"}

HORIZON = int(os.getenv("TREE_ML_HORIZON", "7"))          # 未来 N 日收益作为标签
UP_THR = float(os.getenv("TREE_ML_UP_THR", "0.01"))       # >+1% up / <-1% down / 其余 flat
MIN_SAMPLES = int(os.getenv("TREE_ML_MIN_SAMPLES", "300"))  # 不足则跳过训练
MIN_BARS = int(os.getenv("TREE_ML_MIN_BARS", "120"))        # 单 symbol 最少日线根数
MAX_BARS = int(os.getenv("TREE_ML_MAX_BARS", "2000"))       # 单 symbol 最多用多少根
TIMEFRAME = "1d"
TREE_ML_ENABLED = os.getenv("TREE_ML_ENABLED", "false").strip().lower() in (
    "1", "true", "yes", "on",
)

_MODEL_DIR = Path(os.getenv("TREE_ML_MODEL_DIR", str(Path(__file__).resolve().parent.parent / "models")))
_MODEL_FILE = _MODEL_DIR / "tree_direction.joblib"
_META_FILE = _MODEL_DIR / "meta.json"

_LGB_IMPORT_ERROR = None


def _enabled() -> bool:
    """TREE_ML_ENABLED=true 且 lightgbm 可导入才启用（懒加载，不崩）。"""
    global _LGB_IMPORT_ERROR
    if not TREE_ML_ENABLED:
        return False
    if _LGB_IMPORT_ERROR is None:
        try:
            import lightgbm  # noqa: F401
        except Exception as exc:  # 未安装/损坏
            _LGB_IMPORT_ERROR = exc
            logger.warning("tree_ml disabled: lightgbm unavailable (%s)", exc)
    return _LGB_IMPORT_ERROR is None


# ── 特征工程（纯函数，可单测） ────────────────────────────────

def build_features(df: pd.DataFrame) -> pd.DataFrame:
    """从 OHLCV(+技术指标) DataFrame 构造特征。

    输入需含列：close（必须）；可选 high/low、volume 与
    rsi_14/macd_hist/bb_upper/bb_lower/atr_14/ma_5/ma_10/ma_20。
    技术指标缺失时对应派生特征为 NaN（训练时按列中位数填充）。

    输出特征列（时间序列上的滚动窗口，与 df 对齐）：
      ret_1/3/5/10/20, vol_20, vol_60, mom_5_20,
      rsi_14, macd_hist_pct, bb_pos, bb_width, atr_pct,
      ma5_pct, ma10_pct, ma20_pct, high_low_range
    """
    feat = pd.DataFrame(index=df.index)
    close = df["close"].astype(float)

    for n in (1, 3, 5, 10, 20):
        feat[f"ret_{n}"] = close.pct_change(n)
    r1 = close.pct_change()
    feat["vol_20"] = r1.rolling(20).std()
    feat["vol_60"] = r1.rolling(60).std()
    feat["mom_5_20"] = feat["ret_5"] - feat["ret_20"]

    if "rsi_14" in df.columns:
        feat["rsi_14"] = _num(df, "rsi_14")
    if "macd_hist" in df.columns:
        feat["macd_hist_pct"] = _num(df, "macd_hist") / close
    if {"bb_upper", "bb_lower"}.issubset(df.columns):
        bbw = _num(df, "bb_upper") - _num(df, "bb_lower")
        feat["bb_pos"] = (close - _num(df, "bb_lower")) / bbw.replace(0, np.nan)
        feat["bb_width"] = bbw / close
    if "atr_14" in df.columns:
        feat["atr_pct"] = _num(df, "atr_14") / close
    for n in (5, 10, 20):
        col = f"ma_{n}"
        if col in df.columns:
            feat[f"ma{n}_pct"] = (close - _num(df, col)) / close
    if {"high", "low"}.issubset(df.columns):
        feat["high_low_range"] = (_num(df, "high") - _num(df, "low")) / close

    return feat


def _num(df: pd.DataFrame, col: str) -> pd.Series:
    return df[col].astype(float)


def make_labels(df: pd.DataFrame, horizon: int = HORIZON, up_thr: float = UP_THR) -> pd.Series:
    """未来 horizon 日收益 → 方向标签（2=up / 1=flat / 0=down）。

    尾部 horizon 行因无未来数据为 NaN（训练时丢弃）。
    """
    close = df["close"].astype(float)
    future_ret = close.shift(-horizon) / close - 1.0
    labels = pd.Series(np.nan, index=df.index, dtype="float64")
    labels[future_ret > up_thr] = DIR_UP
    labels[future_ret < -up_thr] = DIR_DOWN
    labels[(future_ret >= -up_thr) & (future_ret <= up_thr)] = DIR_FLAT
    return labels


def opportunity_score(prob_up: float, prob_down: float) -> int:
    """机会评分 0-100：(P(up)-P(down)+1)/2*100。"""
    return int(round((prob_up - prob_down + 1.0) * 50.0))


def volatility_level(vol_pct: float) -> str:
    """按当前 vol_20 在历史分布中的百分位分档。"""
    if vol_pct < 0.60:
        return "low"
    if vol_pct < 0.75:
        return "moderate"
    if vol_pct < 0.90:
        return "high"
    return "very_high"


# ── 数据加载 / 数据集构造 ─────────────────────────────────────

def _kline_symbols(min_bars: int = MIN_BARS) -> list[str]:
    """kline 表中 timeframe='1d' 且行数 >= min_bars 的 symbol 列表。"""
    try:
        db = get_db()
        rows = db.execute(
            """SELECT symbol, COUNT(*) AS n FROM kline
               WHERE timeframe = ? GROUP BY symbol HAVING n >= ?""",
            (TIMEFRAME, min_bars),
        ).fetchall()
        return [r["symbol"] for r in rows]
    except Exception as exc:
        logger.debug("tree_ml _kline_symbols failed: %s", exc)
        return []


def _load_kline_df(symbol: str, limit: int = MAX_BARS) -> Optional[pd.DataFrame]:
    """读某 symbol 日线（升序）→ DataFrame[ts, open, high, low, close, volume, ...指标]。"""
    try:
        db = get_db()
        rows = db.execute(
            """SELECT ts, open, high, low, close, volume,
                      rsi_14, macd, macd_signal, macd_hist,
                      bb_upper, bb_middle, bb_lower, atr_14,
                      ma_5, ma_10, ma_20
               FROM kline WHERE symbol = ? AND timeframe = ?
               ORDER BY ts ASC LIMIT ?""",
            (symbol, TIMEFRAME, limit),
        ).fetchall()
        if not rows:
            return None
        df = pd.DataFrame([dict(r) for r in rows])
        for col in ("open", "high", "low", "close", "volume"):
            df[col] = pd.to_numeric(df[col], errors="coerce")
        return df
    except Exception as exc:
        logger.debug("tree_ml _load_kline_df(%s) failed: %s", symbol, exc)
        return None


def build_dataset(
    horizon: int = HORIZON,
    up_thr: float = UP_THR,
    min_bars: int = MIN_BARS,
    max_bars: int = MAX_BARS,
) -> Optional[list[tuple[str, pd.DataFrame]]]:
    """构造 [(symbol, Xy)]，Xy = 特征 + 方向标签（drop 无标签行）。

    单 symbol 有效样本 < 30 跳过；总样本 < MIN_SAMPLES 返回 None。
    特征列 NaN 保留（训练时按列中位数填充）。
    """
    symbols = _kline_symbols(min_bars)
    if not symbols:
        return None
    frames: list[tuple[str, pd.DataFrame]] = []
    for sym in symbols:
        df = _load_kline_df(sym, max_bars)
        if df is None or len(df) < min_bars:
            continue
        feats = build_features(df)
        labels = make_labels(df, horizon, up_thr)
        labels.name = "direction"
        Xy = pd.concat([feats, labels], axis=1)
        Xy = Xy.dropna(subset=["direction"]).iloc[-max_bars:]
        if len(Xy) < 30:
            continue
        frames.append((sym, Xy))
    if not frames or sum(len(f) for _, f in frames) < MIN_SAMPLES:
        return None
    return frames


# ── 训练 / 持久化 ─────────────────────────────────────────────

def _model_paths() -> tuple[Path, Path]:
    return _MODEL_FILE, _META_FILE


def _load_meta() -> Optional[dict]:
    try:
        if _META_FILE.exists():
            return json.loads(_META_FILE.read_text())
    except Exception:
        pass
    return None


def _load_model() -> Optional[Any]:
    try:
        if _MODEL_FILE.exists():
            import joblib
            return joblib.load(_MODEL_FILE)
    except Exception as exc:
        logger.warning("tree_ml load model failed: %s", exc)
    return None


def train_models() -> Optional[dict]:
    """构建数据集 → 时序切分（每 symbol 后 20% 验证）→ 训练 LightGBM → 存盘。

    返回 meta dict；禁用/数据不足/训练失败返回 None（无模拟数据）。
    """
    if not _enabled():
        return None
    frames = build_dataset()
    if not frames:
        logger.info("tree_ml: not enough daily data to train, skip")
        return None

    parts = []
    for sym, Xy in frames:
        n = len(Xy)
        val_n = max(1, int(n * 0.2))
        parts.append((sym, Xy.iloc[:-val_n], Xy.iloc[-val_n:]))
    X_train = pd.concat([t for _, t, _ in parts])
    y_train = X_train.pop("direction")
    X_val = pd.concat([v for _, _, v in parts])
    y_val = X_val.pop("direction")

    try:
        from lightgbm import LGBMClassifier
    except Exception as exc:
        logger.warning("tree_ml train skipped: lightgbm unavailable (%s)", exc)
        return None

    X_train = X_train.fillna(X_train.median())
    X_val = X_val.fillna(X_train.median())  # 用训练集中位数填充验证集

    clf = LGBMClassifier(
        n_estimators=200, learning_rate=0.05, num_leaves=15,
        subsample=0.8, subsample_freq=1, colsample_bytree=0.8,
        verbose=-1, random_state=42,
    )
    try:
        clf.fit(X_train, y_train)
    except Exception as exc:
        logger.warning("tree_ml training failed: %s", exc)
        return None

    from sklearn.metrics import accuracy_score
    val_acc = float(accuracy_score(y_val, clf.predict(X_val)))

    _MODEL_DIR.mkdir(parents=True, exist_ok=True)
    import joblib
    joblib.dump(clf, _MODEL_FILE)
    meta = {
        "name": "lightgbm-direction",
        "version": 1,
        "trained_at_ms": int(time.time() * 1000),
        "horizon": HORIZON,
        "up_thr": UP_THR,
        "n_samples": int(len(X_train)),
        "n_val": int(len(X_val)),
        "val_accuracy": round(val_acc, 4),
        "n_symbols": len(frames),
        "symbols": [s for s, _, _ in parts],
        "features": list(X_train.columns),
    }
    _META_FILE.write_text(json.dumps(meta, ensure_ascii=False, indent=2))
    logger.info(
        "tree_ml trained: %d samples/%d symbols, val_acc=%.3f",
        meta["n_samples"], meta["n_symbols"], meta["val_accuracy"],
    )
    return meta


# ── 预测 ──────────────────────────────────────────────────────

def _predict_one(
    model: Any, meta: dict, symbol: str,
) -> Optional[dict]:
    """单 symbol 最新特征预测。数据不足返回 None。"""
    df = _load_kline_df(symbol, 500)
    if df is None or len(df) < 60:
        return None
    feats = build_features(df)

    # 波动率档位：当前 vol_20 在该 symbol 历史分布中的百分位
    vol20 = feats["vol_20"].dropna()
    vol_level = "unknown"
    if len(vol20) >= 20:
        vol_level = volatility_level(float((vol20 < vol20.iloc[-1]).mean()))

    cols = meta["features"]
    row = feats.iloc[-1]
    row_df = pd.DataFrame(
        [[row[c] if c in feats.columns and pd.notna(row[c]) else 0.0 for c in cols]],
        columns=cols,
    )
    probs = model.predict_proba(row_df)[0]
    prob_map = {int(cls): float(p) for cls, p in zip(model.classes_, probs)}
    direction = max(prob_map, key=prob_map.get)

    return {
        "symbol": symbol,
        "ts": int(df.iloc[-1]["ts"]),
        "close": float(df.iloc[-1]["close"]),
        "direction": _DIR_NAME.get(direction, "unknown"),
        "prob_up": round(prob_map.get(DIR_UP, 0.0), 4),
        "prob_flat": round(prob_map.get(DIR_FLAT, 0.0), 4),
        "prob_down": round(prob_map.get(DIR_DOWN, 0.0), 4),
        "opportunity_score": opportunity_score(
            prob_map.get(DIR_UP, 0.0), prob_map.get(DIR_DOWN, 0.0),
        ),
        "volatility_level": vol_level,
    }


def predict_all() -> Optional[list[dict]]:
    """对所有已训练 symbol 预测；无模型时尝试训练。

    返回 [{symbol, direction, prob_*, opportunity_score, volatility_level}]；
    禁用/无模型且无法训练时返回 None。
    """
    if not _enabled():
        return None
    meta = _load_meta()
    model = _load_model()
    if meta is None or model is None:
        meta = train_models()
        if meta is None:
            return None
        model = _load_model()
        if model is None:
            return None

    results = []
    for sym in meta["symbols"]:
        pred = _predict_one(model, meta, sym)
        if pred:
            results.append(pred)
    return results or None
