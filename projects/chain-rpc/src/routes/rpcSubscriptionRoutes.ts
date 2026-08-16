// MQ-16 T-3: Chain RPC 读套餐订阅端点（套餐购买/状态轮询/回调激活/用量 + rx_ key 签发）
// 订阅绑定到 rpc_keys（rx_ 前缀 key，SHA-256 哈希存储）；支付引擎管钱，chain-rpc 管权益激活。
// 状态机：free → checkout → pending →（chain 轮询 / fiat callback / x402 verify）→ active
// 对齐 collector T-2 marketSubscriptionRoutes 实现；clientReference 前缀 `rpclin:`。
import { Router } from 'express';
import crypto from 'crypto';
import { config } from '../config';
import { logger } from '../logger';
import { CHAIN_IDS } from '../services/rpcPoolConfig';
import {
  RPC_PLANS, RPC_FREE_PLAN_ID, rpcPool, paymentsApi, PaymentsError,
  generateRpcKey, findRpcKeyByRaw, activateRpcSubscription,
  verifyWebhookSignature, monthStart,
} from '../services/rpcSubscription';
import { timingSafeEqualStr } from '../utils/timingSafe';

const router = Router();

function asyncHandler(fn: (req: any, res: any, next: any) => Promise<any>) {
  return (req: any, res: any, next: any) => Promise.resolve(fn(req, res, next)).catch(next);
}

/** rx_ 订阅 key 鉴权：X-RPC-Key / X-API-Key / Authorization / body.api_key */
async function rpcKeyAuth(req: any, res: any, next: any): Promise<void> {
  const body = req.body || {};
  const key = (req.headers['x-rpc-key'] || req.headers['x-api-key'] || req.headers['x-service-key']
    || (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '') || body.api_key || body.apiKey || '').trim();
  if (!key) { res.status(401).json({ detail: 'rpc key is required', code: 1004 }); return; }
  const row = await findRpcKeyByRaw(key);
  if (!row || row.enabled === false) { res.status(401).json({ detail: 'invalid or disabled rpc key', code: 1004 }); return; }
  req.rpcKey = row;
  next();
}

// GET /v1/subscription/plans — 套餐目录 + 完整链表（RPC-3：链参数与 chainId 映射文档化，公开无敏感数据）
router.get('/plans', asyncHandler(async (_req, res) => {
  const chains = config.supportedChains
    .map((c) => ({ chain: c, chainId: CHAIN_IDS[c] ?? null }))
    .sort((a, b) => a.chain.localeCompare(b.chain));
  res.json({ code: 0, message: 'ok', data: RPC_PLANS, chains });
}));

// POST /v1/subscription/issue-key — 签发 rx_ 读 key / bx_ 广播 key（管理操作：X-Service-Key = 本地 bridge key）
router.post('/issue-key', asyncHandler(async (req, res) => {
  const svcKey = (req.headers['x-service-key'] || req.headers['x-api-key']
    || (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '') || '').trim();
  if (!timingSafeEqualStr(svcKey, config.readKey) && !timingSafeEqualStr(svcKey, config.broadcastKey)) {
    return res.status(401).json({ detail: 'unauthorized' });
  }
  const { label, kind } = req.body ?? {};
  const kKind: 'read' | 'broadcast' = kind === 'broadcast' ? 'broadcast' : 'read';
  const raw = generateRpcKey(kKind);
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const r = await rpcPool.query(
    `INSERT INTO rpc_keys (label, key_hash, key_prefix, key_tail, rpc_plan_id, rpc_sub_status)
     VALUES ($1, $2, $3, $4, '${RPC_FREE_PLAN_ID}', 'active')
     RETURNING id, rpc_plan_id`,
    [label || `${kKind} rpc key`, hash, raw.slice(0, 8), raw.slice(-4)]
  );
  const row = r.rows[0];
  logger.info('[chain-rpc] rpc key issued', { keyId: row.id, kind: kKind, label: label || `${kKind} rpc key` });
  res.status(201).json({
    code: 0,
    message: 'ok',
    data: { keyId: row.id, kind: kKind, rpcKey: raw, planId: row.rpc_plan_id, status: 'active', note: 'rpcKey shown once — store it securely' },
  });
}));

// POST /v1/subscription/checkout — 发起订阅支付（rx_ key 鉴权）
router.post('/checkout', rpcKeyAuth, asyncHandler(async (req, res) => {
  const rpcKey = (req as any).rpcKey as { id: number };
  const { plan_id, rail, subscriber } = req.body ?? {};
  const plan = RPC_PLANS.find((p) => p.id === plan_id);
  if (!plan) return res.status(400).json({ detail: `Unknown plan: ${plan_id}`, code: 1001 });
  // 免费套餐直接激活
  if (plan.price === 0) {
    await rpcPool.query(
      `UPDATE rpc_keys SET rpc_plan_id = $2, rpc_sub_status = 'active',
         rpc_payment_method = COALESCE(rpc_payment_method, 'free'), rpc_payment_ref = NULL,
         rpc_sub_updated_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [rpcKey.id, plan.id]
    );
    return res.json({ code: 0, message: 'ok', data: { keyId: rpcKey.id, planId: plan.id, rpcSubStatus: 'active', free: true } });
  }
  const resourceId = config.payments.planIdMap[plan.id];
  if (!resourceId) {
    return res.status(400).json({ detail: `Plan ${plan.id} has no on-chain mapping (configure PAYMENTS_PLAN_ID_MAP)`, code: 1002 });
  }
  const selectedRail = rail || config.payments.defaultRail;
  const subscriberKey = (typeof subscriber === 'string' && subscriber) ? subscriber : `rpclin:${rpcKey.id}`;
  const payment: any = { rail: selectedRail };
  try {
    if (selectedRail === 'chain') {
      const info = await paymentsApi.chainInfo(config.payments.defaultChain);
      payment.chainId = info.chainId;
      payment.subscriptionManager = info.subscriptionManager;
      payment.nativeAsset = info.nativeAsset;
      payment.price = plan.price;
      await rpcPool.query('UPDATE rpc_keys SET rpc_payment_ref = $1 WHERE id = $2', [String(resourceId), rpcKey.id]);
    } else if (selectedRail === 'fiat') {
      const checkout = await paymentsApi.checkout({
        subscriber: subscriberKey,
        planId: resourceId,
        period: config.payments.fiatPeriod,
        metadata: { product: 'rpc-subscription', planId: plan.id, planName: plan.name, keyId: rpcKey.id },
        clientReference: `rpclin:${rpcKey.id}`,
        successUrl: `${config.payments.corsOrigin}/#/rpc?sub=success`,
        cancelUrl: `${config.payments.corsOrigin}/#/rpc?sub=cancelled`,
      });
      payment.sessionUrl = checkout.sessionUrl;
      payment.paymentId = checkout.paymentId;
      await rpcPool.query('UPDATE rpc_keys SET rpc_payment_ref = $1 WHERE id = $2', [checkout.paymentId, rpcKey.id]);
    } else if (selectedRail === 'x402') {
      const info = await paymentsApi.info();
      if (!info.enabled || !info.x402?.enabled) {
        return res.status(400).json({ detail: 'x402 rail is not enabled on the payments engine', code: 1002 });
      }
      payment.payTo = info.x402.payTo;
      payment.priceWei = info.x402.priceWei;
      payment.network = info.x402.network;
    } else {
      return res.status(400).json({ detail: `Unknown rail: ${selectedRail}`, code: 1001 });
    }
  } catch (err: any) {
    await rpcPool.query("UPDATE rpc_keys SET rpc_sub_status = 'failed', rpc_sub_updated_at = NOW() WHERE id = $1", [rpcKey.id]);
    if (err instanceof PaymentsError) return res.status(err.status).json({ detail: err.message, code: 1003 });
    return res.status(502).json({ detail: `Payments engine unreachable: ${err.message}`, code: 1003 });
  }

  await rpcPool.query(
    `UPDATE rpc_keys SET rpc_sub_status = 'pending', rpc_payment_method = $2,
       rpc_plan_id = $3, rpc_sub_updated_at = NOW(), updated_at = NOW()
     WHERE id = $1`,
    [rpcKey.id, selectedRail, plan.id]
  );
  logger.info('[chain-rpc] rpc checkout', { keyId: rpcKey.id, plan: plan.id, rail: selectedRail });
  res.status(201).json({
    code: 0,
    message: 'Payment required',
    data: { keyId: rpcKey.id, plan: { id: plan.id, name: plan.name, price: plan.price }, rpcSubStatus: 'pending', payment },
  });
}));

// POST /v1/subscription/payment-check — 轮询支付状态（chain rail 链上确认）
router.post('/payment-check', rpcKeyAuth, asyncHandler(async (req, res) => {
  const rpcKey = (req as any).rpcKey as { id: number };
  const { subscriber } = req.body ?? {};
  const r = await rpcPool.query(
    'SELECT rpc_plan_id, rpc_sub_status, rpc_payment_method, rpc_payment_ref FROM rpc_keys WHERE id = $1',
    [rpcKey.id]
  );
  if (r.rows.length === 0) return res.json({ code: 0, message: 'ok', data: { status: 'none' } });
  const key = r.rows[0];
  if (key.rpc_sub_status !== 'pending') return res.json({ code: 0, message: 'ok', data: { status: key.rpc_sub_status || 'none' } });
  if (key.rpc_payment_method === 'chain' && key.rpc_payment_ref) {
    try {
      const resourceId = Number(key.rpc_payment_ref);
      const sub = typeof subscriber === 'string' && subscriber ? subscriber : `rpclin:${rpcKey.id}`;
      const { active } = await paymentsApi.hasActiveSubscription(config.payments.defaultChain, sub, resourceId);
      if (active) {
        await activateRpcSubscription(rpcKey.id, 'chain', key.rpc_payment_ref);
        return res.json({ code: 0, message: 'ok', data: { status: 'active' } });
      }
    } catch (err: any) {
      console.warn(`[chain-rpc] payment-check chain rail failed: ${err.message}`);
    }
  }
  return res.json({ code: 0, message: 'ok', data: { status: 'pending' } });
}));

// POST /v1/subscription/payment-callback — 引擎出站事件回调（HMAC-SHA256 验签，rpclin: 前缀）
router.post('/payment-callback', asyncHandler(async (req, res) => {
  if (!config.payments.webhookSecret) {
    console.warn('[chain-rpc] payment-callback: PAYMENTS_WEBHOOK_SECRET not configured');
    return res.status(503).json({ detail: 'webhook secret not configured', code: 1003 });
  }
  const rawBody = JSON.stringify(req.body);
  const signature = (req.headers['x-payments-signature'] as string) || '';
  const valid = verifyWebhookSignature(Buffer.from(rawBody, 'utf8'), signature);
  if (!valid) {
    console.warn('[chain-rpc] payment-callback invalid signature');
    return res.status(401).json({ detail: 'Invalid signature', code: 401 });
  }
  const { type, event } = req.body ?? {};
  console.log(`[chain-rpc] payment-callback type=${type}`);
  if (type === 'webhook') {
    const ref = event?.object?.client_reference_id;
    if (typeof ref === 'string' && ref.startsWith('rpclin:')) {
      const keyId = Number(ref.slice(7));
      if (Number.isInteger(keyId)) {
        await activateRpcSubscription(keyId, 'fiat', event?.object?.payment_intent ?? null);
      }
    } else {
      console.warn(`[chain-rpc] payment-callback webhook without rpclin: reference → ${ref}`);
    }
  } else if (type === 'credit') {
    // credit 事件：x402/stablecoin 入账。chain-rpc 无钱包维度，x402 激活走 /verify；
    // 此处仅记录，防止重复入账竞态。
    console.warn('[chain-rpc] payment-callback credit without wallet mapping — activation via /verify expected');
  }
  res.json({ received: true });
}));

// POST /v1/subscription/verify — x402 rail 支付确认（txHash → 引擎 verify → 激活 pending x402 订阅）
router.post('/verify', rpcKeyAuth, asyncHandler(async (req, res) => {
  const rpcKey = (req as any).rpcKey as { id: number };
  const { txHash } = req.body ?? {};
  if (!txHash) return res.status(400).json({ detail: 'txHash is required', code: 1001 });
  const result = await paymentsApi.verify(txHash);
  if (!result.verified) return res.json({ code: 0, message: 'ok', data: { verified: false } });
  const r = await rpcPool.query(
    "SELECT id FROM rpc_keys WHERE id = $1 AND rpc_sub_status = 'pending' AND rpc_payment_method = 'x402'",
    [rpcKey.id]
  );
  if (r.rows.length === 0) return res.json({ code: 0, message: 'ok', data: { verified: true, activated: false } });
  await activateRpcSubscription(rpcKey.id, 'x402', txHash);
  return res.json({ code: 0, message: 'ok', data: { verified: true, activated: true } });
}));

// GET /v1/subscription/usage — 真实用量（rpc_usage 月度计数 + 日聚合）
router.get('/usage', rpcKeyAuth, asyncHandler(async (req, res) => {
  const rpcKey = (req as any).rpcKey as { id: number };
  const r = await rpcPool.query('SELECT rpc_plan_id, rpc_sub_status FROM rpc_keys WHERE id = $1', [rpcKey.id]);
  if (r.rows.length === 0) return res.status(404).json({ detail: 'No key found', code: 2002 });
  const row = r.rows[0];
  const plan = RPC_PLANS.find((p) => p.id === row.rpc_plan_id) || RPC_PLANS[0];
  const [totalResult, dailyResult] = await Promise.all([
    rpcPool.query('SELECT COUNT(*)::int as total FROM rpc_usage WHERE key_id = $1 AND timestamp >= $2', [rpcKey.id, monthStart()]),
    rpcPool.query('SELECT date, total_calls FROM rpc_usage_daily WHERE key_id = $1 AND date >= $2 ORDER BY date', [rpcKey.id, monthStart()]),
  ]);
  res.json({
    code: 0,
    message: 'ok',
    data: {
      planId: plan.id,
      planName: plan.name,
      monthlyQuota: plan.features.callsPerMonth,
      currentUsage: totalResult.rows[0].total,
      dailyBreakdown: dailyResult.rows,
      rpcSubStatus: row.rpc_sub_status || 'active',
    },
  });
}));

export default router;
