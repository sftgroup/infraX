#!/usr/bin/env python3
"""InfraX LightRAG 知识库 存 + 取 端到端样例（lightrag-client 2.0.0）。

演示流程：
    1. 初始化 LightRAGClient（base_url / 租户 key / tenant_id）
    2. 存：单条写入 + 批量写入（服务端默认异步，立即返回 task_id）
    3. 等：轮询 tasks/<task_id> 至 indexed（写入后台抽实体建图 + 向量化）
    4. 取：mix / hybrid / local 三种模式语义检索 + retrieve top_k
    5. 管：列出文档 / 删除文档
    6. 错误处理：LightRAGClientError

运行：
    pip install -e .            # 在 sdk/python 目录
    python examples/lightrag_store_and_query.py \
        --base-url https://infrax.0xainet.top/api/rag \
        --api-key lr_... --tenant service-platform --namespace research
"""
from __future__ import annotations

import argparse
import sys
import time

import requests

from lightrag_client import LightRAGClient, LightRAGClientError


def wait_indexed(base_url: str, api_key: str, namespace: str, task_id: str, timeout: float = 120.0) -> dict:
    """轮询写入任务至 indexed（SDK 未封装 tasks 端点，此处用 requests 直连）。"""
    deadline = time.time() + timeout
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    url = f"{base_url.rstrip('/')}/api/v1/namespaces/{namespace}/tasks/{task_id}"
    while time.time() < deadline:
        resp = requests.get(url, headers=headers, timeout=30)
        data = resp.json().get("data", {})
        status = data.get("status")
        print(f"    task {task_id[:8]}... status={status}")
        if status in ("indexed", "error"):
            return data
        time.sleep(3)
    print(f"    !! task {task_id[:8]}... 未在 {timeout}s 内完成，继续查询可能不完整")
    return data


def main() -> int:
    ap = argparse.ArgumentParser(description="LightRAG 存 + 取端到端样例")
    ap.add_argument("--base-url", required=True, help="ragservicer 基址，如 https://infrax.0xainet.top/api/rag")
    ap.add_argument("--api-key", required=True, help="管理员签发的租户 key（lr_...）")
    ap.add_argument("--tenant", default="service-platform", help="租户 id（自动加 X-Tenant-ID 头）")
    ap.add_argument("--namespace", default="research", help="命名空间（首次访问隐式创建）")
    ap.add_argument("--timeout", type=float, default=120.0, help="任务轮询超时（秒）")
    args = ap.parse_args()

    client = LightRAGClient(base_url=args.base_url, api_key=args.api_key, tenant_id=args.tenant)

    # ── 1. 健康检查 ──────────────────────────────────────
    print("== 1. health ==")
    print("   ", client.health())

    # ── 2. 存：单条写入（异步，立即返回 task_id） ────────
    print("== 2. insert (single, async) ==")
    r1 = client.insert(
        args.namespace,
        "InfraX 量化平台因子体系：技术因子（RSI/MACD/布林带）、"
        "宏观因子（VIX/美元指数/美债10Y）、ML 因子（LightGBM/Chronos-Bolt/Moirai/TimesFM 方向与概率预测）。",
        doc_id="doc-factor-overview-001",
    )
    print("   ", r1)

    # ── 3. 存：批量写入 ──────────────────────────────────
    print("== 3. insert_batch ==")
    r2 = client.insert_batch(args.namespace, [
        {"text": "2026-Q2 宏观报告：美联储维持利率不变，10Y 收益率走平。", "doc_id": "doc-macro-2026q2-001"},
        {"text": "链上数据：巨鲸地址 BTC 余额上升，交易所净流出增加。", "doc_id": "doc-onchain-2026q2-001"},
        {"text": "策略说明：动量因子在 1d 时间框架上的 IC 稳定性评估。", "doc_id": "doc-strategy-mom-001"},
    ])
    print("   ", r2)

    # ── 4. 等：轮询所有 task 至 indexed ──────────────────
    print("== 4. wait indexed ==")
    for task in [r1, *r2.get("tasks", [])]:
        if task and task.get("task_id"):
            wait_indexed(args.base_url, args.api_key, args.namespace, task["task_id"], args.timeout)

    # ── 5. 取：三种模式检索 ──────────────────────────────
    print("== 5. query ==")
    for mode in ("mix", "hybrid", "local"):
        try:
            res = client.query(args.namespace, "宏观因子与利率政策", mode=mode)
            ctx = res.get("context", "")[:120]
            print(f"   [{mode}] -> {ctx!r}")
        except LightRAGClientError as exc:
            print(f"   [{mode}] ERROR [{exc.status}] {exc.code}: {exc.message}")

    print("== 6. retrieve top_k=5 ==")
    res = client.retrieve(args.namespace, "巨鲸链上增持", top_k=5)
    print("   keys:", list(res.keys()))

    # ── 7. 管：列出 / 删除 ───────────────────────────────
    print("== 7. list_documents ==")
    docs = client.list_documents(args.namespace, page=1, limit=20)
    total = docs.get("total", 0)
    print(f"   total={total} docs, first: {[d.get('doc_id') for d in docs.get('documents', [])[:4]]}")
    del_task = client.delete(args.namespace, "doc-strategy-mom-001")
    print(f"   delete doc-strategy-mom-001 (async) -> {del_task}")
    if del_task.get("task_id"):
        wait_indexed(args.base_url, args.api_key, args.namespace, del_task["task_id"], args.timeout)

    # ── 8. 错误处理演示 ──────────────────────────────────
    print("== 8. error handling ==")
    try:
        client.query(args.namespace, "x", mode="invalid_mode")
    except LightRAGClientError as exc:
        print(f"   caught LightRAGClientError: [{exc.status}] {exc.code}: {exc.message}")

    print("done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
