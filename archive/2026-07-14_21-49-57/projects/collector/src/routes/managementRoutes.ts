import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { asyncHandler, apiResponse } from '../helpers';
import { pool } from '../database';
import { logger } from '../logger';
const router = Router();

function requireAdmin(_req: Request, _res: Response, next: NextFunction): void {
  next();
}

// ================================================================
// Audit Log
// ================================================================

async function writeAuditLog(userId: string, username: string, action: string, resource: string, detail: any = {}, ip?: string): Promise<void> {
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
// Admin Users (collector-local)
// ================================================================

router.get('/users', requireAdmin, asyncHandler(async (_req, res) => {
  const { rows } = await pool.query(
    'SELECT id, username, email, role, enabled, last_login_at, created_at FROM admin_users ORDER BY created_at'
  );
  res.json(apiResponse(rows));
}));

router.post('/users', requireAdmin, asyncHandler(async (req, res) => {
  const { username, email, password, role } = req.body;
  if (!username || !password) return res.status(400).json(apiResponse(null, 'username and password required', -1));
  const pwHash = crypto.createHash('sha256').update(password).digest('hex');
  const id = uuidv4();
  await pool.query(`INSERT INTO admin_users (id, username, email, password_hash, role) VALUES ($1, $2, $3, $4, $5)`,
    [id, username, email || null, pwHash, role || 'operator']);
  const actor = (req as any).user;
  await writeAuditLog(actor?.id || 'system', actor?.email || 'system', 'user.create', `user:${username}`, { role: role || 'operator' }, req.ip);
  logger.info('[admin] User created', { username, by: actor?.email || 'system' });
  res.status(201).json(apiResponse({ id, username }));
}));

router.patch('/users/:id', requireAdmin, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { role, enabled, password } = req.body;
  const updates: string[] = [];
  const values: any[] = [];
  let idx = 1;
  if (role) { updates.push(`role = $${idx++}`); values.push(role); }
  if (enabled !== undefined) { updates.push(`enabled = $${idx++}`); values.push(enabled); }
  if (password) { updates.push(`password_hash = $${idx++}`); values.push(crypto.createHash('sha256').update(password).digest('hex')); }
  if (!updates.length) return res.status(400).json(apiResponse(null, 'No fields to update', -1));
  updates.push(`updated_at = NOW()`);
  values.push(id);
  await pool.query(`UPDATE admin_users SET ${updates.join(', ')} WHERE id = $${idx}`, values);
  const actor = (req as any).user;
  await writeAuditLog(actor?.id || 'system', actor?.email || 'system', 'user.update', `user:${id}`, req.body, req.ip);
  res.json(apiResponse({ updated: true }));
}));

router.delete('/users/:id', requireAdmin, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const actor = (req as any).user;
  if (actor?.id === id) return res.status(400).json(apiResponse(null, 'Cannot delete yourself', -1));
  await pool.query('DELETE FROM admin_users WHERE id = $1', [id]);
  await writeAuditLog(actor?.id || 'system', actor?.email || 'system', 'user.delete', `user:${id}`, {}, req.ip);
  res.json(apiResponse({ deleted: true }));
}));

// ================================================================
// System Info (collector-local)
// ================================================================

router.get('/system', requireAdmin, asyncHandler(async (_req, res) => {
  const [{ rows: poolStats }, { rows: dbSize }] = await Promise.all([
    pool.query('SELECT count(*)::int as connections FROM pg_stat_activity WHERE datname = current_database()'),
    pool.query("SELECT pg_size_pretty(pg_database_size(current_database())) as size"),
  ]);
  res.json(apiResponse({
    node: process.version, uptime: process.uptime(), memory: process.memoryUsage(), pid: process.pid,
    db: { connections: poolStats[0].connections, size: dbSize[0].size },
  }));
}));

export { writeAuditLog };
export default router;
