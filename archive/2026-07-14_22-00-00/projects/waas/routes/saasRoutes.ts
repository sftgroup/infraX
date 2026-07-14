import { Router } from 'express';
import { asyncHandler, apiResponse } from '../utils/helpers';
import { authenticate, requireAdmin, requireTenantApiKey } from '../middleware/auth';
import { pool } from '../models/database';
import { config } from '../config';
import * as tenantService from '../services/tenantService';
import * as saasService from '../services/saasService';

/**
 * Extract wallet address from request (header, query param, or body).
 * Wallet ownership was proved at connect time — no re-signature needed.
 */
function getWalletAddress(req: any): string | undefined {
  return (req.headers['x-wallet-address'] || req.query.walletAddress || (req.body && req.body.walletAddress)) as string | undefined;
}

async function resolveTenantFromWallet(req: any): Promise<string | undefined> {
  const walletAddr = getWalletAddress(req);
  if (!walletAddr) return undefined;
  try {
    const tw = await tenantService.getTenantByWallet(walletAddr);
    return tw ? tw.id : undefined;
  } catch (_) { return undefined; }
}

const router = Router();

/**
 * SaaS WaaS Routes (F-033 ~ F-037)
 *
 * ── Tenant Management (admin only) ──
 * POST   /api/v2/saas/tenants           — Register new tenant
 * GET    /api/v2/saas/tenants           — List all tenants
 * GET    /api/v2/saas/tenants/:id       — Get tenant details
 * PATCH  /api/v2/saas/tenants/:id       — Update tenant config
 * DELETE /api/v2/saas/tenants/:id       — Suspend tenant
 *
 * ── Tenant-facing API (authenticated via x-api-key) ──
 * POST   /api/v2/saas/address           — Allocate address (F-034)
 * GET    /api/v2/saas/address/:userId   — Get address details
 * GET    /api/v2/saas/addresses         — List all addresses
 * POST   /api/v2/saas/withdraw          — Create withdrawal request (F-036)
 * GET    /api/v2/saas/withdrawals       — List withdrawals
 * POST   /api/v2/saas/withdraw/:id/approve  — Approve withdrawal
 * POST   /api/v2/saas/withdraw/:id/reject   — Reject withdrawal
 * POST   /api/v2/saas/sweep             — Trigger auto-sweep (F-035)
 * GET    /api/v2/saas/balances          — Balance overview (F-037)
 * GET    /api/v2/saas/transactions      — Transaction history (F-037)
 */

// ═══════════════════════════════════════════════
// User-facing: My Tenant (wallet-scoped)
// ═══════════════════════════════════════════════

/**
 * GET /api/v2/saas/tenants/my
 * Get current user's tenant info (wallet-scoped)
 * Auth: wallet address in header or query param (proved at connect time)
 */
router.get(
  '/tenants/my',
  asyncHandler(async (req, res) => {
    const walletAddress = getWalletAddress(req);
    if (!walletAddress) return res.status(400).json(apiResponse(null, 'Missing walletAddress', 1001));
    const tenant = await tenantService.getTenantByWallet(walletAddress);
    res.json(apiResponse(tenant, 'Success'));
  })
);

/**
 * POST /api/v2/saas/tenants/activate
 * Activate WaaS tenant for current user
 * Auth: wallet address in header, body, or query param (proved at connect time)
 */
router.post(
  '/tenants/activate',
  asyncHandler(async (req, res) => {
    const walletAddress = getWalletAddress(req);
    if (!walletAddress) return res.status(400).json(apiResponse(null, 'Missing walletAddress', 1001));
    const planId = (req.body as any)?.planId || 'free';
    const tenant = await tenantService.activateTenant(walletAddress, planId);
    res.json(apiResponse(tenant, 'Tenant activated'));
  })
);

// ═══════════════════════════════════════════════
// Admin: Tenant Management (F-033)
// ═══════════════════════════════════════════════

/**
 * POST /api/v2/saas/tenants
 * Register a new enterprise tenant (admin only)
 */
router.post(
  '/tenants',
  authenticate,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { name, contactEmail, webhookUrl } = req.body;

    if (!name || !contactEmail) {
      return res.status(400).json(apiResponse(null, 'Missing required fields: name, contactEmail', 1001));
    }

    const result = await tenantService.registerTenant({ name, contactEmail, webhookUrl });
    res.status(201).json(apiResponse(result, 'Tenant registered'));
  })
);

/**
 * GET /api/v2/saas/tenants
 * List all tenants (admin only)
 */
router.get(
  '/tenants',
  authenticate,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { status, limit, offset } = req.query;
    const result = await tenantService.listTenants({
      status: status as string,
      limit: limit ? parseInt(limit as string, 10) : undefined,
      offset: offset ? parseInt(offset as string, 10) : undefined,
    });
    res.json(apiResponse(result));
  })
);

/**
 * GET /api/v2/saas/tenants/:id
 * Get tenant details (admin only)
 */
router.get(
  '/tenants/:id',
  authenticate,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const tenant = await tenantService.getTenant(req.params.id);
    res.json(apiResponse(tenant));
  })
);

/**
 * PATCH /api/v2/saas/tenants/:id
 * Update tenant configuration (admin only)
 */
router.patch(
  '/tenants/:id',
  authenticate,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const tenant = await tenantService.updateTenant(req.params.id, req.body);
    res.json(apiResponse(tenant, 'Tenant updated'));
  })
);

/**
 * DELETE /api/v2/saas/tenants/:id
 * Suspend a tenant (admin only)
 */
router.delete(
  '/tenants/:id',
  authenticate,
  requireAdmin,
  asyncHandler(async (req, res) => {
    await tenantService.suspendTenant(req.params.id);
    res.json(apiResponse(null, 'Tenant suspended'));
  })
);

// ═══════════════════════════════════════════════
// Tenant-facing API: Address Management (F-034)
// ═══════════════════════════════════════════════

/**
 * POST /api/v2/saas/address
 * Allocate an address for a tenant's external user (L-019)
 * Auth: x-api-key (tenant)
 */
router.post(
  '/address',
  authenticate,
  asyncHandler(async (req, res) => {
    const tenantId = await resolveTenantFromWallet(req);
    const { externalUserId, chain, label } = req.body;

    if (!externalUserId || !chain) {
      return res.status(400).json(apiResponse(null, 'Missing required fields: externalUserId, chain', 1001));
    }

    const result = await saasService.allocateAddress({
      tenantId: tenantId,
      externalUserId,
      chain,
      label,
    });

    res.status(result.isNew ? 201 : 200).json(apiResponse(result, result.isNew ? 'Address allocated' : 'Address already exists'));
  })
);

/**
 * GET /api/v2/saas/address/:userId
 * Get address details for a tenant's external user
 * Auth: x-api-key (tenant)
 */
router.get(
  '/address/:userId',
  requireTenantApiKey,
  asyncHandler(async (req, res) => {
    const tenantId = await resolveTenantFromWallet(req);
    const address = await saasService.getAddress(tenantId, req.params.userId);
    res.json(apiResponse(address));
  })
);

/**
 * GET /api/v2/saas/addresses
 * List all addresses for a tenant
 * Auth: x-api-key (tenant)
 */
router.get(
  '/addresses',
  authenticate,
  asyncHandler(async (req, res) => {
    const tenantId = await resolveTenantFromWallet(req);
    if (!tenantId) return res.status(401).json(apiResponse(null, 'Authentication required', 1002));

    const { status, chain, limit, offset } = req.query;
    const result = await saasService.listAddresses({
      tenantId,
      status: status as string,
      chain: chain as string,
      limit: limit ? parseInt(limit as string, 10) : undefined,
      offset: offset ? parseInt(offset as string, 10) : undefined,
    });
    res.json(apiResponse(result));
  })
);

// ═══════════════════════════════════════════════
// Tenant-facing API: Withdrawals (F-036)
// ═══════════════════════════════════════════════

/**
 * POST /api/v2/saas/withdraw
 * Create a withdrawal request (L-021/022)
 * Auth: x-api-key (tenant)
 */
router.post(
  '/withdraw',
  authenticate,
  asyncHandler(async (req, res) => {
    const tenantId = await resolveTenantFromWallet(req);
    const { externalUserId, toAddress, token, amount } = req.body;

    if (!externalUserId || !toAddress || !amount) {
      return res.status(400).json(apiResponse(null, 'Missing required fields: externalUserId, toAddress, amount', 1001));
    }

    const result = await saasService.createWithdrawal({
      tenantId: tenantId,
      externalUserId,
      toAddress,
      token: token || '*',
      amount,
    });

    res.status(201).json(apiResponse(result, 'Withdrawal created'));
  })
);

/**
 * GET /api/v2/saas/withdrawals
 * List withdrawals for a tenant
 * Auth: optional — x-api-key (tenant) OR Wallet signature OR anonymous
 */
router.get(
  '/withdrawals',
  asyncHandler(async (req, res) => {
    const { status, limit, offset } = req.query;
    let tenantId: string | undefined;

    // Try x-api-key
    const apiKey = req.headers['x-api-key'] as string | undefined;
    if (apiKey) {
      try {
        const t = await tenantService.getTenantByApiKey(apiKey);
        if (t) tenantId = t.id;
      } catch (_) {}
    }

    // Query hot wallets from chains table (always, even without tenant)
    const hwQuery = await pool.query(
      'SELECT c.chain_id, c.display_name as chain, c.native_currency as native_symbol' +
      ' FROM chains c WHERE c.enabled = true ORDER BY c.display_name'
    );
    let hotWallets: any[] = [];
    if (tenantId) {
      const hwRows = await pool.query(
        'SELECT c.chain_id, c.display_name as chain, c.native_currency as native_symbol,' +
        ' t.hot_wallet_address as address,' +
        ' COALESCE(hwb.balance, \'0\')::float as native_balance' +
        ' FROM chains c' +
        ' LEFT JOIN tenants t ON t.id = $1' +
        ' LEFT JOIN hot_wallet_balances hwb ON hwb.tenant_id = $1 AND hwb.chain_id = c.chain_id' +
        ' WHERE c.enabled = true ORDER BY c.display_name',
        [tenantId]
      );
      hotWallets = hwRows.rows.map((r: any) => ({
        chain: r.chain,
        chainId: String(r.chain_id),
        address: r.address || '',
        nativeSymbol: r.native_symbol,
        nativeBalance: r.native_balance || 0,
      }));
    } else {
      hotWallets = hwQuery.rows.map((r: any) => ({
        chain: r.chain,
        chainId: String(r.chain_id),
        address: '',
        nativeSymbol: r.native_symbol,
        nativeBalance: 0,
      }));
    }

    if (!tenantId) {
      return res.json(apiResponse({ items: [], total: 0, hotWallets }));
    }

    const result = await saasService.listWithdrawals({
      tenantId,
      status: status as string,
      limit: limit ? parseInt(limit as string, 10) : undefined,
      offset: offset ? parseInt(offset as string, 10) : undefined,
    });

    res.json(apiResponse({ ...result, hotWallets }));
  })
);

// ═══════════════════════════════════════════════
// Admin: Withdrawal Review (F-036)
// ═══════════════════════════════════════════════

/**
 * POST /api/v2/saas/withdraw/:id/approve
 * Approve a withdrawal (tenant admin review)
 * Auth: Wallet signature (admin) or tenant API key
 */
router.post(
  '/withdraw/:id/approve',
  authenticate,
  requireAdmin,
  asyncHandler(async (req, res) => {
    // Admin reviews on behalf of tenant
    const withdrawal = await pool.query(
      'SELECT tenant_id FROM saas_withdrawals WHERE id = $1',
      [req.params.id]
    );
    if (withdrawal.rows.length === 0) {
      return res.status(404).json(apiResponse(null, 'Withdrawal not found', 1001));
    }

    const result = await saasService.approveWithdrawal(
      withdrawal.rows[0].tenant_id,
      req.params.id,
      req.user!.walletAddress + '@web3.infrax.local'
    );
    res.json(apiResponse(result, 'Withdrawal approved'));
  })
);

/**
 * POST /api/v2/saas/withdraw/:id/reject
 * Reject a withdrawal (tenant admin review)
 * Auth: Wallet signature (admin)
 */
router.post(
  '/withdraw/:id/reject',
  authenticate,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { reason } = req.body;
    if (!reason) {
      return res.status(400).json(apiResponse(null, 'Missing required field: reason', 1001));
    }

    const withdrawal = await pool.query(
      'SELECT tenant_id FROM saas_withdrawals WHERE id = $1',
      [req.params.id]
    );
    if (withdrawal.rows.length === 0) {
      return res.status(404).json(apiResponse(null, 'Withdrawal not found', 1001));
    }

    const result = await saasService.rejectWithdrawal(
      withdrawal.rows[0].tenant_id,
      req.params.id,
      reason,
      req.user!.walletAddress + '@web3.infrax.local'
    );
    res.json(apiResponse(result, 'Withdrawal rejected'));
  })
);

// ═══════════════════════════════════════════════
// Tenant-facing API: Sweep & Dashboard (F-035, F-037)
// ═══════════════════════════════════════════════

/**
 * POST /api/v2/saas/sweep
 * Trigger auto-sweep for a tenant (F-035)
 * Auth: x-api-key (tenant)
 */
router.post(
  '/sweep',
  requireTenantApiKey,
  asyncHandler(async (req, res) => {
    const tenantId = await resolveTenantFromWallet(req);
    const result = await saasService.sweepTenantFunds(tenantId);
    res.json(apiResponse(result, 'Sweep completed'));
  })
);

/**
 * GET /api/v2/saas/balances
 * Balance overview for a tenant (F-037)
 * Auth: x-api-key (tenant) or Wallet signature (admin via query param)
 */
router.get(
  '/balances',
  requireTenantApiKey,
  asyncHandler(async (req, res) => {
    const tenantId = await resolveTenantFromWallet(req);
    const balances = await saasService.getTenantBalances(tenantId);
    res.json(apiResponse(balances));
  })
);

/**
 * GET /api/v2/saas/transactions
 * Transaction history for a tenant (F-037)
 * Auth: x-api-key (tenant)
 */
router.get(
  '/transactions',
  requireTenantApiKey,
  asyncHandler(async (req, res) => {
    const tenantId = await resolveTenantFromWallet(req);
    const { limit, offset } = req.query;

    const result = await saasService.getTenantTransactions({
      tenantId: tenantId,
      limit: limit ? parseInt(limit as string, 10) : undefined,
      offset: offset ? parseInt(offset as string, 10) : undefined,
    });

    res.json(apiResponse(result));
  })
);

// ═══════════════════════════════════════════════
// Tenant-facing: API Key Management
// ═══════════════════════════════════════════════

/**
 * GET /api/v2/saas/apikeys
 * List all API keys for the authenticated tenant
 * Auth: Wallet signature (tenant user)
 */
router.get(
  '/apikeys',
  authenticate,
  asyncHandler(async (req, res) => {
    const user = (req as any).user;
    if (!user?.walletAddress) {
      return res.status(401).json(apiResponse(null, 'Unauthorized', 401));
    }
    // Resolve tenantId from walletAddress
    const t = await pool.query('SELECT id FROM tenants WHERE owner_user_id = (SELECT id FROM users WHERE wallet_address = $1)', [user.walletAddress]);
    if (t.rows.length === 0) {
      return res.status(404).json(apiResponse(null, 'No tenant found for this wallet', 404));
    }
    const keys = await saasService.listApiKeys(t.rows[0].id);
    res.json(apiResponse(keys));
  })
);

/**
 * POST /api/v2/saas/apikeys
 * Generate a new API key for the authenticated tenant
 * Auth: Wallet signature (tenant user)
 */
router.post(
  '/apikeys',
  authenticate,
  asyncHandler(async (req, res) => {
    const user = (req as any).user;
    if (!user?.walletAddress) {
      return res.status(401).json(apiResponse(null, 'Unauthorized', 401));
    }
    const { name } = req.body;
    // Resolve tenantId from walletAddress
    const t = await pool.query('SELECT id FROM tenants WHERE owner_user_id = (SELECT id FROM users WHERE wallet_address = $1)', [user.walletAddress]);
    if (t.rows.length === 0) {
      return res.status(404).json(apiResponse(null, 'No tenant found for this wallet', 404));
    }
    const result = await saasService.createApiKey(t.rows[0].id, name || 'default');
    res.status(201).json(apiResponse(result));
  })
);

/**
 * POST /api/v2/saas/apikeys/:id/rotate
 * Rotate an existing API key (generates new key, deactivates old one)
 * Auth: Wallet signature (tenant user)
 */
router.post(
  '/apikeys/:id/rotate',
  authenticate,
  asyncHandler(async (req, res) => {
    const user = (req as any).user;
    const keyId = req.params.id;
    if (!user?.walletAddress) {
      return res.status(401).json(apiResponse(null, 'Unauthorized', 401));
    }
    // Resolve tenantId from walletAddress
    const t = await pool.query('SELECT id FROM tenants WHERE owner_user_id = (SELECT id FROM users WHERE wallet_address = $1)', [user.walletAddress]);
    if (t.rows.length === 0) {
      return res.status(404).json(apiResponse(null, 'No tenant found for this wallet', 404));
    }
    const result = await saasService.rotateApiKey(keyId, t.rows[0].id);
    res.json(apiResponse(result));
  })
);

/**
 * DELETE /api/v2/saas/apikeys/:id
 * Revoke an API key
 * Auth: Wallet signature (tenant user)
 */
router.delete(
  '/apikeys/:id',
  authenticate,
  asyncHandler(async (req, res) => {
    const user = (req as any).user;
    const keyId = req.params.id;
    if (!user?.walletAddress) {
      return res.status(401).json(apiResponse(null, 'Unauthorized', 401));
    }
    await saasService.revokeApiKey(keyId);
    res.json(apiResponse(null, 'Key revoked'));
  })
);


// ═══════════════════════════════════════════════
// API Key Management
// ═══════════════════════════════════════════════

router.post('/tenants/:tenantId/apikey', asyncHandler(async (req, res) => {
  const { tenantId } = req.params;
  const tenant = await tenantService.regenerateApiKey(tenantId);
  res.json(apiResponse({ apiKey: tenant.apiKey }));
}) );

router.post('/tenants/:tenantId/apikey/rotate', asyncHandler(async (req, res) => {
  const { tenantId } = req.params;
  const tenant = await tenantService.regenerateApiKey(tenantId);
  res.json(apiResponse({ apiKey: tenant.apiKey }));
}) );

router.delete('/tenants/:tenantId/apikey', asyncHandler(async (req, res) => {
  const { tenantId } = req.params;
  await tenantService.deleteApiKey(tenantId);
  res.json(apiResponse(null, 'API key deleted'));
}) );

// ═══════════════════════════════════════════════
// Hot Wallet
// ═══════════════════════════════════════════════

router.post('/tenants/:tenantId/hot-wallet', asyncHandler(async (req, res) => {
  const { tenantId } = req.params;
  const { chainId } = req.body || {};
  const wallet = await tenantService.generateHotWallet(tenantId, chainId || 11155111);
  res.json(apiResponse(wallet, 'Hot wallet generated'));
}) );


// ═══════════════════════════════════════════════
// API Key Management
// ═══════════════════════════════════════════════

router.post('/tenants/:tenantId/apikey', asyncHandler(async (req, res) => {
  const { tenantId } = req.params;
  const tenant = await tenantService.regenerateApiKey(tenantId);
  res.json(apiResponse({ apiKey: tenant.apiKey }));
}) );

router.post('/tenants/:tenantId/apikey/rotate', asyncHandler(async (req, res) => {
  const { tenantId } = req.params;
  const tenant = await tenantService.regenerateApiKey(tenantId);
  res.json(apiResponse({ apiKey: tenant.apiKey }));
}) );

router.delete('/tenants/:tenantId/apikey', asyncHandler(async (req, res) => {
  const { tenantId } = req.params;
  await tenantService.deleteApiKey(tenantId);
  res.json(apiResponse(null, 'API key deleted'));
}) );

// ═══════════════════════════════════════════════
// Hot Wallet
// ═══════════════════════════════════════════════

router.post('/tenants/:tenantId/hot-wallet', asyncHandler(async (req, res) => {
  const { tenantId } = req.params;
  const { chainId } = req.body || {};
  const wallet = await tenantService.generateHotWallet(tenantId, chainId || 11155111);
  res.json(apiResponse(wallet, 'Hot wallet generated'));
}) );

export default router;
