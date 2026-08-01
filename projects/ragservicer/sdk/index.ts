/**
 * InfraX RAGservicer Client SDK
 *
 * Usage:
 *   import { RagServicerClient } from './projects/ragservicer/sdk';
 *
 *   const rs = new RagServicerClient({
 *     baseUrl: 'http://localhost:9721',
 *     apiKey: 'rs_xxxx',
 *   });
 *
 *   await rs.insert('my-project', 'Hello world', 'doc-1');
 *   const result = await rs.query('my-project', 'What is the greeting?');
 */
import type {
  RagServicerConfig,
  InsertResult,
  QueryResult,
  RetrieveResult,
  DocumentInfo,
  TenantInfo,
  ApiKeyInfo,
  DocConfig,
  LightRAGConfig,
} from './types';
import { RagServicerError, DocError, LightRAGError } from './types';

export type {
  RagServicerConfig,
  InsertResult,
  QueryResult,
  RetrieveResult,
  DocumentInfo,
  TenantInfo,
  ApiKeyInfo,
  DocConfig,
  LightRAGConfig,
};
export { RagServicerError, DocError, LightRAGError };

export class RagServicerClient {
  private baseUrl: string;
  private headers: Record<string, string>;
  private timeout: number;

  constructor(config: RagServicerConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
    this.timeout = config.timeout || 120000;
    this.headers = { 'Content-Type': 'application/json' };

    if (config.apiKey) {
      this.headers['Authorization'] = `Bearer ${config.apiKey}`;
    }
    if (config.tenantId) {
      this.headers['X-Tenant-ID'] = config.tenantId;
    }
  }

  // ── HTTP ──────────────────────────────────────────

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        ...options,
        headers: { ...this.headers, ...options.headers },
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new RagServicerError(
          res.status,
          body.code || 'UNKNOWN',
          body.error || `HTTP ${res.status}`
        );
      }

      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  // ── Documents ─────────────────────────────────────

  async insert(namespace: string, text: string, docId: string): Promise<InsertResult> {
    return this.request(`/api/v1/namespaces/${namespace}/documents`, {
      method: 'POST',
      body: JSON.stringify({ text, doc_id: docId }),
    });
  }

  async insertBatch(
    namespace: string,
    documents: Array<{ text: string; doc_id: string }>
  ): Promise<{ success: boolean; count: number }> {
    return this.request(`/api/v1/namespaces/${namespace}/documents/batch`, {
      method: 'POST',
      body: JSON.stringify({ documents }),
    });
  }

  async delete(namespace: string, docId: string): Promise<{ success: boolean; doc_id: string }> {
    return this.request(
      `/api/v1/namespaces/${namespace}/documents/${encodeURIComponent(docId)}`,
      { method: 'DELETE' }
    );
  }

  async listDocuments(
    namespace: string,
    page: number = 1,
    limit: number = 20
  ): Promise<{ namespace: string; documents: DocumentInfo[]; total: number }> {
    return this.request(
      `/api/v1/namespaces/${namespace}/documents?page=${page}&limit=${limit}`
    );
  }

  // ── Query ─────────────────────────────────────────

  async query(namespace: string, query: string, mode: string = 'mix'): Promise<QueryResult> {
    return this.request(`/api/v1/namespaces/${namespace}/query`, {
      method: 'POST',
      body: JSON.stringify({ query, mode }),
    });
  }

  async retrieve(
    namespace: string,
    query: string,
    mode: string = 'mix',
    topK: number = 5
  ): Promise<RetrieveResult> {
    return this.request(`/api/v1/namespaces/${namespace}/retrieve`, {
      method: 'POST',
      body: JSON.stringify({ query, mode, top_k: topK }),
    });
  }

  // ── Admin: Tenants ────────────────────────────────

  async createTenant(tenantId: string, name: string, description?: string): Promise<TenantInfo> {
    return this.request('/api/v1/tenants', {
      method: 'POST',
      body: JSON.stringify({ tenant_id: tenantId, name, description }),
    });
  }

  async listTenants(): Promise<{ tenants: TenantInfo[] }> {
    return this.request('/api/v1/tenants');
  }

  async deleteTenant(tenantId: string): Promise<{ success: boolean }> {
    return this.request(`/api/v1/tenants/${tenantId}`, { method: 'DELETE' });
  }

  // ── Admin: API Keys ──────────────────────────────

  async generateApiKey(
    tenantId: string,
    name: string,
    expiresDays?: number
  ): Promise<ApiKeyInfo> {
    return this.request(`/api/v1/tenants/${tenantId}/keys`, {
      method: 'POST',
      body: JSON.stringify({ name, expires_days: expiresDays || 0 }),
    });
  }

  async listApiKeys(tenantId: string): Promise<{ keys: ApiKeyInfo[] }> {
    return this.request(`/api/v1/tenants/${tenantId}/keys`);
  }

  async revokeApiKey(keyId: string): Promise<{ success: boolean }> {
    return this.request(`/api/v1/keys/${keyId}/revoke`, { method: 'POST' });
  }

  // ── Health ────────────────────────────────────────

  async health(): Promise<{ status: string; instances: number }> {
    return this.request('/api/v1/health');
  }
}

/** @deprecated Use RagServicerClient instead */
export const DocClient = RagServicerClient;
/** @deprecated Use RagServicerClient instead */
export const LightRAGClient = RagServicerClient;
