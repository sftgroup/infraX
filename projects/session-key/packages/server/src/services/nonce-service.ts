import { generateNonce, normalizeAddress } from '@sftgroup/session-key-core';

/** Pure nonce management — no external dependencies */
export class NonceService {
  private store = new Map<string, { nonce: string; expiresAt: number }>();

  get(userId: string): { nonce: string; message: string } {
    const normalized = normalizeAddress(userId);
    const { nonce, expiresAt } = generateNonce();
    this.store.set(normalized, { nonce, expiresAt });

    return {
      nonce,
      message: `Session Key Engine\n\nAuthorise a session key to execute transactions on your behalf.\n\nNonce: ${nonce}`,
    };
  }

  consume(userId: string, nonce: string): void {
    const normalized = normalizeAddress(userId);
    const record = this.store.get(normalized);
    if (!record) throw Object.assign(new Error('Nonce not found or already used'), { statusCode: 400, code: 'NONCE_INVALID' });
    if (Date.now() > record.expiresAt) {
      this.store.delete(normalized);
      throw Object.assign(new Error('Nonce expired'), { statusCode: 400, code: 'NONCE_EXPIRED' });
    }
    if (record.nonce !== nonce) {
      throw Object.assign(new Error('Invalid nonce'), { statusCode: 400, code: 'NONCE_INVALID' });
    }
    this.store.delete(normalized);
  }
}
