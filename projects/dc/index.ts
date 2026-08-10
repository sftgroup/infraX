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
    // MQ-16 T-1: DC 套餐配额真实扣减——请求级用量明细 + 日聚合（对齐 waas dataSubscriptionRoutes 已读表结构）
    await pool.query(`
      CREATE TABLE IF NOT EXISTS api_usage (
        id BIGSERIAL PRIMARY KEY,
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        endpoint TEXT NOT NULL,
        timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_api_usage_tenant_ts ON api_usage(tenant_id, timestamp);
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS api_usage_daily (
        tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
        date DATE NOT NULL,
        endpoint TEXT NOT NULL DEFAULT 'total',
        total_calls INT NOT NULL DEFAULT 0,
        PRIMARY KEY (tenant_id, date, endpoint)
      );
    `);
    // MQ-16 T-1: tenants 订阅状态列（付费套餐引擎支付意图 pending→active 状态机）
    await pool.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS dc_sub_status VARCHAR(20) DEFAULT 'active';`);
    await pool.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS dc_payment_method VARCHAR(20);`);
    await pool.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS dc_payment_ref VARCHAR(200);`);
    await pool.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS dc_sub_updated_at TIMESTAMPTZ;`);
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

// ─── MQ-16 T-1: 通用支付引擎客户端（infrax-payments :9132，对齐 waas services/paymentsClient）───
// 鉴权：统一契约 X-Service-Key（与平台 bridge key 一致）。未配置 PAYMENTS_URL 时付费订阅 fail-fast。
class PaymentsError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 502, code = 'PAYMENTS_ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const PAYMENTS = {
  baseUrl: (process.env.PAYMENTS_URL || '').replace(/\/+$/, ''),
  apiKey: process.env.PAYMENTS_API_KEY || '',
  webhookSecret: process.env.PAYMENTS_WEBHOOK_SECRET || '',
  defaultChain: process.env.PAYMENTS_CHAIN || 'oxachain',
  defaultRail: process.env.PAYMENTS_DEFAULT_RAIL || 'chain',
  fiatPeriod: process.env.PAYMENTS_FIAT_PERIOD || 'month',
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:9111',
  // 链上套餐 → DC data 套餐对齐表（planId 为 SubscriptionManager.getPlan 的 id）
  planIdMap: JSON.parse(process.env.PAYMENTS_PLAN_ID_MAP || '{"data_pro":1,"data_enterprise":2}') as Record<string, number>,
};

async function paymentsCall<T = any>(path: string, init?: RequestInit): Promise<T> {
  if (!PAYMENTS.baseUrl) {
    throw new PaymentsError('PAYMENTS_URL is not configured', 503, 'PAYMENTS_NOT_CONFIGURED');
  }
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((init?.headers as Record<string, string>) ?? {}),
  };
  if (PAYMENTS.apiKey) headers['X-Service-Key'] = PAYMENTS.apiKey;
  const resp = await fetch(`${PAYMENTS.baseUrl}${path}`, { ...init, headers, signal: AbortSignal.timeout(10_000) });
  if (!resp.ok) {
    let message = `payments ${path} failed (${resp.status})`;
    try {
      const body = (await resp.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch { /* non-JSON */ }
    throw new PaymentsError(message, resp.status);
  }
  return resp.json() as Promise<T>;
}

const paymentsApi = {
  async price(planId: number, chain: string) {
    return paymentsCall<{ planId: number; price: string; period: string; active: boolean; trialDays: number; payToken: string }>(
      `/payments/price?planId=${planId}&chain=${encodeURIComponent(chain)}`
    );
  },
  async chainInfo(chain: string) {
    return paymentsCall<{ chain: string; chainId: number; subscriptionManager: string; nativeAsset: string }>(
      `/payments/chain-info/${encodeURIComponent(chain)}`
    );
  },
  async hasActiveSubscription(chain: string, subscriber: string, resourceId: number): Promise<{ active: boolean }> {
    return paymentsCall(`/payments/subscription/${encodeURIComponent(chain)}/${encodeURIComponent(subscriber.toLowerCase())}/${resourceId}`);
  },
  async checkout(input: { subscriber: string; planId: number; period: string; metadata: Record<string, unknown>; clientReference: string; successUrl?: string; cancelUrl?: string }) {
    return paymentsCall<{ method: 'fiat'; paymentId: string; sessionUrl: string; sessionId: string; clientReference: string; redirect: true }>('/payments/checkout', {
      method: 'POST',
      body: JSON.stringify({
        subscriber: input.subscriber,
        chain: PAYMENTS.defaultChain,
        planId: input.planId,
        period: input.period,
        metadata: input.metadata,
        clientReference: input.clientReference,
        successUrl: input.successUrl,
        cancelUrl: input.cancelUrl,
      }),
    });
  },
  async verify(txHash: string, chain?: string) {
    return paymentsCall<{ verified: boolean; reference?: string; payer?: string; creditedWei?: string; asset?: string; chain?: string }>('/payments/verify', {
      method: 'POST',
      body: JSON.stringify({ txHash, chain: chain ?? PAYMENTS.defaultChain }),
    });
  },
  async info() {
    return paymentsCall<{ enabled: boolean; chain: string; rails: { x402: boolean; stablecoin: boolean }; fiat: boolean; x402?: { enabled: boolean; priceWei: string; payTo: string; network: string } }>('/payments/info');
  },
};

/** 本月起点（配额按自然月结算）。 */
function monthStart(): Date {
  const d = new Date();
  d.setDate(1); d.setHours(0, 0, 0, 0);
  return d;
}

/** MQ-16 T-1: 引擎支付确认后激活 DC 订阅（pending→active，幂等；激活时补发 dc_api_key）。 */
async function activateDcSubscription(tenantId: string, method?: string, ref?: string): Promise<void> {
  const tenant = await pool.query('SELECT dc_sub_status, dc_api_key, data_plan_id FROM tenants WHERE id = $1', [tenantId]);
  if (tenant.rows.length === 0) return;
  const row = tenant.rows[0];
  if (row.dc_sub_status === 'active' && row.dc_api_key) return; // 幂等
  let dcApiKey = row.dc_api_key;
  if (!dcApiKey) dcApiKey = generateDcApiKey();
  await pool.query(
    `UPDATE tenants
     SET dc_sub_status = 'active', dc_payment_method = COALESCE($2, dc_payment_method),
         dc_payment_ref = COALESCE($3, dc_payment_ref), dc_api_key = $4,
         dc_api_key_created_at = NOW(), dc_sub_updated_at = NOW(), updated_at = NOW()
     WHERE id = $1`,
    [tenantId, method ?? null, ref ?? null, dcApiKey]
  );
  console.log(`[DC] subscription activated tenant=${tenantId} plan=${row.data_plan_id} method=${method ?? ''}`);
}

// ─── MQ-16 T-1: 配额扣减/限流中间件（requireDcApiKey 之后挂载）───
// 请求级计数（api_usage 明细 + api_usage_daily 日聚合），当月用量达到套餐配额上限 → 429 + 升级提示。
async function dcQuotaEnforce(req: any, res: any, next: any): Promise<void> {
  try {
    const tenantId = req.dcTenant?.id as string | undefined;
    if (!tenantId) { res.status(401).json(apiResponse(null, 'Invalid API key', 1004)); return; }
    const planId = req.dcTenant.data_plan_id || 'data_free';
    const plan = DATA_PLANS.find((p: any) => p.id === planId) || DATA_PLANS[0];
    const quota = plan.features.apiCallsPerMonth;
    const r = await pool.query(
      'SELECT COUNT(*)::int as cnt FROM api_usage WHERE tenant_id = $1 AND timestamp >= $2',
      [tenantId, monthStart()]
    );
    const used = r.rows[0].cnt;
    if (used >= quota) {
      return res.status(429).json(apiResponse(
        null,
        `Monthly quota exhausted (${used}/${quota} calls). Upgrade your plan at Data Center → Data plans.`,
        4290
      ));
    }
    const endpoint = req.path || 'unknown';
    await pool.query('INSERT INTO api_usage (tenant_id, endpoint) VALUES ($1, $2)', [tenantId, endpoint]);
    await pool.query(
      `INSERT INTO api_usage_daily (tenant_id, date, endpoint, total_calls)
       VALUES ($1, CURRENT_DATE, $2, 1)
       ON CONFLICT (tenant_id, date, endpoint)
       DO UPDATE SET total_calls = api_usage_daily.total_calls + 1`,
      [tenantId, endpoint]
    );
    next();
  } catch (e: any) {
    // 配额服务故障不阻断业务（记账失败仅记录，继续放行）
    console.error('[DC] quota bookkeeping failed:', e.message);
    next();
  }
}

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
  const { planId, rail } = req.body ?? {};
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

  // data_free：免费直通激活（生成 dc_api_key）
  if (plan.price === 0) {
    const dcApiKey = generateDcApiKey();
    await pool.query(
      `UPDATE tenants SET data_plan_id = $1, dc_api_key = $2, dc_api_key_created_at = NOW(),
         dc_sub_status = 'active', dc_payment_method = 'free', dc_sub_updated_at = NOW(), updated_at = NOW()
       WHERE id = $3`,
      [planId, dcApiKey, tenantId]
    );
    return res.status(200).json(apiResponse(
      { tenantId, plan: { id: plan.id, name: plan.name, price: plan.price }, dcApiKey, dcSubStatus: 'active' },
      'Data plan subscribed'
    ));
  }

  // MQ-16 T-1: 付费套餐——创建支付意图（pending），支付确认后由 payment-callback / check / verify 激活并补发 dc_api_key
  const resourceId = PAYMENTS.planIdMap[planId] ?? Number(planId);
  if (!resourceId) {
    return res.status(400).json(apiResponse(null, `No on-chain plan mapped for "${planId}" (PAYMENTS_PLAN_ID_MAP)`, 1001));
  }
  const selectedRail = rail || PAYMENTS.defaultRail;
  const chain = PAYMENTS.defaultChain;
  await pool.query(
    `UPDATE tenants SET data_plan_id = $1, dc_sub_status = 'pending', dc_payment_method = $2, dc_sub_updated_at = NOW(), updated_at = NOW() WHERE id = $3`,
    [planId, selectedRail, tenantId]
  );

  const payment: any = { rail: selectedRail, chain, planId: resourceId };
  try {
    if (selectedRail === 'chain') {
      const [planInfo, info] = await Promise.all([
        paymentsApi.price(resourceId, chain),
        paymentsApi.chainInfo(chain),
      ]);
      payment.price = planInfo.price;
      payment.period = planInfo.period;
      payment.payToken = planInfo.payToken;
      payment.trialDays = planInfo.trialDays;
      payment.subscriptionManager = info.subscriptionManager;
      payment.chainId = info.chainId;
      await pool.query('UPDATE tenants SET dc_payment_ref = $1 WHERE id = $2', [String(resourceId), tenantId]);
    } else if (selectedRail === 'fiat') {
      const checkout = await paymentsApi.checkout({
        subscriber: walletAddr || tenantId,
        planId: resourceId,
        period: PAYMENTS.fiatPeriod,
        metadata: { product: 'dc-subscription', planId, planName: plan.name, tenantId, walletAddress: walletAddr },
        clientReference: `dcsub:${tenantId}`,
        successUrl: `${PAYMENTS.corsOrigin}/#/datacenter?sub=success`,
        cancelUrl: `${PAYMENTS.corsOrigin}/#/datacenter?sub=cancelled`,
      });
      payment.sessionUrl = checkout.sessionUrl;
      payment.paymentId = checkout.paymentId;
      await pool.query('UPDATE tenants SET dc_payment_ref = $1 WHERE id = $2', [checkout.paymentId, tenantId]);
    } else if (selectedRail === 'x402') {
      const info = await paymentsApi.info();
      if (!info.enabled || !info.x402?.enabled) {
        return res.status(400).json(apiResponse(null, 'x402 rail is not enabled on the payments engine', 1002));
      }
      payment.payTo = info.x402.payTo;
      payment.priceWei = info.x402.priceWei;
      payment.network = info.x402.network;
    } else {
      return res.status(400).json(apiResponse(null, `Unknown rail: ${selectedRail}`, 1001));
    }
  } catch (err: any) {
    await pool.query("UPDATE tenants SET dc_sub_status = 'failed', dc_sub_updated_at = NOW() WHERE id = $1", [tenantId]);
    if (err instanceof PaymentsError) {
      return res.status(err.status).json(apiResponse(null, err.message, 1003));
    }
    return res.status(502).json(apiResponse(null, `Payments engine unreachable: ${err.message}`, 1003));
  }

  res.status(201).json(apiResponse(
    { tenantId, plan: { id: plan.id, name: plan.name, price: plan.price }, dcSubStatus: 'pending', payment },
    'Payment required'
  ));
}));

// MQ-16 T-1: 轮询支付状态（chain rail 链上确认；fiat/x402 依赖 payment-callback / verify）
app.post('/api/v2/data/payment-check', asyncHandler(async (req: any, res: any) => {
  const walletAddr = ((req.headers['x-wallet-address'] as string) || '').toLowerCase();
  if (!walletAddr) return res.status(400).json(apiResponse(null, 'Missing x-wallet-address', 1001));
  const tenantResult = await pool.query(
    `SELECT t.id, t.data_plan_id, t.dc_sub_status, t.dc_payment_method, t.dc_payment_ref
     FROM tenants t JOIN users u ON u.id = t.owner_user_id
     WHERE u.wallet_address = $1 ORDER BY t.created_at DESC LIMIT 1`,
    [walletAddr]
  );
  if (tenantResult.rows.length === 0) return res.json(apiResponse({ status: 'none' }));
  const tenant = tenantResult.rows[0];
  if (tenant.dc_sub_status !== 'pending') return res.json(apiResponse({ status: tenant.dc_sub_status || 'none' }));
  if (tenant.dc_payment_method === 'chain' && tenant.dc_payment_ref) {
    try {
      const resourceId = Number(tenant.dc_payment_ref);
      const { active } = await paymentsApi.hasActiveSubscription(PAYMENTS.defaultChain, walletAddr, resourceId);
      if (active) {
        await activateDcSubscription(tenant.id, 'chain', tenant.dc_payment_ref);
        return res.json(apiResponse({ status: 'active' }));
      }
    } catch (err: any) {
      console.warn(`[DC] payment-check chain rail failed: ${err.message}`);
    }
  }
  return res.json(apiResponse({ status: 'pending' }));
}));

// MQ-16 T-1: 通用支付引擎出站事件回调（由 infrax-payments WEBHOOK_FORWARD_URL 指向本端点）
// 契约同 waas subscriptionRoutes /payment-callback：x-payments-signature = HMAC-SHA256(body, PAYMENTS_WEBHOOK_SECRET)
app.post('/api/v2/data/payment-callback', asyncHandler(async (req: any, res: any) => {
  const secret = PAYMENTS.webhookSecret;
  if (!secret) {
    console.warn('[DC] payment-callback: PAYMENTS_WEBHOOK_SECRET not configured');
    return res.status(503).json(apiResponse(null, 'webhook secret not configured', 1003));
  }
  const rawBody = JSON.stringify(req.body);
  const signature = (req.headers['x-payments-signature'] as string) || '';
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const sigBuf = Buffer.from(signature, 'hex');
  const expBuf = Buffer.from(expected, 'hex');
  const valid = sigBuf.length === expBuf.length && sigBuf.length > 0 && crypto.timingSafeEqual(sigBuf, expBuf);
  if (!valid) {
    console.warn('[DC] payment-callback invalid signature');
    return res.status(401).json(apiResponse(null, 'Invalid signature', 401));
  }
  const { type, event } = req.body ?? {};
  console.log(`[DC] payment-callback type=${type}`);
  if (type === 'webhook') {
    const ref = event?.object?.client_reference_id;
    if (typeof ref === 'string' && ref.startsWith('dcsub:')) {
      await activateDcSubscription(ref.slice(6), 'fiat', event?.object?.payment_intent ?? null);
    } else {
      console.warn(`[DC] payment-callback webhook without dcsub: reference → ${ref}`);
    }
  } else if (type === 'credit') {
    const payer = typeof event?.payer === 'string' ? event.payer.toLowerCase() : '';
    if (payer) {
      const pending = await pool.query(
        `SELECT t.id FROM tenants t JOIN users u ON u.id = t.owner_user_id AND LOWER(u.wallet_address) = $1
         WHERE t.dc_sub_status = 'pending' AND t.dc_payment_method = 'x402'
         ORDER BY t.dc_sub_updated_at DESC LIMIT 1`,
        [payer]
      );
      if (pending.rows.length > 0) {
        await activateDcSubscription(pending.rows[0].id, 'x402', event?.txHash ?? null);
      } else {
        console.warn(`[DC] payment-callback credit without matching pending x402 subscription: payer=${payer}`);
      }
    }
  }
  res.json({ received: true });
}));

// MQ-16 T-1: x402 rail 支付确认——提交 txHash → 引擎 verify（幂等入账）→ payer 匹配当前钱包 → 激活 pending x402 订阅
app.post('/api/v2/data/verify', asyncHandler(async (req: any, res: any) => {
  const { txHash } = req.body ?? {};
  if (!txHash) return res.status(400).json(apiResponse(null, 'txHash is required', 1001));
  const walletAddr = ((req.headers['x-wallet-address'] as string) || '').toLowerCase();
  if (!walletAddr) return res.status(400).json(apiResponse(null, 'Missing x-wallet-address', 1001));
  const result = await paymentsApi.verify(txHash);
  if (!result.verified || !result.payer) {
    return res.json(apiResponse({ verified: false }));
  }
  if (result.payer.toLowerCase() !== walletAddr.toLowerCase()) {
    return res.status(409).json(apiResponse(null, 'tx payer does not match current wallet', 1001));
  }
  const pending = await pool.query(
    `SELECT t.id FROM tenants t JOIN users u ON u.id = t.owner_user_id AND LOWER(u.wallet_address) = $1
     WHERE t.dc_sub_status = 'pending' AND t.dc_payment_method = 'x402'
     ORDER BY t.dc_sub_updated_at DESC LIMIT 1`,
    [walletAddr]
  );
  if (pending.rows.length === 0) {
    return res.json(apiResponse({ verified: true, activated: false }));
  }
  await activateDcSubscription(pending.rows[0].id, 'x402', txHash);
  return res.json(apiResponse({ verified: true, activated: true }));
}));

app.get('/api/v2/data/usage', asyncHandler(async (req: any, res: any) => {
  const walletAddr = ((req.headers['x-wallet-address'] as string) || '').toLowerCase();
  if (!walletAddr) return res.status(400).json(apiResponse(null, 'Missing x-wallet-address', 1001));
  const tenantResult = await pool.query(
    'SELECT t.id, t.data_plan_id, t.dc_api_key, t.dc_sub_status FROM tenants t JOIN users u ON u.id = t.owner_user_id WHERE u.wallet_address = $1 ORDER BY t.created_at DESC LIMIT 1',
    [walletAddr]
  );
  if (tenantResult.rows.length === 0) return res.status(404).json(apiResponse(null, 'No tenant found', 2002));
  const tenant = tenantResult.rows[0];
  const planId = tenant.data_plan_id || 'data_free';
  const plan = DATA_PLANS.find((p: any) => p.id === planId) || DATA_PLANS[0];
  // MQ-16 T-1: 真实用量（api_usage 月度明细计数 + api_usage_daily 日聚合）
  const [totalResult, dailyResult] = await Promise.all([
    pool.query('SELECT COUNT(*)::int as total FROM api_usage WHERE tenant_id = $1 AND timestamp >= $2', [tenant.id, monthStart()]),
    pool.query('SELECT date, total_calls FROM api_usage_daily WHERE tenant_id = $1 AND date >= $2 ORDER BY date', [tenant.id, monthStart()]),
  ]);
  res.json(apiResponse({
    planId, planName: plan.name,
    dcApiKey: tenant.dc_api_key, dcApiKeyObscured: obscureKey(tenant.dc_api_key || ''),
    monthlyQuota: plan.features.apiCallsPerMonth,
    currentUsage: totalResult.rows[0].total,
    dailyBreakdown: dailyResult.rows,
    dcSubStatus: tenant.dc_sub_status || 'active',
  }));
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

app.get('/api/v2/data/events', requireDcApiKey, dcQuotaEnforce, asyncHandler(async (req: any, res: any) => {
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

app.get('/api/v2/data/stats', requireDcApiKey, dcQuotaEnforce, asyncHandler(async (_req: any, res: any) => {
  const [stats, total] = await Promise.all([
    eventsPool.query('SELECT chain, COUNT(*)::int as event_count, MAX(block_number)::bigint as latestBlock, COUNT(DISTINCT tx_hash)::int as uniqueTx FROM events GROUP BY chain ORDER BY event_count DESC'),
    eventsPool.query('SELECT COUNT(*)::int as cnt FROM events'),
  ]);
  res.json(apiResponse({ chains: stats.rows, totalRows: total.rows[0].cnt }));
}));

app.get('/api/v2/data/health', requireDcApiKey, dcQuotaEnforce, asyncHandler(async (_req: any, res: any) => {
  const [total, cp] = await Promise.all([
    eventsPool.query('SELECT COUNT(*)::int as cnt FROM events'),
    eventsPool.query('SELECT chain, collector_name, last_block, status, last_fetch_at FROM event_checkpoints ORDER BY chain'),
  ]);
  res.json(apiResponse({ status: 'ok', totalEvents: total.rows[0].cnt, checkpoints: cp.rows }));
}));

app.get('/api/v2/data/checkpoints', requireDcApiKey, dcQuotaEnforce, asyncHandler(async (_req: any, res: any) => {
  const r = await eventsPool.query('SELECT chain, collector_name, last_block, status, last_fetch_at FROM event_checkpoints ORDER BY chain');
  res.json(apiResponse(r.rows));
}));

// MQ-3: B-end token 目录（SDK dc.tokens() / MCP dc_tokens 调用的端点，原 404）
// 数据来源 collector okx_token_snapshots（每 token 取最新一条，去重）
app.get('/api/v2/data/tokens', requireDcApiKey, dcQuotaEnforce, asyncHandler(async (req: any, res: any) => {
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
app.get('/api/v2/data/raw-receipt', requireDcApiKey, dcQuotaEnforce, asyncHandler(async (req: any, res: any) => {
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

// MQ-10 DC-1/DC-9: 统一走 chain-rpc 网关（唯一读入口，读 key）；网关不可用直接抛错，
// 禁止回退直连上游 RPC（全链统一汇总分发）。RPC_ENDPOINTS 仅保留链名校验用。
const CHAIN_RPC_URL = (process.env.CHAIN_RPC_URL || '').replace(/\/+$/, '');
const CHAIN_RPC_READ_KEY = process.env.CHAIN_RPC_READ_KEY || '';

async function rpcCall(chain: string, method: string, params: any[]): Promise<any> {
  if (!CHAIN_RPC_URL) throw new Error('[DC] CHAIN_RPC_URL not configured: gateway is the only RPC entry');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const r = await fetch(`${CHAIN_RPC_URL}/v1/rpc/${encodeURIComponent(chain)}`, {
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
