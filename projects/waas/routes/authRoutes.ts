import { Router } from 'express';
import { asyncHandler, apiResponse } from '../utils/helpers';
import { authenticate, signAdminToken } from '../middleware/auth';
import * as authService from '../services/authService';
import { pool } from '../models/database';

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
 * Admin username/password login (credentials from env ADMIN_USER/ADMIN_PASS;
 * MQ-10 补充 D: no default password — missing config is fail-closed)
 * Body: { username: string, password: string }
 */
router.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { username, password } = req.body;
    const { config } = require('../config');
    const adminUser = config.admin.username || '';
    const adminPass = config.admin.password || '';
    if (!adminUser || !adminPass || username !== adminUser || password !== adminPass) {
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

/**
 * W-15: TOTP 2FA 管理端点
 * POST /api/v2/auth/totp/setup    — 生成绑定材料（secret + otpauth URL）
 * POST /api/v2/auth/totp/enable   — 用验证码激活
 * POST /api/v2/auth/totp/disable  — 用验证码关闭
 * GET  /api/v2/auth/totp/status   — 查询状态
 */
router.post(
  '/totp/setup',
  authenticate,
  asyncHandler(async (req, res) => {
    const userId = req.user!.id;
    const { setupTotp } = await import('../services/totpService');
    const account = (req as any).user?.email || userId;
    const result = await setupTotp(userId, account);
    res.json(apiResponse(result, 'TOTP setup generated'));
  })
);

router.post(
  '/totp/enable',
  authenticate,
  asyncHandler(async (req, res) => {
    const { code } = req.body;
    const userId = req.user!.id;
    if (!code) {
      return res.status(400).json(apiResponse(null, 'Missing TOTP code', 1001));
    }
    const { enableTotp } = await import('../services/totpService');
    await enableTotp(userId, String(code));
    res.json(apiResponse(null, 'TOTP enabled'));
  })
);

router.post(
  '/totp/disable',
  authenticate,
  asyncHandler(async (req, res) => {
    const { code } = req.body;
    const userId = req.user!.id;
    if (!code) {
      return res.status(400).json(apiResponse(null, 'Missing TOTP code', 1001));
    }
    const { disableTotp } = await import('../services/totpService');
    await disableTotp(userId, String(code));
    res.json(apiResponse(null, 'TOTP disabled'));
  })
);

router.get(
  '/totp/status',
  authenticate,
  asyncHandler(async (req, res) => {
    const userId = req.user!.id;
    const result = await pool.query(
      'SELECT totp_secret IS NOT NULL AS configured, totp_enabled FROM users WHERE id = $1',
      [userId]
    );
    res.json(apiResponse(
      result.rows[0] ? { configured: result.rows[0].configured, enabled: result.rows[0].totp_enabled } : { configured: false, enabled: false },
      'TOTP status'
    ));
  })
);

export default router;
