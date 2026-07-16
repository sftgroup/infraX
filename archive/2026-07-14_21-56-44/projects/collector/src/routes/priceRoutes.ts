import { Router, Request } from 'express';
import { asyncHandler, apiResponse } from '../helpers';
import { pool } from '../database';
import { searchTokenSnapshots, getTokenHistory, fetchOnDemandTokenPrice } from '../services/okxChainOS';

const router = Router();

/**
 * Price Routes
 *
 * Extracted from dataRoutes.ts — token price lookup with three-tier fallback.
 */

/**
 * GET /api/v2/data/market/tokens (public)
 * Search DEX tokens across chains.
 *
 * Query params:
 *   chain   — filter by chain (ethereum, bsc, polygon, arbitrum, optimism, base)
 *   address — filter by token_address
 *   symbol  — filter by token_symbol (case-insensitive, partial match)
 *   limit   — max results (default 50)
 */
router.get(
  '/market/tokens',
  asyncHandler(async (req, res) => {
    const { chain, address, symbol, limit } = req.query as any;
    const data = await searchTokenSnapshots(chain, address, symbol, parseInt(limit || '50', 10));
    res.json(apiResponse(data));
  })
);

/**
 * GET /api/v2/data/market/token-history (public)
 * Get historical price snapshots for a specific token.
 *
 * Query params:
 *   chain    — chain name (required)
 *   address  — token address (required)
 *   hours    — time range in hours (default 24)
 *   limit    — max data points (default 100)
 */
router.get(
  '/market/token-history',
  asyncHandler(async (req, res) => {
    const { chain, address, hours, limit } = req.query as any;
    if (!chain || !address) {
      res.status(400).json(apiResponse(null, 'chain and address required'));
      return;
    }
    const data = await getTokenHistory(chain, address, parseInt(hours || '24', 10), parseInt(limit || '100', 10));
    res.json(apiResponse(data));
  })
);

/**
 * GET /api/v2/data/price (public)
 * Quick token price lookup — lightweight, single-value.
 *
 * Query params:
 *   chain  — chain name (required)
 *   token  — token_symbol (e.g. USDT) OR token_address (0x...)
 *
 * Falls back through: OKX DEX snapshots → Binance futures → OKX on-demand
 */
router.get(
  '/price',
  asyncHandler(async (req, res) => {
    const { chain, token } = req.query as any;
    if (!chain || !token) {
      res.status(400).json(apiResponse(null, 'chain and token required'));
      return;
    }

    const isAddress = token.startsWith('0x');
    const whereClause = isAddress
      ? 'chain = $1 AND token_address = $2'
      : 'chain = $1 AND token_symbol ILIKE $2';

    const result = await pool.query(
      `SELECT chain, token_address, token_symbol, token_name, price_usd, volume_24h, market_cap, liquidity_usd, holder_count, price_change_24h, dex_name, collected_at
       FROM okx_token_snapshots
       WHERE ${whereClause}
       ORDER BY collected_at DESC LIMIT 1`,
      [chain, isAddress ? token : token.toUpperCase()]
    );

    if (result.rows.length > 0) {
      const r = result.rows[0];
      res.json(apiResponse({
        chain: r.chain,
        token: r.token_symbol,
        address: r.token_address,
        token_name: r.token_name,
        price_usd: r.price_usd,
        volume_24h: r.volume_24h,
        market_cap: r.market_cap,
        liquidity_usd: r.liquidity_usd,
        holder_count: r.holder_count,
        price_change_24h: r.price_change_24h,
        dex_name: r.dex_name,
        updated_at: r.collected_at,
        source: 'okx_dex',
      }));
      return;
    }

    // Fallback: try Binance futures for major symbols (stored lowercase in DB)
    const symbol = token.toLowerCase() + 'usdt';
    const binRes = await pool.query(
      `SELECT symbol, close_price, mark_price, funding_rate, next_funding_time, bucket
       FROM binance_futures_prices
       WHERE symbol = $1
       ORDER BY bucket DESC LIMIT 1`,
      [symbol]
    );

    if (binRes.rows.length > 0) {
      const r = binRes.rows[0];
      res.json(apiResponse({
        chain: 'futures',
        token: token.toUpperCase(),
        address: null,
        token_name: token.toUpperCase() + ' Perpetual',
        price_usd: r.mark_price || r.close_price,
        funding_rate: r.funding_rate,
        next_funding_time: r.next_funding_time,
        updated_at: r.bucket,
        source: 'binance_futures',
      }));
      return;
    }

    // Fallback 2: On-demand OKX DEX query (real-time, for tokens not yet in cache)
    if (isAddress) {
      const live = await fetchOnDemandTokenPrice(chain, token);
      if (live) {
        res.json(apiResponse({
          chain: live.chain,
          token: live.token_symbol,
          address: live.token_address,
          token_name: live.token_name,
          price_usd: live.price_usd,
          volume_24h: live.volume_24h,
          market_cap: live.market_cap,
          liquidity_usd: live.liquidity_usd,
          holder_count: live.holder_count,
          price_change_24h: live.price_change_24h,
          dex_name: live.dex_name,
          updated_at: live.collected_at,
          source: 'okx_on_demand',
        }));
        return;
      }
    }

    res.json(apiResponse({
      chain,
      token,
      price_usd: null,
      updated_at: null,
      source: 'none',
      message: isAddress
        ? 'Price not available. Ensure OKX API key is configured in Admin Panel.'
        : 'Price not available. Try querying by contract address for on-demand lookup.',
    }));
  })
);

export default router;
