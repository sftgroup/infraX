"""Timestamp helpers — unified millisecond precision (DQ-3).

内部（kline / raw_snapshots / ml_predictions）统一毫秒时间戳。
查询入口（/bars /factors/history）收到秒级 start/end 时自动换算为毫秒。
"""

from __future__ import annotations


def normalize_ms(ts) -> int | None:
    """入口时间戳精度归一化：值 < 1e12 视为秒，自动 ×1000 换算为毫秒（DQ-3）。

    - ``None`` 原样返回（未指定边界）
    - 已是毫秒（>= 1e12）原样返回
    - 非数值返回 ``None``（视为未指定，避免把非法输入误当边界）
    """
    if ts is None:
        return None
    try:
        v = int(ts)
    except (TypeError, ValueError):
        return None
    if abs(v) < 10 ** 12:
        v *= 1000
    return v
