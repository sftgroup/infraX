import crypto from 'crypto';

/** Generate a random 32-byte hex nonce with 15-minute expiry */
export function generateNonce(): { nonce: string; expiresAt: number } {
  const nonce = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + 15 * 60 * 1000; // 15 min
  return { nonce, expiresAt };
}
