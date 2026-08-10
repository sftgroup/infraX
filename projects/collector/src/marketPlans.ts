// MQ-16 T-2: Market 行情 API 按量套餐
// 对齐 dc T-1（projects/dc/index.ts PAYMENTS 段）模式：
//   业务服务管"权益激活"（api_keys.market_* 状态机），支付引擎管"钱"
//   （chain/fiat/x402 收钱 + 账本记钱 + period 周期授权扣费）。
// 套餐按自然月结算，配额 = features.apiCallsPerMonth；超配额 → 503 + 升级提示（middleware/marketQuotaEnforce）。
import crypto from 'crypto';
import { pool } from './database';
import { logger } from './logger';

export const MARKET_PLANS = [
  { id: 'market_free', name: 'Market Free', price: 0, billingCycle: 'monthly',
    features: { apiCallsPerMonth: 10000 } },
  { id: 'market_pro', name: 'Market Pro', price: 49, billingCycle: 'monthly',
    features: { apiCallsPerMonth: 100000 } },
  { id: 'market_enterprise', name: 'Market Enterprise', price: 199, billingCycle: 'monthly',
    features: { apiCallsPerMonth: 1000000 } },
];

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
  // 链上套餐 → Market 套餐对齐表（planId 为 SubscriptionManager.getPlan 的 id，生产可用 env 覆盖）
  planIdMap: JSON.parse(process.env.PAYMENTS_PLAN_ID_MAP || '{"market_pro":3,"market_enterprise":4}') as Record<string, number>,
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

/** 引擎支付确认后激活 Market 订阅（pending→active，幂等）。 */
export async function activateMarketSubscription(keyId: number, method?: string, ref?: string): Promise<void> {
  const key = await pool.query('SELECT market_sub_status, market_plan_id FROM api_keys WHERE id = $1', [keyId]);
  if (key.rows.length === 0) return;
  const row = key.rows[0];
  if (row.market_sub_status === 'active') return; // 幂等
  await pool.query(
    `UPDATE api_keys
     SET market_sub_status = 'active', market_payment_method = COALESCE($2, market_payment_method),
         market_payment_ref = COALESCE($3, market_payment_ref),
         market_sub_updated_at = NOW(), updated_at = NOW()
     WHERE id = $1`,
    [keyId, method ?? null, ref ?? null]
  );
  logger.info('[market] subscription activated', { keyId, plan: row.market_plan_id, method: method ?? '' });
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
