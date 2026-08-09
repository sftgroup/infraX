/**
 * @0xinfrax/mpc-sdk — 最小 HttpClient
 *
 * 零依赖（Node 18+ 原生 fetch + AbortController）。出站统一携带 `X-API-Key` 头
 * （服务端鉴权契约：Bearer / X-API-Key / X-Service-Key 三选一，本 SDK 选 X-API-Key）。
 * 响应信封 `{ code, message, data }`；非 2xx 或信封 code!=0 时抛 MpcApiError。
 */
import { MpcApiError, MpcNetworkError } from './errors';
import type { MpcApiResponse } from './types';

const DEFAULT_BASE_URL = 'http://127.0.0.1:9104';
const DEFAULT_TIMEOUT_MS = 30_000;

export class HttpClient {
  private baseUrl: string;
  private apiKey: string;
  private timeoutMs: number;

  constructor(opts: { baseUrl?: string; apiKey?: string; timeout?: number }) {
    this.baseUrl = (opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.apiKey = opts.apiKey || '';
    this.timeoutMs = opts.timeout || DEFAULT_TIMEOUT_MS;
  }

  setApiKey(key: string): void {
    this.apiKey = key;
  }

  get base(): string {
    return this.baseUrl;
  }

  async get<T>(path: string, query?: Record<string, string | undefined>): Promise<MpcApiResponse<T>> {
    const qs = query ? buildQuery(query) : '';
    return this.request<T>('GET', path + qs);
  }

  async post<T>(path: string, body?: unknown): Promise<MpcApiResponse<T>> {
    return this.request<T>('POST', path, body);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<MpcApiResponse<T>> {
    let res: Response;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        res = await fetch(this.baseUrl + path, {
          method,
          headers: {
            'Content-Type': 'application/json',
            ...(this.apiKey ? { 'X-API-Key': this.apiKey } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } catch (e: any) {
      throw new MpcNetworkError(`Network error calling ${method} ${path}: ${e?.message || String(e)}`, e);
    }

    let payload: MpcApiResponse<T>;
    try {
      payload = (await res.json()) as MpcApiResponse<T>;
    } catch {
      // 非 JSON 响应（网关错误页等）
      throw new MpcNetworkError(`Unexpected non-JSON response (HTTP ${res.status}) from ${method} ${path}`);
    }

    if (!res.ok || payload.code !== 0) {
      throw new MpcApiError(
        res.status,
        payload.code ?? res.status,
        payload.message || `HTTP ${res.status}`,
        payload
      );
    }
    return payload;
  }
}

function buildQuery(params: Record<string, string | undefined>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') usp.set(k, v);
  }
  const s = usp.toString();
  return s ? '?' + s : '';
}
