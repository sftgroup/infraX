#!/usr/bin/env python3
"""ML 回填落库 —— 读 backfill JSONL → ml_predictions / raw_snapshots（幂等）。

在 data-service 生产机执行（配合 ml-service 的 scripts/backfill_ml_history.py）：
  python3 scripts/ingest_backfill.py /tmp/bf_bolt.jsonl /tmp/bf_moirai.jsonl /tmp/bf_tree.jsonl

- ml 行：INSERT OR IGNORE（ml_predictions 有 UNIQUE(model, symbol, generated_at)）
- tree 行：raw_snapshots（data_type=tree_predictions），按 fetched_at 去重，
  与线上 tree_ml collector 的 snapshot 形态一致（predictions 数组）。
"""
import hashlib
import json
import sqlite3
import sys
import time

DB = "/home/ubuntu/infraX-1/projects/data/data/data.db"
TREE_TYPE = "tree_predictions"


def ingest(path: str) -> tuple[int, int, int, int]:
    """返回 (ml 行数, ml 实际插入, tree 行数, tree 实际插入)。"""
    ml_rows: list[tuple] = []
    tree_rows: list[dict] = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            if row.get("kind") == "tree":
                tree_rows.append(row)
                continue
            ml_rows.append((
                row["model"], row["symbol"], int(row["generated_at"]),
                row.get("direction"), row.get("prob_up"), row.get("uncertainty"),
                json.dumps(row.get("point_forecast"), default=str)
                if row.get("point_forecast") is not None else None,
                json.dumps(row.get("quantiles"), default=str)
                if row.get("quantiles") is not None else None,
                int(time.time() * 1000),
            ))

    db = sqlite3.connect(DB, timeout=60)
    db.execute("PRAGMA busy_timeout=60000")

    inserted_ml = 0
    if ml_rows:
        before = db.execute("SELECT total_changes()").fetchone()[0]
        db.executemany(
            """INSERT OR IGNORE INTO ml_predictions
               (model, symbol, generated_at, direction, prob_up, uncertainty,
                point_forecast, quantiles, fetched_at)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            ml_rows,
        )
        db.commit()
        inserted_ml = db.execute("SELECT total_changes()").fetchone()[0] - before

    inserted_tree = 0
    for row in tree_rows:
        fetched_at = int(row["generated_at"])
        if db.execute(
            "SELECT 1 FROM raw_snapshots WHERE data_type=? AND fetched_at=? LIMIT 1",
            (TREE_TYPE, fetched_at),
        ).fetchone():
            continue
        raw = json.dumps(
            {"generated_at": fetched_at, "predictions": row["predictions"]}, default=str
        )
        checksum = hashlib.md5(raw.encode()).hexdigest()
        db.execute(
            "INSERT INTO raw_snapshots (provider, data_type, symbol, raw_json, fetched_at, checksum)"
            " VALUES (?,?,?,?,?,?)",
            ("ml", TREE_TYPE, "", raw, fetched_at, checksum),
        )
        inserted_tree += 1
    db.commit()
    db.close()
    return len(ml_rows), inserted_ml, len(tree_rows), inserted_tree


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("usage: ingest_backfill.py <jsonl> [jsonl...]")
        sys.exit(1)
    for p in sys.argv[1:]:
        try:
            m, mi, t, ti = ingest(p)
            print(f"{p}: ml={m} (inserted {mi}) tree={t} (inserted {ti})")
        except Exception as exc:
            print(f"{p}: FAILED {exc}", file=sys.stderr)
