// ---------------------------------------------------------------------------
// MQ-12: 通用支付引擎客户端（@0xinfrax/payments 独立服务 infrax-payments :9132）
// waas 业务层通过本模块调通用支付通道（chain escrow / fiat / x402）。
// 鉴权：统一契约 X-Service-Key（与平台 bridge key 一致）。
// 未配置 PAYMENTS_URL 时 fail-fast 报错（套餐支付依赖支付引擎）。
// ---------------------------------------------------------------------------
import { config } from '../config';
import { logger } from '../utils/logger';

export class PaymentsError extends Error {
  status: number;
  code: string;
  constructor(message: string, status = 502, code = 'PAYMENTS_ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function call<T = any>(path: string, init?: RequestInit): Promise<T> {
  if (!config.payments.baseUrl) {
    throw new PaymentsError('PAYMENTS_URL is not configured', 503, 'PAYMENTS_NOT_CONFIGURED');
  }
  const base = config.payments.baseUrl.replace(/\/$/, '');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((init?.headers as Record<string, string>) ?? {}),
  };
  if (config.payments.apiKey) headers['X-Service-Key'] = config.payments.apiKey;
  const resp = await fetch(`${base}${path}`, { ...init, headers, signal: AbortSignal.timeout(10_000) });
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

export interface ChainPlan {
  planId: number;
  agentId: number;
  price: string;
  period: string;
  active: boolean;
  trialDays: number;
  payToken: string;
}

export interface ChainInfo {
  chain: string;
  chainId: number;
  subscriptionManager: string;
  nativeAsset: string;
}

export interface CheckoutResult {
  method: 'fiat';
  paymentId: string;
  sessionUrl: string;
  sessionId: string;
  clientReference: string;
  redirect: true;
}

export const paymentsApi = {
  /** 链上套餐定价（SubscriptionManager.getPlan）。 */
  async price(planId: number, chain: string): Promise<ChainPlan> {
    return call<ChainPlan>(`/payments/price?planId=${planId}&chain=${encodeURIComponent(chain)}`);
  },

  /** 链槽信息（chainId + SubscriptionManager 地址），前端链上订阅需用。 */
  async chainInfo(chain: string): Promise<ChainInfo> {
    return call<ChainInfo>(`/payments/chain-info/${encodeURIComponent(chain)}`);
  },

  /** 链上订阅状态（SubscriptionManager.hasActiveSubscription）。 */
  async hasActiveSubscription(chain: string, subscriber: string, resourceId: number): Promise<{ active: boolean }> {
    return call<{ active: boolean }>(
      `/payments/subscription/${encodeURIComponent(chain)}/${encodeURIComponent(subscriber.toLowerCase())}/${resourceId}`
    );
  },

  /** fiat checkout（Stripe session）。metadata 透传业务上下文。 */
  async checkout(input: {
    subscriber: string;
    planId: number;
    period: string;
    metadata: Record<string, unknown>;
    clientReference: string;
    successUrl?: string;
    cancelUrl?: string;
  }): Promise<CheckoutResult> {
    return call<CheckoutResult>('/payments/checkout', {
      method: 'POST',
      body: JSON.stringify({
        subscriber: input.subscriber,
        chain: config.payments.defaultChain,
        planId: input.planId,
        period: input.period,
        metadata: input.metadata,
        clientReference: input.clientReference,
        successUrl: input.successUrl,
        cancelUrl: input.cancelUrl,
      }),
    });
  },

  /** 验证链上支付 tx（x402 rail）并入账。 */
  async verify(txHash: string, chain?: string): Promise<{ verified: boolean; reference?: string; payer?: string; creditedWei?: string; asset?: string; chain?: string }> {
    return call('/payments/verify', {
      method: 'POST',
      body: JSON.stringify({ txHash, chain: chain ?? config.payments.defaultChain }),
    });
  },

  /** rails 能力探测（x402 / fiat / chain 是否启用）。 */
  async info(): Promise<{
    enabled: boolean;
    chain: string;
    rails: { x402: boolean; stablecoin: boolean };
    fiat: boolean;
    x402?: { enabled: boolean; priceWei: string; payTo: string; network: string };
  }> {
    return call('/payments/info');
  },
};
