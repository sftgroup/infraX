import { logger } from '../logger';

// ================================================================
// DexScreener API Client — 主流 DEX 原生数据（免费免 key，单源聚合）
// ================================================================
// 需求：docs/requirements-infrax-dex-data.md R1b/R2/R7/R10
// 数据层唯一推荐来源：一个 API 覆盖 ETH/BSC/BASE/SOL 全部主流 swap
//   （Uniswap/PancakeSwap/Aerodrome/Raydium/Orca/Meteora…），按链过滤 +
//   按 volume24h/liquidity 排序生成该链主流 swap 热门榜。
// 限流：免费层 ~60 req/min → 榜单类走 TTL 内存缓存（60s），token 详情短缓存。
// ================================================================

const BASE_URL = process.env.DEXSCREENER_API || 'https://api.dexscreener.com';

/** 需求链枚举（ETH/BSC/BASE/SOL）→ DexScreener 链原始值 */
export const DEXSCREENER_CHAIN: Record<string, string> = {
  ETH: 'ethereum',
  BSC: 'bsc',
  BASE: 'base',
  SOL: 'solana',
};

/** DexScreener 链原始值 → 需求链枚举 */
export const CHAIN_TO_ENUM: Record<string, string> = {
  ethereum: 'ETH',
  bsc: 'BSC',
  base: 'BASE',
  solana: 'SOL',
};

export interface DexPair {
  chainId: string;        // eth/bsc/base/solana（原始）
  chain: string;          // ETH/BSC/BASE/SOL（需求枚举）
  dexName: string;        // uniswapv3/pancakeswapv2/aerodrome/raydium/orca…
  symbol: string;
  name: string;
  tokenAddress: string;
  pairAddress: string;
  volume24h: number;      // USD
  liquidity: number;      // USD
  priceUsd: number;
  priceChange24h: number; // %
  txns24h: { buys: number; sells: number };
  createdAt: number | null; // 池创建时间（unix ms，新币识别 R10）
}

export interface DexTokenProfile {
  chainId: string;
  chain: string;
  tokenAddress: string;
  url: string;
  description: string;
  links: Array<{ label?: string; type?: string; url: string }>;
}

export interface DexTokenDetail {
  chain: string;
  symbol: string;
  name: string;
  tokenAddress: string;
  pairs: DexPair[];           // 该 token 全池（按流动性排序）
  liquidity: number | null;   // 总流动性（pairs 求和）
  volume24h: number | null;   // 24h 总量
  priceUsd: number | null;
  priceChange24h: number | null;
  marketCap: number | null;
  fdv: number | null;
  txns24h: { buys: number; sells: number } | null;
  poolCount: number;
  poolCreatedAt: number | null; // 最早池创建时间（R10）
}

// ── TTL 缓存（免费层限流保护）──────────────────────────────────
const CACHE_TTL = {
  'token-profiles': 60_000,   // 榜单 60s
  'token-boosts': 60_000,
  search: 30_000,             // 搜索 30s
  tokens: 30_000,             // token 详情 30s
  pairs: 30_000,
};
const cache = new Map<string, { value: any; ts: number }>();
const MAX_CACHE = 1000;

function cacheGet(key: string, ttl: number): any | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.ts >= ttl) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}

function cacheSet(key: string, value: any): void {
  if (cache.size >= MAX_CACHE) {
    const now = Date.now();
    for (const [k, v] of cache) {
      if (now - v.ts >= 120_000) cache.delete(k);
    }
    if (cache.size >= MAX_CACHE) cache.clear();
  }
  cache.set(key, { value, ts: Date.now() });
}

/** 测试专用：清空缓存（避免跨用例污染） */
export function __resetDexCacheForTest(): void {
  cache.clear();
}

async function get(path: string): Promise<any> {
  const url = `${BASE_URL}${path}`;
  // 免费层 60 req/min → 队列节流（令牌桶，1 req/s）
  await throttle();
  const resp = await fetch(url, { headers: { Accept: 'application/json' } });
  if (resp.status === 429) {
    throw new Error(`DexScreener 429 rate-limited: ${path}`);
  }
  if (resp.status === 404) {
    // 上游无该资源（如 token 无任何 DEX 池）→ 视为空结果，调用方降级
    return undefined;
  }
  if (!resp.ok) {
    throw new Error(`DexScreener ${resp.status}: ${path}`);
  }
  return resp.json();
}

// 令牌桶：1 req/s（60/min 上限的安全余量）；单测环境（DEXSCREENER_DISABLE_THROTTLE=1）跳过
let lastReqTs = 0;
async function throttle(): Promise<void> {
  if (process.env.DEXSCREENER_DISABLE_THROTTLE === '1') return;
  const now = Date.now();
  const gap = 1050; // ms，略大于 1/s
  const wait = lastReqTs + gap - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastReqTs = Date.now();
}

function num(v: any): number | null {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return null;
  return Number(v);
}

/** 地址契约：EVM 链小写 hex / SOL 保留 base58（需求字段规范） */
export function normAddr(chainRaw: string, addr: string): string {
  const s = String(addr || '');
  if (!s) return s;
  return CHAIN_TO_ENUM[chainRaw] === 'SOL' ? s : s.toLowerCase();
}

/** 归一化单对 → DexPair */
export function mapPair(p: any): DexPair | null {
  if (!p || !p.pairAddress) return null;
  const base = p.baseToken || {};
  const chainRaw = String(p.chainId || '');
  return {
    chainId: chainRaw,
    chain: CHAIN_TO_ENUM[chainRaw] || chainRaw.toUpperCase(),
    dexName: String(p.dexId || ''),
    symbol: String(base.symbol || ''),
    name: String(base.name || ''),
    tokenAddress: normAddr(chainRaw, base.address),
    pairAddress: String(p.pairAddress || ''),
    volume24h: num(p.volume?.h24) ?? 0,
    liquidity: num(p.liquidity?.usd) ?? 0,
    priceUsd: num(p.priceUsd) ?? 0,
    priceChange24h: num(p.priceChange?.h24) ?? 0,
    txns24h: {
      buys: num(p.txns?.h24?.buys) ?? 0,
      sells: num(p.txns?.h24?.sells) ?? 0,
    },
    createdAt: p.pairCreatedAt ? new Date(p.pairCreatedAt).getTime() : null,
  };
}

/** token-profiles/latest/v1 — 新币发现（带 icon/description/links） */
export async function getTokenProfiles(): Promise<DexTokenProfile[]> {
  const key = 'profiles';
  const cached = cacheGet(key, CACHE_TTL['token-profiles']);
  if (cached !== undefined) return cached;
  const data = await get('/token-profiles/latest/v1');
  const out: DexTokenProfile[] = Array.isArray(data)
    ? data
        .filter((p: any) => p && p.tokenAddress && CHAIN_TO_ENUM[p.chainId])
        .map((p: any) => ({
          chainId: String(p.chainId),
          chain: CHAIN_TO_ENUM[p.chainId] || String(p.chainId).toUpperCase(),
          tokenAddress: normAddr(p.chainId, p.tokenAddress),
          url: String(p.url || ''),
          description: String(p.description || ''),
          links: Array.isArray(p.links) ? p.links : [],
        }))
    : [];
  cacheSet(key, out);
  return out;
}

/** token-boosts/latest/v1 — 有推广资金的热门榜 */
export async function getTokenBoosts(): Promise<DexTokenProfile[]> {
  const key = 'boosts';
  const cached = cacheGet(key, CACHE_TTL['token-boosts']);
  if (cached !== undefined) return cached;
  const data = await get('/token-boosts/latest/v1');
  const out: DexTokenProfile[] = Array.isArray(data)
    ? data
        .filter((p: any) => p && p.tokenAddress && CHAIN_TO_ENUM[p.chainId])
        .map((p: any) => ({
          chainId: String(p.chainId),
          chain: CHAIN_TO_ENUM[p.chainId] || String(p.chainId).toUpperCase(),
          tokenAddress: normAddr(p.chainId, p.tokenAddress),
          url: String(p.url || ''),
          description: String(p.description || ''),
          links: Array.isArray(p.links) ? p.links : [],
        }))
    : [];
  cacheSet(key, out);
  return out;
}

/** /latest/dex/search?q= — 按 symbol/name/address 搜 pairs */
export async function searchTokens(q: string): Promise<DexPair[]> {
  const key = `search:${q.toLowerCase()}`;
  const cached = cacheGet(key, CACHE_TTL.search);
  if (cached !== undefined) return cached;
  const data = await get(`/latest/dex/search?q=${encodeURIComponent(q)}`);
  const out: DexPair[] = Array.isArray(data?.pairs)
    ? data.pairs.map(mapPair).filter((p: DexPair | null): p is DexPair => p !== null)
    : [];
  cacheSet(key, out);
  return out;
}

/**
 * 单币详情（多池聚合）。
 * 上游 `/latest/dex/tokens/{chain}/{addresses}` 已废弃（2026-08 实测 404）→ 改用
 * `/latest/dex/search?q={address}` 按链过滤聚合（search 返回全链该地址的全池）。
 * @param addresses 合约地址列表（逐个 search，聚合目标链全池；单币画像场景通常 1 个）
 */
export async function getTokensDetail(chainRaw: string, addresses: string[]): Promise<DexTokenDetail[]> {
  const results: DexTokenDetail[] = [];
  for (const rawAddr of addresses) {
    const addr = normAddr(chainRaw, rawAddr);
    const key = `tokens:${chainRaw}:${addr}`;
    const cached = cacheGet(key, CACHE_TTL.tokens);
    if (cached !== undefined) {
      results.push(...cached);
      continue;
    }
    const data = await get(`/latest/dex/search?q=${encodeURIComponent(addr)}`);
    const pairs: DexPair[] = Array.isArray(data?.pairs)
      ? data.pairs
          .filter((p: any) => String(p?.chainId) === chainRaw)
          .map(mapPair)
          .filter((p: DexPair | null): p is DexPair => p !== null)
      : [];
    const agg = aggregatePairs(chainRaw, addr, pairs);
    if (agg) cacheSet(key, [agg]);
    if (agg) results.push(agg);
  }
  return results;
}

/** 同链多池 → 单币聚合（流动性/24h 量求和、最早池创建时间、前 5 池） */
function aggregatePairs(chainRaw: string, tokenAddress: string, tokenPairs: DexPair[]): DexTokenDetail | null {
  if (tokenPairs.length === 0) return null;
  const sorted = [...tokenPairs].sort((a, b) => (b.liquidity || 0) - (a.liquidity || 0));
  const liq = tokenPairs.reduce((s, p) => s + (p.liquidity || 0), 0);
  const vol = tokenPairs.reduce((s, p) => s + (p.volume24h || 0), 0);
  const created = tokenPairs
    .map((p) => p.createdAt)
    .filter((t): t is number => t !== null)
    .sort((a, b) => a - b);
  const top = sorted[0];
  return {
    chain: CHAIN_TO_ENUM[chainRaw] || chainRaw.toUpperCase(),
    symbol: top?.symbol || '',
    name: top?.name || '',
    tokenAddress,
    pairs: sorted.slice(0, 5),
    liquidity: liq > 0 ? liq : null,
    volume24h: vol > 0 ? vol : null,
    priceUsd: top?.priceUsd ?? null,
    priceChange24h: top?.priceChange24h ?? null,
    marketCap: null,
    fdv: null,
    txns24h: top?.txns24h ?? null,
    poolCount: tokenPairs.length,
    poolCreatedAt: created.length > 0 ? created[0] : null,
  };
}

/** /latest/dex/pairs/{chain}/{pairAddr} — 单池详情 */
export async function getPairDetail(chainRaw: string, pairAddress: string): Promise<DexPair | null> {
  const key = `pair:${chainRaw}:${normAddr(chainRaw, pairAddress)}`;
  const cached = cacheGet(key, CACHE_TTL.pairs);
  if (cached !== undefined) return cached;
  const data = await get(`/latest/dex/pairs/${chainRaw}/${normAddr(chainRaw, pairAddress)}`);
  const pair = mapPair(data?.pair);
  if (pair) cacheSet(key, pair);
  return pair;
}

/**
 * 主流 DEX 原生热门榜（R1b）：token-profiles（新币发现）+ token-boosts（推广热度）
 * 按链过滤 → 去重 → 有池数据时按 volume24h 排序。
 * @param chain  需求链枚举（ETH/BSC/BASE/SOL），缺省全链
 * @param limit  返回条数
 */
export async function getHotTokens(chain?: string, limit = 20): Promise<Array<DexTokenProfile & { score: number; source: 'profiles' | 'boosts' }>> {
  const [profiles, boosts] = await Promise.all([getTokenProfiles(), getTokenBoosts()]);
  const merged = new Map<string, DexTokenProfile & { score: number; source: 'profiles' | 'boosts' }>();
  // profiles 权重高于 boosts（新币发现优先）；同地址合并（地址已按链契约规范化）
  for (const p of profiles) {
    const k = `${p.chainId}:${p.tokenAddress}`;
    merged.set(k, { ...p, score: 100, source: 'profiles' });
  }
  for (const b of boosts) {
    const k = `${b.chainId}:${b.tokenAddress}`;
    const prev = merged.get(k);
    if (!prev) {
      merged.set(k, { ...b, score: 90, source: 'boosts' });
    } else {
      prev.score = Math.max(prev.score, 95);
    }
  }
  let items = Array.from(merged.values());
  if (chain) {
    const raw = DEXSCREENER_CHAIN[chain.toUpperCase()];
    if (raw) items = items.filter((i) => i.chainId === raw);
  }
  // 按链排序稳定：source 权重 → 原顺序
  return items.slice(0, Math.max(1, limit));
}

logger.info('[dex-screener] client loaded');
