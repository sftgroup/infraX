import { Router, Request, Response, NextFunction } from 'express';
import { asyncHandler, apiResponse } from '../helpers';
import { queryEvents, getChainStats, queryEventsBatch } from '../services/dataWholesale';
import { getCleaner } from '../services/cleaner';
import { getScanner } from '../services/scanner';
import { pool } from '../database';

const router = Router();

// Optional auth — pass through with user if cookie present
function optAuth(req: Request, _res: Response, next: NextFunction): void {
  if (req.cookies?.admin_session === 'valid') (req as any).user = { role: 'admin' };
  next();
}

/**
 * Data Routes — Event Collector + Data Wholesale
 *
 * GET  /api/v2/data/events        — Query on-chain events
 * GET  /api/v2/data/stats         — Chain-level statistics
 * GET  /api/v2/data/health        — Collector health
 * GET  /api/v2/data/checkpoints   — All collector checkpoints
 * POST /api/v2/data/events/batch  — Batch query (multi-address × multi-chain)
 */

/**
 * GET /api/v2/data/events
 * Query standardized on-chain events.
 *
 * Query params:
 *   chain         — filter by chain name
 *   address       — filter by from_address OR to_address
 *   contract      — filter by contract_address
 *   event_type    — filter by event_type (transfer, etc.)
 *   from_block    — block range start
 *   to_block      — block range end
 *   page_size     — results per page (default 100, max 500)
 *   page_token    — cursor for next page
 */
router.get(
  '/events',
  optAuth,
  asyncHandler(async (req, res) => {
    const params = {
      chain: req.query.chain as string | undefined,
      address: req.query.address as string | undefined,
      contract: req.query.contract as string | undefined,
      event_type: req.query.event_type as string | undefined,
      from_block: req.query.from_block ? parseInt(req.query.from_block as string, 10) : undefined,
      to_block: req.query.to_block ? parseInt(req.query.to_block as string, 10) : undefined,
      page_size: req.query.page_size ? parseInt(req.query.page_size as string, 10) : undefined,
      page_token: req.query.page_token as string | undefined,
    };

    const result = await queryEvents(params);
    res.json(apiResponse(result));
  })
);

/**
 * GET /api/v2/data/stats
 * Get chain-level event statistics
 */
router.get(
  '/stats',
  asyncHandler(async (_req, res) => {
    const stats = await getChainStats();
    const storageStats = await getCleaner().getStorageStats();
    res.json(apiResponse({ chains: stats, storage: storageStats }));
  })
);

/**
 * GET /api/v2/data/health
 * Collector health status — scanner state, endpoint count, storage
 */
router.get(
  '/health',
  asyncHandler(async (_req, res) => {
    const scanner = getScanner();
    const scannerHealth = scanner.getHealth();
    const cleaner = getCleaner();
    const storage = await cleaner.getStorageStats();

    const checkpoints = await pool.query(
      'SELECT chain, collector_name, last_block, status, last_fetch_at FROM event_checkpoints ORDER BY chain'
    );

    res.json(apiResponse({
      status: 'ok',
      scanners: scannerHealth.collectors,
      endpoints: scannerHealth.endpoints,
      storage,
      checkpoints: checkpoints.rows,
    }));
  })
);

/**
 * GET /api/v2/data/checkpoints
 * All collector checkpoints
 */
router.get(
  '/checkpoints',
  asyncHandler(async (_req, res) => {
    const result = await pool.query(
      'SELECT chain, collector_name, last_block, status, last_fetch_at, error_message FROM event_checkpoints ORDER BY chain, collector_name'
    );
    res.json(apiResponse(result.rows));
  })
);

/**
 * POST /api/v2/data/events/batch
 * Batch query events for multiple addresses across multiple chains.
 *
 * Body:
 *   addresses   — array of addresses (max 20)
 *   chains      — array of chain names (max 7)
 *   event_type  — optional event type filter
 *   per_address — max results per address (default 50, max 100)
 */
router.post(
  '/events/batch',
  asyncHandler(async (req, res) => {
    let { addresses, chains, event_type, per_address } = req.body || {};

    // Support both formats:
    //   format 1: { addresses: [{address, chain}, ...], ... }
    //   format 2: { addresses: ['0x...'], chains: ['ethernet'], ... }
    if (addresses && Array.isArray(addresses) && addresses.length > 0 && typeof addresses[0] === 'object') {
      // Format 1 — extract per-address chain
      const addressObjs = addresses.slice(0, 20);
      chains = [...new Set(addressObjs.map((a: any) => a.chain).filter(Boolean))];
      addresses = addressObjs.map((a: any) => a.address);
    }

    if (!addresses || !Array.isArray(addresses) || addresses.length === 0) {
      return res.status(400).json({ code: -1, message: 'addresses array (max 20) is required' });
    }
    if (!chains || !Array.isArray(chains) || chains.length === 0) {
      return res.status(400).json({ code: -1, message: 'chains array (max 7) is required' });
    }
    if (addresses.length > 20) {
      return res.status(400).json({ code: -1, message: 'max 20 addresses allowed' });
    }
    if (chains.length > 7) {
      return res.status(400).json({ code: -1, message: 'max 7 chains allowed' });
    }

    const result = await queryEventsBatch({ addresses, chains, event_type, per_address });
    res.json(apiResponse(result));
  })
);

export default router;
