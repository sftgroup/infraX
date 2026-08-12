/**
 * RPC Pool Configuration（迁移自 collector/src/services/rpcPoolConfig.ts）。
 *
 * 多 key round-robin + 健康检查 + 令牌桶限流，支持 EVM 链与 Solana。
 * 端点来源优先级（低 → 高）：
 *   1. rpc-pool.json 静态基线（只保留激活链）
 *   2. 链 env URL：SEPOLIA_RPC_URL/ETH_RPC_URL/BSC_RPC_URL/BASE_RPC_URL/OXA_RPC_URL/SOLANA_RPC_URL（及 _2）
 *   3. INFRAX_RPC_POOL（env JSON，全量覆盖）
 */
import fs from 'fs';
import path from 'path';

export interface RpcEndpoint {
  key: string;           // unique identifier
  url: string;           // full RPC URL including API key
  provider: string;      // infura / alchemy / blastapi / quicknode / public
  tier: 'free' | 'growth' | 'enterprise';
  rateLimit: { rpm: number; rpd: number };
  tokens: { remaining: number; resetAt: number };
  status: 'healthy' | 'degraded' | 'down';
  epoch?: number;
}

export interface RpcPoolConfig {
  [chain: string]: RpcEndpoint[];
}

// RPC-3: 激活链（对齐 OKX ChainOS 7 链执行面：sepolia/ethereum/bsc/base/oxa/solana + polygon/arbitrum/optimism）
const ACTIVE_CHAINS = ['sepolia', 'ethereum', 'bsc', 'base', 'oxa', 'solana', 'polygon', 'arbitrum', 'optimism'];

/** RPC-3: 链参数映射（chainId；solana 无 EVM chainId 用 0 占位），供 /v1/status 与 plans 文档化 */
export const CHAIN_IDS: Record<string, number> = {
  sepolia: 11155111,
  ethereum: 1,
  bsc: 56,
  base: 8453,
  oxa: 19505,
  solana: 0,
  polygon: 137,
  arbitrum: 42161,
  optimism: 10,
};

export function buildRpcPoolConfig(chains: string[]): RpcPoolConfig {
  const envPool = process.env.INFRAX_RPC_POOL;
  if (envPool) {
    try {
      return normalizeConfig(JSON.parse(envPool) as RpcPoolConfig);
    } catch {
      console.warn('[rpc-pool] INFRAX_RPC_POOL parse failed, using per-chain configs');
    }
  }

  const base = loadStaticPoolConfig(chains);

  const chainEnv: Array<[string, string[]]> = [
    ['sepolia', ['SEPOLIA_RPC_URL', 'SEPOLIA_RPC_URL_2']],
    ['ethereum', ['ETH_RPC_URL', 'ETH_RPC_URL_2']],
    ['bsc', ['BSC_RPC_URL', 'BSC_RPC_URL_2']],
    ['base', ['BASE_RPC_URL', 'BASE_RPC_URL_2']],
    ['oxa', ['OXA_RPC_URL']],
    ['solana', ['SOLANA_RPC_URL']],
    ['polygon', ['POLYGON_RPC_URL', 'POLYGON_RPC_URL_2']],
    ['arbitrum', ['ARBITRUM_RPC_URL', 'ARBITRUM_RPC_URL_2']],
    ['optimism', ['OPTIMISM_RPC_URL', 'OPTIMISM_RPC_URL_2']],
  ];
  for (const [chain, keys] of chainEnv) {
    if (!chains.includes(chain)) continue;
    const urls = keys.map((k) => process.env[k] || '').filter(Boolean);
    mergeEnvEndpoints(base, chain, urls);
  }

  return normalizeConfig(base);
}

function loadStaticPoolConfig(chains: string[]): RpcPoolConfig {
  try {
    const poolPath = path.resolve(__dirname, '../../rpc-pool.json');
    if (fs.existsSync(poolPath)) {
      const parsed = JSON.parse(fs.readFileSync(poolPath, 'utf-8')) as RpcPoolConfig;
      const filtered: RpcPoolConfig = {};
      for (const chain of chains) {
        if (parsed[chain]) filtered[chain] = parsed[chain];
      }
      const n = Object.values(filtered).reduce((s, eps) => s + eps.length, 0);
      console.log(`[rpc-pool] Loaded static baseline from rpc-pool.json: ${n} endpoints`);
      return filtered;
    }
  } catch (e: any) {
    console.warn(`[rpc-pool] Failed to load rpc-pool.json: ${e.message}`);
  }
  return {};
}

function mergeEnvEndpoints(config: RpcPoolConfig, chain: string, urls: string[]): void {
  if (urls.length === 0) return;
  if (!config[chain]) config[chain] = [];
  for (const url of urls) {
    if (config[chain].some((e) => e.url === url)) continue;
    config[chain].push(createEndpoint(`${chain}-env-${config[chain].length}`, url, detectProvider(url)));
  }
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

/**
 * 链名归一化（与 waas walletService.getRpcUrl 别名语义一致）。
 */
export function normalizeChain(chain: string): string | null {
  const c = (chain || '').trim().toLowerCase();
  const aliases: Record<string, string> = {
    sepolia: 'sepolia',
    eth: 'ethereum',
    ethereum: 'ethereum',
    mainnet: 'ethereum',
    bsc: 'bsc',
    binance: 'bsc',
    base: 'base',
    oxa: 'oxa',
    solana: 'solana',
    sol: 'solana',
    polygon: 'polygon',
    matic: 'polygon',
    poly: 'polygon',
    arbitrum: 'arbitrum',
    arb: 'arbitrum',
    arbi: 'arbitrum',
    optimism: 'optimism',
    op: 'optimism',
  };
  return aliases[c] || null;
}
