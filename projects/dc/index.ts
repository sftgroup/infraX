// InfraX DC Server — Data Center Service
// API: subscription management + B-end data query (events/stats/checkpoints)
// API: subscription management + B-end data query (events/stats/checkpoints)
// DB: pocketx_dc (independent PostgreSQL)
import express from 'express';
import { Pool } from 'pg';
import crypto from 'crypto';
import cors from 'cors';
import { randomUUID } from 'crypto';

// ─── DB Pools: dc service uses pocketx_dc (users/tenants) + pocketx_collector (events) ───
const eventsPool = new Pool({
  connectionString: process.env.COLLECTOR_DB_URL || 'postgresql://ubuntu@localhost:5432/pocketx_collector',
  max: 5, idleTimeoutMillis: 30000, connectionTimeoutMillis: 5000,
});

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
    features: { chains: ['sepolia', 'ethereum', 'polygon', 'arbitrum', 'optimism', 'bsc', 'base', 'oxa'], apiCallsPerMonth: 100000, dataRetentionHours: 72, realtime: true, support: 'email' } },
  { id: 'data_enterprise', name: 'Data Enterprise', price: 99, billingCycle: 'monthly',
    features: { chains: ['sepolia', 'ethereum', 'polygon', 'arbitrum', 'optimism', 'bsc', 'base', 'oxa'], apiCallsPerMonth: 1000000, dataRetentionHours: -1, realtime: true, support: 'dedicated', customChains: true, sla: '99.9%' } },
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

// ─── B-end Data Query Endpoints (require x-dc-api-key, direct DB on pocketx_collector) ───

app.get('/api/v2/data/events', requireDcApiKey, asyncHandler(async (req: any, res: any) => {
  const pageSize = Math.min(parseInt(req.query.page_size) || 100, 500);
  const conditions: string[] = [];
  const values: any[] = [];
  let idx = 1;
  if (req.query.chain)     { conditions.push(`chain = $${idx++}`); values.push(req.query.chain.toLowerCase()); }
  if (req.query.address)   { conditions.push(`(from_address = $${idx} OR to_address = $${idx})`); values.push(req.query.address.toLowerCase()); idx++; }
  if (req.query.contract)  { conditions.push(`contract_address = $${idx++}`); values.push(req.query.contract.toLowerCase()); }
  if (req.query.event_type){ conditions.push(`event_type = $${idx++}`); values.push(req.query.event_type); }
  if (req.query.from_block){ conditions.push(`block_number >= $${idx++}`); values.push(parseInt(req.query.from_block)); }
  if (req.query.to_block)  { conditions.push(`block_number <= $${idx++}`); values.push(parseInt(req.query.to_block)); }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const q = `SELECT event_id, event_type, chain, block_number, tx_hash, from_address, to_address, contract_address, token_address, token_symbol, amount, amount_raw, confirmations, collected_at, created_at FROM events ${where} ORDER BY block_number DESC, event_id ASC LIMIT $${idx}`;
  const result = await eventsPool.query(q, values.concat(pageSize + 1));
  const rows = result.rows;
  let next_token: string | null = null;
  if (rows.length > pageSize) { rows.pop(); const last = rows[rows.length - 1]; next_token = Buffer.from(JSON.stringify({ block_number: parseInt(last.block_number), event_id: last.event_id })).toString('base64'); }
  res.json(apiResponse({ data: rows, next_page_token: next_token }));
}));

app.get('/api/v2/data/stats', requireDcApiKey, asyncHandler(async (_req: any, res: any) => {
  const [stats, total] = await Promise.all([
    eventsPool.query('SELECT chain, COUNT(*)::int as event_count, MAX(block_number)::bigint as latestBlock, COUNT(DISTINCT tx_hash)::int as uniqueTx FROM events GROUP BY chain ORDER BY event_count DESC'),
    eventsPool.query('SELECT COUNT(*)::int as cnt FROM events'),
  ]);
  res.json(apiResponse({ chains: stats.rows, totalRows: total.rows[0].cnt }));
}));

app.get('/api/v2/data/health', requireDcApiKey, asyncHandler(async (_req: any, res: any) => {
  const [total, cp] = await Promise.all([
    eventsPool.query('SELECT COUNT(*)::int as cnt FROM events'),
    eventsPool.query('SELECT chain, collector_name, last_block, status, last_fetch_at FROM event_checkpoints ORDER BY chain'),
  ]);
  res.json(apiResponse({ status: 'ok', totalEvents: total.rows[0].cnt, checkpoints: cp.rows }));
}));

app.get('/api/v2/data/checkpoints', requireDcApiKey, asyncHandler(async (_req: any, res: any) => {
  const r = await eventsPool.query('SELECT chain, collector_name, last_block, status, last_fetch_at FROM event_checkpoints ORDER BY chain');
  res.json(apiResponse(r.rows));
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

// ═══════════════════════════════════════════════════
// Balance API — queries RPC via InfraX own endpoints
// ═══════════════════════════════════════════════════
const RPC_ENDPOINTS: Record<string, string> = {
  sepolia: "https://ethereum-sepolia-rpc.publicnode.com",
  eth:     "https://ethereum-rpc.publicnode.com",
  bsc:     "https://bsc-dataseed.bnbchain.org",
  base:    "https://mainnet.base.org",
  oxa:     "https://rpc-oxa.0xainet.top",
};

async function rpcCall(chain: string, method: string, params: any[]): Promise<any> {
  const url = RPC_ENDPOINTS[chain];
  if (!url) throw new Error(`No RPC for ${chain}`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || "RPC error");
    return j.result;
  } finally { clearTimeout(timeout); }
}

async function getChainBalance(address: string, chain: string) {
  try {
    const hex = await rpcCall(chain, "eth_getBalance", [address, "latest"]);
    const wei = BigInt(hex);
    const eth = Number(wei) / 1e18;
    return { chain, balance: eth.toFixed(6) };
  } catch (e: any) {
    return { chain, balance: "0", error: e.message };
  }
}

app.get("/api/v2/data/balance", asyncHandler(async (req: any, res: any) => {
  const addr = (req.query.address || req.headers["x-wallet-address"] || "").toString().toLowerCase();
  if (!addr || !/^0x[0-9a-f]{40}$/.test(addr)) {
    return res.json(apiResponse(null, "Invalid address", 1001));
  }
  const allChains = ["sepolia", "eth", "bsc", "base", "oxa"];
  const chainFilter = (req.query.chain || "").toString().toLowerCase();
  const chains = chainFilter && allChains.includes(chainFilter) ? [chainFilter] : allChains;
  const results = await Promise.all(chains.map(c => getChainBalance(addr, c)));
  const total = results.reduce((s, r) => s + parseFloat(r.balance), 0);
  res.json(apiResponse({
    address: addr,
    chainBalances: results,
    totalUsd: "0.00", // token prices later
    nativeTotal: total.toFixed(6),
  }));
}));

// Update docs to include balance endpoint
const _origDocs = app._router?.stack?.find((s: any) => s.route?.path === "/api/v2/data/docs");
