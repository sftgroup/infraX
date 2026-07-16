import { Router } from 'express';
import { asyncHandler, apiResponse } from '../utils/helpers';
import { authenticate } from '../middleware/auth';
import { pool } from '../models/database';

const router = Router();

/**
 * Subscription & Billing Routes
 *
 * GET    /api/v2/subscription/plans     — List available plans (public)
 * GET    /api/v2/subscription/me        — Get current user's subscription
 * POST   /api/v2/subscription/subscribe — Subscribe to a plan
 * POST   /api/v2/subscription/cancel    — Cancel subscription
 */

router.get(
  '/plans',
  asyncHandler(async (req, res) => {
    const plans = [
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

router.post(
  '/subscribe',
  authenticate,
  asyncHandler(async (req, res) => {
    const { planId } = req.body;
    if (!planId) return res.status(400).json(apiResponse(null, 'Missing planId', 1001));

    const validPlans: Record<string, { name: string; price: number }> = {
      free: { name: 'Starter', price: 0 },
      pro: { name: 'Pro', price: 49 },
      enterprise: { name: 'Enterprise', price: 199 },
    };
    const plan = validPlans[planId];
    if (!plan) return res.status(400).json(apiResponse(null, 'Invalid plan', 1001));

    const userId = req.user!.id;
    await pool.query(
      "UPDATE subscriptions SET status = 'cancelled', cancelled_at = NOW() WHERE user_id = $1 AND status = 'active'",
      [userId]
    );
    const expiresAt = plan.price === 0 ? null : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const result = await pool.query(
      `INSERT INTO subscriptions (user_id, plan_id, plan_name, price, billing_cycle, status, expires_at)
       VALUES ($1, $2, $3, $4, 'monthly', 'active', $5) RETURNING *`,
      [userId, planId, plan.name, plan.price, expiresAt]
    );
    res.status(201).json(apiResponse(result.rows[0], 'Subscribed'));
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
