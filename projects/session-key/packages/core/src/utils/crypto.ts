import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/**
 * AES-256-GCM encrypt — returns base64(iv + ciphertext + authTag)
 */
export function encrypt(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, encrypted, authTag]).toString('base64');
}

/**
 * AES-256-GCM decrypt — expects base64(iv + ciphertext + authTag)
 */
export function decrypt(ciphertext: string, key: Buffer): string {
  const buf = Buffer.from(ciphertext, 'base64');
  const iv = buf.subarray(0, IV_LENGTH);
  const authTag = buf.subarray(buf.length - TAG_LENGTH);
  const encrypted = buf.subarray(IV_LENGTH, buf.length - TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return decipher.update(encrypted) + decipher.final('utf8');
}

/** Load 32-byte encryption key from ENCRYPTION_KEY environment variable */
export function loadEncryptionKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) throw new Error('ENCRYPTION_KEY is not set');
  const buf = Buffer.from(key, 'hex');
  if (buf.length !== 32) throw new Error('ENCRYPTION_KEY must be 32 bytes (64 hex chars)');
  return buf;
}
