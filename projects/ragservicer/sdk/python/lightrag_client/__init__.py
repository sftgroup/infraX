"""
InfraX RAGservicer Python SDK

Usage:
    from lightrag_client import LightRAGClient

    rs = LightRAGClient(base_url="http://localhost:9721", api_key="lr_xxx")
    rs.insert("market", "Hello world", "doc-1")
    result = rs.query("market", "What is the greeting?")

Mirrors the TypeScript SDK (projects/ragservicer/sdk) and talks to the
InfraX-standard envelope: { "code": 0, "message": "ok", "data": {...} }.
"""
from __future__ import annotations

import urllib.parse
from typing import Any, Optional

import requests


class LightRAGClientError(Exception):
    """Raised on API-level failures (non-zero code or HTTP error)."""

    def __init__(self, status: int, code: str, message: str):
        self.status = status
        self.code = code
        self.message = message
        super().__init__(f"[{status}] {code}: {message}")


class LightRAGClient:
    def __init__(
        self,
        base_url: str,
        api_key: Optional[str] = None,
        tenant_id: Optional[str] = None,
        timeout: int = 120,
    ):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.headers = {"Content-Type": "application/json"}
        if api_key:
            self.headers["Authorization"] = f"Bearer {api_key}"
        if tenant_id:
            self.headers["X-Tenant-ID"] = tenant_id

    # ── HTTP ──────────────────────────────────────────

    def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        url = f"{self.base_url}{path}"
        try:
            resp = requests.request(
                method, url, timeout=self.timeout,
                headers=self.headers, **kwargs,
            )
        except requests.RequestException as exc:
            raise LightRAGClientError(0, "CONNECTION_ERROR", str(exc)) from exc

        try:
            body = resp.json()
        except ValueError:
            body = {}

        if not resp.ok:
            raise LightRAGClientError(
                resp.status_code,
                (body or {}).get("code", "UNKNOWN"),
                (body or {}).get("message") or f"HTTP {resp.status_code}",
            )
        if isinstance(body, dict) and body.get("code") == 0 and "data" in body:
            return body["data"]
        return body

    def _post(self, path: str, payload: Optional[dict] = None) -> Any:
        return self._request("POST", path, json=payload or {})

    # ── Documents ─────────────────────────────────────

    def insert(self, namespace: str, text: str, doc_id: str) -> dict:
        """Insert a single document (sync; blocks until pipeline completes).

        Returns {doc_id, tenant, namespace, deduplicated, status}.
        When deduplicated is True (content was dropped by LightRAG dedup),
        the result also carries dedup_reason and matched_doc_id.
        """
        return self._post(
            f"/api/v1/namespaces/{namespace}/documents",
            {"text": text, "doc_id": doc_id, "async": False},
        )

    def insert_batch(
        self, namespace: str, documents: list[dict]
    ) -> dict:
        """Insert multiple documents (sync; per-doc execution).

        Each item: {text, doc_id}. Returns {count, results: [...]} where
        results contains per-doc disposition (indexed / duplicate / error).
        """
        return self._post(
            f"/api/v1/namespaces/{namespace}/documents/batch",
            {"documents": documents, "async": False},
        )

    def delete(self, namespace: str, doc_id: str) -> dict:
        return self._request(
            "DELETE",
            f"/api/v1/namespaces/{namespace}/documents/{urllib.parse.quote(doc_id, safe='')}",
        )

    def list_documents(
        self, namespace: str, page: int = 1, limit: int = 20
    ) -> dict:
        """List documents in a namespace (paginated).

        Returns {namespace, tenant, documents, total, page, limit}. Each
        document carries its real status (indexed / indexing / error /
        duplicate) — deduplicated entries also expose dedup_reason and
        matched_doc_id.
        """
        return self._request(
            "GET",
            f"/api/v1/namespaces/{namespace}/documents?page={page}&limit={limit}",
        )

    # ── Query ─────────────────────────────────────────

    def query(self, namespace: str, query: str, mode: str = "mix") -> dict:
        """Query for relevant context (no LLM answer generation)."""
        return self._post(
            f"/api/v1/namespaces/{namespace}/query",
            {"query": query, "mode": mode},
        )

    def retrieve(
        self, namespace: str, query: str, mode: str = "mix", top_k: int = 5
    ) -> dict:
        """Context-only retrieval with configurable top_k."""
        return self._post(
            f"/api/v1/namespaces/{namespace}/retrieve",
            {"query": query, "mode": mode, "top_k": top_k},
        )

    # ── Admin: Tenants ────────────────────────────────

    def create_tenant(
        self, tenant_id: str, name: str, description: str = ""
    ) -> dict:
        return self._post(
            "/api/v1/tenants",
            {"tenant_id": tenant_id, "name": name, "description": description},
        )

    def list_tenants(self) -> dict:
        return self._request("GET", "/api/v1/tenants")

    def delete_tenant(self, tenant_id: str) -> dict:
        return self._request("DELETE", f"/api/v1/tenants/{tenant_id}")

    # ── Admin: API Keys ───────────────────────────────

    def generate_api_key(
        self, tenant_id: str, name: str, expires_days: int = 0
    ) -> dict:
        return self._post(
            f"/api/v1/tenants/{tenant_id}/keys",
            {"name": name, "expires_days": expires_days},
        )

    def list_api_keys(self, tenant_id: str) -> dict:
        return self._request("GET", f"/api/v1/tenants/{tenant_id}/keys")

    def revoke_api_key(self, key_id: str) -> dict:
        return self._post(f"/api/v1/keys/{key_id}/revoke")

    # ── Admin: Runtime Config (LLM / Embedding) ───────

    def get_config(self) -> dict:
        """Return current LLM/embedding config (secrets masked)."""
        return self._request("GET", "/api/v1/admin/config")

    def update_config(self, llm: Optional[dict] = None, embedding: Optional[dict] = None) -> dict:
        """Hot-update LLM/embedding config without restarting the service.
        Pass masked/placeholder values (e.g. "********") to keep a secret.
        Example:
            update_config(llm={"api_key": "sk-new", "model": "deepseek-chat"},
                          embedding={"api_key": "sk-dash-new"})
        """
        payload: dict[str, Any] = {}
        if llm:
            payload["llm"] = llm
        if embedding:
            payload["embedding"] = embedding
        return self._request("PUT", "/api/v1/admin/config", json=payload)

    # ── Instances & Tasks（2026-08-12 补封装）──────────

    def list_instances(self) -> dict:
        """List active RAG instances (needs admin key)."""
        return self._request("GET", "/api/v1/instances")

    def get_task(self, namespace: str, task_id: str) -> dict:
        """Poll ingestion task status by task_id."""
        return self._request(
            "GET",
            f"/api/v1/namespaces/{namespace}/tasks/{urllib.parse.quote(task_id, safe='')}",
        )

    # ── Health ────────────────────────────────────────

    def health(self) -> dict:
        return self._request("GET", "/api/v1/health")
