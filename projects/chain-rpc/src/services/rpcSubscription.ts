/**
 * MQ-16 T-3: Chain RPC 对外读套餐（按次/按带宽 → period 周期授权，key 与订阅绑定）
 *
 * 对齐 dc T-1 / collector T-2 模式：
 *   业务服务管"权益激活"（rpc_keys.rpc_* 状态机），支付引擎管"钱"
 *   （chain/fiat/x402 收钱 + period 周期授权扣费）。
 *
 * 设计要点：
 *   - chain-rpc 新增独立库（默认 infrax_chainrpc，DATABASE_URL 可覆盖）
 *   - `rx_` 前缀 key 由本服务签发，订阅绑定到 key（rpc_keys 表，仅存 SHA-256 哈希）
 *   - 本地 bridge key（CHAIN_RPC_READ_KEY / BROADCAST_KEY）豁免配额（平台内部服务用）
 *   - 套餐按自然月结算，配额 = features.callsPerMonth；超配额 → 503 + 升级提示
 */
import crypto from 'crypto';
import { Pool } from 'pg';
import { config } from '../config';
import { logger } from '../logger';

export const RPC_FREE_PLAN_ID = 'rpc_free';

export const RPC_PLANS = [
  { id: RPC_FREE_PLAN_ID, name: 'RPC Free', price: 0, billingCycle: 'monthly',
    features: { callsPerMonth: 10000, bandwidth: '5GB', concurrent: 10 } },
  { id: 'rpc_pro', name: 'RPC Pro', price: 79, billingCycle: 'monthly',
    features: { callsPerMonth: 100000, bandwidth: '50GB', concurrent: 50 } },
  { id: 'rpc_enterprise', name: 'RPC Enterprise', price: 299, billingCycle: 'monthly',
    features: { callsPerMonth: 1000000, bandwidth: '500GB', concurrent: 200 } },
];

/** 按套餐 id 查目录（未知 id → undefined，上层回退 RPC_PLANS[0] 免费档）。 */
export function planById(id: string | undefined | null): (typeof RPC_PLANS)[number] | undefined {
  return RPC_PLANS.find((p) => p.id === id);
}

// ─── DB Pool（独立库，表结构自举） ─────────────────────────────
export const rpcPool = new Pool({
  connectionString: process.env.CHAIN_RPC_DATABASE_URL || 'postgresql://ubuntu@localhost:5432/infrax_chainrpc',
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
      rpc_plan_id TEXT NOT NULL DEFAULT '${RPC_FREE_PLAN_ID}',
      rpc_sub_status VARCHAR(20) NOT NULL DEFAULT 'active',   -- free→pending→active
      rpc_payment_method VARCHAR(20),
      rpc_payment_ref VARCHAR(200),
      rpc_sub_updated_at TIMESTAMPTZ,
      wallet_address TEXT,                 -- 钱包自助签发绑定（钱包维度查 my keys）
      enabled BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_rpc_keys_hash ON rpc_keys(key_hash);
    ALTER TABLE rpc_keys ADD COLUMN IF NOT EXISTS wallet_address TEXT;
  `);
  // W-8: 钱包维度查询（自助订阅 my keys），历史表自举兼容
  await rpcPool.query(`CREATE INDEX IF NOT EXISTS idx_rpc_keys_wallet ON rpc_keys(wallet_address)`);
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

async function paymentsCall<T = any>(path: string, init?: RequestInit): Promise<T> {
  if (!config.payments.baseUrl) {
    throw new PaymentsError('PAYMENTS_URL is not configured', 503, 'PAYMENTS_NOT_CONFIGURED');
  }
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((init?.headers as Record<string, string>) ?? {}),
  };
  if (config.payments.apiKey) headers['X-Service-Key'] = config.payments.apiKey;
  const resp = await fetch(`${config.payments.baseUrl}${path}`, { ...init, headers, signal: AbortSignal.timeout(10_000) });
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
  async verify(txHash: string, chain?: string) {
    return paymentsCall<{ verified: boolean; reference?: string; payer?: string; creditedWei?: string; asset?: string; chain?: string }>('/payments/verify', {
      method: 'POST',
      body: JSON.stringify({ txHash, chain: chain ?? config.payments.defaultChain }),
    });
  },
  async info() {
    return paymentsCall<{ enabled: boolean; chain: string; rails: { x402: boolean; stablecoin: boolean }; fiat: boolean; x402?: { enabled: boolean; priceWei: string; payTo: string; network: string } }>('/payments/info');
  },
};

/** 生成订阅 key：`rx_` 读 key / `bx_` 广播 key（读写分离，仅存 SHA-256 哈希）。 */
export function generateRpcKey(kind: 'read' | 'broadcast' = 'read'): string {
  const prefix = kind === 'broadcast' ? 'bx_' : 'rx_';
  return prefix + crypto.randomBytes(24).toString('hex');
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

/**
 * 请求级用量记账（rpc_usage 明细 + rpc_usage_daily 日聚合 upsert）。
 * HTTP /v1/rpc 读配额与 WS 订阅共用；fire-and-forget，记账故障不阻断业务（仅告警）。
 */
export function recordRpcUsage(keyId: number, endpoint: string): void {
  rpcPool
    .query('INSERT INTO rpc_usage (key_id, endpoint) VALUES ($1, $2)', [keyId, endpoint])
    .then(() => rpcPool.query(
      `INSERT INTO rpc_usage_daily (key_id, date, endpoint, total_calls)
       VALUES ($1, CURRENT_DATE, $2, 1)
       ON CONFLICT (key_id, date, endpoint)
       DO UPDATE SET total_calls = rpc_usage_daily.total_calls + 1`,
      [keyId, endpoint]
    ))
    .catch((e: any) => logger.warn(`[chain-rpc] rpc usage record failed: ${e.message}`));
}

/** 订阅回调签名校验（HMAC-SHA256，与引擎 webhook 一致）。 */
export function verifyWebhookSignature(payload: Buffer, signature: string | undefined): boolean {
  if (!config.payments.webhookSecret || !signature) return false;
  const expected = crypto.createHmac('sha256', config.payments.webhookSecret).update(payload).digest('hex');
  const received = signature;
  if (expected.length !== received.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ received.charCodeAt(i);
  return diff === 0;
}

// ─── 配额告警（REQ-3：用量 ≥ 阈值主动告警，2026-08-23） ───────────
function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.8;
}

/** 告警阈值（用量/配额 比例，默认 80%）。 */
export const RPC_QUOTA_ALERT_THRESHOLD = clamp01(parseFloat(process.env.RPC_QUOTA_ALERT_THRESHOLD || '0.8'));
/** 可选告警 webhook（配置则 POST JSON；未配置仅 logger.warn）。 */
export const RPC_QUOTA_ALERT_WEBHOOK_URL = (process.env.RPC_QUOTA_ALERT_WEBHOOK_URL || '').trim();
/** 告警扫描间隔（默认 30 分钟）。 */
export const RPC_QUOTA_ALERT_INTERVAL_MS = Math.max(60_000, parseInt(process.env.RPC_QUOTA_ALERT_INTERVAL_MS || '1800000', 10));

/**
 * 配额告警扫描：enabled rx_/bx_ keys 本月用量 ≥ 阈值 → logger.warn（含掩码/用量/配额/使用率）
 * + 可选 webhook POST（若 RPC_QUOTA_ALERT_WEBHOOK_URL 配置）。失败仅告警不抛异常。
 */
export async function checkQuotaAlerts(): Promise<void> {
  try {
    const r = await rpcPool.query(
      `SELECT k.id, k.label, k.key_prefix, k.key_tail, k.rpc_plan_id, k.rpc_sub_status,
              (SELECT COUNT(*)::int FROM rpc_usage u WHERE u.key_id = k.id AND u.timestamp >= $1) AS used
       FROM rpc_keys k WHERE k.enabled = true`,
      [monthStart()]
    );
    for (const row of r.rows) {
      const plan = planById(row.rpc_plan_id) || RPC_PLANS[0];
      const quota = plan.features.callsPerMonth;
      if (quota <= 0) continue;
      const pct = (row.used || 0) / quota;
      if (pct < RPC_QUOTA_ALERT_THRESHOLD) continue;
      const masked = `${row.key_prefix}…${row.key_tail}`;
      const payload = {
        event: 'rpc_quota_alert',
        keyId: row.id,
        maskedKey: masked,
        label: row.label,
        planId: row.rpc_plan_id,
        planName: plan.name,
        used: row.used || 0,
        quota,
        usagePercent: Number((pct * 100).toFixed(1)),
        thresholdPercent: Number((RPC_QUOTA_ALERT_THRESHOLD * 100).toFixed(0)),
        rpcSubStatus: row.rpc_sub_status,
        ts: new Date().toISOString(),
      };
      logger.warn(`[chain-rpc] RPC quota alert: key=${masked} label=${row.label} plan=${row.rpc_plan_id} used=${payload.used}/${quota} (${payload.usagePercent}%)`);
      if (RPC_QUOTA_ALERT_WEBHOOK_URL) {
        fetch(RPC_QUOTA_ALERT_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(5000),
        }).catch((e: any) => logger.warn(`[chain-rpc] quota alert webhook failed: ${e.message}`));
      }
    }
  } catch (e: any) {
    logger.warn(`[chain-rpc] quota alert scan failed: ${e.message}`);
  }
}
