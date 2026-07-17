/**
 * RPC Pool Configuration
 *
 * Multi-key round-robin with epoch allocation for 7 chains.
 * All keys are from free-tier providers — total cost = $0/month.
 *
 * To add keys: set INFRAX_RPC_POOL env var as JSON string, or
 * add them to the individual chain arrays below.
 */
export interface RpcEndpoint {
  key: string;           // unique identifier
  url: string;           // full RPC URL including API key
  provider: string;      // infura / alchemy / blastapi / quicknode / public
  tier: 'free' | 'growth' | 'enterprise';
  // Rate limits (free-tier defaults)
  rateLimit: {
    rpm: number;         // requests per minute
    rpd: number;         // requests per day
  };
  // Runtime state
  tokens: {
    remaining: number;
    resetAt: number;
  };
  status: 'healthy' | 'degraded' | 'down';
  epoch?: number;        // assigned block range start
}

export interface RpcPoolConfig {
  [chain: string]: RpcEndpoint[];
}

/**
 * Build RPC pool config.
 *
 * Priority (lowest → highest):
 *   1. rpc-pool.json static baseline (12+ endpoints per chain)
 *   2. Per-chain env vars (SEPOLIA_RPC_URL, ETH_RPC_URL, etc.) — override/add
 *   3. INFRAX_RPC_POOL env var (JSON) — full override
 *
 * DB endpoints (mergeDbEndpoints) run separately and take top priority.
 */
export function buildRpcPoolConfig(): RpcPoolConfig {
  // Try env-var pool first (for full programmatic override)
  const envPool = process.env.INFRAX_RPC_POOL;
  if (envPool) {
    try {
      const parsed = JSON.parse(envPool) as RpcPoolConfig;
      return normalizeConfig(parsed);
    } catch {
      console.warn('[rpc-pool] INFRAX_RPC_POOL parse failed, using per-chain configs');
    }
  }

  // Load static baseline from rpc-pool.json
  const base = loadStaticPoolConfig();

  // Merge per-chain env vars into the baseline (env vars override same-key endpoints)
  mergeEnvEndpoints(base, 'sepolia', [
    envOr('SEPOLIA_RPC_URL', ''),
    envOr('SEPOLIA_RPC_URL_2', ''),
  ]);
  mergeEnvEndpoints(base, 'ethereum', [
    envOr('ETH_RPC_URL', ''),
    envOr('ETH_RPC_URL_2', ''),
  ]);
  mergeEnvEndpoints(base, 'bsc', [
    envOr('BSC_RPC_URL', ''),
    envOr('BSC_RPC_URL_2', ''),
  ]);
  mergeEnvEndpoints(base, 'base', [
    envOr('BASE_RPC_URL', ''),
    envOr('BASE_RPC_URL_2', ''),
  ]);
  mergeEnvEndpoints(base, 'oxa', [
    envOr('OXA_RPC_URL', ''),
  ]);

  return normalizeConfig(base);
}

/**
 * Load static endpoint baseline from rpc-pool.json.
 */
function loadStaticPoolConfig(): RpcPoolConfig {
  try {
    const fs = require('fs');
    const path = require('path');
    const poolPath = path.resolve(__dirname, '../../rpc-pool.json');
    if (fs.existsSync(poolPath)) {
      const raw = fs.readFileSync(poolPath, 'utf-8');
      const parsed = JSON.parse(raw) as RpcPoolConfig;
      // Filter to only our active chains
      const activeChains = ['sepolia', 'ethereum', 'bsc', 'base', 'oxa'];
      const filtered: RpcPoolConfig = {};
      for (const chain of activeChains) {
        if (parsed[chain]) filtered[chain] = parsed[chain];
      }
      console.log(`[rpc-pool] Loaded static baseline from rpc-pool.json: ${Object.values(filtered).reduce((s, eps) => s + eps.length, 0)} endpoints`);
      return filtered;
    }
  } catch (e: any) {
    console.warn(`[rpc-pool] Failed to load rpc-pool.json: ${e.message}`);
  }
  return {};
}

/**
 * Merge env-provided URLs into the config. Env URLs with non-empty values are
 * added as new endpoints or override the first matching endpoint by key prefix.
 */
function mergeEnvEndpoints(config: RpcPoolConfig, chain: string, urls: string[]): void {
  const validUrls = urls.filter(u => u.length > 0);
  if (validUrls.length === 0) return;
  if (!config[chain]) config[chain] = [];
  for (const url of validUrls) {
    // Check if a similar URL already exists (avoid exact duplicates)
    const exists = config[chain].some(e => e.url === url);
    if (!exists) {
      const key = `${chain}-env-${config[chain].length}`;
      config[chain].push(createEndpoint(key, url, detectProvider(url)));
    }
  }
}

/**
 * Merge DB-stored RPC endpoints into the config.
 * Call this after buildRpcPoolConfig + DB migration is ready.
 * DB endpoints take priority over env-var defaults.
 */
export async function mergeDbEndpoints(config: RpcPoolConfig): Promise<void> {
  const { pool } = await import('../database');
  try {
    const result = await pool.query(
      'SELECT chain, endpoint_key, url, provider, tier, rpm, rpd FROM admin_rpc_config WHERE enabled = true'
    );
    for (const row of result.rows) {
      const chain = row.chain;
      if (!config[chain]) config[chain] = [];
      // Replace existing endpoint with same key, or add new
      const idx = config[chain].findIndex(e => e.key === row.endpoint_key);
      const ep = {
        key: row.endpoint_key,
        url: row.url,
        provider: row.provider,
        tier: row.tier || 'free',
        rateLimit: { rpm: row.rpm || 60, rpd: row.rpd || 10_000 },
        tokens: { remaining: row.rpd || 10_000, resetAt: Date.now() + 86400_000 },
        status: 'healthy' as const,
      };
      if (idx >= 0) {
        config[chain][idx] = ep;
      } else {
        config[chain].push(ep);
      }
    }
    console.log(`[rpc-pool] Loaded ${result.rows.length} DB endpoints`);
  } catch (err: any) {
    console.warn(`[rpc-pool] DB endpoint load failed: ${err.message}`);
  }
}

function envOr(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

function detectProvider(url: string): string {
  if (url.includes('infura')) return 'infura';
  if (url.includes('alchemy')) return 'alchemy';
  if (url.includes('blastapi')) return 'blastapi';
  if (url.includes('quicknode') || url.includes('quiknode')) return 'quicknode';
  if (url.includes('1rpc.io') || url.includes('drpc.org')) return 'public';
  return 'unknown';
}

function createEndpoint(key: string, url: string, provider: string): RpcEndpoint {
  return {
    key,
    url,
    provider,
    tier: 'free',
    rateLimit: rateLimits(provider),
    tokens: { remaining: rateLimits(provider).rpd, resetAt: 0 },
    status: 'healthy',
  };
}

function rateLimits(provider: string): { rpm: number; rpd: number } {
  switch (provider) {
    case 'infura':    return { rpm: 300, rpd: 100_000 };
    case 'alchemy':   return { rpm: 330, rpd: 300_000 };
    case 'blastapi':  return { rpm: 100, rpd: 12_000 };
    case 'quicknode': return { rpm: 300, rpd: 100_000 };
    default:          return { rpm: 60,  rpd: 10_000 };
  }
}

function normalizeConfig(config: RpcPoolConfig): RpcPoolConfig {
  const result: RpcPoolConfig = {};
  for (const [chain, endpoints] of Object.entries(config)) {
    result[chain] = endpoints.map((ep) => ({
      ...ep,
      tokens: { remaining: ep.rateLimit.rpd, resetAt: Date.now() + 86400_000 },
      status: 'healthy' as const,
    }));
  }
  return result;
}
