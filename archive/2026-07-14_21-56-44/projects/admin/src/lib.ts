export const BASE = (import.meta as any).env?.VITE_API_BASE || '/api/v2';

export async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(init?.headers as any) };
  const res = await fetch(`${BASE}${path}`, { ...init, headers, credentials: 'same-origin' });
  if (res.status === 401) { window.location.href = '/admin/login'; throw new Error('auth'); }
  if (!res.ok) { const err = await res.json().catch(()=>({message:'Request failed'})); throw new Error(err.message || `HTTP ${res.status}`); }
  const json = await res.json();
  return json?.data ?? json;
}

// Convenience methods
export async function apiGet<T = any>(path: string): Promise<T> { return api<T>(path); }
export async function apiPost<T = any>(path: string, body?: any): Promise<T> { return api<T>(path, { method: 'POST', body: JSON.stringify(body) }); }
export async function apiPut<T = any>(path: string, body?: any): Promise<T> { return api<T>(path, { method: 'PUT', body: JSON.stringify(body) }); }
export async function apiDelete<T = any>(path: string): Promise<T> { return api<T>(path, { method: 'DELETE' }); }
