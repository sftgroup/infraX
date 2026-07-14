import crypto from 'crypto';
import { config } from '../config';
import { Errors } from '../utils/errors';

/**
 * AES-256-GCM encryption/decryption for private keys
 * Mirrors CWallet's backend/app/utils/encryption.py
 *
 * CWallet uses: key=bytes.fromhex(ENCRYPTION_KEY), AESGCM(nonce=12, ciphertext)
 * We implemented: key=sha256(encryption_key), aes-256-gcm(nonce=12, auth_tag=16)
 */

const ALGORITHM = 'aes-256-gcm';
const NONCE_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32; // 256 bits

function getEncryptionKey(): Buffer {
  const keyHex = config.walletEncryptionKey;
  if (!keyHex) {
    // Dev mode: derive from service secret
    return crypto.createHash('sha256').update(process.env.ENCRYPTION_KEY || 'infrax-ev-encryption-key').digest();
  }
  try {
    return Buffer.from(keyHex, 'hex');
  } catch {
    throw Errors.internal('Invalid WALLET_ENCRYPTION_KEY — must be 64 hex chars (32 bytes)');
  }
}

/**
 * Encrypt a private key hex string
 * Returns: hex(nonce + ciphertext + auth_tag) — same format as CWallet's nonce + ciphertext
 */
export function encryptPrivateKey(privateKeyHex: string): string {
  const key = getEncryptionKey();
  const nonce = crypto.randomBytes(NONCE_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, nonce, { authTagLength: AUTH_TAG_LENGTH });

  const plaintext = Buffer.from(privateKeyHex, 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // nonce(12) + ciphertext(variable) + authTag(16)
  return Buffer.concat([nonce, ciphertext, authTag]).toString('hex');
}

/**
 * Decrypt an encrypted private key hex string
 */
export function decryptPrivateKey(encryptedHex: string): string {
  const key = getEncryptionKey();
  const data = Buffer.from(encryptedHex, 'hex');

  const nonce = data.subarray(0, NONCE_LENGTH);
  const authTag = data.subarray(data.length - AUTH_TAG_LENGTH);
  const ciphertext = data.subarray(NONCE_LENGTH, data.length - AUTH_TAG_LENGTH);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, nonce, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);

  try {
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString('utf8');
  } catch {
    throw Errors.internal('Private key decryption failed — key may have been tampered');
  }
}
