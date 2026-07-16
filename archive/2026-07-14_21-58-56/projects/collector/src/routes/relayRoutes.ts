import { Router, Request, Response } from 'express';
import { asyncHandler, apiResponse } from '../helpers';
import { logger } from '../logger';
import { relayTx } from '../services/relayer';

const router = Router();

/**
 * POST /api/v1/relay
 * Broadcast a signed raw transaction to the target chain.
 *
 * Body:
 *   chain — chain name (ethereum, bsc, polygon, arbitrum, optimism, base, sepolia)
 *   tx    — hex-encoded raw transaction (0x...)
 *
 * Response:
 *   tx_hash — broadcast transaction hash
 */
router.post(
  '/relay',
  asyncHandler(async (req: Request, res: Response) => {
    const { chain, tx } = req.body;

    if (!chain || !tx) {
      res.status(400).json(apiResponse(null, 'chain and tx required'));
      return;
    }

    try {
      const txHash = await relayTx(chain, tx);
      logger.info('[relay] Broadcast success', { chain, txHash: txHash.slice(0, 20) + '...' });
      res.json(apiResponse({ tx_hash: txHash }));
    } catch (err: any) {
      const msg = err.message || 'relay failed';
      logger.error('[relay] Broadcast failed', { chain, error: msg });
      res.status(502).json(apiResponse(null, msg));
    }
  })
);

export default router;
