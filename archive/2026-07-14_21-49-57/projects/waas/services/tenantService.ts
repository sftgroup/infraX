import { ethers } from 'ethers';
import crypto from 'crypto';
import { encryptPrivateKey, decryptPrivateKey } from './encryptionService';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../models/database';
import { logger } from '../utils/logger';
import { Errors, AppError, ErrorCode } from '../utils/errors';

/**
 * Tenant Service (F-033, L-018)
 * Enterprise tenant registration, API Key management, webhook configuration
 */

interface Tenant {
  tenantId?: string;
  activated?: boolean;
  hotWalletAddress?: string;
  apiKey?: string;
  createdAt?: Date;
  id: string;
  name: string;
  contact_email: string;
  status: 'pending' | 'active' | 'suspended';
  api_key: string;
  webhook_url: string | null;
  sweep_address: string | null;
  sweep_threshold: number;
  review_mode: 'manual' | 'auto';
  created_at: Date;
}

/**
 * Register a new tenant (enterprise customer)
 */
export async function registerTenant(params: {
  name: string;
  contactEmail: string;
  webhookUrl?: string;
}): Promise<{ tenantId: string; apiKey: string; apiSecret: string }> {
  const { name, contactEmail, webhookUrl } = params;

  if (!name || !contactEmail) {
    throw Errors.paramError('Missing required fields: name, contactEmail');
  }

  const client = await pool.connect();
  try {
    const tenantId = uuidv4();
    const apiKey = `pk_${crypto.randomBytes(24).toString('hex')}`;
    const apiSecret = `sk_${crypto.randomBytes(32).toString('hex')}`;
    const apiSecretHash = crypto.createHash('sha256').update(apiSecret).digest('hex');

    // Insert tenant
    await client.query(
      `INSERT INTO tenants (id, name, contact_email, status, api_key, api_secret_hash, webhook_url)
       VALUES ($1, $2, $3, 'active', $4, $5, $6)`,
      [tenantId, name, contactEmail, apiKey, apiSecretHash, webhookUrl || null]
    );

    // Insert API key into api_keys table for middleware validation
    const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
    await client.query(
      `INSERT INTO api_keys (id, key_hash, name, scope, enabled)
       VALUES ($1, $2, $3, 'tenant', true)`,
      [uuidv4(), keyHash, `tenant-${name}`]
    );

    logger.info('Tenant registered', { tenantId, name });
    return { tenantId, apiKey, apiSecret };
  } finally {
    client.release();
  }
}

/**
 * Get tenant by ID
 */
export async function getTenant(tenantId: string): Promise<Tenant> {
  const result = await pool.query('SELECT * FROM tenants WHERE id = $1', [tenantId]);
  if (result.rows.length === 0) {
    throw Errors.notFound('Tenant');
  }
  return result.rows[0];
}

/**
 * List all tenants
 */
export async function listTenants(params: {
  status?: string;
  limit?: number;
  offset?: number;
}): Promise<{ items: Tenant[]; total: number }> {
  const { status, limit = 50, offset = 0 } = params;

  let query = 'SELECT * FROM tenants';
  const conditions: string[] = [];
  const values: any[] = [];

  if (status) {
    conditions.push(`status = $${values.length + 1}`);
    values.push(status);
  }

  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }

  query += ' ORDER BY created_at DESC LIMIT $' + (values.length + 1) + ' OFFSET $' + (values.length + 2);
  values.push(limit, offset);

  const result = await pool.query(query, values);

  const countResult = await pool.query(
    'SELECT COUNT(*)::int as cnt FROM tenants' +
      (conditions.length > 0 ? ' WHERE ' + conditions.join(' AND ') : ''),
    status ? [status] : []
  );

  return { items: result.rows, total: countResult.rows[0].cnt };
}

/**
 * Update tenant configuration
 */
export async function updateTenant(tenantId: string, updates: {
  name?: string;
  webhookUrl?: string;
  sweepAddress?: string;
  sweepThreshold?: number;
  reviewMode?: 'manual' | 'auto';
  status?: 'active' | 'suspended';
}): Promise<Tenant> {
  const sets: string[] = [];
  const values: any[] = [];

  if (updates.name !== undefined) { sets.push(`name = $${values.length + 1}`); values.push(updates.name); }
  if (updates.webhookUrl !== undefined) { sets.push(`webhook_url = $${values.length + 1}`); values.push(updates.webhookUrl); }
  if (updates.sweepAddress !== undefined) { sets.push(`sweep_address = $${values.length + 1}`); values.push(updates.sweepAddress); }
  if (updates.sweepThreshold !== undefined) { sets.push(`sweep_threshold = $${values.length + 1}`); values.push(updates.sweepThreshold); }
  if (updates.reviewMode !== undefined) { sets.push(`review_mode = $${values.length + 1}`); values.push(updates.reviewMode); }
  if (updates.status !== undefined) { sets.push(`status = $${values.length + 1}`); values.push(updates.status); }

  if (sets.length === 0) {
    throw Errors.paramError('No updates provided');
  }

  sets.push('updated_at = NOW()');
  values.push(tenantId);

  const result = await pool.query(
    `UPDATE tenants SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING *`,
    values
  );

  if (result.rows.length === 0) {
    throw Errors.notFound('Tenant');
  }

  logger.info('Tenant updated', { tenantId, updates: Object.keys(updates) });
  return result.rows[0];
}

/**
 * Delete (suspend) a tenant
 */
export async function suspendTenant(tenantId: string): Promise<void> {
  const result = await pool.query(
    `UPDATE tenants SET status = 'suspended', updated_at = NOW() WHERE id = $1 RETURNING id`,
    [tenantId]
  );
  if (result.rows.length === 0) {
    throw Errors.notFound('Tenant');
  }
  logger.info('Tenant suspended', { tenantId });
}

/**
 * Look up tenant by API key for request authentication
 */
export async function getTenantByApiKey(apiKey: string): Promise<Tenant | null> {
  const result = await pool.query(
    'SELECT * FROM tenants WHERE api_key = $1 AND status = $2',
    [apiKey, 'active']
  );
  return result.rows[0] || null;
}

/**
 * Get tenant by wallet address (owner_email = walletAddress@web3.infrax.local)
 */
export async function getTenantByWallet(walletAddress: string): Promise<Tenant | null> {
  const result = await pool.query(
    `SELECT t.id, t.name, t.api_key, t.status, t.created_at, t.hot_wallet_address
     FROM tenants t JOIN users u ON t.owner_user_id = u.id
     WHERE u.wallet_address = $1
     UNION ALL
     SELECT t.id, t.name, t.api_key, t.status, t.created_at, t.hot_wallet_address
     FROM tenants t
     WHERE t.owner_email = $2`,
    [walletAddress.toLowerCase(), walletAddress.toLowerCase() + "@web3.infrax.local"]
  );
  if (result.rows.length === 0) return null;
  const t = result.rows[0];
  return {
    tenantId: t.id,
    name: t.name,
    apiKey: t.api_key,
    status: t.status,
    activated: true,
    createdAt: t.created_at,
    hotWalletAddress: t.hot_wallet_address
  };
}

/**
 * Activate (create) WaaS tenant for a wallet address
 */
export async function activateTenant(walletAddress: string, planId: string = 'free'): Promise<Tenant> {
  const existing = await getTenantByWallet(walletAddress);
  if (existing) {
    return existing;
  }
  const tenantId = uuidv4();
  const apiKey = `pk_${crypto.randomBytes(16).toString('hex')}`;
  const email = `${walletAddress}@web3.infrax.local`;
  const name = `Wallet ${walletAddress.slice(0, 8)}...`;

  // Resolve user_id from wallet_address
  const userResult = await pool.query('SELECT id FROM users WHERE wallet_address = $1', [walletAddress]);
  const userId = userResult.rows.length > 0 ? userResult.rows[0].id : null;

  await pool.query(
    `INSERT INTO tenants (id, name, owner_email, owner_user_id, api_key, api_secret_hash, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'active', NOW(), NOW())`,
    [tenantId, name, email, userId, apiKey, '']
  );

  // Create subscription record if user exists
  if (userId) {
    const validPlans: Record<string, { name: string; price: number }> = {
      free: { name: 'Starter', price: 0 },
      pro: { name: 'Pro', price: 49 },
      enterprise: { name: 'Enterprise', price: 199 },
    };
    const plan = validPlans[planId] || validPlans.free;
    const expiresAt = plan.price === 0 ? null : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await pool.query(
      `INSERT INTO subscriptions (user_id, plan_id, plan_name, price, billing_cycle, status, expires_at)
       VALUES ($1, $2, $3, $4, 'monthly', 'active', $5)`,
      [userId, planId, plan.name, plan.price, expiresAt]
    );
  }

  logger.info('WaaS tenant activated', { walletAddress, tenantId, planId });

  return {
    tenantId,
    name,
    apiKey,
    planId,
    planName: planId === 'pro' ? 'Pro' : planId === 'enterprise' ? 'Enterprise' : 'Starter',
    status: 'active',
    activated: true,
    createdAt: new Date().toISOString(),
  } as any;
}

export async function regenerateApiKey(tenantId: string) {
  const apiKey = `pk_${crypto.randomBytes(16).toString('hex')}`;
  await pool.query('UPDATE tenants SET api_key = $1, updated_at = NOW() WHERE id = $2', [apiKey, tenantId]);
  return { apiKey };
}

export async function deleteApiKey(tenantId: string): Promise<void> {
  await pool.query('UPDATE tenants SET api_key = $1, updated_at = NOW() WHERE id = $2', ['', tenantId]);
}

export async function generateHotWallet(tenantId: string, chainId: number) {
  var wallet = ethers.Wallet.createRandom();
  var encryptedKey = encryptPrivateKey(wallet.privateKey.slice(2));
  await pool.query(
    'UPDATE tenants SET hot_wallet_address = $1, hot_wallet_pkey = $2, updated_at = NOW() WHERE id = $3',
    [wallet.address, encryptedKey, tenantId]
  );
  return { address: wallet.address, chainId };
}

export async function getHotWalletPrivateKey(tenantId: string): Promise<string | null> {
  var result = await pool.query('SELECT hot_wallet_pkey FROM tenants WHERE id = $1', [tenantId]);
  var encryptedKey = result.rows[0]?.hot_wallet_pkey;
  if (!encryptedKey) return null;
  return '0x' + decryptPrivateKey(encryptedKey);
}
