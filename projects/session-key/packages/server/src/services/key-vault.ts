import { EnvKeyVault } from '@0xinfrax/session-key-core';
import type { IKeyVault } from '@0xinfrax/session-key-core';

/**
 * AX-12/SK-4: HTTP 外部密钥托管适配器（可选接缝的现成实现）。
 *
 * 把「加密/解密」转发给任意外部密钥服务（如 AWS/GCP KMS 代理、HashiCorp
 * Vault transit、自建密钥网关），让会话私钥**不落明文 env**。协议约定：
 *
 *   POST {baseUrl}/vault/encrypt  body { "plaintext": string }  → { "ciphertext": string }
 *   POST {baseUrl}/vault/decrypt  body { "ciphertext": string } → { "plaintext": string }
 *
 * 可带 Bearer token（KEY_VAULT_TOKEN）。集成方也可直接实现 IKeyVault 注入，
 * 不依赖本 HTTP 约定。
 */
export class HttpKeyVault implements IKeyVault {
  constructor(
    private baseUrl: string,
    private token?: string,
  ) {}

  private async call(action: 'encrypt' | 'decrypt', input: string): Promise<string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/vault/${action}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ [action === 'encrypt' ? 'plaintext' : 'ciphertext']: input }),
    });
    if (!res.ok) throw new Error(`Key vault ${action} failed: HTTP ${res.status}`);
    const json = await res.json() as { ciphertext?: string; plaintext?: string };
    const out = action === 'encrypt' ? json.ciphertext : json.plaintext;
    if (!out) throw new Error(`Key vault ${action} returned no value`);
    return out;
  }

  async encrypt(plaintext: string): Promise<string> {
    return this.call('encrypt', plaintext);
  }

  async decrypt(ciphertext: string): Promise<string> {
    return this.call('decrypt', ciphertext);
  }
}

/** 按配置构建密钥托管：KEY_VAULT_TYPE=env（默认）| http。 */
export function buildKeyVault(config: { type: 'env' | 'http'; url?: string; token?: string }): IKeyVault {
  if (config.type === 'http') {
    if (!config.url) throw new Error('KEY_VAULT_TYPE=http requires KEY_VAULT_URL');
    return new HttpKeyVault(config.url, config.token);
  }
  return new EnvKeyVault();
}
