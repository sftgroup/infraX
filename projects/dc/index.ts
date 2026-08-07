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

// ─── Init tables on startup ───
(async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        wallet_address TEXT NOT NULL UNIQUE,
        role TEXT DEFAULT 'user',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_users_wallet ON users(wallet_address);
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tenants (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        owner_user_id INTEGER REFERENCES users(id),
        data_plan_id TEXT,
        api_key TEXT,
        api_secret_hash TEXT,
        dc_api_key TEXT,
        dc_api_key_created_at TIMESTAMPTZ,
        status TEXT DEFAULT 'active',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_tenants_owner ON tenants(owner_user_id);
      CREATE INDEX IF NOT EXISTS idx_tenants_dc_key ON tenants(dc_api_key);
    `);
    console.log('[DC] Tables initialized successfully');
  } catch (e: any) {
    console.error('[DC] Table init error:', e.message);
  }
})();

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

// Supported chains list
const SUPPORTED_CHAINS = [
  { name: 'sepolia', chainId: 11155111, type: 'evm', network: 'testnet', rpc: 'https://ethereum-sepolia-rpc.publicnode.com' },
  { name: 'ethereum', chainId: 1, type: 'evm', network: 'mainnet', rpc: 'https://ethereum-rpc.publicnode.com' },
  { name: 'bsc', chainId: 56, type: 'evm', network: 'mainnet', rpc: 'https://bsc-dataseed.bnbchain.org' },
  { name: 'base', chainId: 8453, type: 'evm', network: 'l2', rpc: 'https://mainnet.base.org' },
  { name: 'oxa', chainId: 19505, type: 'evm', network: 'l1', rpc: 'https://rpc.l1.oxachain.io' },
];

app.get('/api/v2/data/plans', asyncHandler(async (_req: any, res: any) => {
  res.json(apiResponse(DATA_PLANS));
}));

app.get('/api/v2/data/chains', asyncHandler(async (_req: any, res: any) => {
  res.json(apiResponse(SUPPORTED_CHAINS));
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
  // raw 字段导出（高级租户自解析）：topic_hash（topic0 签名哈希）、amount_raw（原始精度金额）、event_data（原始日志元数据 jsonb）
  const q = `SELECT event_id, event_type, chain, block_number, tx_hash, from_address, to_address, contract_address, token_address, token_symbol, amount, amount_raw, topic_hash, event_data, confirmations, collected_at, created_at FROM events ${where} ORDER BY block_number DESC, event_id ASC LIMIT $${idx}`;
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

// MQ-3: B-end token 目录（SDK dc.tokens() / MCP dc_tokens 调用的端点，原 404）
// 数据来源 collector okx_token_snapshots（每 token 取最新一条，去重）
app.get('/api/v2/data/tokens', requireDcApiKey, asyncHandler(async (req: any, res: any) => {
  const conditions: string[] = [];
  const values: any[] = [];
  let idx = 1;
  if (req.query.symbol) { conditions.push(`token_symbol ILIKE $${idx++}`); values.push(`%${req.query.symbol}%`); }
  if (req.query.chain) { conditions.push(`chain = $${idx++}`); values.push(String(req.query.chain).toLowerCase()); }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limit = Math.min(parseInt(req.query.limit) || 200, 500);
  const r = await eventsPool.query(
    `SELECT DISTINCT ON (token_address) token_address, token_symbol, token_name, chain, price_usd
     FROM okx_token_snapshots ${where}
     ORDER BY token_address, collected_at DESC
     LIMIT $${idx}`,
    values.concat(limit)
  );
  res.json(apiResponse(r.rows.map((t: any) => ({
    symbol: t.token_symbol,
    name: t.token_name || t.token_symbol,
    address: t.token_address,
    chain: t.chain,
    decimals: 18,
    price_usd: parseFloat(t.price_usd) || 0,
  }))));
}));

// Raw receipt 导出：按 tx_hash 实时从链节点拉取**完整原始 receipt logs**
// （topics 全量数组 + data 字节，含 topic0 事件签名哈希），供高级租户自解析。
// 不落库、即时取，与 events 表的结构化数据互补（raw 查询 → 自解析 / 结构化 → 直接用）。
app.get('/api/v2/data/raw-receipt', requireDcApiKey, asyncHandler(async (req: any, res: any) => {
  const chain = (req.query.chain || '').toString().toLowerCase();
  const txHash = (req.query.tx_hash || '').toString().toLowerCase();
  if (!chain || !/^0x[0-9a-f]{64}$/.test(txHash)) {
    return res.status(400).json(apiResponse(null, 'chain and tx_hash (0x + 64 hex) required', 1001));
  }
  if (!RPC_ENDPOINTS[chain]) {
    return res.status(400).json(apiResponse(null, `unsupported chain: ${chain}`, 1001));
  }
  try {
    const receipt = await rpcCall(chain, 'eth_getTransactionReceipt', [txHash]);
    if (!receipt) {
      return res.json(apiResponse({ tx_hash: txHash, chain, status: 'pending_or_not_found', logs: [] }));
    }
    res.json(apiResponse({
      tx_hash: txHash,
      chain,
      status: receipt.status === '0x1' ? 'success' : 'failed',
      block_number: receipt.blockNumber ? parseInt(receipt.blockNumber, 16) : null,
      contract_address: receipt.contractAddress || null,
      logs: (receipt.logs || []).map((l: any) => ({
        address: l.address,
        topics: l.topics,          // 原始 topics（topics[0] = 事件签名 keccak）
        data: l.data,              // 原始 data（ABI 编码参数，可配合 ABI 解码）
        block_number: l.blockNumber ? parseInt(l.blockNumber, 16) : null,
        log_index: l.logIndex ? parseInt(l.logIndex, 16) : null,
        transaction_hash: l.transactionHash,
      })),
    }));
  } catch (e: any) {
    res.status(502).json(apiResponse(null, 'RPC error: ' + e.message, -1));
  }
}));

app.get('/api/v2/data/docs', asyncHandler(async (_req: any, res: any) => {
  res.json(apiResponse({
    title: 'InfraX Data Center API', version: '1.0.0',
    endpoints: [
      { method: 'GET', path: '/plans', description: 'List data plans' },
      { method: 'POST', path: '/subscribe', description: 'Subscribe to a plan' },
      { method: 'GET', path: '/key', description: 'Get API key' },
      { method: 'GET', path: '/events', description: 'Query on-chain events (auth, 含 topic_hash/amount_raw/event_data raw 字段)' },
      { method: 'GET', path: '/raw-receipt', description: '导出 tx 完整原始 receipt logs（topics+data，实时 RPC，auth）' },
      { method: 'GET', path: '/stats', description: 'Chain statistics (auth)' },
      { method: 'GET', path: '/tokens', description: 'DEX token catalog (auth, MQ-3)' },
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
  oxa:     "https://rpc.l1.oxachain.io",
};

// MQ-10 DC-1: 优先走 chain-rpc 网关（统一池化 RPC，读 key）；
// 未配置 CHAIN_RPC_URL 或网关失败时回退直连 RPC_ENDPOINTS（兼容旧行为）。
const CHAIN_RPC_URL = process.env.CHAIN_RPC_URL || '';
const CHAIN_RPC_READ_KEY = process.env.CHAIN_RPC_READ_KEY || '';

async function rpcCall(chain: string, method: string, params: any[]): Promise<any> {
  if (CHAIN_RPC_URL) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        const r = await fetch(`${CHAIN_RPC_URL.replace(/\/$/, '')}/v1/rpc/${encodeURIComponent(chain)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Service-Key": CHAIN_RPC_READ_KEY || "" },
          body: JSON.stringify({ method, params }),
          signal: controller.signal,
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j.detail || `gateway ${r.status}`);
        // chain-rpc 统一信封 {code, message, data:{chain, method, result}}
        if (j.code === 0) return j.data?.result;
        throw new Error(j.message || "gateway error");
      } finally { clearTimeout(timeout); }
    } catch (e: any) {
      console.warn(`[DC] chain-rpc gateway fallback for ${chain}.${method}: ${e.message}`);
    }
  }

  // 直连 fallback（原有逻辑）
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
