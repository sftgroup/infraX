import { Router } from 'express';
import { asyncHandler, apiResponse } from '../utils/helpers';
import { authenticate, requireAdmin } from '../middleware/auth';
import * as riskService from '../services/riskService';

const router = Router();

/**
 * BE-05: Risk Control Routes
 * GET  /api/v2/risk/limits — Query user's limits
 * POST /api/v2/risk/blacklist — Manage blacklist (admin)
 */

/**
 * GET /api/v2/risk/limits
 * Query current user's risk limits and daily usage
 * Auth: Wallet signature required
 */
router.get(
  '/limits',
  authenticate,
  asyncHandler(async (req, res) => {
    const userId = req.user!.id;
    const limits = await riskService.getUserLimits(userId);
    res.json(apiResponse(limits, 'Success'));
  })
);

/**
 * POST /api/v2/risk/blacklist
 * Add an address to the blacklist
 * Auth: Wallet signature + Admin required
 * Body: { address: string }
 */
router.post(
  '/blacklist',
  authenticate,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { address } = req.body;

    if (!address || typeof address !== 'string') {
      return res.status(400).json(apiResponse(null, 'Missing required field: address', 1001));
    }

    if (!address.startsWith('0x') || address.length !== 42) {
      return res.status(400).json(apiResponse(null, 'Invalid Ethereum address format', 1001));
    }

    await riskService.addBlacklistAddress(address);
    res.json(apiResponse(null, 'Address added to blacklist'));
  })
);

export default router;
