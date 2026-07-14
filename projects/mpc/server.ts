// PocketX MPC Server — email-based MPC key shard management
// Standalone Express service, independent of other PocketX modules
import express from 'express';
import { Pool } from 'pg';
import cors from 'cors';
import crypto from 'crypto';
import { ethers } from 'ethers';

const app = express();
app.use(express.json());
app.use(cors({ origin: true, credentials: true }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://ubuntu@localhost:5432/pocketx_mpc',
  max: 10,
  idleTimeoutMillis: 30000,
});

function asyncHandler(fn: any) {
  return (req: any, res: any, next: any) => Promise.resolve(fn(req, res, next)).catch(next);
}

function apiResponse(data: any = null, message = 'success', code = 0) {
  return { code, message, data };
}

// ─── Encryption helpers ───
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
  if (parts.length !== 3) throw new Error('Invalid encrypted shard format');
  const iv = Buffer.from(parts[0], 'hex');
  const authTag = Buffer.from(parts[1], 'hex');
  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(parts[2], 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// ─── In-memory verification codes (same pattern as WAAS) ───
const mpcCodes = new Map<string, { code: string; expiresAt: number; attempts: number }>();

function storeCode(email: string, code: string): void {
  mpcCodes.set(email.toLowerCase(), { code, expiresAt: Date.now() + 5 * 60_000, attempts: 0 });
}

function verifyCode(email: string, code: string): void {
  const record = mpcCodes.get(email.toLowerCase());
  if (!record) throw Object.assign(new Error('No verification code for this email'), { statusCode: 400 });
  if (Date.now() > record.expiresAt) { mpcCodes.delete(email.toLowerCase()); throw Object.assign(new Error('Code expired (5 min)'), { statusCode: 400 }); }
  if (record.attempts >= 5) { mpcCodes.delete(email.toLowerCase()); throw Object.assign(new Error('Too many attempts'), { statusCode: 429 }); }
  record.attempts++;
  if (code !== record.code) throw Object.assign(new Error('Invalid code'), { statusCode: 400 });
  mpcCodes.delete(email.toLowerCase());
}

// ─── Health ───
app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'pocketx-mpc', uptime: process.uptime() }));

// ─── Send verification code ───
app.post('/api/v2/mpc/send-code', asyncHandler(async (req: any, res: any) => {
  const { email } = req.body;
  if (!email) return res.status(400).json(apiResponse(null, 'email required', 1001));
  const code = '888888'; // Dev: fixed
  storeCode(email, code);
  console.log(`[MPC] Code for ${email}: ${code}`);
  res.json(apiResponse({ message: 'Code sent' }));
}));

// ─── Register ───
app.post('/api/v2/mpc/register', asyncHandler(async (req: any, res: any) => {
  const { email, code, walletAddress } = req.body;
  if (!email || !code) return res.status(400).json(apiResponse(null, 'email + code required', 1001));
  verifyCode(email, code);

  const emailLower = email.toLowerCase();
  const existing = await pool.query('SELECT id FROM mpc_wallets WHERE email = $1', [emailLower]);
  if (existing.rows.length > 0) {
    return res.status(400).json(apiResponse(null, 'Email already registered. Use /recover.', 1006));
  }

  const wallet = ethers.Wallet.createRandom();
  const encryptedShard = encryptShard(wallet.privateKey, emailLower);
  const connectedAddr = (req.headers['x-wallet-address'] as string) || walletAddress || null;

  const result = await pool.query(
    `INSERT INTO mpc_wallets (id, email, email_verified, wallet_address, encrypted_shard, shard_count, total_shards, connected_wallet_address)
     VALUES ($1, $2, true, $3, $4, 1, 1, $5) RETURNING id, email, wallet_address, created_at`,
    [crypto.randomUUID(), emailLower, wallet.address, encryptedShard, connectedAddr]
  );

  const row = result.rows[0];
  res.status(201).json(apiResponse({ id: row.id, email: row.email, walletAddress: row.wallet_address, createdAt: row.created_at }, 'MPC wallet created'));
}));

// ─── Recover ───
app.post('/api/v2/mpc/recover', asyncHandler(async (req: any, res: any) => {
  const { email, code } = req.body;
  if (!email || !code) return res.status(400).json(apiResponse(null, 'email + code required', 1001));
  verifyCode(email, code);

  const emailLower = email.toLowerCase();
  const result = await pool.query(
    `SELECT id, email, wallet_address, encrypted_shard, recovery_count FROM mpc_wallets WHERE email = $1 AND status = 'active'`,
    [emailLower]
  );
  if (result.rows.length === 0) {
    return res.status(404).json(apiResponse(null, 'No MPC wallet found. Register first.', 1004));
  }

  const row = result.rows[0];
  let privateKey: string;
  try {
    privateKey = decryptShard(row.encrypted_shard, emailLower);
  } catch {
    return res.status(500).json(apiResponse(null, 'Failed to decrypt shard', 1007));
  }

  const recoveredWallet = new ethers.Wallet(privateKey);
  if (recoveredWallet.address.toLowerCase() !== row.wallet_address.toLowerCase()) {
    return res.status(500).json(apiResponse(null, 'Recovered key mismatch', 1008));
  }

  await pool.query(`UPDATE mpc_wallets SET recovered_at = NOW(), recovery_count = recovery_count + 1 WHERE id = $1`, [row.id]);

  res.json(apiResponse({
    email: row.email,
    walletAddress: row.wallet_address,
    recoveredAt: new Date().toISOString(),
    recoveryCount: row.recovery_count + 1,
  }, 'MPC wallet recovered'));
}));

// ─── Status ───
app.get('/api/v2/mpc/status', asyncHandler(async (req: any, res: any) => {
  const { email, walletAddress } = req.query;

  if (walletAddress && typeof walletAddress === 'string') {
    const addr = walletAddress.toLowerCase();
    const result = await pool.query(
      `SELECT id, email, wallet_address, email_verified, shard_count, total_shards, created_at, recovered_at, recovery_count, status
       FROM mpc_wallets WHERE LOWER(connected_wallet_address) = $1 OR LOWER(wallet_address) = $1`,
      [addr]
    );
    if (result.rows.length === 0) return res.json(apiResponse({ registered: false }));
    const r = result.rows[0];
    return res.json(apiResponse({ registered: true, email: r.email, walletAddress: r.wallet_address, emailVerified: r.email_verified, shardCount: r.shard_count, totalShards: r.total_shards, createdAt: r.created_at, lastRecoveredAt: r.recovered_at, recoveryCount: r.recovery_count, status: r.status }));
  }

  if (!email || typeof email !== 'string') {
    return res.status(400).json(apiResponse(null, 'walletAddress or email required', 1001));
  }

  const result = await pool.query(
    `SELECT id, email, wallet_address, email_verified, shard_count, total_shards, created_at, recovered_at, recovery_count, status
     FROM mpc_wallets WHERE email = $1`,
    [email.toLowerCase()]
  );
  if (result.rows.length === 0) return res.json(apiResponse({ registered: false }));
  const r = result.rows[0];
  res.json(apiResponse({ registered: true, email: r.email, walletAddress: r.wallet_address, emailVerified: r.email_verified, shardCount: r.shard_count, totalShards: r.total_shards, createdAt: r.created_at, lastRecoveredAt: r.recovered_at, recoveryCount: r.recovery_count, status: r.status }));
}));

// ─── Start ───
const PORT = parseInt(process.env.PORT || '6003', 10);
app.listen(PORT, () => console.log(`MPC API running on port ${PORT}`));
