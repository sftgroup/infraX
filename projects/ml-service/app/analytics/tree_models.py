"""Tree ML — LightGBM / XGBoost / RandomForest 方向预测（真实训练，无模拟回退）。

归属：ml-service 算法层（独立推理服务）。数据经 data_client 走
data-service /bars + /symbols（HTTP），不直连 SQLite。

从 data-service 拉取日线历史（含技术指标列），构造特征 + 未来
horizon 日收益方向标签（三分类 up/flat/down），对每个启用家族
（lightgbm / xgboost / random_forest）在**同一数据集、同一切分**上
训练分类器，对每个 symbol 最新特征预测：

    direction（prob_up/prob_flat/prob_down）+ 机会评分（0-100）
    + 波动率档位（基于该 symbol 历史 vol_20 分位数）

家族开关：TREE_ML_ENABLED（lightgbm，主模型）/ XGB_ENABLED /
RF_ENABLED，全部默认 false。禁用/不可用时 predict_payload() 返回
None（不产生任何数据）；模型文件存 ml-service/models/（joblib）。
"""
from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path
from typing import Any, Optional

import numpy as np
import pandas as pd

import config
from app import data_client

logger = logging.getLogger(__name__)

# ── 常量 ────────────────────────────────────────────────────

DIR_UP = 2
DIR_FLAT = 1
DIR_DOWN = 0
_DIR_NAME = {DIR_UP: "up", DIR_FLAT: "flat", DIR_DOWN: "down"}

TIMEFRAME = "1d"

_MODEL_DIR = Path(config.TREE_ML_MODEL_DIR)

# 模型家族注册：文件 / meta 文件名 / 展示名（lightgbm 保持原文件名兼容）
_FAMILIES = {
    "lightgbm": {
        "file": "tree_direction.joblib",
        "meta": "meta.json",
        "name": "lightgbm-direction",
        "enabled": lambda: config.TREE_ML_ENABLED,
    },
    "xgboost": {
        "file": "xgb_direction.joblib",
        "meta": "xgb_meta.json",
        "name": "xgboost-direction",
        "enabled": lambda: config.XGB_ENABLED,
    },
    "random_forest": {
        "file": "rf_direction.joblib",
        "meta": "rf_meta.json",
        "name": "random-forest-direction",
        "enabled": lambda: config.RF_ENABLED,
    },
}

_IMPORT_ERRORS: dict[str, Exception] = {}


def _import_ok(family: str) -> bool:
    """按家族做依赖导入检查（懒加载，失败置 flag 不再重试）。"""
    if family in _IMPORT_ERRORS:
        return False
    try:
        if family == "lightgbm":
            import lightgbm  # noqa: F401
        elif family == "xgboost":
            import xgboost  # noqa: F401
        else:  # random_forest
            from sklearn.ensemble import RandomForestClassifier  # noqa: F401
    except Exception as exc:  # 未安装/损坏
        _IMPORT_ERRORS[family] = exc
        logger.warning("tree_ml family %s disabled: %s", family, exc)
        return False
    return True


def _enabled(family: str = "lightgbm") -> bool:
    """某家族是否启用（env 开关 + 依赖可导入，懒加载不崩）。"""
    spec = _FAMILIES.get(family)
    if spec is None or not spec["enabled"]():
        return False
    return _import_ok(family)


def _family_path(family: str) -> Path:
    return _MODEL_DIR / _FAMILIES[family]["file"]


def _family_meta_file(family: str) -> Path:
    return _MODEL_DIR / _FAMILIES[family]["meta"]


# ── 特征工程（纯函数，可单测） ──────────────────────────────

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


def make_labels(df: pd.DataFrame, horizon: int = None, up_thr: float = None) -> pd.Series:
    """未来 horizon 日收益 → 方向标签（2=up / 1=flat / 0=down）。

    尾部 horizon 行因无未来数据为 NaN（训练时丢弃）。
    """
    horizon = horizon or config.TREE_ML_HORIZON
    up_thr = up_thr if up_thr is not None else config.TREE_ML_UP_THR
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


# ── 数据加载（HTTP → DataFrame） ───────────────────────────

def _kline_symbols(min_bars: int = None) -> list[str]:
    """data-service 中 timeframe='1d' 且行数 >= min_bars 的 symbol 列表。"""
    min_bars = min_bars or config.TREE_ML_MIN_BARS
    try:
        return data_client.fetch_symbols(timeframe=TIMEFRAME, min_bars=min_bars)
    except Exception as exc:
        logger.debug("tree_ml fetch_symbols failed: %s", exc)
        return []


def _load_kline_df(symbol: str, limit: int = None) -> Optional[pd.DataFrame]:
    """拉某 symbol 日线（升序）→ DataFrame[ts, open, high, low, close, volume, ...指标]。"""
    limit = limit or config.TREE_ML_MAX_BARS
    try:
        bars = data_client.fetch_bars(symbol, timeframe=TIMEFRAME, limit=limit)
        if not bars:
            return None
        df = pd.DataFrame(bars)
        for col in ("open", "high", "low", "close", "volume"):
            if col in df.columns:
                df[col] = pd.to_numeric(df[col], errors="coerce")
        return df
    except Exception as exc:
        logger.debug("tree_ml _load_kline_df(%s) failed: %s", symbol, exc)
        return None


def build_dataset() -> Optional[list[tuple[str, pd.DataFrame]]]:
    """构造 [(symbol, Xy)]，Xy = 特征 + 方向标签（drop 无标签行）。

    单 symbol 有效样本 < 30 跳过；总样本 < MIN_SAMPLES 返回 None。
    特征列 NaN 保留（训练时按列中位数填充）。
    """
    horizon = config.TREE_ML_HORIZON
    up_thr = config.TREE_ML_UP_THR
    min_bars = config.TREE_ML_MIN_BARS
    max_bars = config.TREE_ML_MAX_BARS
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
    if not frames or sum(len(f) for _, f in frames) < config.TREE_ML_MIN_SAMPLES:
        return None
    return frames


# ── 训练 / 持久化 ──────────────────────────────────────────

def _load_meta(family: str = "lightgbm") -> Optional[dict]:
    try:
        p = _family_meta_file(family)
        if p.exists():
            return json.loads(p.read_text())
    except Exception:
        pass
    return None


def _load_model(family: str = "lightgbm") -> Optional[Any]:
    try:
        p = _family_path(family)
        if p.exists():
            import joblib
            return joblib.load(p)
    except Exception as exc:
        logger.warning("tree_ml load model (%s) failed: %s", family, exc)
    return None


def _is_stale(meta: Optional[dict]) -> bool:
    """无模型或超过重训周期。"""
    if meta is None:
        return True
    return time.time() * 1000 - meta.get("trained_at_ms", 0) > config.TREE_ML_RETRAIN_HOURS * 3600 * 1000


def _fit_family(family: str, X_train, y_train, X_val, y_val) -> tuple[Any, float]:
    """按家族构造并训练分类器，返回 (model, val_acc)。

    三个家族共用同一训练/验证切分，保证横向可比（对照基线）。
    """
    if family == "lightgbm":
        from lightgbm import LGBMClassifier
        clf = LGBMClassifier(
            n_estimators=200, learning_rate=0.05, num_leaves=15,
            subsample=0.8, subsample_freq=1, colsample_bytree=0.8,
            verbose=-1, random_state=42,
        )
    elif family == "xgboost":
        import xgboost as xgb
        clf = xgb.XGBClassifier(
            n_estimators=200, learning_rate=0.05, max_depth=6,
            subsample=0.8, colsample_bytree=0.8, random_state=42,
            tree_method="hist", eval_metric="mlogloss",
        )
    else:  # random_forest — 对照基线（sklearn 自带）
        from sklearn.ensemble import RandomForestClassifier
        clf = RandomForestClassifier(
            n_estimators=200, max_depth=8, min_samples_leaf=10,
            random_state=42, n_jobs=2,
        )
    clf.fit(X_train, y_train)
    from sklearn.metrics import accuracy_score
    val_acc = float(accuracy_score(y_val, clf.predict(X_val)))
    return clf, val_acc


def train_models() -> Optional[dict]:
    """构建数据集 → 时序切分（每 symbol 后 20% 验证）→ 训练全部启用家族 → 存盘。

    返回 lightgbm（主家族）meta dict；禁用/数据不足/主家族训练失败返回
    None（无模拟数据）。其余启用家族即使成功也照常落盘，供对比读取。
    """
    enabled_fams = [f for f in _FAMILIES if _enabled(f)]
    if not enabled_fams:
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

    X_train = X_train.fillna(X_train.median())
    X_val = X_val.fillna(X_train.median())  # 用训练集中位数填充验证集

    features = list(X_train.columns)
    symbols = [s for s, _, _ in parts]
    meta_primary: Optional[dict] = None
    for family in enabled_fams:
        try:
            model, val_acc = _fit_family(family, X_train, y_train, X_val, y_val)
        except Exception as exc:
            logger.warning("tree_ml family %s training failed: %s", family, exc)
            continue
        _MODEL_DIR.mkdir(parents=True, exist_ok=True)
        import joblib
        joblib.dump(model, _family_path(family))
        meta = {
            "name": _FAMILIES[family]["name"],
            "version": 1,
            "trained_at_ms": int(time.time() * 1000),
            "horizon": config.TREE_ML_HORIZON,
            "up_thr": config.TREE_ML_UP_THR,
            "n_samples": int(len(X_train)),
            "n_val": int(len(X_val)),
            "val_accuracy": round(val_acc, 4),
            "n_symbols": len(parts),
            "symbols": symbols,
            "features": features,
        }
        _family_meta_file(family).write_text(json.dumps(meta, ensure_ascii=False, indent=2))
        logger.info(
            "tree_ml %s trained: %d samples/%d symbols, val_acc=%.3f",
            family, meta["n_samples"], meta["n_symbols"], meta["val_accuracy"],
        )
        if family == "lightgbm":
            meta_primary = meta
    return meta_primary


# ── 预测 ────────────────────────────────────────────────────

def _predict_one(model: Any, meta: dict, symbol: str) -> Optional[dict]:
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


def predict_all(family: str = "lightgbm") -> Optional[list[dict]]:
    """对某家族已训练 symbol 预测；无模型或过期时触发全家族重训。

    返回 [{symbol, direction, prob_*, opportunity_score, volatility_level}]；
    禁用/无模型且无法训练时返回 None。
    """
    if not _enabled(family):
        return None
    meta = _load_meta(family)
    model = _load_model(family)
    if _is_stale(meta) or model is None:
        # 共享数据集，任一家族过期即整体重训；随后重读本家族模型
        train_models()
        meta = _load_meta(family)
        model = _load_model(family)
        if meta is None or model is None:
            return None

    results = []
    for sym in meta["symbols"]:
        pred = _predict_one(model, meta, sym)
        if pred:
            results.append(pred)
    return results or None


def _primary_family() -> Optional[str]:
    """主家族（优先 lightgbm，其次启用顺序）。"""
    for fam in ("lightgbm", "xgboost", "random_forest"):
        if _enabled(fam):
            return fam
    return None


def predict_payload() -> Optional[dict]:
    """训练（如需）+ 主家族预测 → 快照 payload。

    结构（与 data-service 原快照兼容）：
      {"generated_at", "model": {主家族}, "predictions": [主家族],
       "families": {"xgboost": {"model", "predictions"},
                    "random_forest": {...}}}   # 仅启用的对比家族
    """
    primary = _primary_family()
    if primary is None:
        return None
    predictions = predict_all(primary)
    if not predictions:
        return None
    meta = _load_meta(primary) or {}
    payload = {
        "generated_at": int(time.time() * 1000),
        "model": {
            "name": _FAMILIES[primary]["name"],
            "horizon": config.TREE_ML_HORIZON,
            "n_samples": meta.get("n_samples"),
            "val_accuracy": meta.get("val_accuracy"),
        },
        "predictions": predictions,
    }
    families: dict[str, dict] = {}
    for family in _FAMILIES:
        if family == primary or not _enabled(family):
            continue
        fam_meta = _load_meta(family) or {}
        fam_preds = predict_all(family) or []
        if not fam_preds:
            continue
        families[family] = {
            "model": {
                "name": _FAMILIES[family]["name"],
                "horizon": config.TREE_ML_HORIZON,
                "n_samples": fam_meta.get("n_samples"),
                "val_accuracy": fam_meta.get("val_accuracy"),
            },
            "predictions": fam_preds,
        }
    if families:
        payload["families"] = families
    return payload
