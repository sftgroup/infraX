import { Request, Response, NextFunction } from 'express';
import { ethers } from 'ethers';
import * as crypto from 'crypto';
import { Errors } from '../utils/errors';
import { pool } from '../models/database';

export interface AuthPayload {
  walletAddress: string;
  id: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthPayload;
    }
  }
}

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const ADMIN_JWT_SECRET = 'pocketx-admin-' + crypto.randomBytes(16).toString('hex');

/**
 * EIP-191 Wallet Signature Authentication
 * Standard Web3 auth: client signs message, server recovers address, verifies match.
 * Session cached in-memory per address (not per request) — one sign per 24h.
 */
const sessionCache = new Map<string, { ts: number }>();

export async function authenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const walletAddress = (req.headers['x-wallet-address'] as string || '').toLowerCase();
  const signature = req.headers['x-wallet-signature'] as string | undefined;
  const timestamp = req.headers['x-wallet-timestamp'] as string | undefined;

  // Skip wallet auth for admin JWT (Bearer token in Authorization header)
  const authHeader = req.headers['authorization'] as string || '';
  if (authHeader.startsWith('Bearer ')) {
    try {
      const payload = verifyAdminToken(authHeader.replace('Bearer ', ''));
      (req as any).adminUser = payload;
      // Set a synthetic wallet address so downstream code doesn't crash
      req.user = { walletAddress: '0xadmin0000000000000000000000000000000000000', id: 'admin' };
      return next();
    } catch {}
  }

  if (!walletAddress || walletAddress.length < 42) {
    return next(Errors.unauthorized('Missing x-wallet-address header'));
  }

  // Check session cache first — no re-verify needed within TTL
  const cached = sessionCache.get(walletAddress);
  if (cached && (Date.now() - cached.ts) < SESSION_TTL_MS) {
    return resolveUser(walletAddress, req, next);
  }

  // Require signature for first auth or expired session
  if (!signature || !timestamp) {
    return next(Errors.unauthorized('Missing signature headers — sign the message first'));
  }

  const ts = parseInt(timestamp, 10);
  if (isNaN(ts) || Math.abs(Date.now() - ts) > SESSION_TTL_MS) {
    return next(Errors.unauthorized('Signature expired'));
  }

  const message = `PocketX auth: ${timestamp}`;
  let recovered: string;
  try {
    recovered = ethers.verifyMessage(message, signature);
  } catch {
    return next(Errors.unauthorized('Invalid signature'));
  }

  if (recovered.toLowerCase() !== walletAddress) {
    return next(Errors.unauthorized('Signature does not match wallet address'));
  }

  // Cache valid session
  sessionCache.set(walletAddress, { ts: Date.now() });

  return resolveUser(walletAddress, req, next);
}

async function resolveUser(walletAddress: string, req: Request, next: NextFunction) {
  try {
    const result = await pool.query('SELECT id FROM users WHERE wallet_address = $1', [walletAddress]);
    if (result.rows.length === 0) {
      const inserted = await pool.query(
        `INSERT INTO users (wallet_address, created_at, updated_at)
         VALUES ($1, NOW(), NOW()) RETURNING id`,
        [walletAddress]
      );
      req.user = { walletAddress, id: inserted.rows[0].id };
    } else {
      req.user = { walletAddress, id: result.rows[0].id };
    }
    next();
  } catch (err: any) {
    return next(Errors.unauthorized('Database error'));
  }
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  // Also accept admin JWT (via Authorization header) for /api/v2/dashboard and /api/v2/saas
  const token = (req.headers['authorization'] as string || '').replace('Bearer ', '');
  if (token) {
    try {
      const payload = verifyAdminToken(token);
      (req as any).adminUser = payload;
      return next();
    } catch {}
  }
  next();
}

export function signAdminToken(username: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    sub: username,
    role: 'admin',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 86400
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', ADMIN_JWT_SECRET)
    .update(header + '.' + payload).digest('base64url');
  return header + '.' + payload + '.' + signature;
}

function verifyAdminToken(token: string): any {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid token');
  const expected = crypto.createHmac('sha256', ADMIN_JWT_SECRET)
    .update(parts[0] + '.' + parts[1]).digest('base64url');
  if (expected !== parts[2]) throw new Error('Invalid signature');
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  if (payload.exp && Date.now() > payload.exp * 1000) throw new Error('Token expired');
  return payload;
}

export async function requireApiKey(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const apiKey = req.headers['x-api-key'] as string | undefined;
  if (!apiKey) return next(Errors.unauthorized('Missing API key'));

  const crypto = require('crypto');
  const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');

  try {
    const result = await pool.query(
      `SELECT id FROM api_keys WHERE key_hash = $1 AND enabled = true AND (expires_at IS NULL OR expires_at > NOW())`,
      [keyHash]
    );
    if (result.rows.length > 0) {
      await pool.query('UPDATE api_keys SET last_used_at = NOW() WHERE id = $1', [result.rows[0].id]).catch(() => {});
      return next();
    }
    if (apiKey === (require('../config').config.cwallet.apiKey)) return next();
  } catch {
    if (apiKey === (require('../config').config.cwallet.apiKey)) return next();
  }
  return next(Errors.unauthorized('Invalid API key'));
}

export function verifyCWalletSignature(req: Request, _res: Response, next: NextFunction): void {
  const signature = req.headers['x-cwallet-signature'] as string;
  const timestamp = req.headers['x-cwallet-timestamp'] as string;
  if (!signature || !timestamp) return next(Errors.unauthorized('Missing CWallet signature'));

  const ts = parseInt(timestamp, 10);
  if (isNaN(ts) || Math.abs(Date.now() - ts) > 5 * 60 * 1000) return next(Errors.unauthorized('CWallet signature expired'));

  const crypto = require('crypto');
  const expected = crypto.createHmac('sha256', (require('../config').config.cwallet.apiKey))
    .update(JSON.stringify(req.body) + timestamp).digest('hex');
  if (signature !== expected) return next(Errors.unauthorized('Invalid CWallet signature'));
  next();
}

export function enforceTenantScope(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user) return next(Errors.unauthorized());
  next();
}

export async function requireTenantApiKey(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const apiKey = req.headers['x-api-key'] as string | undefined;
  if (!apiKey) return next(Errors.unauthorized('Missing x-api-key'));
  try {
    const { getTenantByApiKey } = await import('../services/tenantService');
    const tenant = await getTenantByApiKey(apiKey);
    if (!tenant) return next(Errors.unauthorized('Invalid or suspended API key'));
    (req as any).tenant = tenant;
    next();
  } catch {
    return next(Errors.unauthorized('Tenant authentication failed'));
  }
}
