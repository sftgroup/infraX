#!/usr/bin/env python3
"""ml_predictions_integration.py — ML 预测集成示例：快照优先 + data=null 兜底。

按 docs/SERVICE_API_REFERENCE.md §3 / docs/DATA_SERVICE_CATALOG.md §4 的调用方建议实现：

  1. 优先读 data-service `/api/data/ml/predictions` 快照（P2 采集快照，30min 落库，
     稳定低延迟，SDK 已内置 get_ml_predictions()）；
  2. 快照无数据（404 → None）或需实时结果时，再直连 ml-service `/ml/<model>`
     （缓存命中返回统一 dict；缓存 miss 立即返回 data=null，属预期行为）；
  3. 用 `/ml/cache/stats`（免鉴权）判断该端点缓存是否就绪（cached/expires_in/
     last_compute_ms），再决定立即拉取还是按 TTL 轮询重试；
  4. 统一解析：顶层聚合指标（n_symbols / avg_prob_up / generated_at / model）
     + symbols[] 明细（direction/prob_up/point_forecast/quantiles/uncertainty）。

运行（生产参数）：
  python examples/ml_predictions_integration.py --symbol BTC/USDT --model bolt \
      --data-url https://43.163.105.172/api/data --data-key <dx_... 或 DATA_API_KEY> \
      --ml-url http://43.156.25.197:9120 --ml-key <ML_API_KEY>

本地（无鉴权开发环境可省略 --*-key）。
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from typing import Any, Optional

import requests

# 未安装 SDK 时（git 引用/仓库内直跑）也能 import 本地包
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from infra_data_client import InfraDataClient

# 与 ml-service config 对齐：ML_CACHE_TTL_SEC 默认 1800（秒）
ML_CACHE_TTL_SEC = 1800.0
# 直连 ml-service 的轮询间隔与最大次数（示例用短轮询演示；生产可放大到 ~TTL/interval）
ML_POLL_INTERVAL_SEC = 60.0
ML_POLL_MAX_ATTEMPTS = 3

# model → ml-service 直连端点（P2 三个模型）
_MODEL_ENDPOINT = {"bolt": "/ml/bolt", "moirai": "/ml/moirai", "timesfm": "/ml/timesfm"}

_DIRECTION_NAMES = {1: "up", 0: "flat", -1: "down"}


# ── 1. 优先路径：data-service 快照 ─────────────────────────────


def read_snapshot(client: InfraDataClient, model: str, symbol: str) -> Optional[dict]:
    """优先读 P2 预测快照（30min 周期落库，稳定低延迟）。

    返回 {model, symbol, count, predictions:[...]}（generated_at 升序）；
    该符号尚无快照 → 404 → SDK fail_silent 返回 None。
    """
    return client.get_ml_predictions(model=model, symbol=symbol, limit=20)


# ── 2. 兜底路径：ml-service 直连 ───────────────────────────────


def ml_cache_stats(ml_url: str) -> Optional[dict]:
    """/ml/cache/stats 免鉴权，返回 {total:{...}, keys:{endpoint:{...}}} 或 None。"""
    try:
        resp = requests.get(f"{ml_url}/ml/cache/stats", timeout=10)
        resp.raise_for_status()
        body = resp.json()
        return body.get("data") if body.get("code") == 0 else None
    except requests.RequestException:
        return None


def ml_fetch(ml_url: str, ml_key: Optional[str], endpoint: str) -> Any:
    """直连 ml-service 重计算端点。

    命中缓存返回 data dict（{generated_at, n_symbols, model, avg_* , symbols[]}）；
    缓存 miss / 模型不可用 / 数据不足返回 data=null —— **属预期行为**，非故障。
    请求带任一鉴权头（Authorization: Bearer / X-API-Key / X-Service-Key）。
    """
    headers = {}
    if ml_key:
        headers["X-API-Key"] = ml_key
    resp = requests.get(f"{ml_url}{endpoint}", headers=headers, timeout=30)
    resp.raise_for_status()
    body = resp.json()
    if body.get("code") != 0:
        return None
    return body.get("data")


def ml_endpoint_ready(ml_url: str, key: str) -> tuple[bool, Optional[dict]]:
    """查缓存统计，判断指定端点是否已缓存就绪（cached 且未过期，配合预热线程使用）。"""
    stats = ml_cache_stats(ml_url)
    if not stats:
        return False, None
    kinfo = (stats.get("keys") or {}).get(key)
    ready = bool(kinfo and kinfo.get("cached") and (kinfo.get("expires_in") or 0) > 0)
    return ready, kinfo


def fetch_with_fallback(ml_url: str, ml_key: Optional[str], endpoint: str) -> Any:
    """缓存命中立即返回；miss 时按 TTL 语义短轮询几次，最终返回 data（可能为 None）。"""
    data = ml_fetch(ml_url, ml_key, endpoint)
    if data is not None:
        return data

    print(f"[ml-service] {endpoint} 返回 data=null（缓存 miss 或计算中），查询缓存状态…")
    ready, kinfo = ml_endpoint_ready(ml_url, endpoint.lstrip("/"))
    if kinfo:
        print(f"[ml-service] {endpoint} 缓存统计: {json.dumps(kinfo, ensure_ascii=False)}")

    for attempt in range(1, ML_POLL_MAX_ATTEMPTS + 1):
        if ready:
            data = ml_fetch(ml_url, ml_key, endpoint)
            if data is not None:
                return data
        print(f"[ml-service] 第 {attempt}/{ML_POLL_MAX_ATTEMPTS} 次轮询："
              f"{ML_POLL_INTERVAL_SEC}s 后再试（生产可放到 ~TTL={int(ML_CACHE_TTL_SEC)}s）")
        time.sleep(ML_POLL_INTERVAL_SEC)
        ready, kinfo = ml_endpoint_ready(ml_url, endpoint.lstrip("/"))
    return None


# ── 3. 解析与展示 ──────────────────────────────────────────────


def show_snapshot(snap: dict) -> None:
    """打印 data 快照：最近几条预测明细（方向/prob_up/点位/分位）。"""
    print("\n== 路径 1：data-service 快照 /api/data/ml/predictions ==")
    print(f"  model={snap['model']}  symbol={snap['symbol']}  count={snap['count']}（generated_at 升序，最近在前）")
    for row in snap["predictions"][-3:]:
        ts = row.get("generated_at")
        q = row.get("quantiles") or {}
        print(
            f"  - {ts}: direction={_DIRECTION_NAMES.get(row.get('direction'), row.get('direction'))}"
            f"  prob_up={row.get('prob_up')}  point_forecast={row.get('point_forecast')}"
            f"  q10/q50/q90={q.get('0.1')}/{q.get('0.5')}/{q.get('0.9')}"
        )


def show_ml_payload(data: dict) -> None:
    """打印 ml-service 统一 dict 结构：聚合指标 + symbols[] 明细。"""
    print("\n== 路径 2：ml-service 直连（统一 dict + 聚合指标） ==")
    print(
        f"  generated_at={data.get('generated_at')}  n_symbols={data.get('n_symbols')}"
        f"  model={data.get('model')}  avg_prob_up={data.get('avg_prob_up')}"
    )
    rows = data.get("symbols") or []
    for row in rows[:3]:
        print(
            f"  - {row.get('symbol')}: direction={_DIRECTION_NAMES.get(row.get('direction'), row.get('direction'))}"
            f"  prob_up={row.get('prob_up')}  point_forecast={row.get('point_forecast')}"
            f"  uncertainty={row.get('uncertainty')}"
        )


# ── main ────────────────────────────────────────────────────────


def main() -> int:
    ap = argparse.ArgumentParser(description="ML 预测集成示例：快照优先 + data=null 兜底")
    ap.add_argument("--symbol", default="BTC/USDT", help="符号，如 BTC/USDT / EURUSD=X（data 服务端归一化）")
    ap.add_argument("--model", default="bolt", choices=sorted(_MODEL_ENDPOINT), help="P2 模型")
    ap.add_argument("--data-url", default="http://127.0.0.1:9112", help="data-service（生产 https://43.163.105.172/api/data）")
    ap.add_argument("--data-key", default=None, help="data 鉴权 key（dx_* 或 DATA_API_KEY）")
    ap.add_argument("--ml-url", default="http://127.0.0.1:9120", help="ml-service")
    ap.add_argument("--ml-key", default=None, help="ml-service 鉴权 key（ML_API_KEY，未配置开放）")
    ap.add_argument("--verify", action="store_true", help="启用 TLS 校验（生产证书暂不可信时省略）")
    args = ap.parse_args()

    endpoint = _MODEL_ENDPOINT[args.model]

    with InfraDataClient(
        base_url=args.data_url, api_key=args.data_key, verify=args.verify,
        # 生产建议保持 fail_silent=True：快照 404/网络抖动返回 None 走兜底，不抛错
        fail_silent=True,
    ) as client:
        # ── 路径 1：优先读快照（推荐，稳定低延迟） ──
        snap = read_snapshot(client, args.model, args.symbol)
        if snap:
            show_snapshot(snap)
            print("\n→ 已获取快照，无需直连 ml-service。如需实时性可改用路径 2。")
            return 0
        print(f"[data] {args.symbol} 尚无 {args.model} 快照（404→None，采集周期内通常 30min 补齐），尝试直连 ml-service…")

        # ── 路径 2：直连 ml-service，处理 data=null ──
        try:
            data = fetch_with_fallback(args.ml_url, args.ml_key, endpoint)
        except requests.HTTPError as exc:
            status = exc.response.status_code if exc.response is not None else None
            if status == 401:
                print("[ml-service] 鉴权失败（401）：ml-service 已配置 ML_API_KEY，请通过 --ml-key 传入", file=sys.stderr)
            else:
                print(f"[ml-service] HTTP {status} 错误: {exc}", file=sys.stderr)
            return 1
        except requests.RequestException as exc:
            print(f"[ml-service] 请求失败（服务未就绪？）: {exc}", file=sys.stderr)
            return 1

        if data:
            show_ml_payload(data)
        else:
            print(
                f"\n→ {endpoint} 仍返回 data=null。处理建议：\n"
                f"  1) 数据在后台计算中/模型未启用，稍后（≥{int(ML_CACHE_TTL_SEC)}s TTL 或预热周期）重试；\n"
                f"  2) 优先改回读 data 快照（采集器会周期性落库）；\n"
                f"  3) 用 /ml/cache/stats 持续观察 cached/last_compute_ms 是否就绪。"
            )
            return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
