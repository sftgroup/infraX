/**
 * MQ-16 T-3: Chain RPC 对外读套餐（按次/按带宽 → period 周期授权，key 与订阅绑定）
 *
 * 对齐 dc T-1 / collector T-2 模式：
 *   业务服务管"权益激活"（rpc_keys.rpc_* 状态机），支付引擎管"钱"
 *   （chain/fiat/x402 收钱 + period 周期授权扣费）。
 *
 * 设计要点：
 *   - chain-rpc 新增独立库（默认 pocketx_chainrpc，DATABASE_URL 可覆盖）
 *   - `rx_` 前缀 key 由本服务签发，订阅绑定到 key（rpc_keys 表，仅存 SHA-256 哈希）
 *   - 本地 bridge key（CHAIN_RPC_READ_KEY / BROADCAST_KEY）豁免配额（平台内部服务用）
 *   - 套餐按自然月结算，配额 = features.callsPerMonth；超配额 → 503 + 升级提示
 */
import crypto from 'crypto';
import { Pool } from 'pg';

export const RPC_PLANS = [
  { id: 'rpc_free', name: 'RPC Free', price: 0, billingCycle: 'monthly',
    features: { callsPerMonth: 10000, bandwidth: '5GB' } },
  { id: 'rpc_pro', name: 'RPC Pro', price: 79, billingCycle: 'monthly',
    features: { callsPerMonth: 100000, bandwidth: '50GB' } },
  { id: 'rpc_enterprise', name: 'RPC Enterprise', price: 299, billingCycle: 'monthly',
    features: { callsPerMonth: 1000000, bandwidth: '500GB' } },
];

// ─── DB Pool（独立库，表结构自举） ─────────────────────────────
export const rpcPool = new Pool({
  connectionString: process.env.CHAIN_RPC_DATABASE_URL || 'postgresql://ubuntu@localhost:5432/pocketx_chainrpc',
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

export async function initRpcTables(): Promise<void> {
  await rpcPool.query(`
    CREATE TABLE IF NOT EXISTS rpc_keys (
      id SERIAL PRIMARY KEY,
      label TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,       -- SHA-256 hex，不存明文
      key_prefix TEXT NOT NULL,            -- 前 8 位，掩码展示
      key_tail TEXT NOT NULL,              -- 后 4 位，掩码展示
      rpc_plan_id TEXT NOT NULL DEFAULT 'rpc_free',
      rpc_sub_status VARCHAR(20) NOT NULL DEFAULT 'active',   -- free→pending→active
      rpc_payment_method VARCHAR(20),
      rpc_payment_ref VARCHAR(200),
      rpc_sub_updated_at TIMESTAMPTZ,
      enabled BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_rpc_keys_hash ON rpc_keys(key_hash);
  `);
  // MQ-16 T-3: 请求级用量明细 + 日聚合（对齐 dc api_usage 结构）
  await rpcPool.query(`
    CREATE TABLE IF NOT EXISTS rpc_usage (
      id BIGSERIAL PRIMARY KEY,
      key_id INTEGER NOT NULL REFERENCES rpc_keys(id) ON DELETE CASCADE,
      endpoint TEXT NOT NULL,
      timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_rpc_usage_key_ts ON rpc_usage(key_id, timestamp);
  `);
  await rpcPool.query(`
    CREATE TABLE IF NOT EXISTS rpc_usage_daily (
      key_id INTEGER NOT NULL REFERENCES rpc_keys(id) ON DELETE CASCADE,
      date DATE NOT NULL,
      endpoint TEXT NOT NULL DEFAULT 'total',
      total_calls INT NOT NULL DEFAULT 0,
      PRIMARY KEY (key_id, date, endpoint)
    );
  `);
  console.log('[chain-rpc] rpc subscription tables initialized');
}

/** 本月起点（配额按自然月结算）。 */
export function monthStart(): Date {
  const d = new Date();
  d.setDate(1); d.setHours(0, 0, 0, 0);
  return d;
}

// ─── 支付引擎客户端（infrax-payments :9132，对齐 dc paymentsApi）───
export class PaymentsError extends Error {
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
  // 链上套餐 → RPC 套餐对齐表（planId 为 SubscriptionManager.getPlan 的 id）
  planIdMap: JSON.parse(process.env.PAYMENTS_PLAN_ID_MAP || '{"rpc_pro":5,"rpc_enterprise":6}') as Record<string, number>,
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

export const paymentsApi = {
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

/** 生成 `rx_` 前缀读 key。 */
export function generateRpcKey(): string {
  return 'rx_' + crypto.randomBytes(24).toString('hex');
}

/** 按 key 明文解析订阅（key 不匹配 → null）。 */
export async function findRpcKeyByRaw(raw: string): Promise<any | null> {
  if (!raw) return null;
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const r = await rpcPool.query(
    `SELECT id, label, key_hash, rpc_plan_id, rpc_sub_status, rpc_payment_method, rpc_payment_ref, enabled
     FROM rpc_keys WHERE key_hash = $1 LIMIT 1`,
    [hash]
  );
  return r.rows[0] || null;
}

/** 免费套餐直通：签发/升级为指定免费套餐（幂等）。返回完整 key（仅首次可见）。 */
export async function activateFreePlan(keyId: number, planId: string, raw?: string): Promise<void> {
  await rpcPool.query(
    `UPDATE rpc_keys
     SET rpc_plan_id = $2, rpc_sub_status = 'active', rpc_payment_method = COALESCE(rpc_payment_method, 'free'),
         rpc_sub_updated_at = NOW(), updated_at = NOW()
     WHERE id = $1`,
    [keyId, planId]
  );
}

/** 引擎支付确认后激活订阅（pending→active，幂等）。 */
export async function activateRpcSubscription(keyId: number, method?: string, ref?: string): Promise<void> {
  const row = await rpcPool.query('SELECT rpc_sub_status, rpc_plan_id FROM rpc_keys WHERE id = $1', [keyId]);
  if (row.rows.length === 0) return;
  if (row.rows[0].rpc_sub_status === 'active') return; // 幂等
  await rpcPool.query(
    `UPDATE rpc_keys
     SET rpc_sub_status = 'active', rpc_payment_method = COALESCE($2, rpc_payment_method),
         rpc_payment_ref = COALESCE($3, rpc_payment_ref),
         rpc_sub_updated_at = NOW(), updated_at = NOW()
     WHERE id = $1`,
    [keyId, method ?? null, ref ?? null]
  );
  console.log(`[chain-rpc] rpc subscription activated key=${keyId} plan=${row.rows[0].rpc_plan_id} method=${method ?? ''}`);
}

/** 订阅回调签名校验（HMAC-SHA256，与引擎 webhook 一致）。 */
export function verifyWebhookSignature(payload: Buffer, signature: string | undefined): boolean {
  if (!PAYMENTS.webhookSecret || !signature) return false;
  const expected = crypto.createHmac('sha256', PAYMENTS.webhookSecret).update(payload).digest('hex');
  const received = signature;
  if (expected.length !== received.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ received.charCodeAt(i);
  return diff === 0;
}
