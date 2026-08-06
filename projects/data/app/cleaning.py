"""Data quality cleaning — explicit rules + quality observability.

DQ-1: 异常 bar 检测（/bars 查询路径清洗）
DQ-6: 质量指标（/stats.quality：missing_rate / abnormal_bars / source_freshness）

清洗规则集中于此，/bars 查询路径与 /stats 质量指标共用同一套判定，
保证「指标与库内真实数据一致」（DQ-6 验收）。

规则行为可配置（见 app.config）：
  - CLEAN_MODE: "drop"（剔除异常 bar）| "mark"（保留并打 is_abnormal 标记）
  - CLEAN_ZERO_VOLUME / CLEAN_NONPOSITIVE_PRICE: 零量 / 非正价格开关
  - CLEAN_MAX_JUMP_PCT: 相邻 bar 价格突变阈值（0.3 = 30%）
"""

from __future__ import annotations

import time
from typing import Optional

from app.config import (
    CLEAN_MODE,
    CLEAN_ZERO_VOLUME,
    CLEAN_NONPOSITIVE_PRICE,
    CLEAN_MAX_JUMP_PCT,
    FRESHNESS_MS,
)


def is_abnormal(bar: dict, prev_bar: Optional[dict] = None) -> Optional[str]:
    """判定单个 bar 是否异常，返回原因字符串；正常返回 None。

    规则（DQ-1）：
      - 非正价格（open/high/low/close 任一 <= 0）
      - 零/负成交量
      - 与前一 bar 极端跳空（价格突变超 CLEAN_MAX_JUMP_PCT）
    ``prev_bar`` 缺失时跳过跳空检测（序列首 bar 无法比较）。
    """
    o, h, l, c, v = (
        bar.get("open"), bar.get("high"), bar.get("low"),
        bar.get("close"), bar.get("volume"),
    )
    if CLEAN_NONPOSITIVE_PRICE and any(
        p is None or not isinstance(p, (int, float)) or p <= 0 for p in (o, h, l, c)
    ):
        return "non_positive_price"
    if CLEAN_ZERO_VOLUME and (
        v is None or not isinstance(v, (int, float)) or v <= 0
    ):
        return "zero_volume"
    if prev_bar is not None and CLEAN_MAX_JUMP_PCT > 0:
        prev_close = prev_bar.get("close")
        if (
            isinstance(prev_close, (int, float)) and prev_close
            and isinstance(c, (int, float))
        ):
            jump = abs(c - prev_close) / abs(prev_close)
            if jump > CLEAN_MAX_JUMP_PCT:
                return "extreme_jump"
    return None


def clean_bars(bars: list[dict], mode: Optional[str] = None) -> list[dict]:
    """清洗异常 bar（DQ-1）。

    ``mode="drop"`` 剔除异常 bar；``mode="mark"`` 保留并附 ``is_abnormal`` 标记。
    默认取 config.CLEAN_MODE。跳空检测相对前一个「保留的」正常 bar 进行，
    避免异常 bar 互相污染的连锁误判。
    """
    mode = (mode or CLEAN_MODE or "drop").strip().lower()
    cleaned: list[dict] = []
    prev: Optional[dict] = None
    for bar in bars:
        reason = is_abnormal(bar, prev)
        if reason:
            if mode == "mark":
                bar["is_abnormal"] = reason
                cleaned.append(bar)
                prev = bar
            # drop 模式：跳过，不更新 prev（与下一个正常 bar 比较）
        else:
            cleaned.append(bar)
            prev = bar
    return cleaned


# kline 必需字段（missing_rate 统计范围）：OHLCV + 代表性技术因子列
_QC_COLS = (
    "open", "high", "low", "close", "volume",
    "rsi_14", "macd", "bb_upper", "atr_14", "ma_20",
)
# abnormal_bars 扫描上限（避免大表全扫拖慢 /stats）
_QC_SCAN_LIMIT = 100000


def quality_stats(db) -> dict:
    """数据质量指标（DQ-6）：missing_rate / abnormal_bars / source_freshness。

    - missing_rate: kline 每必需字段的 NULL 占比（0~1）
    - abnormal_bars: 最近 _QC_SCAN_LIMIT 行按 is_abnormal 判定的异常数
    - source_freshness: raw_snapshots 各 data_type 最新快照 age_ms 与 fresh
    """
    now_ms = int(time.time() * 1000)

    # 1. missing_rate
    total = 0
    missing_rate: dict[str, float] = {}
    try:
        sel = ", ".join(
            f"SUM(CASE WHEN {c} IS NULL THEN 1 ELSE 0 END)" for c in _QC_COLS
        )
        row = db.execute(f"SELECT COUNT(*), {sel} FROM kline").fetchone()
        total = row[0] or 0
        for i, c in enumerate(_QC_COLS):
            m = row[i + 1] or 0
            missing_rate[c] = round(m / total, 6) if total else 0.0
    except Exception:
        total = 0

    # 2. abnormal_bars（按 symbol 分组，组内时间升序做跳空判定）
    abnormal = 0
    scanned = 0
    try:
        if total:
            # 修复（2026-08-07）：原 ORDER BY ts ASC 取的是「最旧」行，与注释
            # 「最近 _QC_SCAN_LIMIT」相悖，导致早期低质量数据放大 abnormal 比例。
            # 改为取最近 _QC_SCAN_LIMIT 行，组内再按 ts 升序做跳空判定。
            rows = db.execute(
                "SELECT symbol, ts, open, high, low, close, volume "
                "FROM kline ORDER BY ts DESC LIMIT ?",
                (_QC_SCAN_LIMIT,),
            ).fetchall()
            per_symbol: dict[str, list[dict]] = {}
            for r in rows:
                per_symbol.setdefault(r["symbol"], []).append(r)
            for seq in per_symbol.values():
                seq.sort(key=lambda b: b["ts"])  # 组内时间升序
                prev = None
                for r in seq:
                    scanned += 1
                    if is_abnormal(dict(r), prev):
                        abnormal += 1
                    else:
                        prev = dict(r)
    except Exception:
        scanned = 0

    # 3. source_freshness
    source_freshness: dict[str, dict] = {}
    try:
        snap_rows = db.execute(
            "SELECT provider, data_type, MAX(fetched_at) AS latest "
            "FROM raw_snapshots GROUP BY provider, data_type ORDER BY latest DESC"
        ).fetchall()
        for r in snap_rows:
            latest = r["latest"] or 0
            age_ms = max(int(now_ms - latest), 0)
            source_freshness[r["data_type"]] = {
                "age_ms": age_ms,
                "fresh": age_ms <= FRESHNESS_MS,
            }
    except Exception:
        pass

    return {
        "missing_rate": missing_rate,
        "abnormal_bars": {"scanned": scanned, "count": abnormal},
        "source_freshness": source_freshness,
    }
