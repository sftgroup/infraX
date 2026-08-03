#!/usr/bin/env python3
"""
Import legacy LightRAG documents (exported from the old aitrader-lightrag
deployment) into the current ragservicer as a namespace.

Usage:
    ./.venv/bin/python scripts/import_legacy_docs.py [--namespace market] [--export data/legacy_docs_export.json] [--include-test] [--limit N]

Requirements:
  - ragservicer must be running on REST_HOST:REST_PORT (default 127.0.0.1:9721)
  - LLM / Embedding keys must be configured in ragservicer/.env, otherwise
    inserts will fail (401/500) — auth itself uses ADMIN_API_KEY from .env.

The script reads the API key from ragservicer/.env automatically.
"""
import argparse
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import requests

ENV_PATH = Path(__file__).resolve().parent.parent / ".env"


def load_key() -> str:
    """Read ADMIN_API_KEY (or RAGSERVICER_API_KEY) from ragservicer/.env."""
    key = os.getenv("ADMIN_API_KEY", "")
    if key and "YOUR_" not in key:
        return key
    if not ENV_PATH.exists():
        sys.exit(f"ERROR: {ENV_PATH} not found")
    for line in ENV_PATH.read_text().splitlines():
        line = line.strip()
        if line.startswith("ADMIN_API_KEY=") or line.startswith("RAGSERVICER_API_KEY="):
            v = line.split("=", 1)[1].strip()
            if v and "YOUR_" not in v:
                return v
    sys.exit("ERROR: ADMIN_API_KEY / RAGSERVICER_API_KEY not configured in .env (still a placeholder)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--namespace", default="market")
    ap.add_argument("--export", default="data/legacy_docs_export.json")
    ap.add_argument("--base-url", default="http://127.0.0.1:9721")
    ap.add_argument("--include-test", action="store_true", help="include test:xxx docs (skipped by default)")
    ap.add_argument("--limit", type=int, default=0, help="only import first N docs (for trial run)")
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--timeout", type=int, default=600, help="max seconds to wait for async extraction")
    args = ap.parse_args()

    key = load_key()
    export_path = Path(args.export)
    if not export_path.exists():
        sys.exit(f"ERROR: export file not found: {export_path}")

    docs = json.loads(export_path.read_text())
    if not args.include_test:
        docs = [d for d in docs if not d.get("file_path", "").startswith("test:")]
    if args.limit:
        docs = docs[: args.limit]

    url = f"{args.base_url}/api/v1/namespaces/{args.namespace}/documents"
    headers = {"X-API-Key": key, "Content-Type": "application/json"}
    print(f"target: {url}")
    print(f"docs to import: {len(docs)} (namespace={args.namespace})")

    accepted, fail = 0, 0

    def insert(doc):
        payload = {"text": doc["content"], "doc_id": doc["doc_id"]}
        for attempt in range(3):
            try:
                r = requests.post(url, json=payload, headers=headers, timeout=120)
                if r.status_code in (200, 201):
                    return doc["doc_id"], None
                err = r.text[:200]
            except Exception as exc:
                err = str(exc)[:200]
            time.sleep(2 * (attempt + 1))
        return doc["doc_id"], err

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(insert, d): d for d in docs}
        for i, fut in enumerate(as_completed(futures), 1):
            doc_id, err = fut.result()
            if err:
                fail += 1
                print(f"[{i}] FAIL {doc_id}: {err}")
            else:
                accepted += 1
                if accepted % 25 == 0 or accepted == len(docs):
                    print(f"[{i}] accepted={accepted} reject={fail}")

    print(f"\nPOST phase done: accepted={accepted} reject={fail}")

    # ── 异步抽提校验：HTTP 201 只代表"已接收"，
    #    实体抽取在后台执行，需轮询 doc_status 确认 processed ──
    tenant = "admin"  # ADMIN_API_KEY 鉴权 → tenant "admin"
    status_file = Path("data") / tenant / args.namespace / "kv_store_doc_status.json"
    print(f"waiting for async extraction, status file: {status_file}")

    pending = {d["doc_id"] for d in docs}
    deadline = time.time() + args.timeout
    while pending and time.time() < deadline:
        time.sleep(5)
        if not status_file.exists():
            continue
        try:
            st = json.loads(status_file.read_text())
        except Exception:
            continue
        processed = {did for did in list(pending) if st.get(did, {}).get("status") == "processed"}
        failed = {did for did in list(pending)
                  if did not in st or st[did].get("status") == "failed"}
        if processed:
            print(f"  processed={len(processed)} failed={len(failed)} remaining={len(pending) - len(processed) - len(failed)}")
            pending -= processed
            pending -= failed
        elif failed:
            print(f"  failed={len(failed)} remaining={len(pending) - len(failed)}")
            pending -= failed

    not_done = len(pending)
    ok = len(docs) - fail - not_done
    print(f"\nDONE: processed={ok} failed={fail} pending/timeout={not_done}")
    sys.exit(0 if not_done == 0 and fail == 0 else 1)


if __name__ == "__main__":
    main()
