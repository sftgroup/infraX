import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { asyncHandler, apiResponse } from '../helpers';
import { pool } from '../database';
import { logger } from '../logger';
const router = Router();

// Admin-only guard
function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  // All Cookie/Basic Auth users are admin for now
  next();
}

// ================================================================
// Audit Log
// ================================================================

/**
 * POST /api/v2/admin/audit
 * Write audit log entry
 */
export async function writeAuditLog(userId: string, username: string, action: string, resource: string, detail: any = {}, ip?: string): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO audit_logs (id, user_id, username, action, resource, detail, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [uuidv4(), userId, username, action, resource, JSON.stringify(detail), ip || null]
    );
  } catch (err: any) {
    logger.error('[audit] Failed to write audit log', { error: err.message });
  }
}

/**
 * GET /api/v2/admin/audit
 * Query audit logs
 */
router.get('/audit', requireAdmin, asyncHandler(async (req, res) => {
  const { user, action, resource, limit, offset } = req.query as any;
  const conditions: string[] = [];
  const values: any[] = [];
  let idx = 1;

  if (user) { conditions.push(`user_id = $${idx++}`); values.push(user); }
  if (action) { conditions.push(`action = $${idx++}`); values.push(action); }
  if (resource) { conditions.push(`resource = $${idx++}`); values.push(resource); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const pageSize = Math.min(parseInt(limit) || 50, 200);
  const pageOffset = parseInt(offset) || 0;

  const [{ rows }, { rows: cntRows }] = await Promise.all([
    pool.query(`SELECT * FROM audit_logs ${where} ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`, [...values, pageSize, pageOffset]),
    pool.query(`SELECT COUNT(*)::int as total FROM audit_logs ${where}`, values),
  ]);

  res.json(apiResponse({ data: rows, total: cntRows[0].total }));
}));

// ================================================================
// User Management (admin only)
// ================================================================

/**
 * GET /api/v2/admin/users
 * List all admin users
 */
router.get('/users', requireAdmin, asyncHandler(async (_req, res) => {
  const { rows } = await pool.query(
    'SELECT id, username, email, role, enabled, last_login_at, created_at FROM admin_users ORDER BY created_at'
  );
  res.json(apiResponse(rows));
}));

/**
 * POST /api/v2/admin/users
 * Create a new admin user
 */
router.post('/users', requireAdmin, asyncHandler(async (req, res) => {
  const { username, email, password, role } = req.body;
  if (!username || !password) {
    return res.status(400).json(apiResponse(null, 'username and password required', -1));
  }

  const pwHash = crypto.createHash('sha256').update(password).digest('hex');
  const id = uuidv4();

  await pool.query(
    `INSERT INTO admin_users (id, username, email, password_hash, role)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, username, email || null, pwHash, role || 'operator']
  );

  const actor = (req as any).user;
  await writeAuditLog(actor.id, actor.email, 'user.create', `user:${username}`, { role: role || 'operator' }, req.ip);

  logger.info('[admin] User created', { username, by: actor.email });
  res.status(201).json(apiResponse({ id, username }));
}));

/**
 * PATCH /api/v2/admin/users/:id
 * Update user (role, enabled, password)
 */
router.patch('/users/:id', requireAdmin, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { role, enabled, password } = req.body;
  const updates: string[] = [];
  const values: any[] = [];
  let idx = 1;

  if (role) { updates.push(`role = $${idx++}`); values.push(role); }
  if (enabled !== undefined) { updates.push(`enabled = $${idx++}`); values.push(enabled); }
  if (password) {
    updates.push(`password_hash = $${idx++}`);
    values.push(crypto.createHash('sha256').update(password).digest('hex'));
  }
  if (!updates.length) return res.status(400).json(apiResponse(null, 'No fields to update', -1));

  updates.push(`updated_at = NOW()`);
  values.push(id);

  await pool.query(`UPDATE admin_users SET ${updates.join(', ')} WHERE id = $${idx}`, values);

  const actor = (req as any).user;
  await writeAuditLog(actor.id, actor.email, 'user.update', `user:${id}`, req.body, req.ip);

  res.json(apiResponse({ updated: true }));
}));

/**
 * DELETE /api/v2/admin/users/:id
 * Delete user (can't delete self)
 */
router.delete('/users/:id', requireAdmin, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const actor = (req as any).user;
  if (actor.id === id) {
    return res.status(400).json(apiResponse(null, 'Cannot delete yourself', -1));
  }

  await pool.query('DELETE FROM admin_users WHERE id = $1', [id]);
  await writeAuditLog(actor.id, actor.email, 'user.delete', `user:${id}`, {}, req.ip);

  res.json(apiResponse({ deleted: true }));
}));

// ================================================================
// System Info
// ================================================================

/**
 * GET /api/v2/admin/system
 * System-level info: node version, uptime, memory, db pool
 */
router.get('/system', requireAdmin, asyncHandler(async (_req, res) => {
  const { rows: poolStats } = await pool.query(
    'SELECT count(*)::int as connections FROM pg_stat_activity WHERE datname = current_database()'
  );
  const { rows: dbSize } = await pool.query(
    "SELECT pg_size_pretty(pg_database_size(current_database())) as size"
  );

  res.json(apiResponse({
    node: process.version,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    pid: process.pid,
    db: {
      connections: poolStats[0].connections,
      size: dbSize[0].size,
    },
  }));
}));

// ================================================================
// WaaS / Vault — Tenants Management
// ================================================================

/** GET /api/v2/admin/tenants */
router.get('/tenants', requireAdmin, asyncHandler(async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT t.id, t.name, t.contact_email, t.status, t.webhook_url,
           t.sweep_address, t.sweep_threshold, t.review_mode, t.created_at,
           (SELECT count(*) FROM address_pool ap WHERE ap.tenant_id = t.id) as addresses,
           (SELECT count(*) FROM saas_withdrawals sw WHERE sw.tenant_id = t.id) as withdrawals
    FROM tenants t
    ORDER BY t.created_at DESC
  `);
  res.json(apiResponse(rows));
}));

/** PATCH /api/v2/admin/tenants/:id */
router.patch('/tenants/:id', requireAdmin, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status, review_mode, sweep_threshold, sweep_address, webhook_url } = req.body;
  const sets: string[] = [];
  const vals: any[] = [];
  let i = 1;
  if (status) { sets.push(`status = $${i++}`); vals.push(status); }
  if (review_mode) { sets.push(`review_mode = $${i++}`); vals.push(review_mode); }
  if (sweep_threshold !== undefined) { sets.push(`sweep_threshold = $${i++}`); vals.push(sweep_threshold); }
  if (sweep_address !== undefined) { sets.push(`sweep_address = $${i++}`); vals.push(sweep_address); }
  if (webhook_url !== undefined) { sets.push(`webhook_url = $${i++}`); vals.push(webhook_url); }
  if (!sets.length) return res.json(apiResponse(null, 'nothing to update'));
  sets.push(`updated_at = NOW()`);
  vals.push(id);
  await pool.query(`UPDATE tenants SET ${sets.join(', ')} WHERE id = $${i}`, vals);
  res.json(apiResponse({ updated: true }));
}));

/** GET /api/v2/admin/tenants/:id */
router.get('/tenants/:id', requireAdmin, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const [tenant, addresses, withdrawals, sweeps] = await Promise.all([
    pool.query('SELECT * FROM tenants WHERE id = $1', [id]),
    pool.query('SELECT * FROM address_pool WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 50', [id]),
    pool.query('SELECT * FROM saas_withdrawals WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 50', [id]),
    pool.query('SELECT * FROM sweep_records WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 50', [id]),
  ]);
  res.json(apiResponse({
    tenant: tenant.rows[0],
    addresses: addresses.rows,
    withdrawals: withdrawals.rows,
    sweeps: sweeps.rows,
  }));
}));

// ================================================================
// Transaction Queue
// ================================================================

/** GET /api/v2/admin/transactions */
router.get('/transactions', requireAdmin, asyncHandler(async (req, res) => {
  const { status, limit, offset } = req.query as any;
  const conditions: string[] = [];
  const vals: any[] = [];
  let idx = 1;
  if (status) { conditions.push(`tx.status = $${idx++}`); vals.push(status); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const pageSize = Math.min(parseInt(limit) || 50, 200);
  const pageOffset = parseInt(offset) || 0;

  const [{ rows }, { rows: cntRows }] = await Promise.all([
    pool.query(`
      SELECT tx.*, cw.address as wallet_address, u.email as user_email
      FROM transactions tx
      LEFT JOIN custodial_wallets cw ON cw.id = tx.wallet_id
      LEFT JOIN users u ON u.id = cw.user_id
      ${where}
      ORDER BY tx.created_at DESC LIMIT $${idx} OFFSET $${idx + 1}
    `, [...vals, pageSize, pageOffset]),
    pool.query(`SELECT COUNT(*)::int as total FROM transactions tx ${where}`, vals),
  ]);
  res.json(apiResponse({ data: rows, total: cntRows[0].total }));
}));

/** PATCH /api/v2/admin/transactions/:id */
router.patch('/transactions/:id', requireAdmin, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status, review_note } = req.body;
  if (!status) return res.status(400).json(apiResponse(null, 'status required', -1));
  await pool.query(`UPDATE transactions SET status = $1, updated_at = NOW() WHERE id = $2`, [status, id]);
  res.json(apiResponse({ updated: true }));
}));

// ================================================================
// Webhook Events
// ================================================================

/** GET /api/v2/admin/webhooks */
router.get('/webhooks', requireAdmin, asyncHandler(async (req, res) => {
  const { status, limit, offset } = req.query as any;
  const conditions: string[] = [];
  const vals: any[] = [];
  let idx = 1;
  if (status) { conditions.push(`status = $${idx++}`); vals.push(status); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const pageSize = Math.min(parseInt(limit) || 50, 200);
  const pageOffset = parseInt(offset) || 0;

  const [{ rows }, { rows: cntRows }] = await Promise.all([
    pool.query(`SELECT * FROM webhook_events ${where} ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`, [...vals, pageSize, pageOffset]),
    pool.query(`SELECT COUNT(*)::int as total FROM webhook_events ${where}`, vals),
  ]);
  res.json(apiResponse({ data: rows, total: cntRows[0].total }));
}));

// ================================================================
// Sweep Queue
// ================================================================

/** GET /api/v2/admin/sweeps */
router.get('/sweeps', requireAdmin, asyncHandler(async (req, _res) => {
  const { rows } = await pool.query(`
    SELECT sr.*, t.name as tenant_name
    FROM sweep_records sr
    LEFT JOIN tenants t ON t.id = sr.tenant_id
    ORDER BY sr.created_at DESC LIMIT 100
  `);
  _res.json(apiResponse(rows));
}));

// ================================================================
// Data Center Subscriptions
// ================================================================

/** GET /api/v2/admin/dc-subscriptions */
router.get('/dc-subscriptions', requireAdmin, asyncHandler(async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT t.name, t.id as tenant_id, t.status,
           COALESCE(t.data_plan_id, 'N/A') as data_plan_id,
           t.dc_api_key, t.dc_api_key_created_at
    FROM tenants t
    WHERE t.data_plan_id IS NOT NULL
    ORDER BY t.dc_api_key_created_at DESC NULLS LAST
  `);
  res.json(apiResponse(rows));
}));

// ================================================================
// Settings (Fee Configs + Tokens + Chains)
// ================================================================

/** GET /api/v2/admin/settings */
router.get('/settings', requireAdmin, asyncHandler(async (_req, res) => {
  const [tokens, chains, feeConfigs] = await Promise.all([
    pool.query('SELECT * FROM tokens ORDER BY symbol'),
    pool.query('SELECT * FROM chains ORDER BY chain_id'),
    pool.query('SELECT fc.*, t.symbol FROM fee_configs fc LEFT JOIN tokens t ON t.id = fc.token_id'),
  ]);
  res.json(apiResponse({ tokens: tokens.rows, chains: chains.rows, feeConfigs: feeConfigs.rows }));
}));

// ================================================================
// Revenue Dashboard
// ================================================================

/** GET /api/v2/admin/revenue */
router.get('/revenue', requireAdmin, asyncHandler(async (_req, res) => {
  const [subs, payments, apiStats, dcCount, activeTenants] = await Promise.all([
    pool.query(`SELECT plan_id, plan_name, price, billing_cycle, status, COUNT(*)::int as cnt FROM subscriptions GROUP BY plan_id, plan_name, price, billing_cycle, status ORDER BY plan_id`),
    pool.query(`SELECT status, COUNT(*)::int as cnt, COALESCE(SUM(CASE WHEN currency = 'USD' THEN amount ELSE 0 END), 0) as total_usd FROM payment_orders WHERE created_at > NOW() - INTERVAL '30 days' GROUP BY status`),
    pool.query(`SELECT date, SUM(total_calls)::int as calls FROM api_usage_daily WHERE date > NOW() - INTERVAL '30 days' GROUP BY date ORDER BY date`),
    pool.query(`SELECT COUNT(*)::int as cnt FROM tenants WHERE data_plan_id IS NOT NULL`),
    pool.query(`SELECT COUNT(*)::int as cnt FROM tenants WHERE status = 'active'`),
  ]);
  res.json(apiResponse({
    subscriptions: subs.rows,
    payments: payments.rows,
    apiUsage: apiStats.rows,
    dcSubscribers: dcCount.rows[0].cnt,
    activeTenants: activeTenants.rows[0].cnt,
  }));
}));

// ================================================================
// API Usage Monitoring
// ================================================================

/** GET /api/v2/admin/api-usage */
router.get('/api-usage', requireAdmin, asyncHandler(async (_req, res) => {
  const [byTenant, daily, topKeys] = await Promise.all([
    pool.query(`SELECT t.name, t.id, COUNT(au.id) as total_calls FROM api_usage au RIGHT JOIN tenants t ON t.id = au.tenant_id WHERE au.created_at > NOW() - INTERVAL '30 days' OR au.id IS NULL GROUP BY t.id, t.name ORDER BY total_calls DESC LIMIT 50`),
    pool.query(`SELECT date, SUM(total_calls)::int as calls FROM api_usage_daily WHERE date > NOW() - INTERVAL '30 days' GROUP BY date ORDER BY date`),
    pool.query(`SELECT key_hash, enabled, last_used_at, expires_at FROM api_keys ORDER BY last_used_at DESC NULLS LAST LIMIT 50`),
  ]);
  res.json(apiResponse({ byTenant: byTenant.rows, daily: daily.rows, apiKeys: topKeys.rows }));
}));

// ================================================================
// Risk Rules
// ================================================================

/** GET /api/v2/admin/risk-rules */
router.get('/risk-rules', requireAdmin, asyncHandler(async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM risk_rules ORDER BY updated_at DESC');
  res.json(apiResponse(rows));
}));

/** GET /api/v2/admin/token-blacklist */
router.get('/token-blacklist', requireAdmin, asyncHandler(async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM token_blacklist ORDER BY created_at DESC');
  res.json(apiResponse(rows));
}));

export default router;
