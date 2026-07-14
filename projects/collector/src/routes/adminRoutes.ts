import { Router, Request, Response } from 'express';
import { asyncHandler, apiResponse } from '../helpers';
import { pool } from '../database';
import { logger } from '../logger';
import { getScanner } from '../services/scanner';
import { getCleaner } from '../services/cleaner';
import { getOkxCollector } from '../services/okxChainOS';
import { getBinanceCollector } from '../services/binanceFutures';
const router = Router();

// ── Env-based endpoints (exposed as read-only to the frontend) ──
const ENV_CHAINS = ['ethereum', 'bsc', 'base', 'sepolia', 'solana'];
const ENV_VARS: Record<string, string[]> = {
  ethereum:  ['ETH_RPC_URL', 'ETH_RPC_URL_2'],
  bsc:       ['BSC_RPC_URL', 'BSC_RPC_URL_2'],
  base:      ['BASE_RPC_URL', 'BASE_RPC_URL_2'],
  sepolia:   ['SEPOLIA_RPC_URL', 'SEPOLIA_RPC_URL_2'],
  solana:    ['SOLANA_RPC_URL', 'SOLANA_RPC_URL_2'],
};

function getEnvEndpoints() {
  const result: any[] = [];
  for (const chain of ENV_CHAINS) {
    for (const envKey of ENV_VARS[chain]) {
      const url = process.env[envKey];
      if (!url) continue;
      result.push({
        chain,
        endpoint_key: envKey,
        url,
        provider: detectProvider(url),
        tier: 'free',
        rpm: 60,
        rpd: 10_000,
        enabled: true,
        source: 'env',
        _readonly: true,
      });
    }
  }
  return result;
}

function detectProvider(url: string): string {
  if (url.includes('infura')) return 'infura';
  if (url.includes('alchemy')) return 'alchemy';
  if (url.includes('blastapi')) return 'blastapi';
  if (url.includes('publicnode')) return 'publicnode';
  if (url.includes('1rpc.io')) return '1rpc';
  if (url.includes('drpc.org')) return 'drpc';
  if (url.includes('tenderly')) return 'tenderly';
  if (url.includes('quicknode')) return 'quicknode';
  return 'custom';
}

/**
 * GET /api/v2/admin/rpc-endpoints
 * Returns env-based endpoints + DB endpoints merged
 */
router.get(
  '/rpc-endpoints',
  asyncHandler(async (_req, res) => {
    const envEps = getEnvEndpoints();
    const dbResult = await pool.query(
      'SELECT chain, endpoint_key, url, provider, tier, rpm, rpd, enabled, created_at, updated_at FROM admin_rpc_config ORDER BY chain, endpoint_key'
    );
    // Merge: DB endpoints take priority over env when same chain+key
    const merged = [...envEps];
    for (const dbEp of dbResult.rows) {
      const idx = merged.findIndex(e => e.chain === dbEp.chain && e.endpoint_key === dbEp.endpoint_key);
      if (idx >= 0) {
        merged[idx] = { ...dbEp, source: 'db', _readonly: false };
      } else {
        merged.push({ ...dbEp, source: 'db', _readonly: false });
      }
    }
    res.json(apiResponse(merged));
  })
);

/**
 * POST /api/v2/admin/rpc-endpoint
 * Add or update an RPC endpoint. Persisted to admin_rpc_config table.
 */
router.post(
  '/rpc-endpoint',
  asyncHandler(async (req, res) => {
    const { chain, key, url, provider, tier, rpm, rpd } = req.body;
    if (!chain || !url) {
      return res.status(400).json(apiResponse(null, 'chain and url are required', -1));
    }

    const endpointKey = key || `${chain}-${Date.now()}`;
    const endpointProvider = provider || 'custom';
    const endpointTier = tier || 'free';
    const endpointRpm = rpm || 60;
    const endpointRpd = rpd || 10_000;

    await pool.query(
      `INSERT INTO admin_rpc_config (chain, endpoint_key, url, provider, tier, rpm, rpd, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true)
       ON CONFLICT (chain, endpoint_key)
       DO UPDATE SET url = $3, provider = $4, tier = $5, rpm = $6, rpd = $7, enabled = true, updated_at = NOW()`,
      [chain.toLowerCase(), endpointKey, url.trim(), endpointProvider, endpointTier, endpointRpm, endpointRpd]
    );

    logger.info('[admin] RPC endpoint saved', { chain, key: endpointKey });
    // Refresh scanner's RPC pool so new endpoint is used immediately
    try { await getScanner().refreshConfig(); } catch {}
    res.json(apiResponse({ chain, key: endpointKey, saved: true }));
  })
);

/**
 * DELETE /api/v2/admin/rpc-endpoint/:chain/:key
 * Remove an RPC endpoint
 */
router.delete(
  '/rpc-endpoint/:chain/:key',
  asyncHandler(async (req, res) => {
    const { chain, key } = req.params;
    await pool.query(
      'DELETE FROM admin_rpc_config WHERE chain = $1 AND endpoint_key = $2',
      [chain.toLowerCase(), key]
    );
    logger.info('[admin] RPC endpoint removed', { chain, key });
    try { await getScanner().refreshConfig(); } catch {}
    res.json(apiResponse({ removed: true }));
  })
);

/**
 * PATCH /api/v2/admin/rpc-endpoint/:chain/:key/toggle
 * Enable/disable an endpoint
 */
router.patch(
  '/rpc-endpoint/:chain/:key/toggle',
  asyncHandler(async (req, res) => {
    const { chain, key } = req.params;
    const result = await pool.query(
      'UPDATE admin_rpc_config SET enabled = NOT enabled, updated_at = NOW() WHERE chain = $1 AND endpoint_key = $2 RETURNING enabled',
      [chain.toLowerCase(), key]
    );
    res.json(apiResponse({ enabled: result.rows[0]?.enabled }));
    try { await getScanner().refreshConfig(); } catch {}
  })
);

/**
 * GET /api/v2/admin/dashboard
 * Full dashboard data: scanner status, storage, events count, endpoints
 * Uses 5s cache to avoid overwhelming DB during RPC storms
 */
let dashboardCache: { data: any; ts: number } | undefined;
router.get(
  '/dashboard',
  asyncHandler(async (_req, res) => {
    const now = Date.now();
    if (dashboardCache && now - dashboardCache.ts < 5000) {
      res.json(apiResponse(dashboardCache.data));
      return;
    }

    const scanner = getScanner();
    const cleaner = getCleaner();
    const scannerHealth = scanner.getHealth();

    const [storage, eventsStat, checkpoints, endpoints] = await Promise.all([
      cleaner.getStorageStats(),
      pool.query(`
        SELECT chain, count(*)::int as total, max(block_number)::bigint as latest_block
        FROM events WHERE collected_at > NOW() - interval '1 hour'
        GROUP BY chain ORDER BY total DESC
      `),
      pool.query(
        'SELECT chain, collector_name, last_block, status, last_fetch_at, error_message FROM event_checkpoints ORDER BY chain'
      ),
      pool.query(
        'SELECT chain, endpoint_key, url, provider, enabled FROM admin_rpc_config ORDER BY chain, endpoint_key'
      ),
    ]);

    // Per-chain blocks scanned last hour
    const hourlyStats: Record<string, any> = {};
    for (const row of eventsStat.rows) {
      const cp = checkpoints.rows.find((c: any) => c.chain === row.chain);
      hourlyStats[row.chain] = {
        total: row.total,
        latest_block: row.latest_block,
        checkpoint: cp?.last_block || 0,
        status: cp?.status || 'unknown',
      };
    }

    // Checkpoint blocks for chains without events yet
    for (const cp of checkpoints.rows) {
      if (!hourlyStats[cp.chain]) {
        hourlyStats[cp.chain] = {
          total: 0,
          latest_block: 0,
          checkpoint: cp.last_block,
          status: cp.status,
        };
      }
    }

    // Binance & OKX health (non-blocking)
    let binanceHealth: any = { running: false, symbols: 0 };
    let okxHealth: any = { running: false, active: false, accounts: 0 };
    try { binanceHealth = getBinanceCollector().getHealth(); } catch {}
    try { okxHealth = getOkxCollector().getHealth(); } catch {}

    const result = {
      scanner: scannerHealth,
      storage,
      hourly: hourlyStats,
      endpoints: endpoints.rows,
      binance: binanceHealth,
      okx: okxHealth,
    };

    dashboardCache = { data: result, ts: now };
    res.json(apiResponse(result));
  })
);

/**
 * GET /api/v2/admin/config
 * Get current RPC config as env-var compatible JSON
 */
router.get(
  '/config',
  asyncHandler(async (_req, res) => {
    const result = await pool.query(
      'SELECT chain, endpoint_key, url, provider, tier, rpm, rpd, enabled FROM admin_rpc_config WHERE enabled = true ORDER BY chain, endpoint_key'
    );

    const config: Record<string, any[]> = {};
    for (const row of result.rows) {
      if (!config[row.chain]) config[row.chain] = [];
      config[row.chain].push({
        key: row.endpoint_key,
        url: row.url,
        provider: row.provider,
        tier: row.tier,
        rateLimit: { rpm: row.rpm, rpd: row.rpd },
      });
    }

    res.json(apiResponse(config));
  })
);

/**
 * GET /api/v2/admin/rpc-health
 * Live health status mapped by URL. Uses 10s cache.
 */
let rpcHealthCache: { data: any; ts: number } | undefined;
router.get(
  '/rpc-health',
  asyncHandler(async (_req, res) => {
    const now = Date.now();
    if (rpcHealthCache && now - rpcHealthCache.ts < 10000) {
      res.json(apiResponse(rpcHealthCache.data));
      return;
    }

    const scanner = getScanner();
    const rpcPool = (scanner as any).rpcPool;
    const config = (rpcPool as any).config as Record<string, any[]>;

    const report: any[] = [];
    const summary = { total: 0, healthy: 0, degraded: 0, down: 0 };

    for (const endpoints of Object.values(config || {})) {
      for (const ep of (endpoints as any[])) {
        summary.total++;
        if (ep.status === 'healthy') summary.healthy++;
        else if (ep.status === 'degraded') summary.degraded++;
        else summary.down++;
        report.push({
          url: ep.url,
          status: ep.status,
          tokens: ep.tokens,
          rateLimit: ep.rateLimit,
        });
      }
    }

    const result = { report, summary };
    rpcHealthCache = { data: result, ts: now };
    res.json(apiResponse(result));
  })
);

// ──────────────────────────────────────────────
// OKX ChainOS — multi-account management
// ──────────────────────────────────────────────

// List OKX accounts
router.get('/okx-accounts', asyncHandler(async (_req: Request, res: Response) => {
  const result = await pool.query(
    `SELECT id, label, enabled, is_default, last_used_at, status, error_message, created_at, updated_at
     FROM admin_okx_accounts ORDER BY is_default DESC, id ASC`
  );
  // Strip secrets from response
  const accounts = result.rows.map((r: any) => ({
    ...r,
    has_api_key: true, // don't expose the key, just indicate it exists
  }));
  res.json(apiResponse(accounts));
}));

// Add OKX account
router.post('/okx-accounts', asyncHandler(async (req: Request, res: Response) => {
  const { label, api_key, api_secret, api_passphrase, is_default } = req.body;
  if (!label || !api_key || !api_secret || !api_passphrase) {
    res.status(400).json(apiResponse(null, 'label, api_key, api_secret, api_passphrase required'));
    return;
  }
  const result = await pool.query(
    `INSERT INTO admin_okx_accounts (label, api_key, api_secret, api_passphrase, is_default)
     VALUES ($1,$2,$3,$4,$5) RETURNING id, label, enabled, is_default`,
    [label, api_key, api_secret, api_passphrase, is_default || false]
  );
  res.json(apiResponse(result.rows[0]));
}));

// Update OKX account
router.put('/okx-accounts/:id', asyncHandler(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { label, api_key, api_secret, api_passphrase, enabled, is_default } = req.body;
  const sets: string[] = [];
  const vals: any[] = [];
  let i = 1;

  if (label !== undefined) { sets.push(`label = $${i++}`); vals.push(label); }
  if (api_key !== undefined) { sets.push(`api_key = $${i++}`); vals.push(api_key); }
  if (api_secret !== undefined) { sets.push(`api_secret = $${i++}`); vals.push(api_secret); }
  if (api_passphrase !== undefined) { sets.push(`api_passphrase = $${i++}`); vals.push(api_passphrase); }
  if (enabled !== undefined) { sets.push(`enabled = $${i++}`); vals.push(enabled); }
  if (is_default !== undefined) { sets.push(`is_default = $${i++}`); vals.push(is_default); }

  sets.push(`updated_at = NOW()`);
  vals.push(id);

  await pool.query(`UPDATE admin_okx_accounts SET ${sets.join(', ')} WHERE id = $${i}`, vals);
  res.json(apiResponse({ updated: true }));
}));

// Delete OKX account
router.delete('/okx-accounts/:id', asyncHandler(async (req: Request, res: Response) => {
  await pool.query('DELETE FROM admin_okx_accounts WHERE id = $1', [req.params.id]);
  res.json(apiResponse({ deleted: true }));
}));

// ──────────────────────────────────────────────
// Market Data API (public + admin)
// ──────────────────────────────────────────────

// Binance health
router.get('/binance-health', asyncHandler(async (_req: Request, res: Response) => {
  const collector = getBinanceCollector();
  res.json(apiResponse(collector.getHealth()));
}));

// OKX health
router.get('/okx-health', asyncHandler(async (_req: Request, res: Response) => {
  const collector = getOkxCollector();
  res.json(apiResponse(collector.getHealth()));
}));

/**
 * GET /api/v2/admin/events/export?format=csv
 * Export events as CSV (max 10,000 rows)
 */
router.get('/events/export', asyncHandler(async (req: Request, res: Response) => {
  const { chain } = req.query;
  let query = 'SELECT event_id, event_type, chain, block_number, tx_hash, from_address, to_address, contract_address, token_address, token_symbol, amount, collected_at FROM events';
  const vals: any[] = [];
  if (chain) { query += ' WHERE chain = $1'; vals.push((chain as string).toLowerCase()); }
  query += ' ORDER BY block_number DESC LIMIT 10000';

  const result = await pool.query(query, vals);
  const rows = result.rows;

  if (rows.length === 0) {
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=events.csv');
    return res.send('No data\n');
  }

  const headers = Object.keys(rows[0]);
  const csv = [
    headers.join(','),
    ...rows.map((row: any) => headers.map(h => {
      const v = row[h];
      if (v === null || v === undefined) return '';
      const s = String(v);
      // Escape CSV special characters
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(','))
  ].join('\n');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename=events.csv');
  res.send(csv);
}));

export default router;
