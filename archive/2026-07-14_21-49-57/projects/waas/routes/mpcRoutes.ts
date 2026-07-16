import { Router } from 'express';
import { asyncHandler, apiResponse } from '../utils/helpers';
import * as mpcService from '../services/mpcService';

const router = Router();

/**
 * MPC Wallet Routes — Email-based registration & recovery
 *
 * POST /api/v2/mpc/register          — Register MPC wallet (email + code → generate shard)
 * POST /api/v2/mpc/recover           — Recover MPC wallet (email + code → return shard)
 * GET  /api/v2/mpc/status            — Check MPC wallet status by walletAddress (canonical) or email (fallback)
 * POST /api/v2/mpc/send-code         — Send verification code to email (dev: fixed 888888)
 */

/**
 * POST /api/v2/mpc/send-code
 * Send verification code to email (dev: fixed code 888888)
 * Body: { email }
 */
router.post(
  '/send-code',
  asyncHandler(async (req, res) => {
    const { email } = req.body;
    if (!email || typeof email !== 'string') {
      return res.status(400).json(apiResponse(null, 'Missing required field: email', 1001));
    }
    // Dev: fixed code 888888
    const code = '888888';
    mpcService.storeMpcVerificationCode(email, code);
    console.log(`[MPC] Verification code for ${email}: ${code}`);
    res.json(apiResponse({ message: 'Verification code sent' }, 'Verification code sent'));
  })
);

/**
 * POST /api/v2/mpc/register
 * Register a new MPC wallet:
 * 1. Generate EOA keypair
 * 2. Split into shards (currently 1 shard)
 * 3. Encrypt shard with email-derived key
 * 4. Store encrypted shard
 * 5. Return wallet address (never return private key)
 *
 * Body: { email, code }
 */
router.post(
  '/register',
  asyncHandler(async (req, res) => {
    const { email, code } = req.body;
    if (!email || !code) {
      return res.status(400).json(apiResponse(null, 'Missing required fields: email, code', 1001));
    }
    const result = await mpcService.registerWallet(email, code, (req as any).headers["x-wallet-address"] || (req.body as any).walletAddress);
    res.status(201).json(apiResponse(result, 'MPC wallet created'));
  })
);

/**
 * POST /api/v2/mpc/recover
 * Recover MPC wallet using email + verification code:
 * 1. Verify email + code
 * 2. Retrieve encrypted shard
 * 3. Decrypt shard using email-derived key
 * 4. Return private key (for wallet reconstruction)
 *
 * Body: { email, code }
 */
router.post(
  '/recover',
  asyncHandler(async (req, res) => {
    const { email, code } = req.body;
    if (!email || !code) {
      return res.status(400).json(apiResponse(null, 'Missing required fields: email, code', 1001));
    }
    const result = await mpcService.recoverWallet(email, code);
    res.json(apiResponse(result, 'MPC wallet recovered'));
  })
);

/**
 * GET /api/v2/mpc/status
 * Check MPC wallet status by wallet address or email
 * Query: walletAddress (primary) or email (fallback)
 * Note: walletAddress is the canonical user identity in the system
 */
router.get(
  '/status',
  asyncHandler(async (req, res) => {
    const { email, walletAddress } = req.query;
    // Primary: query by walletAddress (canonical user identity)
    if (walletAddress && typeof walletAddress === 'string') {
      const status = await mpcService.getWalletStatusByAddress(walletAddress);
      return res.json(apiResponse(status, 'ok'));
    }
    // Fallback: query by email (backward compat)
    if (!email || typeof email !== 'string') {
      return res.status(400).json(apiResponse(null, 'Missing query param: walletAddress or email', 1001));
    }
    const status = await mpcService.getWalletStatus(email);
    res.json(apiResponse(status, 'ok'));
  })
);

export default router;
