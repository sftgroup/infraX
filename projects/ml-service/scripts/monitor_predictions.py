"""ML 预测监控脚本 — 持续跟踪符号池（默认 30 个）的预测耗时与缓存命中率。

数据来源（全部走 HTTP，无 DB 直连）：
  1. ml-service GET /ml/cache/stats（每 tick 拉取，免鉴权）
     - 缓存命中率：总量命中率 + 每 tick 窗口命中率（hits/(hits+misses)）
     - 预测耗时：各端点最近一次全量计算耗时 last_compute_ms（30 符号批量）
  2. data-service GET /ml/predictions（每 --fresh-every 个 tick 全量扫描）
     - 符号池 × 3 模型（bolt/moirai/timesfm）最新预测新鲜度
     - 覆盖率：多少符号在 MONITOR_STALE_MS（默认 2h）内有预测

符号池来自 ml-service .env 的 P2_TARGET_SYMBOLS（逗号分隔，不硬编码）；
查询 /ml/predictions 前做与 data-service 相同的符号归一化（BTC/USDT → BTC）。

用法：
  # 前台单次检查
  .venv/bin/python scripts/monitor_predictions.py --once
  # 持续跟踪（后台，默认每 60s 一 tick、每 5 tick 扫一次新鲜度）
  nohup .venv/bin/python scripts/monitor_predictions.py \
      --interval 60 --fresh-every 5 >> logs/monitor_predictions.log 2>&1 &
"""
from __future__ import annotations

import argparse
import os
import sys
import threading
import time
from pathlib import Path

import requests

# ── 加载 .env（与 main.py 同款 loader，须在读取环境前执行） ──────
_env = Path(__file__).resolve().parents[1] / ".env"
if _env.exists():
    with open(_env) as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, _, v = line.partition("=")
                k, v = k.strip(), v.strip().strip("\"'")
                if k and k not in os.environ:
                    os.environ[k] = v

ML_URL = (os.getenv("ML_SERVICE_URL", "http://127.0.0.1:9120")).rstrip("/")
DATA_URL = (os.getenv("DATA_SERVICE_URL", "http://43.163.105.172:9112")).rstrip("/")
API_KEY = os.getenv("ML_API_KEY", "") or os.getenv("DATA_API_KEY", "")
MODELS = ("bolt", "moirai", "timesfm")
STALE_MS = int(os.getenv("MONITOR_STALE_MS", str(2 * 3600 * 1000)))

# 与 data-service app/factors._CRYPTO_QUOTES 对齐的 quote 剥离表
_CRYPTO_QUOTES = ("USDT", "USDC", "USD", "US", "BUSD", "TUSD", "DAI")


def _normalize_symbol(symbol: str) -> str:
    """复刻 data-service normalize_ml_symbol：大写 + 交易对/quote 剥离。"""
    s = (symbol or "").strip().upper()
    if "/" in s:
        s = s.split("/")[0].strip()
    elif ":" in s:
        s = s.split(":")[0].strip()
    for q in _CRYPTO_QUOTES:
        if s.endswith(q) and len(s) > len(q):
            s = s[: -len(q)]
            break
    if "-" in s:
        s = s.split("-")[0].strip()
    return s


def _symbols() -> list[str]:
    """符号池：P2_TARGET_SYMBOLS（已配置 30 个），失败回退去重逻辑。"""
    raw = os.getenv("P2_TARGET_SYMBOLS", "")
    syms = [s.strip() for s in raw.split(",") if s.strip()]
    if syms:
        return syms
    try:
        import config  # type: ignore

        raw = getattr(config, "P2_TARGET_SYMBOLS", "")
        syms = [s.strip() for s in raw.split(",") if s.strip()]
    except Exception:
        pass
    return syms


def _headers() -> dict:
    return {"X-API-Key": API_KEY} if API_KEY else {}


def fetch_cache_stats() -> dict | None:
    """拉取 ml-service 缓存统计 {total, keys}；失败返回 None。"""
    try:
        r = requests.get(f"{ML_URL}/ml/cache/stats", headers=_headers(), timeout=10)
        if r.status_code != 200:
            return None
        return (r.json() or {}).get("data") or {}
    except Exception as exc:
        print(f"[warn] /ml/cache/stats 拉取失败: {exc}", flush=True)
        return None


def fetch_latest_age(model: str, symbol: str) -> int | None:
    """该 symbol×model 最近一条预测的 age（ms）；无数据/异常返回 None。"""
    try:
        r = requests.get(
            f"{DATA_URL}/ml/predictions",
            params={"model": model, "symbol": _normalize_symbol(symbol), "limit": 1},
            headers=_headers(), timeout=15,
        )
        if r.status_code != 200:
            return None
        rows = (r.json() or {}).get("predictions") or []
        if not rows:
            return None
        gen = rows[-1].get("generated_at")
        return max(0, int(time.time() * 1000) - gen) if gen else None
    except Exception:
        return None


def freshness_sweep(symbols: list[str], pace_s: float = 1.1) -> dict:
    """扫描符号池 × 3 模型最新预测新鲜度。

    默认每请求间隔 1.1s（90 请求 ≈ 100s，≈55 req/min），确保不超过
    data-service RATE_LIMIT_RPM（60/min/IP），避免扫描自身触发 429。
    """
    covered: set[str] = set()
    fresh: set[str] = set()
    model_fresh = {m: 0 for m in MODELS}
    max_age, rows = 0, 0
    for sym in symbols:
        for model in MODELS:
            age = fetch_latest_age(model, sym)
            if pace_s > 0:
                time.sleep(pace_s)
            if age is None:
                continue
            rows += 1
            covered.add(sym)
            max_age = max(max_age, age)
            if age <= STALE_MS:
                fresh.add(sym)
                model_fresh[model] += 1
    return {
        "symbols_total": len(symbols),
        "covered_symbols": len(covered),
        "fresh_symbols": len(fresh),
        "max_age_s": round(max_age / 1000.0, 1),
        "rows": rows,
        "per_model_fresh": model_fresh,
    }


def _pct(hits: int, misses: int) -> float | None:
    denom = hits + misses
    return round(100.0 * hits / denom, 1) if denom else None


class Monitor:
    def __init__(self, symbols: list[str], interval: int, fresh_every: int, once: bool):
        self.symbols = symbols
        self.interval = interval
        self.fresh_every = max(1, fresh_every)
        self.once = once
        self.prev_total: dict | None = None
        self.tick = 0
        self._sweep_lock = threading.Lock()

    def run(self) -> None:
        if not self.symbols:
            print("P2_TARGET_SYMBOLS 未配置，无法确定监控符号池", file=sys.stderr)
            return
        print(f"monitor start: {len(self.symbols)} symbols, "
              f"ml={ML_URL} data={DATA_URL} interval={self.interval}s "
              f"fresh_every={self.fresh_every} stale={STALE_MS//1000}s",
              flush=True)
        while True:
            self.tick += 1
            try:
                self._tick()
            except Exception as exc:
                print(f"[tick {self.tick}] error: {exc}", flush=True)
            if self.once:
                break
            time.sleep(self.interval)

    def _tick(self) -> None:
        now = time.strftime("%Y-%m-%d %H:%M:%S")
        stats = fetch_cache_stats()
        total = (stats or {}).get("total") or {}
        keys = (stats or {}).get("keys") or {}

        hits, misses = total.get("hits", 0), total.get("misses", 0)
        hit_total = _pct(hits, misses)
        win = None
        if self.prev_total is not None:
            win = _pct(hits - self.prev_total.get("hits", 0),
                       misses - self.prev_total.get("misses", 0))
        self.prev_total = dict(total)

        last = {k: v["last_compute_ms"] for k, v in keys.items()
                if v.get("last_compute_ms") is not None}

        parts = [
            f"[tick {self.tick}] {now}",
            f"hit_rate: window={win}% total={hit_total}% "
            f"(hits={hits} misses={misses} expired={total.get('expired', 0)} "
            f"computes={total.get('computes', 0)} total_compute={total.get('compute_ms', 0) / 1000:.0f}s)",
        ]
        if last:
            parts.append("last_compute: " + ", ".join(
                f"{k}={v / 1000:.1f}s" for k, v in sorted(last.items())))
        else:
            parts.append("last_compute: (无，全部缓存命中或尚未计算)")
        print(" | ".join(parts), flush=True)

        if self.tick % self.fresh_every == 0:
            self._launch_sweep()

    def _launch_sweep(self) -> None:
        """后台线程执行新鲜度扫描（节流 1.1s/请求，不阻塞 tick 主循环）。

        上一次扫描未结束时跳过本次（锁非阻塞），避免扫描重叠叠加突发。
        """
        if not self._sweep_lock.acquire(blocking=False):
            print(f"[tick {self.tick}] freshness: 上一轮扫描仍在进行，跳过", flush=True)
            return

        def _run() -> None:
            try:
                fr = freshness_sweep(self.symbols, pace_s=1.1)
                print(f"[tick {self.tick}] freshness: {fr['fresh_symbols']}/{fr['symbols_total']} "
                      f"符号 STALE 内有预测 | covered={fr['covered_symbols']} "
                      f"rows={fr['rows']} max_age={fr['max_age_s']}s "
                      f"per_model_fresh={fr['per_model_fresh']}", flush=True)
            except Exception as exc:
                print(f"[tick {self.tick}] freshness 扫描异常: {exc}", flush=True)
            finally:
                self._sweep_lock.release()

        threading.Thread(target=_run, daemon=True).start()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--interval", type=int, default=60, help="tick 间隔秒（默认 60）")
    ap.add_argument("--fresh-every", type=int, default=5, help="每 N 个 tick 做一次新鲜度全量扫描（默认 5）")
    ap.add_argument("--once", action="store_true", help="只跑一次即退出")
    args = ap.parse_args()
    Monitor(_symbols(), args.interval, args.fresh_every, args.once).run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
