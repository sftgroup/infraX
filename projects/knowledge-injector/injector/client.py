"""InfraX RAGservicer HTTP 客户端。

线程安全，fail-silent。
所有异常在方法内部消化，不抛到上层。
"""
from __future__ import annotations

import logging

import requests

from config import SETTINGS

logger = logging.getLogger(__name__)

_INJECT_TIMEOUT = 30  # RAGservicer 内部调用 LLM 做实体提取
_QUERY_TIMEOUT = 15


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

        返回 True 表示注入成功。
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
            }
            resp = requests.post(
                f"{self._base_url}/api/v1/namespaces/{ns}/documents",
                json=payload,
                headers=self._headers(),
                timeout=_INJECT_TIMEOUT,
            )
            # 2xx=success, 409=already exists (skip)
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
