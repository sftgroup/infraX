import crypto from 'crypto';
import { DEFAULTS } from '../config/defaults.js';

/** Generate a random 32-byte hex nonce with expiry from shared config */
export function generateNonce(): { nonce: string; expiresAt: number } {
  const nonce = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + DEFAULTS.NONCE_TTL_MS;
  return { nonce, expiresAt };
}
