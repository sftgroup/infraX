import { Router } from 'express';
import { asyncHandler, apiResponse } from '../utils/helpers';
import { pool } from '../models/database';
import crypto from 'crypto';

const router = Router();

const DATA_PLANS = [
  { id: 'data_free', name: 'Data Free', price: 0, billingCycle: 'monthly',
    features: { chains: ['sepolia'], apiCallsPerMonth: 10000, dataRetentionHours: 24, realtime: false, support: 'community' } },
  { id: 'data_pro', name: 'Data Pro', price: 29, billingCycle: 'monthly',
    features: { chains: ['sepolia', 'ethereum', 'polygon', 'arbitrum', 'optimism', 'bsc', 'base'], apiCallsPerMonth: 100000, dataRetentionHours: 72, realtime: true, support: 'email' } },
  { id: 'data_enterprise', name: 'Data Enterprise', price: 99, billingCycle: 'monthly',
    features: { chains: ['sepolia', 'ethereum', 'polygon', 'arbitrum', 'optimism', 'bsc', 'base'], apiCallsPerMonth: 1000000, dataRetentionHours: -1, realtime: true, support: 'dedicated', customChains: true, sla: '99.9%' } },
];

function generateDcApiKey(): string { return 'infrax_dc_' + crypto.randomBytes(24).toString('hex'); }
function obscureKey(key: string): string { return key && key.length > 16 ? key.slice(0, 14) + '…' + key.slice(-8) : key; }

// ─── Public ───
router.get('/plans', asyncHandler(async (_req, res) => { res.json(apiResponse(DATA_PLANS)); }));

// ─── Subscribe (wallet address only — no signature needed in dev) ───
router.post('/subscribe', asyncHandler(async (req, res) => {
  const { planId } = req.body;
  if (!planId) return res.status(400).json(apiResponse(null, 'Missing planId', 1001));
  const plan = DATA_PLANS.find(p => p.id === planId);
  if (!plan) return res.status(400).json(apiResponse(null, 'Invalid plan', 1001));
  const walletAddr = ((req.headers['x-wallet-address'] as string) || '').toLowerCase();
  if (!walletAddr) return res.status(400).json(apiResponse(null, 'Missing x-wallet-address', 1001));

  // Upsert user
  let userResult = await pool.query('SELECT id FROM users WHERE wallet_address = $1 LIMIT 1', [walletAddr]);
  let userId = userResult.rows[0]?.id;
  if (!userId) {
    userResult = await pool.query("INSERT INTO users (wallet_address, role) VALUES ($1, 'user') RETURNING id", [walletAddr]);
    userId = userResult.rows[0].id;
  }

  // Find or create tenant
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

// ─── Usage ───
router.get('/usage', asyncHandler(async (req, res) => {
  const walletAddr = ((req.headers['x-wallet-address'] as string) || '').toLowerCase();
  if (!walletAddr) return res.status(400).json(apiResponse(null, 'Missing x-wallet-address', 1001));
  const tenantResult = await pool.query(
    'SELECT t.id, t.data_plan_id, t.dc_api_key FROM tenants t JOIN users u ON u.id = t.owner_user_id WHERE u.wallet_address = $1 ORDER BY t.created_at DESC LIMIT 1',
    [walletAddr]
  );
  if (tenantResult.rows.length === 0) return res.status(404).json(apiResponse(null, 'No tenant found', 2002));
  const { id: tenantId } = tenantResult.rows[0];
  const dcApiKey = tenantResult.rows[0].dc_api_key;
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
  const [totalResult, dailyResult] = await Promise.all([
    pool.query('SELECT COUNT(*)::int as total FROM api_usage WHERE tenant_id = $1 AND timestamp >= $2', [tenantId, monthStart]),
    pool.query('SELECT date, total_calls FROM api_usage_daily WHERE tenant_id = $1 AND date >= $2 ORDER BY date', [tenantId, monthStart]),
  ]);
  const planId = tenantResult.rows[0].data_plan_id || 'data_free';
  const plan = DATA_PLANS.find(p => p.id === planId) || DATA_PLANS[0];
  res.json(apiResponse({ planId, planName: plan.name, dcApiKey, dcApiKeyObscured: obscureKey(dcApiKey), monthlyQuota: plan.features.apiCallsPerMonth, currentUsage: totalResult.rows[0].total, dailyBreakdown: dailyResult.rows }));
}));

// ─── Key ───
router.get('/key', asyncHandler(async (req, res) => {
  const walletAddr = ((req.headers['x-wallet-address'] as string) || '').toLowerCase();
  if (!walletAddr) return res.status(400).json(apiResponse(null, 'Missing x-wallet-address', 1001));
  const tenantResult = await pool.query(
    'SELECT t.id, t.data_plan_id, t.dc_api_key FROM tenants t JOIN users u ON u.id = t.owner_user_id WHERE u.wallet_address = $1 ORDER BY t.created_at DESC LIMIT 1',
    [walletAddr]
  );
  if (tenantResult.rows.length === 0) return res.status(404).json(apiResponse(null, 'No tenant found', 2002));
  const regenerate = req.query.regenerate === 'true';
  let dcApiKey = tenantResult.rows[0].dc_api_key;
  if (regenerate || !dcApiKey) {
    dcApiKey = generateDcApiKey();
    await pool.query('UPDATE tenants SET dc_api_key = $1, dc_api_key_created_at = NOW() WHERE id = $2', [dcApiKey, tenantResult.rows[0].id]);
  }
  res.json(apiResponse({ dcApiKey, dcApiKeyObscured: obscureKey(dcApiKey), dataPlanId: tenantResult.rows[0].data_plan_id }));
}));

// ─── Docs ───
router.get('/docs', asyncHandler(async (_req, res) => {
  res.json(apiResponse({
    title: 'InfraX Data Center API', version: '1.0.0', baseUrl: 'https://api.infrax.io/api/v2/data',
    authentication: { method: 'API Key', header: 'x-dc-api-key', description: 'Use your Data Center API Key (independent from WaaS key) to authenticate requests.' },
    endpoints: [
      { method: 'GET', path: '/events', description: 'Query on-chain events', params: [
        { name: 'chain', type: 'string', required: false, description: 'Chain: sepolia, ethereum, polygon, arbitrum, optimism, bsc, base' },
        { name: 'address', type: 'string', required: false, description: 'Filter by from_address or to_address' },
        { name: 'event_type', type: 'string', required: false, description: 'Event type: transfer' },
        { name: 'page_size', type: 'number', required: false, description: 'Results per page (max 500)' },
        { name: 'page_token', type: 'string', required: false, description: 'Cursor for next page' },
      ], example: 'curl -H "x-dc-api-key: pocketx_dc_..." "BASE/events?chain=ethereum&page_size=50"' },
      { method: 'GET', path: '/stats', description: 'Chain-level statistics', params: [] },
      { method: 'GET', path: '/health', description: 'Collector health + storage', params: [] },
      { method: 'GET', path: '/checkpoints', description: 'Scan checkpoints', params: [] },
    ],
    notes: ['10s scan cycle', 'Retention: 24h (Free) / 72h (Pro) / Unlimited (Enterprise)', 'Rate limiting per DC API key'],
  }));
}));

export default router;
