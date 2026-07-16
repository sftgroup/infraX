import { Router } from 'express';
import { asyncHandler, apiResponse, paginationParams } from '../utils/helpers';
import { authenticate, requireAdmin } from '../middleware/auth';
import { pool } from '../models/database';
import * as walletService from '../services/walletService';

const router = Router();

/**
 * POST /api/v2/wallet/create
 * Create custodial wallet for a chain
 * Auth: Wallet signature required
 * Body: { chain: string }
 */
router.post(
  '/create',
  authenticate,
  asyncHandler(async (req, res) => {
    const userId = req.user!.id;
    const { chain } = req.body;

    if (!chain || typeof chain !== 'string') {
      return res.status(400).json(apiResponse(null, 'Missing required field: chain', 1001));
    }

    const wallet = await walletService.createCustodialWallet(userId, chain.toLowerCase());
    res.json(apiResponse(wallet, 'Custodial wallet created'));
  })
);

/**
 * POST /api/v2/wallet/import
 * Import existing HD wallet
 * Auth: Wallet signature required
 * Body: { chain: string, hdPath: string }
 */
router.post(
  '/import',
  authenticate,
  asyncHandler(async (req, res) => {
    const userId = req.user!.id;
    const { chain, hdPath } = req.body;

    if (!chain || !hdPath) {
      return res.status(400).json(apiResponse(null, 'Missing required fields: chain, hdPath', 1001));
    }

    const wallet = await walletService.importCustodialWallet(userId, chain.toLowerCase(), hdPath);
    res.json(apiResponse(wallet, 'Custodial wallet imported'));
  })
);

/**
 * GET /api/v2/wallet/balance
 * Query balance across all chains
 * - Non-Custodial mode: queries RPC directly by walletAddress
 * - Custodial mode: queries cwallet HSM by userId
 * Auth: Wallet signature required
 * Query: (optional) chain, nc (bool) — nc=true triggers direct RPC query
 */
router.get(
  '/balance',
  authenticate,
  asyncHandler(async (req, res) => {
    const { chain, nc } = req.query;
    const walletAddress = req.user!.walletAddress;
    const userId = req.user!.id;

    // Non-Custodial: direct RPC query by wallet address
    if (nc === 'true' || nc === '1') {
      const chains = chain ? [String(chain)] : undefined;
      const balances = await walletService.getNCBalance(walletAddress, chains);
      return res.json(apiResponse(balances, 'Success'));
    }

    // Custodial: query cwallet HSM + DB
    const balances = await walletService.getAggregatedBalance(userId);
    res.json(apiResponse(balances, 'Success'));
  })
);

/**
 * GET /api/v2/wallet/address
 * Get deposit address for a specific chain
 * Auth: Wallet signature required
 * Query: chain: string
 */
router.get(
  '/address',
  authenticate,
  asyncHandler(async (req, res) => {
    const { chain } = req.query;
    const userId = req.user!.id;

    if (!chain || typeof chain !== 'string') {
      return res.status(400).json(apiResponse(null, 'Missing required query param: chain', 1001));
    }

    const address = await walletService.getWalletAddress(userId, chain.toLowerCase());
    res.json(apiResponse({ address, chain }, 'Success'));
  })
);

/**
 * GET /api/v2/wallet/transactions
 * Get transaction history with pagination
 * - Non-Custodial (nc=true): scans blocks via RPC
 * - Custodial: queries DB
 * Auth: Wallet signature required
 * Query: page, limit, chain, nc, type
 */
router.get(
  '/transactions',
  authenticate,
  asyncHandler(async (req, res) => {
    const walletAddress = req.user!.walletAddress;
    const userId = req.user!.id;
    const { nc, chain, type } = req.query;
    const page = Math.max(1, parseInt(req.query.page as string || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string || '10', 10)));

    // Non-Custodial: scan chain blocks via RPC
    if (nc === 'true' || nc === '1') {
      const result = await walletService.getNCTransactions(
        walletAddress,
        (chain as string) || 'sepolia',
        { page, limit, type: type as string | undefined }
      );
      return res.json({
        code: 0,
        message: 'success',
        data: { items: result.items, pagination: result.pagination },
      });
    }

    // Custodial: query DB
    const { offset } = paginationParams(req.query);
    const result = await walletService.getTransactionHistory(userId, offset, limit);
    res.json({
      code: 0,
      message: 'success',
      data: {
        items: result.items,
        pagination: {
          total: result.total,
          page,
          limit,
          totalPages: Math.ceil(result.total / limit),
        },
      },
    });
  })
);


/**
 * GET /api/v2/wallet/token-info
 * Get ERC20 token metadata (symbol, decimals, name)
 * Auth: Wallet signature required
 * Query: chain, address
 */
router.get(
  '/token-info',
  authenticate,
  asyncHandler(async (req, res) => {
    const { chain, address } = req.query;
    if (!chain || !address || typeof chain !== 'string' || typeof address !== 'string') {
      return res.status(400).json(apiResponse(null, 'Missing chain or address', 1001));
    }
    const info = await walletService.getTokenInfo(chain, address);
    res.json(apiResponse(info, 'Success'));
  })
);

/**
 * GET /api/v2/wallet/token-balance
 * Get ERC20 token balance for a wallet
 * Auth: Wallet signature required
 * Query: chain, address, wallet
 */
router.get(
  '/token-balance',
  authenticate,
  asyncHandler(async (req, res) => {
    const { chain, address: tokenAddress, wallet } = req.query;
    if (!chain || !tokenAddress || !wallet || typeof chain !== 'string' || typeof tokenAddress !== 'string' || typeof wallet !== 'string') {
      return res.status(400).json(apiResponse(null, 'Missing chain, address, or wallet', 1001));
    }
    const balance = await walletService.getTokenBalance(chain, tokenAddress, wallet);
    res.json(apiResponse(balance, 'Success'));
  })
);

/**
 * GET /api/v2/wallet/nfts
 * Get NFTs owned by a wallet address (scans ERC-721 Transfer events)
 * Auth: Wallet signature required
 * Query: address (wallet), chain (default sepolia)
 */
router.get(
  '/nfts',
  authenticate,
  asyncHandler(async (req, res) => {
    const address = (req.query.address as string) || req.user!.walletAddress;
    const chain = (req.query.chain as string) || 'sepolia';
    if (!address) {
      return res.status(400).json(apiResponse(null, 'Missing wallet address', 1001));
    }
    try {
      const nfts = await walletService.getNFTs(address, chain);
      res.json(apiResponse({ items: nfts, chain }, 'Success'));
    } catch (e: any) {
      // If RPC doesn't support NFT scanning, return empty gracefully
      res.json(apiResponse({ items: [], chain, note: e.message || 'NFT scanning unavailable on this chain' }, 'Success'));
    }
  })
);

/**
 * GET /api/v2/wallet/:chainId
 * Get HD wallet details + tokens for a specific chain
 */
router.get(
  "/:chainId",
  authenticate,
  asyncHandler(async (req, res) => {
    const userId = req.user!.id;
    const { chainId } = req.params;
    const wallet = await walletService.getWalletDetail(userId, chainId);
    if (!wallet) {
      return res.status(404).json(apiResponse(null, "Wallet not found", 1404));
    }
    res.json(apiResponse(wallet, "Success"));
  })
);

export default router;

// ── Custom Token CRUD (merged into same router) ──

// List custom tokens for current wallet
router.get(
  '/custom-tokens',
  authenticate,
  asyncHandler(async (req, res) => {
    const walletAddress = req.user!.walletAddress;
    // Ensure table exists
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS user_custom_tokens (
        id SERIAL PRIMARY KEY,
        wallet_address VARCHAR(42) NOT NULL,
        token_address VARCHAR(42) NOT NULL,
        symbol VARCHAR(20) NOT NULL,
        chain VARCHAR(20) DEFAULT 'sepolia',
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(wallet_address, token_address, chain)
      )`);
    } catch (_) {}
    const r = await pool.query(
      'SELECT token_address, symbol, chain FROM user_custom_tokens WHERE wallet_address = $1 ORDER BY created_at',
      [walletAddress]
    );
    res.json(apiResponse(r.rows, 'Success'));
  })
);

router.post(
  '/custom-token',
  authenticate,
  async (req, res, next) => {
    try {
      const walletAddress = req.user!.walletAddress;
      const { token_address, symbol, chain, network } = req.body;
      if (!token_address || !symbol) return res.status(400).json(apiResponse(null, 'Missing token_address or symbol', 1001));
      await pool.query(
        `INSERT INTO user_custom_tokens (wallet_address, token_address, symbol, chain)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (wallet_address, token_address, chain) DO UPDATE SET symbol = $3`,
        [walletAddress, token_address.toLowerCase(), symbol, network || 'sepolia']
      );
      res.json(apiResponse({ added: true }, 'OK'));
    } catch (e: any) { next(e); }
  }
);
router.delete(
  '/custom-token/:token_address',
  authenticate,
  async (req, res, next) => {
    try {
      const walletAddress = req.user!.walletAddress;
      await pool.query(
        'DELETE FROM user_custom_tokens WHERE wallet_address = $1 AND token_address = $2',
        [walletAddress, req.params.token_address.toLowerCase()]
      );
      res.json(apiResponse({ removed: true }, 'OK'));
    } catch (e: any) { next(e); }
  }
);
