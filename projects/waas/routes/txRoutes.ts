import { Router } from 'express';
import { asyncHandler, apiResponse } from '../utils/helpers';
import { authenticate, requireAdmin } from '../middleware/auth';
import * as txService from '../services/txService';

const isValidEthereumAddress = (addr: string): boolean => {
  return /^0x[0-9a-fA-F]{40}$/.test(addr);
};

const router = Router();

/**
 * BE-04: Transaction Routes
 * POST /api/v2/tx/send — Send transaction → risk check → sign → broadcast
 * POST /api/v2/tx/estimate-gas — Estimate gas
 * GET  /api/v2/tx/status/:txHash — Transaction status
 * POST /api/v2/tx/batch — Batch transfer (admin)
 */

/**
 * POST /api/v2/tx/send
 * Transfer with risk check, gas sponsorship, and signature strategy
 * Auth: Wallet signature required
 * Body: { walletId, toAddress, amount, chain, paymentPassword, tokenAddress? }
 */
router.post(
  '/send',
  authenticate,
  asyncHandler(async (req, res) => {
    const { walletId, toAddress, amount, chain, paymentPassword, tokenAddress, idempotencyKey, totpCode } = req.body;
    const userId = req.user!.id;

    // Input validation
    if (!walletId || !toAddress || !amount || !chain || !paymentPassword) {
      return res.status(400).json(
        apiResponse(null, 'Missing required fields: walletId, toAddress, amount, chain, paymentPassword', 1001)
      );
    }

    if (isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
      return res.status(400).json(apiResponse(null, 'Invalid amount', 1001));
    }
    // Ethereum address format validation
    if (!isValidEthereumAddress(toAddress)) {
      return res.status(400).json(apiResponse(null, 'Invalid ethereum address format', 1006));
    }
    // W-8: 幂等键长度校验
    if (idempotencyKey && (typeof idempotencyKey !== 'string' || idempotencyKey.length > 100)) {
      return res.status(400).json(apiResponse(null, 'idempotencyKey must be a string ≤ 100 chars', 1001));
    }
    // W-15: TOTP 2FA（已启用则必须携带有效验证码）
    const { verifyTotp } = await import('../services/totpService');
    await verifyTotp(userId, totpCode);

    const result = await txService.sendTransaction({
      userId,
      walletId,
      toAddress,
      amount,
      tokenAddress: tokenAddress || '*',
      chain,
      paymentPassword,
      idempotencyKey,
    });

    res.json(apiResponse(result, 'Transaction processed'));
  })
);

/**
 * POST /api/v2/tx/estimate-gas
 * Estimate gas for a transaction
 * Auth: Wallet signature required
 * Body: { walletId, toAddress, amount, chain, tokenAddress? }
 */
router.post(
  '/estimate-gas',
  authenticate,
  asyncHandler(async (req, res) => {
    const { walletId, toAddress, amount, chain, tokenAddress } = req.body;
    const userId = req.user!.id;

    if (!walletId || !toAddress || !amount || !chain) {
      return res.status(400).json(
        apiResponse(null, 'Missing required fields: walletId, toAddress, amount, chain', 1001)
      );
    }
    if (!isValidEthereumAddress(toAddress)) {
      return res.status(400).json(apiResponse(null, 'Invalid ethereum address format', 1006));
    }

    const gasEstimate = await txService.estimateGas(
      userId, walletId, toAddress, amount, chain, tokenAddress
    );
    res.json(apiResponse(gasEstimate, 'Gas estimated'));
  })
);

/**
 * GET /api/v2/tx/status/:txHash
 * Get transaction status by tx hash
 * Auth: Wallet signature required
 */
router.get(
  '/status/:txHash',
  authenticate,
  asyncHandler(async (req, res) => {
    const { txHash } = req.params;
    const userId = req.user!.id;

    if (!txHash || txHash.length < 10) {
      return res.status(400).json(apiResponse(null, 'Invalid txHash', 1001));
    }

    const tx = await txService.getTransactionStatus(txHash, userId);
    res.json(apiResponse(tx, 'Success'));
  })
);

/**
 * POST /api/v2/tx/sweep (MQ-2)
 * 清空钱包原生余额到指定地址（sweep）
 * Auth: Wallet signature required
 * Body: { walletId, toAddress, chain, paymentPassword }
 */
router.post(
  '/sweep',
  authenticate,
  asyncHandler(async (req, res) => {
    const { walletId, toAddress, chain, paymentPassword } = req.body;
    const userId = req.user!.id;

    if (!walletId || !toAddress || !chain || !paymentPassword) {
      return res.status(400).json(
        apiResponse(null, 'Missing required fields: walletId, toAddress, chain, paymentPassword', 1001)
      );
    }
    if (!isValidEthereumAddress(toAddress)) {
      return res.status(400).json(apiResponse(null, 'Invalid ethereum address format', 1006));
    }

    const result = await txService.sweepNative({ userId, walletId, toAddress, chain, paymentPassword });
    res.json(apiResponse(result, 'Sweep processed'));
  })
);

/**
 * POST /api/v2/tx/batch
 * Batch transfer (admin only)
 * Auth: Wallet signature + Admin required
 * Body: { walletId, transfers: [{to, amount}], paymentPassword }
 */
router.post(
  '/batch',
  authenticate,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { walletId, transfers, paymentPassword } = req.body;
    const userId = req.user!.id;

    if (!walletId || !transfers || !Array.isArray(transfers) || transfers.length === 0) {
      return res.status(400).json(
        apiResponse(null, 'Missing required fields: walletId, transfers (non-empty array)', 1001)
      );
    }

    if (!paymentPassword) {
      return res.status(400).json(apiResponse(null, 'Missing required field: paymentPassword', 1001));
    }

    const result = await txService.batchTransfer(userId, walletId, transfers, paymentPassword);
    res.json(apiResponse(result, 'Batch transfer processed'));
  })
);

/**
 * GET /api/v2/tx/batch/:batchId/progress
 * Get batch transfer progress (polling endpoint)
 * Auth: Wallet signature required
 */
router.get(
  '/batch/:batchId/progress',
  authenticate,
  asyncHandler(async (req, res) => {
    const { batchId } = req.params;
    const { getBatchProgress } = await import('../services/batchService');
    const progress = await getBatchProgress(batchId);
    res.json(apiResponse(progress, 'Success'));
  })
);

/**
 * GET /api/v2/tx/pending
 * List pending confirmation/approval transactions for current user
 * Auth: Wallet signature required
 */
router.get(
  '/pending',
  authenticate,
  asyncHandler(async (req, res) => {
    const userId = req.user!.id;
    const pending = await txService.getPendingTransactions(userId);
    res.json(apiResponse(pending, 'Success'));
  })
);

/**
 * POST /api/v2/tx/:id/confirm
 * Confirm a pending_confirmation transaction
 * Auth: Wallet signature required
 * Body: { paymentPassword }
 */
router.post(
  '/:id/confirm',
  authenticate,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { paymentPassword, totpCode } = req.body;
    const userId = req.user!.id;

    if (!paymentPassword) {
      return res.status(400).json(apiResponse(null, 'Missing paymentPassword', 1001));
    }
    // W-15: TOTP 2FA 强校验
    const { verifyTotp } = await import('../services/totpService');
    await verifyTotp(userId, totpCode);

    const result = await txService.confirmTransaction(id, userId, paymentPassword);
    res.json(apiResponse(result, 'Transaction confirmed'));
  })
);

/**
 * POST /api/v2/tx/:id/reject
 * Reject a pending_confirmation transaction
 * Auth: Wallet signature required
 */
router.post(
  '/:id/reject',
  authenticate,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const userId = req.user!.id;
    const result = await txService.rejectTransaction(id, userId);
    res.json(apiResponse(result, 'Transaction rejected'));
  })
);

export default router;
