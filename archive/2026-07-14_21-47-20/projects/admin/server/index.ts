// InfraX Admin Server — independent backend for admin panel
// Aggregates data from all module databases
import express from 'express';
import { Pool } from 'pg';
import cors from 'cors';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());
app.use(cors({ origin: true, credentials: true }));

// Serve React admin frontend
app.use(express.static(path.join(__dirname, '..', 'dist')));

const BASE = 'postgresql://ubuntu@localhost:5432';

const pools: Record<string, Pool> = {
  mpc:     new Pool({ connectionString: process.env.MPC_DB     || `${BASE}/pocketx_mpc`,     max: 3 }),
  admin:   new Pool({ connectionString: process.env.ADMIN_DB   || `${BASE}/pocketx_admin`,   max: 3 }),
  waas:    new Pool({ connectionString: process.env.WAAS_DB    || `${BASE}/pocketx_waas`,    max: 3 }),
  dc:      new Pool({ connectionString: process.env.DC_DB      || `${BASE}/pocketx_dc`,      max: 3 }),
  vault:   new Pool({ connectionString: process.env.VAULT_DB   || `${BASE}/pocketx_vault`,   max: 3 }),
  payment: new Pool({ connectionString: process.env.PAYMENT_DB || `${BASE}/pocketx_payment`, max: 3 }),
  collector: new Pool({ connectionString: process.env.COLLECTOR_DB || `${BASE}/pocketx_collector`, max: 3 }),
};

// ─── Helpers ───
function asyncHandler(fn: any) {
  return (req: any, res: any, next: any) => Promise.resolve(fn(req, res, next)).catch(next);
}
function apiResponse(data: any = null, message = 'success', code = 0) {
  return { code, message, data };
}

// ─── Simple Auth ───
const SESSIONS = new Map<string, { username: string; expires: number }>();
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';



app.post('/api/v2/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    const token = crypto.randomBytes(32).toString('hex');
    SESSIONS.set(token, { username, expires: Date.now() + 8 * 3600_000 });
    res.cookie('admin_token', token, { httpOnly: true, sameSite: 'lax', maxAge: 8 * 3600_000 });
    return res.json(apiResponse({ token }, 'Login successful'));
  }
  res.status(401).json(apiResponse(null, 'Invalid credentials', 4001));
});

app.post('/api/v2/admin/logout', (req, res) => {
  const token = req.cookies?.admin_token;
  if (token) SESSIONS.delete(token);
  res.clearCookie('admin_token');
  res.json(apiResponse(null, 'Logged out'));
});

function requireAdmin(req: any, res: any, next: any) {
  const token = req.cookies?.admin_token || req.headers['x-admin-token'];
  if (!token) return res.status(401).json(apiResponse(null, 'Unauthorized', 4001));
  const session = SESSIONS.get(token);
  if (!session || session.expires < Date.now()) {
    if (session) SESSIONS.delete(token);
    return res.status(401).json(apiResponse(null, 'Unauthorized', 4001));
  }
  next();
}

// ─── Dashboard (aggregated from all modules) ───
app.get('/api/v2/admin/dashboard', requireAdmin, asyncHandler(async (_req: any, res: any) => {
  const [totalUsers, activeTenants, totalEvents, totalRevenue] = await Promise.all([
    pools.waas.query("SELECT COUNT(*)::int as cnt FROM users").then(r => r.rows[0]?.cnt || 0).catch(() => 0),
    pools.waas.query("SELECT COUNT(*)::int as cnt FROM tenants WHERE status='active'").then(r => r.rows[0]?.cnt || 0).catch(() => 0),
    pools.collector.query("SELECT COUNT(*)::int as cnt FROM events").then(r => r.rows[0]?.cnt || 0).catch(() => 0),
    pools.payment.query("SELECT COUNT(*)::int as cnt FROM payment_orders WHERE status='confirmed'").then(r => r.rows[0]?.cnt || 0).catch(() => 0),
  ]);
  res.json(apiResponse({ totalUsers, activeTenants, totalEvents, totalRevenue }));
}));

// ─── Revenue (per-module breakdown) ───
app.get('/api/v2/admin/revenue', requireAdmin, asyncHandler(async (_req: any, res: any) => {
  const [activeTenants, dcSubscribers, subscriptions, payments30d, dcPayments] = await Promise.all([
    pools.waas.query("SELECT COUNT(*)::int as cnt FROM tenants WHERE status='active'").then(r => r.rows[0]?.cnt || 0).catch(() => 0),
    pools.dc.query("SELECT COUNT(*)::int as cnt FROM dc_subscriptions").then(r => r.rows[0]?.cnt || 0).catch(() => 0),
    pools.waas.query("SELECT plan_name, billing_cycle, COUNT(*)::int as cnt FROM subscriptions GROUP BY plan_name, billing_cycle ORDER BY cnt DESC").then(r => r.rows).catch(() => []),
    pools.payment.query("SELECT status, COUNT(*)::int as cnt FROM payment_orders WHERE created_at >= NOW() - INTERVAL '30 days' GROUP BY status").then(r => r.rows).catch(() => []),
  ]);
  res.json(apiResponse({
    activeTenants, dcSubscribers,
    subscriptions, payments: payments30d,
  }));
}));

// ─── API Usage ───
app.get('/api/v2/admin/api-usage', requireAdmin, asyncHandler(async (_req: any, res: any) => {
  const result = await pools.waas.query(
    "SELECT date, endpoint, COUNT(*)::int as calls FROM api_usage_daily WHERE date >= NOW() - INTERVAL '30 days' GROUP BY date, endpoint ORDER BY date DESC LIMIT 500"
  ).catch(() => ({ rows: [] }));
  res.json(apiResponse(result.rows));
}));

// ─── RPC Config ───
app.get('/api/v2/admin/rpc', requireAdmin, asyncHandler(async (_req: any, res: any) => {
  const result = await pools.admin.query('SELECT * FROM admin_rpc_config ORDER BY chain, priority').catch(() => ({ rows: [] }));
  res.json(apiResponse(result.rows));
}));

app.post('/api/v2/admin/rpc', requireAdmin, asyncHandler(async (req: any, res: any) => {
  const { chain, url, priority, enabled } = req.body;
  const result = await pools.admin.query(
    'INSERT INTO admin_rpc_config (chain, url, priority, enabled) VALUES ($1,$2,$3,$4) RETURNING *',
    [chain, url, priority || 99, enabled !== false]
  );
  res.status(201).json(apiResponse(result.rows[0], 'RPC endpoint added'));
}));

app.patch('/api/v2/admin/rpc/:id', requireAdmin, asyncHandler(async (req: any, res: any) => {
  const { id } = req.params;
  const { enabled, priority } = req.body;
  await pools.admin.query('UPDATE admin_rpc_config SET enabled = COALESCE($1, enabled), priority = COALESCE($2, priority) WHERE id = $3',
    [enabled, priority, id]);
  res.json(apiResponse(null, 'Updated'));
}));

// ─── Service Status (check all module health endpoints) ───
app.get('/api/v2/admin/status', requireAdmin, asyncHandler(async (_req: any, res: any) => {
  const services = [
    { name: 'waas', port: 6001 },
    { name: 'dc', port: 3001 },
    { name: 'vault', port: 6002 },
    { name: 'mpc', port: 6003 },
    { name: 'payment', port: 6004 },
    { name: 'admin', port: 3002 },
    { name: 'web', port: 6100 },
  ];
  const statuses = await Promise.all(services.map(async s => {
    const path = s.path || '/health';
    try { const r = await fetch('http://localhost:' + s.port + path); return { ...s, status: r.ok || r.status === 404 ? 'up' : 'error' }; }
    catch { return { ...s, status: 'down' }; }
  }));
  res.json(apiResponse(statuses));
}));

// ─── Tenants (WaaS) ───
app.get('/api/v2/admin/tenants', requireAdmin, asyncHandler(async (_req: any, res: any) => {
  const { rows } = await pools.waas.query(`
    SELECT t.id, t.name, t.contact_email, t.status, t.webhook_url,
           t.sweep_address, t.sweep_threshold, t.review_mode, t.created_at,
           (SELECT count(*) FROM address_pool ap WHERE ap.tenant_id = t.id) as addresses,
           (SELECT count(*) FROM saas_withdrawals sw WHERE sw.tenant_id = t.id) as withdrawals
    FROM tenants t ORDER BY t.created_at DESC`);
  res.json(apiResponse(rows));
}));

app.get('/api/v2/admin/tenants/:id', requireAdmin, asyncHandler(async (req: any, res: any) => {
  const { id } = req.params;
  const [tenant, addresses, withdrawals, sweeps] = await Promise.all([
    pools.waas.query('SELECT * FROM tenants WHERE id = $1', [id]),
    pools.waas.query('SELECT * FROM address_pool WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 50', [id]),
    pools.waas.query('SELECT * FROM saas_withdrawals WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 50', [id]),
    pools.waas.query('SELECT * FROM sweep_records WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 50', [id]),
  ]);
  res.json(apiResponse({ tenant: tenant.rows[0], addresses: addresses.rows, withdrawals: withdrawals.rows, sweeps: sweeps.rows }));
}));

app.patch('/api/v2/admin/tenants/:id', requireAdmin, asyncHandler(async (req: any, res: any) => {
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
  await pools.waas.query(`UPDATE tenants SET ${sets.join(', ')} WHERE id = $${i}`, vals);
  res.json(apiResponse({ updated: true }));
}));

// ─── Transactions (WaaS) ───
app.get('/api/v2/admin/transactions', requireAdmin, asyncHandler(async (req: any, res: any) => {
  const { status, limit, offset } = req.query as any;
  const conditions: string[] = [];
  const vals: any[] = [];
  let idx = 1;
  if (status) { conditions.push(`tx.status = $${idx++}`); vals.push(status); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const pageSize = Math.min(parseInt(limit) || 50, 200);
  const pageOffset = parseInt(offset) || 0;
  const [{ rows }, { rows: cntRows }] = await Promise.all([
    pools.waas.query(`
      SELECT tx.*, cw.address as wallet_address, u.email as user_email
      FROM transactions tx
      LEFT JOIN custodial_wallets cw ON cw.id = tx.wallet_id
      LEFT JOIN users u ON u.id = cw.user_id
      ${where} ORDER BY tx.created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
      [...vals, pageSize, pageOffset]),
    pools.waas.query(`SELECT COUNT(*)::int as total FROM transactions tx ${where}`, vals),
  ]);
  res.json(apiResponse({ data: rows, total: cntRows[0].total }));
}));

app.patch('/api/v2/admin/transactions/:id', requireAdmin, asyncHandler(async (req: any, res: any) => {
  const { id } = req.params;
  const { status } = req.body;
  if (!status) return res.status(400).json(apiResponse(null, 'status required', -1));
  await pools.waas.query(`UPDATE transactions SET status = $1, updated_at = NOW() WHERE id = $2`, [status, id]);
  res.json(apiResponse({ updated: true }));
}));

// ─── Webhooks (WaaS) ───
app.get('/api/v2/admin/webhooks', requireAdmin, asyncHandler(async (req: any, res: any) => {
  const { status, limit, offset } = req.query as any;
  const conditions: string[] = [];
  const vals: any[] = [];
  let idx = 1;
  if (status) { conditions.push(`status = $${idx++}`); vals.push(status); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const pageSize = Math.min(parseInt(limit) || 50, 200);
  const pageOffset = parseInt(offset) || 0;
  const [{ rows }, { rows: cntRows }] = await Promise.all([
    pools.waas.query(`SELECT * FROM webhook_events ${where} ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`, [...vals, pageSize, pageOffset]),
    pools.waas.query(`SELECT COUNT(*)::int as total FROM webhook_events ${where}`, vals),
  ]);
  res.json(apiResponse({ data: rows, total: cntRows[0].total }));
}));

// ─── Sweeps (WaaS) ───
app.get('/api/v2/admin/sweeps', requireAdmin, asyncHandler(async (_req: any, res: any) => {
  const { rows } = await pools.waas.query(`
    SELECT sr.*, t.name as tenant_name
    FROM sweep_records sr LEFT JOIN tenants t ON t.id = sr.tenant_id
    ORDER BY sr.created_at DESC LIMIT 100`);
  res.json(apiResponse(rows));
}));

// ─── DC Subscriptions (WaaS) ───
app.get('/api/v2/admin/dc-subscriptions', requireAdmin, asyncHandler(async (_req: any, res: any) => {
  const { rows } = await pools.waas.query(`
    SELECT t.name, t.id as tenant_id, t.status,
           COALESCE(t.data_plan_id, 'N/A') as data_plan_id,
           t.dc_api_key, t.dc_api_key_created_at
    FROM tenants t WHERE t.data_plan_id IS NOT NULL
    ORDER BY t.dc_api_key_created_at DESC NULLS LAST`);
  res.json(apiResponse(rows));
}));

// ─── Settings — FIXED: tokens/chains/fee_configs in pocketx_collector ───
app.get('/api/v2/admin/settings', requireAdmin, asyncHandler(async (_req: any, res: any) => {
  const [tokens, chains, feeConfigs] = await Promise.all([
    pools.collector.query('SELECT * FROM tokens ORDER BY symbol').catch(() => ({ rows: [] })),
    pools.collector.query('SELECT * FROM chains ORDER BY chain_id').catch(() => ({ rows: [] })),
    pools.collector.query('SELECT fc.*, t.symbol FROM fee_configs fc LEFT JOIN tokens t ON t.id = fc.token_id').catch(() => ({ rows: [] })),
  ]);
  res.json(apiResponse({ tokens: tokens.rows, chains: chains.rows, feeConfigs: feeConfigs.rows }));
}));

// ─── Risk Rules — FIXED: catch table-missing error ───
app.get('/api/v2/admin/risk-rules', requireAdmin, asyncHandler(async (_req: any, res: any) => {
  const { rows } = await pools.waas.query('SELECT * FROM risk_rules ORDER BY updated_at DESC').catch(() => ({ rows: [] }));
  res.json(apiResponse(rows));
}));

app.get('/api/v2/admin/token-blacklist', requireAdmin, asyncHandler(async (_req: any, res: any) => {
  const { rows } = await pools.waas.query('SELECT * FROM token_blacklist ORDER BY created_at DESC').catch(() => ({ rows: [] }));
  res.json(apiResponse(rows));
}));

// ─── Audit — FIXED: try collector→waas→dc→empty ───
app.get('/api/v2/admin/audit', requireAdmin, asyncHandler(async (_req: any, res: any) => {
  for (const p of [pools.collector, pools.waas, pools.dc]) {
    try { const r = await p.query("SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 200"); return res.json(apiResponse(r.rows)); } catch {}
  }
  res.json(apiResponse([], "No audit table found"));
}));

// ─── WAAS Panel: wallet stats ───
app.get('/api/v2/admin/waas/stats', requireAdmin, asyncHandler(async (_req: any, res: any) => {
  const [users, wallets, txns, subs] = await Promise.all([
    pools.waas.query("SELECT COUNT(*)::int as cnt FROM users").then(r => r.rows[0].cnt).catch(() => 0),
    pools.waas.query("SELECT COUNT(*)::int as cnt FROM wallets").then(r => r.rows[0].cnt).catch(() => 0),
    pools.waas.query("SELECT COUNT(*)::int as cnt FROM transactions").then(r => r.rows[0].cnt).catch(() => 0),
    pools.waas.query("SELECT COUNT(*)::int as cnt FROM subscriptions WHERE status='active'").then(r => r.rows[0].cnt).catch(() => 0),
  ]);
  res.json(apiResponse({ users, wallets, transactions: txns, activeSubs: subs }));
}));

app.get('/api/v2/admin/waas/subscriptions', requireAdmin, asyncHandler(async (_req: any, res: any) => {
  const r = await pools.waas.query("SELECT * FROM subscriptions ORDER BY created_at DESC LIMIT 100");
  res.json(apiResponse(r.rows));
}));

// ─── DC Panel — FIXED: events/checkpoints/tokens in collector, dc_subscriptions in waas ───
app.get('/api/v2/admin/dc/stats', requireAdmin, asyncHandler(async (_req: any, res: any) => {
  const [events, checkpoints, subs, tokens] = await Promise.all([
    pools.collector.query("SELECT COUNT(*)::int as cnt FROM events").then(r => r.rows[0].cnt).catch(() => 0),
    pools.collector.query("SELECT * FROM event_checkpoints ORDER BY chain").then(r => r.rows).catch(() => []),
    pools.waas.query("SELECT COUNT(*)::int as cnt FROM dc_subscriptions").then(r => r.rows[0].cnt).catch(() => 0),
    pools.collector.query("SELECT COUNT(*)::int as cnt FROM tokens").then(r => r.rows[0].cnt).catch(() => 0),
  ]);
  res.json(apiResponse({ totalEvents: events, checkpoints, totalSubs: subs, totalTokens: tokens }));
}));

app.get('/api/v2/admin/dc/checkpoints', requireAdmin, asyncHandler(async (_req: any, res: any) => {
  const r = await pools.collector.query("SELECT * FROM event_checkpoints ORDER BY chain").catch(() => ({ rows: [] }));
  res.json(apiResponse(r.rows));
}));

// ─── Vault Panel — FIXED: table names safe_wallets/safe_transactions/safe_signatures ───
app.get('/api/v2/admin/vault/stats', requireAdmin, asyncHandler(async (_req: any, res: any) => {
  const [safes, txns, signatures] = await Promise.all([
    pools.vault.query("SELECT COUNT(*)::int as cnt FROM safe_wallets").then(r => r.rows[0].cnt).catch(() => 0),
    pools.vault.query("SELECT COUNT(*)::int as cnt FROM safe_transactions").then(r => r.rows[0].cnt).catch(() => 0),
    pools.vault.query("SELECT COUNT(*)::int as cnt FROM safe_signatures").then(r => r.rows[0].cnt).catch(() => 0),
  ]);
  res.json(apiResponse({ safes, transactions: txns, signatures }));
}));

app.get('/api/v2/admin/vault/safes', requireAdmin, asyncHandler(async (_req: any, res: any) => {
  const r = await pools.vault.query("SELECT * FROM safe_wallets ORDER BY created_at DESC LIMIT 100").catch(() => ({ rows: [] }));
  res.json(apiResponse(r.rows));
}));

app.get('/api/v2/admin/vault/transactions', requireAdmin, asyncHandler(async (_req: any, res: any) => {
  const r = await pools.vault.query("SELECT * FROM safe_transactions ORDER BY created_at DESC LIMIT 100").catch(() => ({ rows: [] }));
  res.json(apiResponse(r.rows));
}));

// ─── MPC Panel ───
app.get('/api/v2/admin/mpc/stats', requireAdmin, asyncHandler(async (_req: any, res: any) => {
  const [wallets, registered, recovered] = await Promise.all([
    pools.mpc.query("SELECT COUNT(*)::int as cnt FROM mpc_wallets").then(r => r.rows[0].cnt).catch(() => 0),
    pools.mpc.query("SELECT COUNT(*)::int as cnt FROM mpc_wallets WHERE status='active'").then(r => r.rows[0].cnt).catch(() => 0),
    pools.mpc.query("SELECT COUNT(*)::int as cnt FROM mpc_wallets WHERE recovered_at IS NOT NULL").then(r => r.rows[0].cnt).catch(() => 0),
  ]);
  res.json(apiResponse({ total: wallets, registered, recovered }));
}));

app.get('/api/v2/admin/mpc/wallets', requireAdmin, asyncHandler(async (_req: any, res: any) => {
  const r = await pools.mpc.query("SELECT * FROM mpc_wallets ORDER BY created_at DESC LIMIT 100");
  res.json(apiResponse(r.rows));
}));

// ─── Data Pipeline — FIXED: tables in collector ───
app.get('/api/v2/admin/okx/accounts', requireAdmin, asyncHandler(async (_req: any, res: any) => {
  const r = await pools.collector.query("SELECT * FROM okx_chainos_accounts ORDER BY created_at DESC").catch(() => ({ rows: [] }));
  res.json(apiResponse(r.rows));
}));

app.get('/api/v2/admin/okx/health', requireAdmin, asyncHandler(async (_req: any, res: any) => {
  try {
    const r = await pools.collector.query("SELECT * FROM okx_token_snapshots ORDER BY fetched_at DESC LIMIT 1");
    res.json(apiResponse({ status: 'ok', lastSnapshot: r.rows[0] }));
  } catch {
    res.json(apiResponse({ status: 'error', message: 'No OKX data' }));
  }
}));

// ─── Health ───
app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'infrax-dmin', uptime: process.uptime() }));

// ─── SPA fallback ───
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'dist', 'index.html'));
});

const PORT = parseInt(process.env.PORT || '3002', 10);
app.listen(PORT, () => console.log(`Admin API running on port ${PORT}`));

export default app;
