// MQ-16 T-2: Market 行情 API 订阅端点（套餐购买/状态轮询/回调激活/用量）
// 订阅绑定到 api_keys（X-API-Key 识别 keyId）；支付引擎管钱，collector 管权益激活。
// 状态机：free → checkout → pending →（chain 轮询 / fiat callback / x402 verify）→ active
import { Router } from 'express';
import crypto from 'crypto';
import { asyncHandler, apiResponse } from '../helpers';
import { pool } from '../database';
import { logger } from '../logger';
import { apiKeyAuth } from '../middleware/apiKeyAuth';
import { MARKET_PLANS, paymentsApi, activateMarketSubscription, verifyWebhookSignature, monthStart, PaymentsError } from '../marketPlans';

const router = Router();

const PAYMENTS = {
  baseUrl: (process.env.PAYMENTS_URL || '').replace(/\/+$/, ''),
  webhookSecret: process.env.PAYMENTS_WEBHOOK_SECRET || '',
  defaultChain: process.env.PAYMENTS_CHAIN || 'oxachain',
  defaultRail: process.env.PAYMENTS_DEFAULT_RAIL || 'chain',
  fiatPeriod: process.env.PAYMENTS_FIAT_PERIOD || 'month',
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:9111',
  planIdMap: JSON.parse(process.env.PAYMENTS_PLAN_ID_MAP || '{"market_pro":3,"market_enterprise":4}') as Record<string, number>,
};

// GET /api/v2/market/plans — 套餐目录（公开，无敏感数据）
router.get('/plans', asyncHandler(async (_req, res) => {
  res.json(apiResponse(MARKET_PLANS));
}));

// POST /api/v2/market/checkout — 发起订阅支付（key 鉴权）
router.post('/checkout', apiKeyAuth, asyncHandler(async (req, res) => {
  const keyId = (req as any).apiKey.id;
  const { plan_id, rail, subscriber } = req.body ?? {};
  const plan = MARKET_PLANS.find((p) => p.id === plan_id);
  if (!plan) return res.status(400).json(apiResponse(null, `Unknown plan: ${plan_id}`, 1001));
  // 免费套餐直接激活
  if (plan.price === 0) {
    await pool.query(
      `UPDATE api_keys SET market_plan_id = $2, market_sub_status = 'active',
         market_payment_method = NULL, market_payment_ref = NULL,
         market_sub_updated_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [keyId, plan.id]
    );
    return res.json(apiResponse({ keyId, planId: plan.id, marketSubStatus: 'active', free: true }));
  }
  const resourceId = PAYMENTS.planIdMap[plan.id];
  if (!resourceId) {
    return res.status(400).json(apiResponse(null, `Plan ${plan.id} has no on-chain mapping (configure PAYMENTS_PLAN_ID_MAP)`, 1002));
  }
  const selectedRail = rail || PAYMENTS.defaultRail;
  const subscriberKey = (typeof subscriber === 'string' && subscriber) ? subscriber : `mktsub:${keyId}`;
  const payment: any = { rail: selectedRail };
  try {
    if (selectedRail === 'chain') {
      const info = await paymentsApi.chainInfo(PAYMENTS.defaultChain);
      payment.chainId = info.chainId;
      payment.subscriptionManager = info.subscriptionManager;
      payment.nativeAsset = info.nativeAsset;
      payment.price = plan.price;
      await pool.query('UPDATE api_keys SET market_payment_ref = $1 WHERE id = $2', [String(resourceId), keyId]);
    } else if (selectedRail === 'fiat') {
      const checkout = await paymentsApi.checkout({
        subscriber: subscriberKey,
        planId: resourceId,
        period: PAYMENTS.fiatPeriod,
        metadata: { product: 'market-subscription', planId: plan.id, planName: plan.name, keyId },
        clientReference: `mktsub:${keyId}`,
        successUrl: `${PAYMENTS.corsOrigin}/#/market?sub=success`,
        cancelUrl: `${PAYMENTS.corsOrigin}/#/market?sub=cancelled`,
      });
      payment.sessionUrl = checkout.sessionUrl;
      payment.paymentId = checkout.paymentId;
      await pool.query('UPDATE api_keys SET market_payment_ref = $1 WHERE id = $2', [checkout.paymentId, keyId]);
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
    await pool.query("UPDATE api_keys SET market_sub_status = 'failed', market_sub_updated_at = NOW() WHERE id = $1", [keyId]);
    if (err instanceof PaymentsError) return res.status(err.status).json(apiResponse(null, err.message, 1003));
    return res.status(502).json(apiResponse(null, `Payments engine unreachable: ${err.message}`, 1003));
  }

  await pool.query(
    `UPDATE api_keys SET market_sub_status = 'pending', market_payment_method = $2,
       market_plan_id = $3, market_sub_updated_at = NOW(), updated_at = NOW()
     WHERE id = $1`,
    [keyId, selectedRail, plan.id]
  );
  logger.info('[market] checkout', { keyId, plan: plan.id, rail: selectedRail });
  res.status(201).json(apiResponse(
    { keyId, plan: { id: plan.id, name: plan.name, price: plan.price }, marketSubStatus: 'pending', payment },
    'Payment required'
  ));
}));

// POST /api/v2/market/payment-check — 轮询支付状态（chain rail 链上确认）
router.post('/payment-check', apiKeyAuth, asyncHandler(async (req, res) => {
  const keyId = (req as any).apiKey.id;
  const { subscriber } = req.body ?? {};
  const r = await pool.query(
    'SELECT market_plan_id, market_sub_status, market_payment_method, market_payment_ref FROM api_keys WHERE id = $1',
    [keyId]
  );
  if (r.rows.length === 0) return res.json(apiResponse({ status: 'none' }));
  const key = r.rows[0];
  if (key.market_sub_status !== 'pending') return res.json(apiResponse({ status: key.market_sub_status || 'none' }));
  if (key.market_payment_method === 'chain' && key.market_payment_ref) {
    try {
      const resourceId = Number(key.market_payment_ref);
      const sub = typeof subscriber === 'string' && subscriber ? subscriber : `mktsub:${keyId}`;
      const { active } = await paymentsApi.hasActiveSubscription(PAYMENTS.defaultChain, sub, resourceId);
      if (active) {
        await activateMarketSubscription(keyId, 'chain', key.market_payment_ref);
        return res.json(apiResponse({ status: 'active' }));
      }
    } catch (err: any) {
      console.warn(`[market] payment-check chain rail failed: ${err.message}`);
    }
  }
  return res.json(apiResponse({ status: 'pending' }));
}));

// POST /api/v2/market/payment-callback — 引擎出站事件回调（HMAC-SHA256 验签，mktsub: 前缀）
router.post('/payment-callback', asyncHandler(async (req, res) => {
  if (!PAYMENTS.webhookSecret) {
    console.warn('[market] payment-callback: PAYMENTS_WEBHOOK_SECRET not configured');
    return res.status(503).json(apiResponse(null, 'webhook secret not configured', 1003));
  }
  const rawBody = JSON.stringify(req.body);
  const signature = (req.headers['x-payments-signature'] as string) || '';
  const valid = verifyWebhookSignature(Buffer.from(rawBody, 'utf8'), signature);
  if (!valid) {
    console.warn('[market] payment-callback invalid signature');
    return res.status(401).json(apiResponse(null, 'Invalid signature', 401));
  }
  const { type, event } = req.body ?? {};
  console.log(`[market] payment-callback type=${type}`);
  if (type === 'webhook') {
    const ref = event?.object?.client_reference_id;
    if (typeof ref === 'string' && ref.startsWith('mktsub:')) {
      const keyId = Number(ref.slice(7));
      if (Number.isInteger(keyId)) {
        await activateMarketSubscription(keyId, 'fiat', event?.object?.payment_intent ?? null);
      }
    } else {
      console.warn(`[market] payment-callback webhook without mktsub: reference → ${ref}`);
    }
  } else if (type === 'credit') {
    // credit 事件：x402/stablecoin 入账。collector 无钱包维度，x402 激活走 /verify；
    // 此处仅记录，防止重复入账竞态。
    console.warn('[market] payment-callback credit without wallet mapping — activation via /verify expected');
  }
  res.json({ received: true });
}));

// POST /api/v2/market/verify — x402 rail 支付确认（txHash → 引擎 verify → 激活 pending x402 订阅）
router.post('/verify', apiKeyAuth, asyncHandler(async (req, res) => {
  const keyId = (req as any).apiKey.id;
  const { txHash } = req.body ?? {};
  if (!txHash) return res.status(400).json(apiResponse(null, 'txHash is required', 1001));
  const result = await paymentsApi.verify(txHash);
  if (!result.verified) return res.json(apiResponse({ verified: false }));
  const r = await pool.query(
    "SELECT id FROM api_keys WHERE id = $1 AND market_sub_status = 'pending' AND market_payment_method = 'x402'",
    [keyId]
  );
  if (r.rows.length === 0) return res.json(apiResponse({ verified: true, activated: false }));
  await activateMarketSubscription(keyId, 'x402', txHash);
  return res.json(apiResponse({ verified: true, activated: true }));
}));

// GET /api/v2/market/usage — 真实用量（market_usage 月度计数 + 日聚合）
router.get('/usage', apiKeyAuth, asyncHandler(async (req, res) => {
  const keyId = (req as any).apiKey.id;
  const r = await pool.query('SELECT market_plan_id, market_sub_status FROM api_keys WHERE id = $1', [keyId]);
  if (r.rows.length === 0) return res.status(404).json(apiResponse(null, 'No key found', 2002));
  const row = r.rows[0];
  const plan = MARKET_PLANS.find((p) => p.id === row.market_plan_id) || MARKET_PLANS[0];
  const [totalResult, dailyResult] = await Promise.all([
    pool.query('SELECT COUNT(*)::int as total FROM market_usage WHERE key_id = $1 AND timestamp >= $2', [keyId, monthStart()]),
    pool.query('SELECT date, total_calls FROM market_usage_daily WHERE key_id = $1 AND date >= $2 ORDER BY date', [keyId, monthStart()]),
  ]);
  res.json(apiResponse({
    planId: plan.id,
    planName: plan.name,
    monthlyQuota: plan.features.apiCallsPerMonth,
    currentUsage: totalResult.rows[0].total,
    dailyBreakdown: dailyResult.rows,
    marketSubStatus: row.market_sub_status || 'active',
  }));
}));

export default router;
