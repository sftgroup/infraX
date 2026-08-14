"""因子目录（需求6 FF-3.1 / FF-3.2）。

factors_catalog：合格因子登记表（key/公式/数据源/窗口/版本/状态 active|inactive）。
存储：SQLite（复用 factor_factory.db 的 factor_catalog 表，与 jobs 同库）。
管理端点：GET/POST /factors/catalog + POST /factors/{key}/activate|deactivate。
"""
from __future__ import annotations

import json
import logging
import threading
from typing import Any, Optional

import config

logger = logging.getLogger(__name__)

_DDL = """
CREATE TABLE IF NOT EXISTS factor_catalog (
    factor_key TEXT PRIMARY KEY,
    name TEXT,
    category TEXT,
    template TEXT,
    params_json TEXT,
    description TEXT,
    source TEXT,
    version TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    registered_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
"""


class CatalogStore:
    """因子目录（与 factor_jobs 同库单连接 + 锁）。"""

    def __init__(self) -> None:
        from app.factorengine.jobs import get_store

        self._conn = get_store()._conn  # 复用连接（jobs 模块已建表路径）
        self._lock = threading.Lock()
        with self._lock:
            self._conn.executescript(_DDL)
            self._conn.commit()

    def upsert(self, entry: dict[str, Any]) -> None:
        now = entry.get("updated_at")
        with self._lock:
            self._conn.execute(
                "INSERT INTO factor_catalog (factor_key, name, category, template, params_json, "
                "description, source, version, status, registered_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(factor_key) DO UPDATE SET name=excluded.name, "
                "category=excluded.category, template=excluded.template, "
                "params_json=excluded.params_json, description=excluded.description, "
                "source=excluded.source, version=excluded.version, "
                "status=excluded.status, updated_at=excluded.updated_at",
                (entry["factor_key"], entry.get("name", ""), entry.get("category", ""),
                 entry.get("template"), json.dumps(entry.get("params", {}), ensure_ascii=False),
                 entry.get("description", ""), entry.get("source", "factor_miner"),
                 entry.get("version", "1.0"), entry.get("status", "active"),
                 entry.get("registered_at", entry.get("updated_at")), entry.get("updated_at")),
            )
            self._conn.commit()

    def list(self, status: str | None = None) -> list[dict[str, Any]]:
        with self._lock:
            if status:
                rows = self._conn.execute(
                    "SELECT * FROM factor_catalog WHERE status = ? ORDER BY factor_key",
                    (status,)).fetchall()
            else:
                rows = self._conn.execute(
                    "SELECT * FROM factor_catalog ORDER BY factor_key").fetchall()
        out = []
        for r in rows:
            d = dict(r)
            try:
                d["params"] = json.loads(d.get("params_json") or "{}")
            except (json.JSONDecodeError, TypeError):
                d["params"] = {}
            out.append(d)
        return out

    def get(self, factor_key: str) -> Optional[dict[str, Any]]:
        for e in self.list():
            if e["factor_key"] == factor_key:
                return e
        return None

    def set_status(self, factor_key: str, status: str) -> bool:
        if status not in ("active", "inactive"):
            return False
        with self._lock:
            cur = self._conn.execute(
                "SELECT 1 FROM factor_catalog WHERE factor_key = ?", (factor_key,)).fetchone()
            if cur is None:
                return False
            self._conn.execute(
                "UPDATE factor_catalog SET status = ?, updated_at = ? WHERE factor_key = ?",
                (status, _now(), factor_key))
            self._conn.commit()
        return True

    def active_keys(self) -> list[str]:
        return [e["factor_key"] for e in self.list(status="active")]


def _now() -> int:
    import time
    return int(time.time() * 1000)


# ── 登记合格因子（FF-3.1：挖掘产出 → catalog 候选） ─────────

def register_qualified(job_id: str, results: list[dict[str, Any]],
                       spec: Optional["JobSpec"] = None) -> int:
    """把挖掘任务中 passed 的因子登记进 catalog（inactive，待自动激活）。

    返回新登记数。同 key 已存在时仅刷新元数据（不重置 status）。
    DSL 因子（FF-5，dsl_ 前缀）登记时从注册表带出完整公式到 params，可追溯可复算。
    spec 可选：登记评估环境（asset_pool/horizon）到 params，供衰退淘汰（FF-4.4）
    用因子原市场标的重新评估，避免跨市场误停用。
    """
    from app.factorengine.job import JobSpec  # noqa: F401（类型注解）

    store = get_catalog()
    registered = 0
    now = _now()
    eval_env: dict[str, Any] = {}
    if spec is not None:
        eval_env = {"asset_pool": list(getattr(spec.preferences, "asset_pool", None) or []),
                    "horizon": getattr(spec.preferences, "horizon", 1)}
    for r in results:
        if not r.get("passed"):
            continue
        key = r["factor_key"]
        existing = store.get(key)
        fd = _registry_def(key)
        params: dict[str, Any] = {}
        if fd is not None and getattr(fd, "template", None):
            # 模板实例参数（如 mom_10_30 → {"f":10,"s":30}），供复算/进特征
            params = dict(getattr(fd, "params", {}) or {})
        if key.startswith("dsl_") and fd is not None:
            # FF-5：持久化完整公式（name 现在存完整公式），跨进程重注册可复算
            formula = (getattr(fd, "name", "") or "")
            if formula.startswith("dsl "):
                formula = formula[4:]
            params["formula"] = formula
        if eval_env:
            # 评估环境（asset_pool/horizon）：衰退淘汰用原市场标的重新评估
            params.update(eval_env)
        entry = {
            "factor_key": key,
            "name": fd.name if fd else f"factor {key}",
            "category": fd.category if fd else _category_of(key),
            "template": getattr(fd, "template", None),
            "params": params,
            "description": f"auto-mined by job {job_id} (IC={r.get('ic')}, ICIR={r.get('icir')})",
            "source": "factor_miner",
            "version": "1.0",
            "status": "inactive" if existing is None else existing.get("status", "inactive"),
            "registered_at": now,
            "updated_at": now,
        }
        if existing is None:
            registered += 1
        store.upsert(entry)
    return registered


def auto_activate(job_id: str, results: list[dict[str, Any]]) -> int:
    """自动闭环（FF-4.3）：任务 passed 因子登记后直接激活（status → active），
    使其进入 /factors/current 查询名单与模型特征集合。返回激活数（幂等）。"""
    store = get_catalog()
    n = 0
    for r in results:
        if not r.get("passed"):
            continue
        if store.set_status(r["factor_key"], "active"):
            n += 1
    if n:
        logger.info("factor miner auto-activated %d factor(s) from job %s", n, job_id)
    return n


def health_check_active() -> int:
    """衰退淘汰（FF-4.4）：对 catalog 所有 active 因子用各自登记的评估环境
    （asset_pool/horizon）重新评估 IC/ICIR（最新 K 线），低于停用阈值
    （FACTOR_MINER_DEACTIVATE_IC / _ICIR）自动停用（inactive + 记录原因）。

    返回停用数。挖掘任务 COMPLETED 后调用（jobs 钩子）。未登记评估环境
    （旧数据/动态标的池）的因子跳过，不误停用。
    """
    import pandas as pd

    from app.factorengine.eval import evaluate_factor
    from app.factorengine.factors import compute_factor
    from app.factorengine.runner import _kline_df

    store = get_catalog()
    active = [e for e in store.list() if e["status"] == "active"]
    if not active:
        return 0
    deactivated = 0
    for e in active:
        key = e["factor_key"]
        params = e.get("params") or {}
        pool = params.get("asset_pool") or []
        if not pool:
            continue  # 未登记评估环境 → 跳过（不误停用）
        horizon = int(params.get("horizon") or 1)
        parts = []
        for sym in pool:
            df = _kline_df(sym, "1d")
            if df is None or len(df) <= 120:
                continue
            f = compute_factor(key, df)
            if f is None:
                continue
            close = df["close"].astype(float)
            future_ret = close.shift(-horizon) / close - 1.0
            panel = pd.concat([f.rename("f"), future_ret.rename("r")], axis=1).dropna()
            if len(panel) >= 30:
                parts.append(panel)
        if not parts:
            continue
        allp = pd.concat(parts)
        if len(allp) < 30:
            continue
        ev = evaluate_factor(key, allp["f"], allp["r"])
        decayed = (ev.ic is None or abs(ev.ic or 0) < config.FACTOR_MINER_DEACTIVATE_IC
                   or ev.icir is None
                   or abs(ev.icir or 0) < config.FACTOR_MINER_DEACTIVATE_ICIR)
        if not decayed:
            continue
        store.set_status(key, "inactive")
        cur = store.get(key) or e
        cur["description"] = (f"{cur.get('description') or ''} "
                              f"[FF-4.4 decayed: |IC|={abs(ev.ic or 0):.4f} "
                              f"|ICIR|={abs(ev.icir or 0):.4f} deactivated]").strip()
        cur["updated_at"] = _now()
        store.upsert(cur)
        logger.info("factor decayed deactivated: %s |IC|=%.4f |ICIR|=%.4f",
                    key, abs(ev.ic or 0), abs(ev.icir or 0))
        deactivated += 1
    if deactivated:
        logger.info("factor miner decay deactivation: %d factor(s) deactivated", deactivated)
    return deactivated


def ensure_dsl_registered() -> int:
    """服务启动时恢复 catalog 中 DSL 因子的运行时注册（FF-5：进程重启后
    FACTOR_REGISTRY 为空，需按持久化的公式重注册，特征计算/复算才可用）。
    返回恢复数；公式缺失/非法跳过（日志告警）。"""
    from app.factorengine.factors import register_dsl_factor

    n = 0
    try:
        for e in get_catalog().list():
            if not e["factor_key"].startswith("dsl_"):
                continue
            formula = (e.get("params") or {}).get("formula") or ""
            if not formula:
                logger.warning("ensure_dsl_registered: %s 缺公式，无法恢复", e["factor_key"])
                continue
            try:
                register_dsl_factor(formula)
                n += 1
            except Exception as exc:
                logger.warning("ensure_dsl_registered skip %s: %s", e["factor_key"], exc)
    except Exception as exc:
        logger.warning("ensure_dsl_registered failed: %s", exc)
    if n:
        logger.info("factor catalog: restored %d DSL factor(s)", n)
    return n


def _registry_def(key: str):
    """因子注册表定义（DSL 因子 name 含公式；内置因子带类别）。"""
    try:
        from app.factorengine.factors import FACTOR_REGISTRY

        return FACTOR_REGISTRY.get(key)
    except Exception:
        return None


def _category_of(key: str) -> str:
    from app.factorengine.pool import expand_factor_pool

    for c in expand_factor_pool():
        if c.key == key:
            return c.category
    return "L0"


_catalog: Optional[CatalogStore] = None
_catalog_lock = threading.Lock()


def get_catalog() -> CatalogStore:
    global _catalog
    if _catalog is None:
        with _catalog_lock:
            if _catalog is None:
                _catalog = CatalogStore()
    return _catalog
