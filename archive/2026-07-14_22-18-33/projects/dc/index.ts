// InfraX DC Server — Data Center Service
// API: subscription management + B-end data query (events/stats/checkpoints)
// API: subscription management + B-end data query (events/stats/checkpoints)
// DB: pocketx_dc (independent PostgreSQL)
import express from 'express';
import { Pool } from 'pg';
import crypto from 'crypto';
import cors from 'cors';
import { randomUUID } from 'crypto';

// ─── Collector API proxy ───
const COLLECTOR_BASE = process.env.COLLECTOR_API_URL || 'http://localhost:3008';
const COLLECTOR_API_KEY = process.env.COLLECTOR_API_KEY || 'pkx_141e16eb5bf5cb8d3fd7cc03fef8a1c76956d1fe9c032e4a';

async function collectorFetch(path: string): Promise<any> {
  const url = `${COLLECTOR_BASE}${path}`;
  const resp = await fetch(url, { headers: { 'x-api-key': COLLECTOR_API_KEY } });
  if (!resp.ok) throw new Error(`Collector ${resp.status}: ${await resp.text().catch(() => '')}`);
  const json = await resp.json();
  return json.data;
}

const app = express();
app.use(express.json());
app.use(cors({ origin: true, credentials: true }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://ubuntu@localhost:5432/pocketx_dc',
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

// ─── Helpers ───
function asyncHandler(fn: any) {
  return (req: any, res: any, next: any) => Promise.resolve(fn(req, res, next)).catch(next);
}
function apiResponse(data: any = null, message = 'success', code = 0) {
  return { code, message, data };
}

// ─── Data Plans ───
const DATA_PLANS = [
  { id: 'data_free', name: 'Data Free', price: 0, billingCycle: 'monthly',
    features: { chains: ['sepolia'], apiCallsPerMonth: 10000, dataRetentionHours: 24, realtime: false, support: 'community' } },
  { id: 'data_pro', name: 'Data Pro', price: 29, billingCycle: 'monthly',
    features: { chains: ['sepolia', 'ethereum', 'polygon', 'arbitrum', 'optimism', 'bsc', 'base'], apiCallsPerMonth: 100000, dataRetentionHours: 72, realtime: true, support: 'email' } },
  { id: 'data_enterprise', name: 'Data Enterprise', price: 99, billingCycle: 'monthly',
    features: { chains: ['sepolia', 'ethereum', 'polygon', 'arbitrum', 'optimism', 'bsc', 'base'], apiCallsPerMonth: 1000000, dataRetentionHours: -1, realtime: true, support: 'dedicated', customChains: true, sla: '99.9%' } },
];

function generateDcApiKey(): string { return `infrax_dc_` + crypto.randomBytes(24).toString('hex'); }
function obscureKey(key: string): string { return key && key.length > 16 ? key.slice(0, 14) + '…' + key.slice(-8) : key; }

// ─── DC Auth middleware ───

async function requireDcApiKey(req: any, res: any, next: any): Promise<void> {
  const apiKey = (req.headers['x-dc-api-key'] as string) || '';
  if (!apiKey) { res.status(401).json(apiResponse(null, 'Missing x-dc-api-key', 1003)); return; }
  try {
    const result = await pool.query(
      "SELECT id, data_plan_id, status FROM tenants WHERE dc_api_key = $1 AND status = 'active' LIMIT 1",
      [apiKey]
    );
    if (result.rows.length === 0) { res.status(401).json(apiResponse(null, 'Invalid API key', 1004)); return; }
    req.dcTenant = result.rows[0];
    next();
  } catch (err: any) {
    res.status(500).json(apiResponse(null, 'Auth error: ' + err.message, -1));
  }
}

// ─── Subscription Endpoints (no auth) ───

app.get('/api/v2/data/plans', asyncHandler(async (_req: any, res: any) => {
  res.json(apiResponse(DATA_PLANS));
}));

app.post('/api/v2/data/subscribe', asyncHandler(async (req: any, res: any) => {
  const { planId } = req.body;
  if (!planId) return res.status(400).json(apiResponse(null, 'Missing planId', 1001));
  const plan = DATA_PLANS.find((p: any) => p.id === planId);
  if (!plan) return res.status(400).json(apiResponse(null, 'Invalid plan', 1001));
  const walletAddr = ((req.headers['x-wallet-address'] as string) || '').toLowerCase();
  if (!walletAddr) return res.status(400).json(apiResponse(null, 'Missing x-wallet-address', 1001));

  let userResult = await pool.query('SELECT id FROM users WHERE wallet_address = $1 LIMIT 1', [walletAddr]);
  let userId = userResult.rows[0]?.id;
  if (!userId) {
    userResult = await pool.query("INSERT INTO users (wallet_address, role) VALUES ($1, 'user') RETURNING id", [walletAddr]);
    userId = userResult.rows[0].id;
  }

  let tenantResult = await pool.query('SELECT t.id FROM tenants t WHERE t.owner_user_id = $1 ORDER BY t.created_at DESC LIMIT 1', [userId]);
  let tenantId = tenantResult.rows[0]?.id;
  if (!tenantId) {
    tenantResult = await pool.query(
      "INSERT INTO tenants (id, name, owner_user_id, data_plan_id, api_key, api_secret_hash, status) VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 'active') RETURNING id",
      ['DC Tenant', userId, planId, crypto.randomBytes(16).toString('hex'), crypto.randomBytes(32).toString('hex')]
    );
    tenantId = tenantResult.rows[0].id;
  }

  const dcApiKey = generateDcApiKey();
  await pool.query('UPDATE tenants SET data_plan_id = $1, dc_api_key = $2, dc_api_key_created_at = NOW(), updated_at = NOW() WHERE id = $3', [planId, dcApiKey, tenantId]);
  res.status(200).json(apiResponse({ tenantId, plan: { id: plan.id, name: plan.name, price: plan.price }, dcApiKey }, 'Data plan subscribed'));
}));

app.get('/api/v2/data/usage', asyncHandler(async (req: any, res: any) => {
  const walletAddr = ((req.headers['x-wallet-address'] as string) || '').toLowerCase();
  if (!walletAddr) return res.status(400).json(apiResponse(null, 'Missing x-wallet-address', 1001));
  const tenantResult = await pool.query(
    'SELECT t.id, t.data_plan_id, t.dc_api_key FROM tenants t JOIN users u ON u.id = t.owner_user_id WHERE u.wallet_address = $1 ORDER BY t.created_at DESC LIMIT 1',
    [walletAddr]
  );
  if (tenantResult.rows.length === 0) return res.status(404).json(apiResponse(null, 'No tenant found', 2002));
  const planId = tenantResult.rows[0].data_plan_id || 'data_free';
  const plan = DATA_PLANS.find((p: any) => p.id === planId) || DATA_PLANS[0];
  res.json(apiResponse({ planId, planName: plan.name, dcApiKey: tenantResult.rows[0].dc_api_key, monthlyQuota: plan.features.apiCallsPerMonth, currentUsage: 0, dailyBreakdown: [] }));
}));

app.get('/api/v2/data/key', asyncHandler(async (req: any, res: any) => {
  const walletAddr = ((req.headers['x-wallet-address'] as string) || '').toLowerCase();
  if (!walletAddr) return res.status(400).json(apiResponse(null, 'Missing x-wallet-address', 1001));
  const tenantResult = await pool.query(
    'SELECT t.id, t.data_plan_id, t.dc_api_key FROM tenants t JOIN users u ON u.id = t.owner_user_id WHERE u.wallet_address = $1 ORDER BY t.created_at DESC LIMIT 1',
    [walletAddr]
  );
  if (tenantResult.rows.length === 0) return res.status(404).json(apiResponse(null, 'No tenant found', 2002));
  res.json(apiResponse({ dcApiKey: tenantResult.rows[0].dc_api_key, dcApiKeyObscured: obscureKey(tenantResult.rows[0].dc_api_key || ''), dataPlanId: tenantResult.rows[0].data_plan_id }));
}));

// ─── B-end Data Query Endpoints (require x-dc-api-key) — proxy to Collector REST API ───

app.get('/api/v2/data/events', requireDcApiKey, asyncHandler(async (req: any, res: any) => {
  const params = new URLSearchParams();
  if (req.query.chain)      params.set('chain', req.query.chain);
  if (req.query.address)    params.set('address', req.query.address);
  if (req.query.contract)   params.set('contract', req.query.contract);
  if (req.query.event_type) params.set('event_type', req.query.event_type);
  if (req.query.from_block) params.set('from_block', req.query.from_block);
  if (req.query.to_block)   params.set('to_block', req.query.to_block);
  if (req.query.page_size)  params.set('page_size', req.query.page_size);
  if (req.query.page_token) params.set('page_token', req.query.page_token);
  const qs = params.toString();
  const data = await collectorFetch(`/api/v2/data/events${qs ? '?' + qs : ''}`);
  res.json(apiResponse(data));
}));

app.get('/api/v2/data/stats', requireDcApiKey, asyncHandler(async (_req: any, res: any) => {
  const data = await collectorFetch('/api/v2/data/stats');
  res.json(apiResponse(data));
}));

app.get('/api/v2/data/health', requireDcApiKey, asyncHandler(async (_req: any, res: any) => {
  const data = await collectorFetch('/api/v2/data/health');
  res.json(apiResponse({ status: data.status || 'ok', totalEvents: data.scanners ? 'see scanners' : 'ok', checkpoints: data.checkpoints || [] }));
}));

app.get('/api/v2/data/checkpoints', requireDcApiKey, asyncHandler(async (_req: any, res: any) => {
  const data = await collectorFetch('/api/v2/data/checkpoints');
  res.json(apiResponse(data));
}));

app.get('/api/v2/data/docs', asyncHandler(async (_req: any, res: any) => {
  res.json(apiResponse({
    title: 'InfraX Data Center API', version: '1.0.0',
    endpoints: [
      { method: 'GET', path: '/plans', description: 'List data plans' },
      { method: 'POST', path: '/subscribe', description: 'Subscribe to a plan' },
      { method: 'GET', path: '/key', description: 'Get API key' },
      { method: 'GET', path: '/events', description: 'Query on-chain events (auth)' },
      { method: 'GET', path: '/stats', description: 'Chain statistics (auth)' },
      { method: 'GET', path: '/health', description: 'DC service health (auth)' },
      { method: 'GET', path: '/checkpoints', description: 'Scan checkpoints (auth)' },
    ],
  }));
}));

// ═══════════════════════════════════════════════════
// ─── Health ───
app.get('/health', asyncHandler(async (_req: any, res: any) => {
  res.json({ status: 'ok', service: 'infrax-dc', uptime: process.uptime() });
}));

const PORT = parseInt(process.env.PORT || '3001', 10);
app.listen(PORT, () => {
  console.log(`DC service running on port ${PORT}`);
});

export default app;
