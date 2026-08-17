import type {
  Chain, PermissionConfig, CreateSessionRequest,
  ExecuteRequest, ExecuteResult, NonceData, SessionKey,
} from '@0xinfrax/session-key-core';

export interface ClientConfig {
  baseUrl: string;
  apiKey?: string;
}

export interface ApiResponse<T = any> {
  code: number;
  message: string;
  data: T;
}

/**
 * Session Key Engine REST API client.
 *
 * Usage:
 *   const sk = new SessionKeyClient({ baseUrl: 'http://localhost:3500', apiKey: 'xxx' });
 *   const { nonce, message } = await sk.getNonce('0xUserAddress');
 *   const session = await sk.createSession({ ... });
 *   const result = await sk.execute({ sessionId, chain: 'eth', to, data });
 */
export class SessionKeyClient {
  constructor(private config: ClientConfig) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.apiKey) h['Authorization'] = `Bearer ${this.config.apiKey}`;
    return h;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<ApiResponse<T>> {
    const res = await fetch(`${this.config.baseUrl}${path}`, {
      method,
      headers: this.headers(),
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.message || `HTTP ${res.status}`);
    return json;
  }

  /** Get a one-time nonce for EIP-712 session auth signature */
  async getNonce(userAddress: string): Promise<NonceData> {
    const res = await this.request<NonceData>('GET', `/api/v1/nonce?user=${encodeURIComponent(userAddress)}`);
    return res.data;
  }

  /** Create a new session key (requires EIP-712 signature) */
  async createSession(params: {
    signature: string;
    chain: Chain;
    permissions: PermissionConfig;
    validDays?: number;
    maxPerTx?: string;
    maxTotal?: string;
    userAddress: string;
    nonce: string;
    /** A-16：session key 由客户端生成并提交（EIP-712 签名消息含 sessionAddress，服务端随机生成会死锁） */
    sessionPublicKey: string;
    sessionPrivateKey: string;
    /** EIP-712 签名时使用的 validUntil（unix 秒）；需与 buildSessionAuthMessage 中一致。省略则服务端自行计算。 */
    validUntil?: number;
  }): Promise<{ id: string; sessionAddress: string; status: string; validUntil: Date }> {
    const res = await this.request<any>('POST', '/api/v1/sessions', params);
    return res.data;
  }

  /** List all sessions for a user */
  async listSessions(userAddress: string, chain?: Chain, status?: string): Promise<SessionKey[]> {
    const params = new URLSearchParams({ user: userAddress });
    if (chain) params.set('chain', chain);
    if (status) params.set('status', status);
    const res = await this.request<{ sessions: SessionKey[] }>('GET', `/api/v1/sessions?${params.toString()}`);
    return res.data.sessions;
  }

  /** Get a single session by ID */
  async getSession(id: string): Promise<SessionKey> {
    const res = await this.request<SessionKey>('GET', `/api/v1/sessions/${id}`);
    return res.data;
  }

  /** Revoke a session */
  async revokeSession(id: string): Promise<{ revoked: boolean }> {
    const res = await this.request<{ revoked: boolean }>('DELETE', `/api/v1/sessions/${id}`);
    return res.data;
  }

  /** Execute a transaction through a session key */
  async execute(params: ExecuteRequest): Promise<ExecuteResult> {
    const res = await this.request<ExecuteResult>('POST', '/api/v1/execute', params);
    return res.data;
  }

  /** Health check */
  async health(): Promise<{ status: string }> {
    const res = await this.request<{ status: string }>('GET', '/api/v1/health');
    return res.data;
  }
}
