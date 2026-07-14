import { Router } from 'express';
import { asyncHandler, apiResponse } from '../utils/helpers';
import { authenticate, signAdminToken } from '../middleware/auth';
import * as authService from '../services/authService';

const router = Router();

/**
 * Auth Routes (wallet-signature based, no JWT)
 *
 * POST /api/v2/auth/login             — Admin username/password login
 * POST /api/v2/auth/set-payment-password — Set or change 6-digit payment password
 * GET  /api/v2/auth/payment-password-status — Check if payment password is set
 */

/**
 * POST /api/v2/auth/login
 * Admin username/password login (hardcoded credentials)
 * Body: { username: string, password: string }
 */
router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { username, password } = req.body;
    if (username !== 'admin' || password !== 'admin123') {
      return res.status(401).json(apiResponse(null, 'Invalid credentials', 1002));
    }
    const token = signAdminToken('admin');
    res.json(apiResponse({ accessToken: token }));
  })
);

/**
 * POST /api/v2/auth/set-payment-password
 * Set or change 6-digit payment password
 * Auth: wallet signature required
 * Body: { newPassword: string, oldPassword?: string }
 */
router.post(
  '/set-payment-password',
  authenticate,
  asyncHandler(async (req, res) => {
    const { newPassword, oldPassword } = req.body;
    const userId = req.user!.id;

    if (!newPassword || typeof newPassword !== 'string') {
      return res.status(400).json(apiResponse(null, 'Missing required field: newPassword', 1001));
    }

    await authService.setPaymentPassword(userId, newPassword, oldPassword || undefined);
    res.json(apiResponse(null, 'Payment password set successfully'));
  })
);

/**
 * GET /api/v2/auth/payment-password-status
 * Check if user has set payment password
 * Auth: wallet signature required
 */
router.get(
  '/payment-password-status',
  authenticate,
  asyncHandler(async (req, res) => {
    const userId = req.user!.id;
    const has = await authService.hasPaymentPassword(userId);
    res.json(apiResponse({ hasPaymentPassword: has }));
  })
);

export default router;
