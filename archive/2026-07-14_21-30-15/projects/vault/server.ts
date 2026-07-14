// InfraX Vault Server — multi-sig + Safe chain execution + risk control
// Standalone Express service, independent of other InfraX modules
import express from 'express';
import { Pool } from 'pg';
import cors from 'cors';
import crypto from 'crypto';
import * as multiSigService from './src/services/multiSigService';

const app = express();
app.use(express.json());
app.use(cors({ origin: true, credentials: true }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://ubuntu@localhost:5432/pocketx_vault',
  max: 10,
  idleTimeoutMillis: 30000,
});

function asyncHandler(fn: any) {
  return (req: any, res: any, next: any) => Promise.resolve(fn(req, res, next)).catch(next);
}
function apiResponse(data: any = null, message = 'success', code = 0) {
  return { code, message, data };
}

// ─── Health ───
app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'infrax-ault', uptime: process.uptime() }));

// ─── Dashboard ───
app.get('/api/vault/dashboard', asyncHandler(async (_req: any, res: any) => {
  const [safeCount, txCount, pendingSig, activeRules] = await Promise.all([
    pool.query('SELECT COUNT(*)::int as count FROM safe_wallets').then(r => r.rows[0].count || 0).catch(() => 0),
    pool.query('SELECT COUNT(*)::int as count FROM safe_transactions').then(r => r.rows[0].count || 0).catch(() => 0),
    pool.query("SELECT COUNT(*)::int as count FROM safe_signatures WHERE status='pending'").then(r => r.rows[0].count || 0).catch(() => 0),
    pool.query('SELECT COUNT(*)::int as count FROM risk_rules WHERE enabled=true').then(r => r.rows[0].count || 0).catch(() => 0),
  ]);
  res.json({ safeCount, txCount, pendingSig, activeRules });
}));

// ═══ Safe Multi-Sig ═══

// POST /api/vault/safe/create
app.post('/api/vault/safe/create', asyncHandler(async (req: any, res: any) => {
  const { userId, chainId, owners, threshold, name } = req.body;
  if (!chainId || !owners || !Array.isArray(owners) || owners.length === 0) {
    return res.status(400).json(apiResponse(null, 'Missing required fields: chainId, owners', 1001));
  }
  if (typeof threshold !== 'number' || threshold < 1 || threshold > owners.length) {
    return res.status(400).json(apiResponse(null, `Threshold must be between 1 and ${owners.length}`, 1001));
  }
  const safe = await multiSigService.createSafe({ userId: userId || 'vault', chainId, owners, threshold, name });
  res.status(201).json(apiResponse(safe, 'Safe wallet created'));
}));

// POST /api/vault/safe/propose
app.post('/api/vault/safe/propose', asyncHandler(async (req: any, res: any) => {
  const { userId, safeAddress, to, value, data } = req.body;
  if (!safeAddress || !to) {
    return res.status(400).json(apiResponse(null, 'Missing required fields: safeAddress, to', 1001));
  }
  const tx = await multiSigService.proposeTransaction({ userId: userId || 'vault', safeAddress, to, value: value || '0', data });
  res.status(201).json(apiResponse(tx, 'Transaction proposed'));
}));

// POST /api/vault/safe/confirm
app.post('/api/vault/safe/confirm', asyncHandler(async (req: any, res: any) => {
  const { userId, safeAddress, safeTxHash, signature } = req.body;
  if (!safeAddress || !safeTxHash || !signature) {
    return res.status(400).json(apiResponse(null, 'Missing required fields', 1001));
  }
  const result = await multiSigService.confirmTransaction({ userId: userId || 'vault', safeAddress, safeTxHash, signature });
  const msg = result.sigCount >= result.threshold
    ? `Threshold met! ${result.sigCount}/${result.threshold} - ready to execute`
    : `Signed (${result.sigCount}/${result.threshold})`;
  res.json(apiResponse(result, msg));
}));

// POST /api/vault/safe/execute
app.post('/api/vault/safe/execute', asyncHandler(async (req: any, res: any) => {
  const { userId, safeTxHash } = req.body;
  if (!safeTxHash) return res.status(400).json(apiResponse(null, 'Missing safeTxHash', 1001));
  const result = await multiSigService.executeTransaction({ userId: userId || 'vault', safeTxHash });
  res.json(apiResponse(result, 'Transaction executed'));
}));

// GET /api/vault/safe/list
app.get('/api/vault/safe/list', asyncHandler(async (req: any, res: any) => {
  const safes = await multiSigService.listSafes(req.query.userId as string || undefined);
  res.json(apiResponse({ items: safes }));
}));

// GET /api/vault/safe/owned — FIXED: requires userId auth
app.get('/api/vault/safe/owned', asyncHandler(async (req: any, res: any) => {
  const userId = req.query.userId as string || req.headers['x-user-id'] as string;
  if (!userId) return res.status(400).json(apiResponse(null, 'userId required (query param or x-user-id header)', 1001));
  const safes = await multiSigService.listSafes(userId);
  res.json(apiResponse({ items: safes }));
}));

// GET /api/vault/safe/participating — FIXED: requires userId auth
app.get('/api/vault/safe/participating', asyncHandler(async (req: any, res: any) => {
  const userId = req.query.userId as string || req.headers['x-user-id'] as string;
  if (!userId) return res.status(400).json(apiResponse(null, 'userId required (query param or x-user-id header)', 1001));
  const safes = await multiSigService.listSafes(userId);
  res.json(apiResponse({ items: safes }));
}));

// GET /api/vault/safe/:address
app.get('/api/vault/safe/:address', asyncHandler(async (req: any, res: any) => {
  const { address } = req.params;
  if (!address || !address.startsWith('0x') || address.length !== 42) {
    return res.status(400).json(apiResponse(null, 'Invalid address format', 1001));
  }
  const safe = await multiSigService.getSafe(address);
  const transactions = await multiSigService.getSafeTransactions(address);
  res.json(apiResponse({ safe, transactions }));
}));

// PUT /api/vault/safe/:address/owners
app.put('/api/vault/safe/:address/owners', asyncHandler(async (req: any, res: any) => {
  const { address } = req.params;
  const { userId, owners, threshold } = req.body;
  if (!owners || !Array.isArray(owners) || !threshold) {
    return res.status(400).json(apiResponse(null, 'Missing required fields: owners, threshold', 1001));
  }
  const result = await multiSigService.updateSafeOwners({
    userId: userId || 'vault', safeAddress: address, newOwners: owners, newThreshold: threshold,
  });
  res.json(apiResponse(result, 'Safe owners updated'));
}));

// POST /api/vault/safe/retry
app.post('/api/vault/safe/retry', asyncHandler(async (req: any, res: any) => {
  const { chainId } = req.body;
  const result = await multiSigService.retryPendingSafes(chainId);
  res.json(apiResponse(result, `Retried ${result.retried}: deployed=${result.deployed} failed=${result.failed}`));
}));

// POST /api/vault/safe/execute-ready
app.post('/api/vault/safe/execute-ready', asyncHandler(async (req: any, res: any) => {
  const { safeAddress } = req.body;
  const result = await multiSigService.executeReadyTransactions(safeAddress);
  res.json(apiResponse(result, `Executed: ${result.executed} failed=${result.failed}`));
}));

// POST /api/vault/safe/sync
app.post('/api/vault/safe/sync', asyncHandler(async (req: any, res: any) => {
  const { safeAddress } = req.body;
  if (!safeAddress) return res.status(400).json(apiResponse(null, 'Missing safeAddress', 1001));
  const result = await multiSigService.syncSafeState(safeAddress);
  res.json(apiResponse(result, 'Safe synced'));
}));

// GET /api/vault/safe/status
app.get('/api/vault/safe/status', asyncHandler(async (req: any, res: any) => {
  const walletAddress = req.query.walletAddress as string || '0x';
  const count = await multiSigService.getSafeCount(walletAddress);
  res.json(apiResponse({ enabled: count > 0, count }));
}));

// ═══ Risk Rules ═══
app.get('/api/vault/risk/rules', asyncHandler(async (_req: any, res: any) => {
  const result = await pool.query('SELECT * FROM risk_rules ORDER BY created_at DESC').catch(() => ({ rows: [] }));
  res.json(result.rows);
}));

app.post('/api/vault/risk/rules', asyncHandler(async (req: any, res: any) => {
  const { name, chain, max_single, max_daily, enabled } = req.body;
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO risk_rules (id, name, chain, max_single, max_daily, enabled) VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, name, chain, max_single, max_daily, enabled !== false]
  );
  res.status(201).json({ id, name });
}));

app.post('/api/vault/risk/check', asyncHandler(async (req: any, res: any) => {
  const { amount, chain } = req.body;
  const rules = await pool.query(
    'SELECT * FROM risk_rules WHERE chain = $1 AND enabled = true ORDER BY max_single DESC LIMIT 1', [chain]
  ).catch(() => ({ rows: [] }));
  if (rules.rows.length === 0) return res.json({ pass: true, reason: 'no rules' });
  const rule = rules.rows[0];
  if (parseFloat(amount) > parseFloat(rule.max_single)) {
    return res.json({ pass: false, reason: `exceeds max_single ${rule.max_single}`, rule: rule.name });
  }
  res.json({ pass: true, rule: rule.name });
}));

// ─── Start ───
const PORT = parseInt(process.env.PORT || '6002', 10);
app.listen(PORT, () => console.log(`Vault API running on port ${PORT}`));
