"""符号池去重工具 — 输出可直接写入 .env 的 P2_TARGET_SYMBOLS 配置行。

从 data-service /symbols（timeframe=1d）拉取当前符号池，
去除重复永续合约（BTC/USDT:USDT ↔ BTC/USDT 等），输出去重结果。

用法（在 ml-service 项目目录执行）：
    .venv/bin/python scripts/dedupe_symbols.py
    .venv/bin/python scripts/dedupe_symbols.py --print-json

名单是可配的：把输出贴到 ml-service/.env 的 P2_TARGET_SYMBOLS= 即可固定
预测符号池（kronos/bolt/moirai/timesfm/tree 共用）；不配置则走
data-service 动态池（同样去重）。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

# 加载 .env（与 main.py 同款 loader，须在任何 app import 前执行）
_env_path = Path(__file__).resolve().parents[1] / ".env"
if _env_path.exists():
    with open(_env_path) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, _, val = line.partition("=")
                key, val = key.strip(), val.strip().strip("\"'")
                if key and key not in os.environ:
                    os.environ[key] = val

from app import data_client  # noqa: E402
from app.providers.kronos import dedupe_symbols  # noqa: E402

_TIMEFRAME = "1d"
_MIN_BARS = int(os.getenv("TREE_ML_MIN_BARS", "120"))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--print-json", action="store_true",
                    help="同时以 JSON 输出完整去重列表")
    ap.add_argument("--min-bars", type=int, default=_MIN_BARS,
                    help=f"最少 bar 数过滤（默认 {_MIN_BARS}）")
    args = ap.parse_args()

    symbols = data_client.fetch_symbols(timeframe=_TIMEFRAME, min_bars=args.min_bars)
    if not symbols:
        print(f"错误：data-service /symbols 拉取为空（{data_client._base_url()}）", file=sys.stderr)
        return 1

    deduped = dedupe_symbols(symbols)
    removed = [s for s in symbols if s not in deduped]

    print(f"# 原始 {len(symbols)} 个符号 → 去重后 {len(deduped)} 个")
    if removed:
        print(f"# 剔除永续重复: {', '.join(removed)}")
    print(f"P2_TARGET_SYMBOLS={','.join(deduped)}")
    if args.print_json:
        print()
        print(json.dumps(deduped, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
