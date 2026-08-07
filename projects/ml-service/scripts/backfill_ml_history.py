"""ML 历史回填 —— 对已上线符号按历史 bars 回放推理写 ml_predictions / raw_snapshots。

归属：ml-service（独立推理服务）。在 ml-service 生产机运行（复用 venv +
HF 模型权重缓存），数据经 data-service /bars（HTTP，limit 5000 全量 1d）。

回放语义（与线上端点同款推理，仅把「最新窗口」换成「历史窗口」）：
  - bolt / timesfm：单变量前向走查 —— 对第 i 根 bar 用其前 context 根收盘
    推理，generated_at = 该 bar 的 ts（asof 对齐 bars，回测可直接 join）。
  - moirai：多变量按日对齐 —— 每个回放日把所有符号该日前的最近 context
    根收盘组成矩阵批量推理（与线上 predict_all 同语义，数据不足符号降级）。
  - tree：用当前已训练 LightGBM（stale-model 近似，模型每 24h 重训）对
    历史 bar 特征推理，按回放日聚合成 raw_snapshots 快照行（与线上
    tree_ml collector 落库形态一致）。

产出 JSONL（ml 行 / tree 行分开）→ 经 SSH 管道写入 data-service：
  ml_predictions  INSERT OR IGNORE（UNIQUE model,symbol,generated_at 幂等）
  raw_snapshots   按 data_type=tree_predictions + fetched_at 去重插入

用法（cwd = ml-service 项目根目录）：
  # 试点（单符号 × 最近 N 根，快速验证）
  .venv/bin/python scripts/backfill_ml_history.py --model bolt --symbols BTC/USDT --limit 3 --out /tmp/bf_pilot.jsonl
  # 阶段一（不停服）：bolt / moirai / tree 各一次
  .venv/bin/python scripts/backfill_ml_history.py --model bolt  --out /tmp/bf_bolt.jsonl
  .venv/bin/python scripts/backfill_ml_history.py --model moirai --out /tmp/bf_moirai.jsonl
  .venv/bin/python scripts/backfill_ml_history.py --model tree   --out /tmp/bf_tree.jsonl
  # 阶段二（停服窗口）：timesfm
  .venv/bin/python scripts/backfill_ml_history.py --model timesfm --out /tmp/bf_timesfm.jsonl

落库（在 data-service 生产机执行，见 ingest 脚本）：
  python3 /tmp/ingest_backfill.py /tmp/bf_bolt.jsonl /tmp/bf_moirai.jsonl /tmp/bf_tree.jsonl
"""
from __future__ import annotations

import argparse
import bisect
import json
import logging
import os
import sys
import time
from typing import Any, Iterator

import numpy as np
import pandas as pd

# scripts/ 子目录运行 → 把项目根加入 sys.path（config 在项目根）
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import config  # noqa: F401  (app 模块依赖 config 顶层导入)
from app import data_client

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"),
                    format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("backfill_ml_history")

# ── 符号归一化（与 data-service factors._ml_symbol_key 等价） ──────────
_CRYPTO_QUOTES = ("USDT", "USDC", "BUSD", "DAI", "TUSD", "FDUSD", "USD")


def normalize_ml_symbol(symbol: str) -> str:
    s = (symbol or "").strip().upper()
    if "/" in s:
        s = s.split("/")[0].strip()
    elif ":" in s:
        s = s.split(":")[0].strip()
    for q in _CRYPTO_QUOTES:
        if s.endswith(q) and len(s) > len(q):
            s = s[:-len(q)]
            break
    if "-" in s:
        s = s.split("-")[0].strip()
    return s


def target_symbols(subset: str = "") -> list[str]:
    if subset:
        return [s.strip() for s in subset.split(",") if s.strip()]
    explicit = config.P2_TARGET_SYMBOLS
    if explicit:
        return [s.strip() for s in explicit.split(",") if s.strip()]
    from app.providers.kronos import get_target_symbols
    return get_target_symbols()


def fetch_full_klines(symbol: str) -> list[dict]:
    """全量 1d K 线（data-service /bars，limit 5000；不做 yfinance 回退——
    30 个目标符号均已有 1d 数据，回退只会引入与 bars 不对齐的历史）。"""
    candidates = [symbol]
    if "/" not in symbol:
        candidates += [f"{symbol}/USDT", f"{symbol}USDT"]
    for cand in candidates:
        rows = data_client.fetch_bars(cand, timeframe="1d", limit=5000)
        if rows:
            return rows
    return []


# ── bolt（单变量） ─────────────────────────────────────────

def replay_bolt(klines: list[dict], ctx: int, pred_len: int,
                levels: list[float]) -> Iterator[dict]:
    import torch
    from app.providers import chronos_bolt as bolt_mod

    pipeline = bolt_mod._load_pipeline()
    if pipeline is None:
        logger.warning("bolt pipeline unavailable, skip")
        return
    closes = [float(b["close"]) for b in klines]
    idx = {lv: i for i, lv in enumerate(levels)}
    for i in range(ctx - 1, len(klines)):
        win = np.asarray(closes[i - ctx + 1: i + 1], dtype=np.float32)
        q_t, p_t = pipeline.predict_quantiles(
            inputs=torch.tensor(win, dtype=torch.float32),
            prediction_length=pred_len, quantile_levels=levels,
        )
        q10 = q_t[0, :, idx.get(0.1, 0)].numpy()
        q50 = q_t[0, :, idx.get(0.5, 1)].numpy()
        q90 = q_t[0, :, idx.get(0.9, 2)].numpy()
        stats = bolt_mod._stats_from_paths(p_t[0].numpy(), q10, q50, q90,
                                           float(klines[i]["close"]))
        if stats:
            yield {"generated_at": int(klines[i]["ts"]), **stats}


# ── timesfm（单变量，长上下文） ────────────────────────────

def replay_timesfm(klines: list[dict], ctx: int, pred_len: int) -> Iterator[dict]:
    from app.providers import chronos_bolt as bolt_mod
    from app.providers import timesfm25

    model = timesfm25._load_model()
    if model is None:
        logger.warning("timesfm model unavailable, skip")
        return
    closes = [float(b["close"]) for b in klines]
    for i in range(ctx - 1, len(klines)):
        win = np.asarray(closes[i - ctx + 1: i + 1], dtype=np.float32)
        point_forecast, quantile_forecast = model.forecast(horizon=pred_len, inputs=[win])
        point = np.asarray(point_forecast)[0]
        q = np.asarray(quantile_forecast)[0]
        q_min, q_max = q[:, 0], q[:, -1]
        stats = bolt_mod._stats_from_paths(point, q_min, point, q_max,
                                           float(klines[i]["close"]))
        if stats:
            stats["quantiles"] = {"min": [round(float(x), 6) for x in q_min],
                                  "max": [round(float(x), 6) for x in q_max]}
            yield {"generated_at": int(klines[i]["ts"]), **stats}


# ── moirai（多变量按日对齐） ───────────────────────────────

def replay_moirai(all_klines: dict[str, list[dict]], ctx: int, pred_len: int) -> Iterator[dict]:
    from app.providers import moirai2

    module = moirai2._load_model()
    if module is None:
        logger.warning("moirai module unavailable, skip")
        return
    # 回放日以最长序列（crypto 日更）为 pivot；其余符号按「该日前最近 bar」对齐
    pivot_sym = max(all_klines, key=lambda s: len(all_klines[s]))
    pivot = all_klines[pivot_sym]
    ts_arrays = {s: [b["ts"] for b in kl] for s, kl in all_klines.items()}
    close_arrays = {s: np.asarray([float(b["close"]) for b in kl], dtype=np.float32)
                    for s, kl in all_klines.items()}
    order_base = [s for s in all_klines if s != pivot_sym]

    from uni2ts.model.moirai2 import Moirai2Forecast

    for i in range(ctx - 1, len(pivot)):
        d_ts = int(pivot[i]["ts"])
        closes_map: dict[str, np.ndarray] = {}
        last_close_map: dict[str, float] = {}
        for sym in [pivot_sym] + order_base:
            tsa = ts_arrays[sym]
            j = bisect.bisect_right(tsa, d_ts) - 1
            if j < ctx - 1:
                continue
            closes_map[sym] = close_arrays[sym][j - ctx + 1: j + 1]
            last_close_map[sym] = float(all_klines[sym][j]["close"])
        if not closes_map:
            continue
        order = list(closes_map)
        min_len = min(len(v) for v in closes_map.values())
        if min_len < ctx:  # 与线上一致：长度不足即跳过该日
            continue
        context_len = ctx if min_len > ctx else max(1, min_len - 1)
        past_target = np.stack([closes_map[s][-min_len:] for s in order], axis=1)

        fc_model = Moirai2Forecast(
            module=module, prediction_length=pred_len, target_dim=len(order),
            feat_dynamic_real_dim=0, past_feat_dynamic_real_dim=0,
            context_length=context_len,
        )
        preds = fc_model.predict(past_target=[past_target])
        q_levels = list(module.quantile_levels)
        q_i = {0.1: q_levels.index(0.1) if 0.1 in q_levels else 0,
               0.5: q_levels.index(0.5) if 0.5 in q_levels else len(q_levels) // 2,
               0.9: q_levels.index(0.9) if 0.9 in q_levels else len(q_levels) - 1}
        from app.providers import chronos_bolt as bolt_mod
        for k, sym in enumerate(order):
            q10 = np.asarray(preds[0, q_i[0.1], :, k])
            q50 = np.asarray(preds[0, q_i[0.5], :, k])
            q90 = np.asarray(preds[0, q_i[0.9], :, k])
            stats = bolt_mod._stats_from_paths(q50, q10, q50, q90, last_close_map[sym])
            if stats:
                yield {"generated_at": d_ts, "symbol": sym, **stats}


# ── tree（stale-model，写入 raw_snapshots 快照行） ──────────

def _tree_predict_at(model, meta, df: "pd.DataFrame", ts: int) -> dict | None:
    """对截止 ts 的 df 末行特征预测（与 tree_models._predict_one 同逻辑）。"""
    from app.analytics.tree_models import (DIR_DOWN, DIR_FLAT, DIR_UP, _DIR_NAME,
                                           build_features, opportunity_score,
                                           volatility_level)
    feats = build_features(df)
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
        "symbol": None,  # 由调用方填充
        "ts": ts,
        "close": float(df.iloc[-1]["close"]),
        "direction": _DIR_NAME.get(direction, "unknown"),
        "prob_up": round(prob_map.get(DIR_UP, 0.0), 4),
        "prob_flat": round(prob_map.get(DIR_FLAT, 0.0), 4),
        "prob_down": round(prob_map.get(DIR_DOWN, 0.0), 4),
        "opportunity_score": opportunity_score(prob_map.get(DIR_UP, 0.0),
                                               prob_map.get(DIR_DOWN, 0.0)),
        "volatility_level": vol_level,
    }


def replay_tree(all_klines: dict[str, list[dict]], min_bars: int = 60) -> Iterator[dict]:
    import joblib
    import pandas as pd

    model_path = os.path.join(config.TREE_ML_MODEL_DIR, "tree_direction.joblib")
    meta_path = os.path.join(config.TREE_ML_MODEL_DIR, "meta.json")
    if not (os.path.exists(model_path) and os.path.exists(meta_path)):
        logger.warning("tree model/meta not found (%s), skip", model_path)
        return
    model = joblib.load(model_path)
    meta = json.loads(open(meta_path).read())

    # 每个回放日：所有符号在该日的预测聚合为一行快照
    by_date: dict[int, dict] = {}
    for sym, kl in all_klines.items():
        if len(kl) < min_bars + 1:
            continue
        raw_sym = sym  # 快照 predictions 内用原始符号形式（与线上一致）
        closes = [float(b["close"]) for b in kl]
        for i in range(min_bars, len(kl)):
            df = pd.DataFrame(kl[:i + 1])
            for col in ("open", "high", "low", "close", "volume"):
                if col in df.columns:
                    df[col] = pd.to_numeric(df[col], errors="coerce")
            pred = _tree_predict_at(model, meta, df, int(kl[i]["ts"]))
            if not pred:
                continue
            pred["symbol"] = raw_sym
            by_date.setdefault(int(kl[i]["ts"]), []).append(pred)
        logger.info("tree replay %s done (%d points)", sym, len(kl) - min_bars)

    for ts in sorted(by_date):
        yield {"kind": "tree", "generated_at": ts, "predictions": by_date[ts]}


# ── 主流程 ─────────────────────────────────────────────────

def _iter_rows(model: str, all_klines: dict[str, list[dict]], limit: int | None):
    ctx = config.MOIRAI_CONTEXT  # bolt/moirai/timesfm 生产均为 400
    pred_len = config.MOIRAI_PRED_LEN
    if model == "bolt":
        ctx = config.BOLT_CONTEXT
        pred_len = config.BOLT_PRED_LEN
        levels = [float(x) for x in (config.BOLT_QUANTILES or "0.1,0.5,0.9").split(",") if x.strip()]
        for sym, kl in all_klines.items():
            if limit:
                kl = kl[-(ctx - 1 + limit):]
            n = 0
            for row in replay_bolt(kl, ctx, pred_len, levels):
                row.update({"kind": "ml", "model": "bolt", "symbol": normalize_ml_symbol(sym)})
                yield row
                n += 1
            logger.info("bolt %s: %d rows", sym, n)
    elif model == "timesfm":
        ctx = config.TIMESFM_CONTEXT
        pred_len = config.TIMESFM_PRED_LEN
        for sym, kl in all_klines.items():
            if limit:
                kl = kl[-(ctx - 1 + limit):]
            n = 0
            for row in replay_timesfm(kl, ctx, pred_len):
                row.update({"kind": "ml", "model": "timesfm", "symbol": normalize_ml_symbol(sym)})
                yield row
                n += 1
            logger.info("timesfm %s: %d rows", sym, n)
    elif model == "moirai":
        if limit:
            # 只回放 pivot 序列最后 limit 个回放日
            pivot_sym = max(all_klines, key=lambda s: len(all_klines[s]))
            cutoff = all_klines[pivot_sym][-(ctx - 1 + limit)]["ts"]
            all_klines = {s: [b for b in kl if b["ts"] >= cutoff] for s, kl in all_klines.items()}
        n = 0
        for row in replay_moirai(all_klines, ctx, pred_len):
            row.update({"kind": "ml", "model": "moirai", "symbol": normalize_ml_symbol(row["symbol"])})
            yield row
            n += 1
        logger.info("moirai: %d rows", n)
    elif model == "tree":
        n = 0
        for row in replay_tree(all_klines):
            yield row
            n += 1
        logger.info("tree snapshots: %d rows", n)
    else:
        raise SystemExit(f"unknown model: {model}")


def main() -> None:
    ap = argparse.ArgumentParser(description="ML 历史回填（bars 回放推理 → JSONL）")
    ap.add_argument("--model", choices=["bolt", "moirai", "timesfm", "tree"], required=True)
    ap.add_argument("--symbols", default="", help="逗号分隔子集（默认 P2_TARGET_SYMBOLS 全量）")
    ap.add_argument("--limit", type=int, default=None, help="试点：仅回放每符号最近 N 根")
    ap.add_argument("--out", default="", help="输出 JSONL 路径（默认 stdout）")
    args = ap.parse_args()

    syms = target_symbols(args.symbols)
    logger.info("loading klines for %d symbols: %s", len(syms), ",".join(syms[:5]) + ("..." if len(syms) > 5 else ""))
    all_klines: dict[str, list[dict]] = {}
    for sym in syms:
        kl = fetch_full_klines(sym)
        if len(kl) < 100:
            logger.warning("symbol %s: only %d bars, skip", sym, len(kl))
            continue
        all_klines[sym] = kl
        logger.info("  %s: %d bars (%s -> %s)", sym, len(kl),
                    time.strftime("%Y-%m-%d", time.gmtime(kl[0]["ts"] / 1000)),
                    time.strftime("%Y-%m-%d", time.gmtime(kl[-1]["ts"] / 1000)))
    if not all_klines:
        raise SystemExit("no symbols with enough data")

    out = sys.stdout
    fh = None
    if args.out:
        fh = open(args.out, "w")
        out = fh
    t0 = time.time()
    n = 0
    for row in _iter_rows(args.model, all_klines, args.limit):
        out.write(json.dumps(row, ensure_ascii=False, default=str) + "\n")
        n += 1
        if n % 200 == 0:
            logger.info("progress: %d rows in %.0fs", n, time.time() - t0)
    if fh:
        fh.close()
    logger.info("DONE model=%s rows=%d elapsed=%.0fs", args.model, n, time.time() - t0)


if __name__ == "__main__":
    main()
