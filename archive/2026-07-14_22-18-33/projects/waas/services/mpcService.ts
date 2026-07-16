import { ethers } from 'ethers';
import crypto from 'crypto';
import { pool } from '../models/database';
import { AppError } from '../utils/errors';

const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

function deriveKey(email: string): Buffer {
  const serverSecret = process.env.MPC_ENCRYPTION_SECRET || 'mpc-dev-secret-change-in-production';
  return crypto.pbkdf2Sync(email.toLowerCase() + serverSecret, 'mpc-salt', 100000, 32, 'sha256');
}

function encryptShard(shard: string, email: string): string {
  const key = deriveKey(email);
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  let encrypted = cipher.update(shard, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();
  return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted;
}

function decryptShard(encryptedData: string, email: string): string {
  const key = deriveKey(email);
  const parts = encryptedData.split(':');
  if (parts.length !== 3) throw new AppError('Invalid encrypted shard format', 500, 5000);
  const iv = Buffer.from(parts[0], 'hex');
  const authTag = Buffer.from(parts[1], 'hex');
  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(parts[2], 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// MPC verification codes (session-based, same pattern as auth)
const mpcVerificationCodes = new Map<string, { code: string; expiresAt: number; attempts: number }>();

export function storeMpcVerificationCode(email: string, code: string): void {
  const sanitized = email.trim().toLowerCase();
  const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes
  mpcVerificationCodes.set(sanitized, { code, expiresAt, attempts: 0 });
}

function verifyCode(email: string, code: string): void {
  const sanitized = email.trim().toLowerCase();
  const record = mpcVerificationCodes.get(sanitized);
  if (!record) {
    throw new AppError("No verification code sent for this email", 400, 1005);
  }
  if (Date.now() > record.expiresAt) {
    mpcVerificationCodes.delete(sanitized);
    throw new AppError("Verification code expired (5 minutes)", 400, 1005);
  }
  if (record.attempts >= 5) {
    mpcVerificationCodes.delete(sanitized);
    throw new AppError("Too many attempts. Please request a new code.", 429, 1005);
  }
  record.attempts++;
  if (code !== record.code) {
    throw new AppError("Invalid verification code", 400, 1005);
  }
  // Code verified — remove from store (one-time use)
  mpcVerificationCodes.delete(sanitized);
}


export async function registerWallet(email: string, code: string, connectedWalletAddress?: string) {
  verifyCode(email, code);
  const emailLower = email.toLowerCase();

  const existing = await pool.query(
    'SELECT id FROM mpc_wallets WHERE email = $1',
    [emailLower]
  );
  if (existing.rows.length > 0) {
    throw new AppError('Email already registered. Use recovery to restore your wallet.', 400, 1006);
  }

  const wallet = ethers.Wallet.createRandom();
  const encryptedShard = encryptShard(wallet.privateKey, emailLower);

  const result = await pool.query(
    `INSERT INTO mpc_wallets (email, email_verified, wallet_address, encrypted_shard, shard_count, total_shards, connected_wallet_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, email, wallet_address, created_at`,
    [emailLower, true, wallet.address, encryptedShard, 1, 1, connectedWalletAddress || null]
  );

  const row = result.rows[0];
  return {
    id: row.id,
    email: row.email,
    walletAddress: row.wallet_address,
    createdAt: row.created_at
  };
}

export async function recoverWallet(email: string, code: string) {
  verifyCode(email, code);
  const emailLower = email.toLowerCase();

  const result = await pool.query(
    `SELECT id, email, wallet_address, encrypted_shard, created_at, recovery_count
     FROM mpc_wallets WHERE email = $1 AND status = 'active'`,
    [emailLower]
  );

  if (result.rows.length === 0) {
    throw new AppError('No MPC wallet found for this email. Register first.', 404, 1004);
  }

  const row = result.rows[0];

  let privateKey: string;
  try {
    privateKey = decryptShard(row.encrypted_shard, emailLower);
  } catch (err: any) {
    throw new AppError('Failed to decrypt wallet shard. Data may be corrupted.', 500, 1007);
  }

  await pool.query(
    `UPDATE mpc_wallets SET recovered_at = NOW(), recovery_count = recovery_count + 1 WHERE id = $1`,
    [row.id]
  );

  const recoveredWallet = new ethers.Wallet(privateKey);
  if (recoveredWallet.address.toLowerCase() !== row.wallet_address.toLowerCase()) {
    throw new AppError('Recovered key does not match stored address. Data integrity error.', 500, 1008);
  }

  return {
    email: row.email,
    walletAddress: row.wallet_address,
    recoveredAt: new Date().toISOString(),
    recoveryCount: row.recovery_count + 1
  };
}

export async function getWalletStatus(email: string) {
  const emailLower = email.toLowerCase();
  const result = await pool.query(
    `SELECT id, email, wallet_address, email_verified, shard_count, total_shards,
            created_at, recovered_at, recovery_count, status
     FROM mpc_wallets WHERE email = $1`,
    [emailLower]
  );

  if (result.rows.length === 0) {
    return { registered: false };
  }

  const row = result.rows[0];
  return {
    registered: true,
    email: row.email,
    walletAddress: row.wallet_address,
    emailVerified: row.email_verified,
    shardCount: row.shard_count,
    totalShards: row.total_shards,
    createdAt: row.created_at,
    lastRecoveredAt: row.recovered_at,
    recoveryCount: row.recovery_count,
    status: row.status
  };
}

export async function getWalletStatusByAddress(walletAddress: string) {
  const addr = walletAddress.toLowerCase();
  const result = await pool.query(
    `SELECT id, email, wallet_address, email_verified, shard_count, total_shards,
            created_at, recovered_at, recovery_count, status
     FROM mpc_wallets WHERE connected_wallet_address = $1 OR wallet_address = $1`,
    [addr]
  );

  if (result.rows.length === 0) {
    return { registered: false };
  }

  const row = result.rows[0];
  return {
    registered: true,
    email: row.email,
    walletAddress: row.wallet_address,
    emailVerified: row.email_verified,
    shardCount: row.shard_count,
    totalShards: row.total_shards,
    createdAt: row.created_at,
    lastRecoveredAt: row.recovered_at,
    recoveryCount: row.recovery_count,
    status: row.status
  };
}
