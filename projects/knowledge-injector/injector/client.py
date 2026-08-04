"""InfraX RAGservicer HTTP 客户端。

线程安全，fail-silent。
所有异常在方法内部消化，不抛到上层。
"""
from __future__ import annotations

import logging
import time

import requests

from config import SETTINGS

logger = logging.getLogger(__name__)

_INJECT_TIMEOUT = 30  # 提交注入请求的超时（写入已异步化，提交即返回）
_QUERY_TIMEOUT = 15
_TASK_POLL_TIMEOUT = 300  # 等待单个注入任务完成的最长时间（秒）
_TASK_POLL_INTERVAL = 3  # 任务状态轮询间隔（秒）


class LightRAGClient:
    """InfraX RAGservicer 客户端（多租户 namespace + X-API-Key 鉴权）。

    用法:
        client = LightRAGClient()
        client.inject("some text", doc_id="macro:daily")
        client.query("BTC price action")
    """

    def __init__(self, base_url: str | None = None):
        self._base_url = (base_url or SETTINGS.lightrag_url).rstrip("/")
        self._enabled = bool(self._base_url)
        if not self._enabled:
            logger.warning(
                "RAGservicer disabled — set RAGSERVICER_URL env var. "
                "All inject/query calls will be no-ops."
            )

    # ─── headers ────────────────────────────────────

    def _headers(self) -> dict:
        h = {"Content-Type": "application/json"}
        if SETTINGS.ragservicer_api_key:
            h["X-API-Key"] = SETTINGS.ragservicer_api_key
        return h

    # ─── inject ───────────────────────────────────────

    def inject(
        self,
        text: str,
        doc_id: str | None = None,
        namespace: str | None = None,
    ) -> bool:
        """注入文本到 RAGservicer 知识图谱（doc_id 幂等去重）。

        读写分离：提交 `async: true`，RAGservicer 立即返回 202 + task_id，
        然后轮询任务状态直至成功/失败/超时。返回 True 表示注入成功。
        失败则静默返回 False，不抛异常。
        """
        if not self._enabled:
            return False
        if not text:
            logger.warning("RAGservicer inject skipped: empty text (ns=%s)", namespace)
            return False
        ns = namespace or SETTINGS.default_namespace
        resolved_doc_id = doc_id or "injector:default"
        try:
            payload: dict = {
                "text": text,
                "doc_id": resolved_doc_id,
                "async": True,
            }
            resp = requests.post(
                f"{self._base_url}/api/v1/namespaces/{ns}/documents",
                json=payload,
                headers=self._headers(),
                timeout=_INJECT_TIMEOUT,
            )
            # 202 = 已入队，轮询任务状态
            if resp.status_code == 202:
                data = resp.json().get("data") or {}
                task_id = data.get("task_id")
                if task_id:
                    return self._poll_task(ns, task_id)
                logger.warning("RAGservicer inject 202 without task_id ns=%s", ns)
                return False

            # 非异步路径（旧版 ragservicer / 显式同步）：2xx=success, 409=already exists
            ok = resp.status_code < 300 or resp.status_code == 409
            if ok:
                logger.debug(
                    "RAGservicer inject ok ns=%s doc_id=%s status=%d",
                    ns, resolved_doc_id, resp.status_code,
                )
            else:
                logger.warning(
                    "RAGservicer inject failed ns=%s doc_id=%s status=%d body=%s",
                    ns, resolved_doc_id, resp.status_code, resp.text[:200],
                )
            return ok
        except requests.Timeout:
            logger.warning(
                "RAGservicer inject timeout (%ss) ns=%s doc_id=%s",
                _INJECT_TIMEOUT, ns, resolved_doc_id,
            )
            return False
        except requests.ConnectionError:
            logger.warning("RAGservicer unreachable: %s", self._base_url)
            return False
        except Exception as exc:
            logger.warning("RAGservicer inject failed ns=%s doc_id=%s: %s", ns, resolved_doc_id, exc)
            return False

    # ─── task polling ──────────────────────────────────

    def _poll_task(self, ns: str, task_id: str) -> bool:
        """轮询写任务直到 success/failed/超时。"""
        url = f"{self._base_url}/api/v1/namespaces/{ns}/tasks/{task_id}"
        deadline = time.time() + _TASK_POLL_TIMEOUT
        while time.time() < deadline:
            try:
                resp = requests.get(url, headers=self._headers(), timeout=15)
            except requests.RequestException as exc:
                logger.warning("RAGservicer task poll failed task_id=%s: %s", task_id, exc)
                time.sleep(_TASK_POLL_INTERVAL)
                continue

            if resp.status_code != 200:
                time.sleep(_TASK_POLL_INTERVAL)
                continue

            data = (resp.json().get("data") or {})
            status = data.get("status")
            if status == "success":
                logger.debug("RAGservicer inject task done task_id=%s", task_id)
                return True
            if status == "failed":
                logger.warning(
                    "RAGservicer inject task failed task_id=%s error=%s",
                    task_id, data.get("error"),
                )
                return False
            time.sleep(_TASK_POLL_INTERVAL)

        logger.warning(
            "RAGservicer inject task timeout (%ss) task_id=%s ns=%s",
            _TASK_POLL_TIMEOUT, task_id, ns,
        )
        return False

    # ─── query ────────────────────────────────────────

    def query(
        self,
        query_text: str,
        top_k: int = 5,
        mode: str = "hybrid",
        namespace: str | None = None,
    ) -> list[dict]:
        """查询 RAGservicer 知识图谱。

        失败返回空列表。
        """
        if not self._enabled:
            return []
        ns = namespace or SETTINGS.default_namespace
        try:
            resp = requests.post(
                f"{self._base_url}/api/v1/namespaces/{ns}/query",
                json={
                    "query": query_text,
                    "mode": mode,
                },
                headers=self._headers(),
                timeout=_QUERY_TIMEOUT,
            )
            if resp.status_code == 200:
                body = resp.json()
                data = body.get("data", [])
                logger.debug("RAGservicer query ok ns=%s results=%d", ns, len(data))
                return data
            logger.warning("RAGservicer query failed ns=%s status=%d body=%s", ns, resp.status_code, resp.text[:200])
            return []
        except requests.Timeout:
            logger.warning("RAGservicer query timeout (%ss) ns=%s", _QUERY_TIMEOUT, ns)
            return []
        except requests.ConnectionError:
            logger.warning("RAGservicer unreachable: %s", self._base_url)
            return []
        except Exception as exc:
            logger.warning("RAGservicer query failed ns=%s: %s", ns, exc)
            return []
