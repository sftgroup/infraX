import { Router } from 'express';
import crypto from 'crypto';
import { asyncHandler, apiResponse } from '../utils/helpers';
import { authenticate } from '../middleware/auth';
import { pool } from '../models/database';
import { config } from '../config';
import { logger } from '../utils/logger';
import { paymentsApi, PaymentsError } from '../services/paymentsClient';

const router = Router();

/**
 * Subscription & Billing Routes — MQ-12（支付走通用支付引擎 @0xinfrax/payments）
 *
 * GET    /api/v2/subscription/plans               — List available plans (public)
 * GET    /api/v2/subscription/me                  — Get current user's subscription
 * POST   /api/v2/subscription/subscribe           — 创建支付意图（pending）或 free 直通 active
 * POST   /api/v2/subscription/check               — 轮询支付状态（chain rail 链上确认 / pending 查询）
 * POST   /api/v2/subscription/verify              — x402 rail：提交 txHash → 验证并入账后激活
 * POST   /api/v2/subscription/payment-callback    — 通用支付引擎出站事件回调（webhook/credit）
 * POST   /api/v2/subscription/cancel              — Cancel subscription
 *
 * 状态机：pending（支付意图）→ active（支付确认）｜ cancelled / failed
 * rail：chain（链上 SubscriptionManager escrow，默认）/ fiat（Stripe）/ x402（原生代币单期）
 */

const PLANS: Record<string, { name: string; price: number }> = {
  free: { name: 'Starter', price: 0 },
  pro: { name: 'Pro', price: 49 },
  enterprise: { name: 'Enterprise', price: 199 },
};

// B-11-5：默认套餐（代码常量兜底）；billing_plans 表（service='waas-subscription'）
// 有同名 plan_id 记录时 DB 覆盖（admin 面板 CRUD）。
const DEFAULT_PLANS = [
  {
    id: 'free',
    name: 'Starter',
    price: 0,
    billingCycle: 'monthly',
    features: {
      mpcWallets: 3,
      safeWallets: 3,
      sweepAddresses: 100,
      apiKeys: 1,
      apiCallsPerMonth: 10000,
      sweepIntervalHours: 24,
      sweepFeePercent: 0.5,
      support: 'community',
      sla: null,
      whitelabel: false,
    },
  },
  {
    id: 'pro',
    name: 'Pro',
    price: 49,
    billingCycle: 'monthly',
    features: {
      mpcWallets: 20,
      safeWallets: 10,
      sweepAddresses: 10000,
      apiKeys: 5,
      apiCallsPerMonth: 100000,
      sweepIntervalHours: 1,
      sweepFeePercent: 0.3,
      support: 'email',
      sla: '99.5%',
      whitelabel: false,
    },
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    price: 199,
    billingCycle: 'monthly',
    features: {
      mpcWallets: 100,
      safeWallets: 50,
      sweepAddresses: 100000,
      apiKeys: 20,
      apiCallsPerMonth: 1000000,
      sweepIntervalHours: 0,
      sweepFeePercent: 0.1,
      support: 'dedicated',
      sla: '99.9%',
      whitelabel: true,
    },
  },
];

function mapSubscription(row: any) {
  return {
    id: row.id,
    planId: row.plan_id,
    planName: row.plan_name,
    price: Number(row.price ?? 0),
    billingCycle: row.billing_cycle,
    status: row.status,
    expiresAt: row.expires_at,
    paymentMethod: row.payment_method ?? null,
    paymentStatus: row.payment_status ?? null,
  };
}

/** 取消用户全部 active 订阅（新订阅生效前保留旧订阅，支付确认后才切换）。 */
async function cancelActive(userId: string): Promise<void> {
  await pool.query(
    "UPDATE subscriptions SET status = 'cancelled', cancelled_at = NOW() WHERE user_id = $1 AND status = 'active'",
    [userId]
  );
}

/** 支付确认后激活订阅：cancel 旧 active → pending→active（expires_at=now+period）。幂等。 */
async function activateSubscription(subscriptionId: string): Promise<void> {
  const sub = await pool.query('SELECT * FROM subscriptions WHERE id = $1', [subscriptionId]);
  if (sub.rows.length === 0) return;
  const row = sub.rows[0];
  if (row.status === 'active') return; // 幂等：已激活跳过
  await cancelActive(row.user_id);
  await pool.query(
    `UPDATE subscriptions
     SET status = 'active', payment_status = 'succeeded',
         expires_at = NOW() + INTERVAL '30 days'
     WHERE id = $1`,
    [subscriptionId]
  );
  logger.info(`[subscription] activated ${subscriptionId} (user=${row.user_id}, plan=${row.plan_id}, method=${row.payment_method})`);
}

router.get(
  '/plans',
  asyncHandler(async (req, res) => {
    // B-11-5：DB 优先（billing_plans 表 admin 可 CRUD）→ 回退代码常量 DEFAULT_PLANS
    let plans = DEFAULT_PLANS;
    try {
      const { rows } = await pool.query(
        `SELECT plan_id, name, price, billing_cycle, features, enabled
         FROM billing_plans WHERE service = 'waas-subscription' ORDER BY created_at`
      );
      if (rows.length > 0) {
        const enabled = rows.filter((r: any) => r.enabled);
        // 仅覆盖有 enabled 记录的套餐，其余保留默认
        plans = DEFAULT_PLANS.map(p => {
          const row = enabled.find((r: any) => r.plan_id === p.id);
          if (!row) return p;
          return {
            id: row.plan_id,
            name: row.name,
            price: Number(row.price ?? p.price),
            billingCycle: row.billing_cycle || p.billingCycle,
            features: { ...p.features, ...(row.features || {}) },
          };
        });
      }
    } catch {
      // billing_plans 表不存在等 → 保持默认常量
    }
    res.json(apiResponse(plans));
  })
);

router.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    const userId = req.user!.id;
    const result = await pool.query(
      `SELECT s.*, u.email FROM subscriptions s
       JOIN users u ON u.id = s.user_id
       WHERE s.user_id = $1 AND s.status = 'active'
       ORDER BY s.created_at DESC LIMIT 1`,
      [userId]
    );
    if (result.rows.length === 0) {
      return res.json(apiResponse({
        plan: { id: 'free', name: 'Starter', price: 0, billingCycle: 'monthly' },
        status: 'active',
        features: {
          mpcWallets: 3, safeWallets: 3, sweepAddresses: 100, apiKeys: 1,
          apiCallsPerMonth: 10000, sweepIntervalHours: 24, sweepFeePercent: 0.5,
          support: 'community', sla: null, whitelabel: false,
        },
      }));
    }
    const sub = result.rows[0];
    res.json(apiResponse({
      plan: { id: sub.plan_id, name: sub.plan_name, price: sub.price, billingCycle: sub.billing_cycle },
      startedAt: sub.created_at,
      expiresAt: sub.expires_at,
      status: sub.status,
    }));
  })
);

/**
 * POST /subscribe — 创建支付意图（MQ-12）
 * - free：免费试用直通 active
 * - pro/enterprise：按 rail（chain 默认 / fiat / x402）调通用支付引擎取支付信息，落 pending
 * body: { planId, rail? }
 */
router.post(
  '/subscribe',
  authenticate,
  asyncHandler(async (req, res) => {
    const { planId, rail } = req.body ?? {};
    if (!planId) return res.status(400).json(apiResponse(null, 'Missing planId', 1001));

    const plan = PLANS[planId];
    if (!plan) return res.status(400).json(apiResponse(null, 'Invalid plan', 1001));

    const userId = req.user!.id;
    const walletAddress = req.user!.walletAddress || '';

    // free：免费试用直通（T-6：仅 free 允许免支付激活）
    if (plan.price === 0) {
      await cancelActive(userId);
      const inserted = await pool.query(
        `INSERT INTO subscriptions (user_id, plan_id, plan_name, price, billing_cycle, status, expires_at, payment_method, payment_status)
         VALUES ($1, $2, $3, $4, 'monthly', 'active', NULL, 'free', 'succeeded') RETURNING *`,
        [userId, planId, plan.name, plan.price]
      );
      return res.status(201).json(apiResponse(
        { subscription: mapSubscription(inserted.rows[0]), payment: { rail: 'none' } },
        'Subscribed'
      ));
    }

    // 付费套餐：创建支付意图（pending）。不取消旧 active —— 支付确认后由回调/check 切换。
    const selectedRail = rail || config.payments.defaultRail;
    const chain = config.payments.defaultChain;
    const resourceId = (config.payments.planIdMap[planId] ?? Number(planId)) || 0;
    if (!resourceId) {
      return res.status(400).json(apiResponse(null, `No on-chain plan mapped for "${planId}" (PAYMENTS_PLAN_ID_MAP)`, 1001));
    }

    const inserted = await pool.query(
      `INSERT INTO subscriptions (user_id, plan_id, plan_name, price, billing_cycle, status, expires_at, payment_method, payment_status)
       VALUES ($1, $2, $3, $4, 'monthly', 'pending', NULL, $5, 'pending') RETURNING *`,
      [userId, planId, plan.name, plan.price, selectedRail]
    );
    const subscriptionId = inserted.rows[0].id;

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
        await pool.query('UPDATE subscriptions SET payment_ref = $1 WHERE id = $2', [String(resourceId), subscriptionId]);
      } else if (selectedRail === 'fiat') {
        const checkout = await paymentsApi.checkout({
          subscriber: walletAddress || subscriptionId,
          planId: resourceId,
          period: config.payments.fiatPeriod,
          metadata: { product: 'subscription', planId, planName: plan.name, userId, subscriptionId },
          clientReference: `sub:${subscriptionId}`,
          successUrl: `${config.corsOrigin}/#/waas?sub=success`,
          cancelUrl: `${config.corsOrigin}/#/waas?sub=cancelled`,
        });
        payment.sessionUrl = checkout.sessionUrl;
        payment.paymentId = checkout.paymentId;
        await pool.query('UPDATE subscriptions SET payment_ref = $1 WHERE id = $2', [checkout.paymentId, subscriptionId]);
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
    } catch (err) {
      logger.error(`[subscription] payments rail failed (${selectedRail}): ${(err as Error).message}`);
      await pool.query("UPDATE subscriptions SET status = 'failed', payment_status = 'failed' WHERE id = $1", [subscriptionId]);
      if (err instanceof PaymentsError) {
        return res.status(err.status).json(apiResponse(null, err.message, 1003));
      }
      return res.status(502).json(apiResponse(null, `Payments engine unreachable: ${(err as Error).message}`, 1003));
    }

    res.status(201).json(apiResponse(
      { subscription: mapSubscription(inserted.rows[0]), payment },
      'Payment required'
    ));
  })
);

/**
 * POST /check — 轮询支付状态（T-3 chain rail 兜底）
 * chain：调 payments hasActiveSubscription（SubscriptionManager escrow）→ active 则激活
 * fiat/x402：pending（激活依赖 payment-callback / verify 端点）
 */
router.post(
  '/check',
  authenticate,
  asyncHandler(async (req, res) => {
    const userId = req.user!.id;
    const walletAddress = req.user!.walletAddress || '';
    const pending = await pool.query(
      `SELECT * FROM subscriptions WHERE user_id = $1 AND status = 'pending' ORDER BY created_at DESC LIMIT 1`,
      [userId]
    );
    if (pending.rows.length === 0) {
      return res.json(apiResponse({ status: 'none' }));
    }
    const sub = pending.rows[0];
    if (sub.payment_method === 'chain' && sub.payment_ref) {
      try {
        const resourceId = Number(sub.payment_ref);
        const { active } = await paymentsApi.hasActiveSubscription(
          config.payments.defaultChain,
          walletAddress || sub.user_id,
          resourceId
        );
        if (active) {
          await activateSubscription(sub.id);
          return res.json(apiResponse({ status: 'active', subscription: mapSubscription(sub) }));
        }
      } catch (err) {
        logger.warn(`[subscription] check chain rail failed: ${(err as Error).message}`);
      }
      return res.json(apiResponse({ status: 'pending', subscription: mapSubscription(sub) }));
    }
    return res.json(apiResponse({ status: 'pending', subscription: mapSubscription(sub) }));
  })
);

/**
 * POST /verify — x402 rail 支付确认
 * 前端提交链上转账 txHash → waas 调 payments verify（幂等入账）→ 校验 payer == 当前钱包 → 激活 pending x402 订阅
 */
router.post(
  '/verify',
  authenticate,
  asyncHandler(async (req, res) => {
    const { txHash } = req.body ?? {};
    if (!txHash) return res.status(400).json(apiResponse(null, 'txHash is required', 1001));
    const walletAddress = req.user!.walletAddress || '';
    const userId = req.user!.id;

    const result = await paymentsApi.verify(txHash);
    if (!result.verified || !result.payer) {
      return res.json(apiResponse({ verified: false }));
    }
    if (result.payer.toLowerCase() !== walletAddress.toLowerCase()) {
      return res.status(409).json(apiResponse(null, 'tx payer does not match current wallet', 1001));
    }
    const pending = await pool.query(
      `SELECT * FROM subscriptions WHERE user_id = $1 AND status = 'pending' AND payment_method = 'x402' ORDER BY created_at DESC LIMIT 1`,
      [userId]
    );
    if (pending.rows.length === 0) {
      return res.json(apiResponse({ verified: true, activated: false }));
    }
    await activateSubscription(pending.rows[0].id);
    return res.json(apiResponse({ verified: true, activated: true }));
  })
);

/**
 * POST /payment-callback — 通用支付引擎出站事件回调（T-2）
 * 由 infrax-payments `WEBHOOK_FORWARD_URL` 指向本端点（forwarder 契约）：
 *   headers: x-payments-signature = HMAC-SHA256(body, WEBHOOK_FORWARD_SECRET)、idempotency-key
 *   body: { type: 'webhook'|'credit', eventId, event, forwardedAt }
 * - webhook（fiat Stripe）：event.object.client_reference_id = `sub:<subscriptionId>` → 激活
 * - credit（x402 入账）：按 payer 匹配最近 pending x402 订阅 → 激活（无法匹配仅记录）
 */
router.post(
  '/payment-callback',
  asyncHandler(async (req, res) => {
    const secret = config.payments.webhookSecret;
    if (!secret) {
      logger.warn('[subscription] payment-callback: PAYMENTS_WEBHOOK_SECRET not configured');
      return res.status(503).json(apiResponse(null, 'webhook secret not configured', 1003));
    }
    // 重建原始 body 校验签名（forwarder body 为 JSON.stringify 紧凑格式，键顺序稳定）
    const rawBody = JSON.stringify(req.body);
    const signature = (req.headers['x-payments-signature'] as string) || '';
    const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    const sigBuf = Buffer.from(signature, 'hex');
    const expBuf = Buffer.from(expected, 'hex');
    const valid =
      sigBuf.length === expBuf.length &&
      sigBuf.length > 0 &&
      crypto.timingSafeEqual(sigBuf, expBuf);
    if (!valid) {
      logger.warn('[subscription] payment-callback invalid signature');
      return res.status(401).json(apiResponse(null, 'Invalid signature', 401));
    }

    const { type, eventId, event } = req.body ?? {};
    logger.info(`[subscription] payment-callback type=${type} eventId=${eventId}`);

    if (type === 'webhook') {
      const ref = event?.object?.client_reference_id;
      if (typeof ref === 'string' && ref.startsWith('sub:')) {
        const subscriptionId = ref.slice(4);
        await activateSubscription(subscriptionId);
      } else {
        logger.warn(`[subscription] payment-callback webhook without sub: reference → ${ref}`);
      }
    } else if (type === 'credit') {
      const payer = typeof event?.payer === 'string' ? event.payer.toLowerCase() : '';
      if (payer) {
        const pending = await pool.query(
          `SELECT s.id FROM subscriptions s
           JOIN users u ON u.id = s.user_id AND LOWER(u.wallet_address) = $1
           WHERE s.status = 'pending' AND s.payment_method = 'x402'
           ORDER BY s.created_at DESC LIMIT 1`,
          [payer]
        );
        if (pending.rows.length > 0) {
          await activateSubscription(pending.rows[0].id);
        } else {
          logger.warn(`[subscription] payment-callback credit without matching pending x402 subscription: payer=${payer}`);
        }
      }
    }

    res.json({ received: true });
  })
);

router.post(
  '/cancel',
  authenticate,
  asyncHandler(async (req, res) => {
    const userId = req.user!.id;
    await pool.query(
      "UPDATE subscriptions SET status = 'cancelled', cancelled_at = NOW() WHERE user_id = $1 AND status = 'active'",
      [userId]
    );
    res.json(apiResponse(null, 'Subscription cancelled'));
  })
);

export default router;
