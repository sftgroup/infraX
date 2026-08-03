#!/usr/bin/env python3
"""知识图谱注入微服务入口。

用法:
    python main.py                         # 启动定时注入器
    python main.py --api                   # 启动 REST API
    python main.py --api --port 8765       # 自定义端口
    python main.py --once                  # 执行一次全量注入后退出
    python main.py --inject macro          # 执行单类型注入后退出
    python main.py --db-stats              # 查看数据库统计

环境变量:
    LIGHTRAG_URL          — LightRAG 服务地址（空=禁用图谱）
    INJECTOR_INTERVAL_SEC — 注入间隔秒数（默认 21600 = 6h）
    HOST / PORT           — API 服务地址
    LOG_LEVEL             — 日志级别（默认 INFO）
    INJECT_DB_PATH        — SQLite 数据库路径（默认 data/injector.db）
"""
from __future__ import annotations

import argparse
import logging
import os
import sys

# ── 日志配置（在 import 其他模块前） ────────────────

logging.basicConfig(
    level=getattr(logging, os.getenv("LOG_LEVEL", "INFO").upper()),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    stream=sys.stdout,
    datefmt="%H:%M:%S",
)

logger = logging.getLogger(__name__)


def _get_db():
    """获取 InjectDB 实例（延迟导入）。"""
    try:
        from storage import InjectDB
        db_path = os.getenv("INJECT_DB_PATH", "")
        return InjectDB(db_path) if db_path else InjectDB()
    except Exception:
        logger.debug("InjectDB init failed", exc_info=True)
        return None


def _run_once(inject_type: str | None, dry_run: bool = False) -> None:
    """执行一次注入后退出。"""
    from injector.worker import GraphInjector

    db = _get_db()
    injector = GraphInjector(dry_run=dry_run, db=db)
    if inject_type:
        method = getattr(injector, f"inject_{inject_type}", None)
        if not method:
            logger.error("Unknown inject type: %s", inject_type)
            sys.exit(1)
        ok = method()
        logger.info("inject_%s → %s", inject_type, ok)
    else:
        results = injector.inject_all()
        logger.info("inject_all → %s", results)

    if db:
        s = db.stats()
        logger.info("DB: %d snapshots, %d injects (%d ok, %d failed) — %s (%.1fMB)",
                    s["total_snapshots"], s["total_injects"],
                    s["success"], s["failed"], s["db_path"], s["db_size_mb"])


def _run_worker() -> None:
    """启动定时注入器。"""
    import asyncio
    from injector.worker import GraphInjector, run_worker_loop

    db = _get_db()
    injector = GraphInjector(db=db)
    if not injector.enabled:
        logger.warning(
            "LightRAG not configured (LIGHTRAG_URL is empty). "
            "Worker will run an empty loop."
        )
    asyncio.run(run_worker_loop(injector))


def _run_api(host: str, port: int) -> None:
    """启动 REST API。"""
    try:
        from waitress import serve
    except ImportError:
        logger.error("waitress not installed. Run: pip install waitress")
        sys.exit(1)

    from api.routes import create_app

    app = create_app()
    logger.info("REST API starting on %s:%s", host, port)
    serve(app, host=host, port=port)


def _show_db_stats() -> None:
    """打印数据库统计信息。"""
    db = _get_db()
    if db is None:
        logger.error("Failed to init database")
        sys.exit(1)

    s = db.stats()
    print(f"Database: {s['db_path']} ({s['db_size_mb']:.1f} MB)")
    print(f"Snapshots: {s['total_snapshots']}  |  Injects: {s['total_injects']}")
    print(f"Success:   {s['success']}  |  Failed:  {s['failed']}")
    print()

    print("--- Recent Snapshots ---")
    for snap in db.recent_snapshots(limit=10):
        print(f"  [{snap['id']}] {snap['provider']}/{snap['data_type']} "
              f"{snap['symbol']} @ {snap['fetched_at'][:19]}")

    print()
    print("--- Recent Injects ---")
    for inj in db.recent_injects(limit=10):
        status_icon = "OK" if inj['status'] == 'success' else "FAIL"
        print(f"  [{inj['id']}] {status_icon} {inj['file_source']} "
              f"({inj.get('provider', '?')}/{inj.get('data_type', '?')})")


# ─── CLI ──────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(description="Knowledge Graph Injector")
    parser.add_argument("--api", action="store_true", help="Start REST API")
    parser.add_argument("--host", default=os.getenv("HOST", "0.0.0.0"))
    parser.add_argument("--port", type=int, default=int(os.getenv("PORT", "9113")))
    parser.add_argument("--once", action="store_true", help="Inject once then exit")
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Dry run (print generated text, skip LightRAG call)",
    )
    parser.add_argument(
        "--inject", metavar="TYPE",
        help="Inject specific type: macro/sentiment/crypto_overview/volatility/"
             "news_sentiment/major_events/fred_economics/earnings_index/"
             "onchain/defi_tvl/macro_trend/evm/global_macro/indices",
    )
    parser.add_argument("--db-stats", action="store_true",
                        help="Show database statistics and recent records")
    args = parser.parse_args()

    if args.db_stats:
        _show_db_stats()
    elif args.once or args.inject:
        _run_once(args.inject, dry_run=args.dry_run)
    elif args.api:
        _run_api(args.host, args.port)
    else:
        _run_worker()


if __name__ == "__main__":
    main()
