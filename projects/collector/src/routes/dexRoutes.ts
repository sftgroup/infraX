import { Router } from 'express';
import { asyncHandler, apiResponse } from '../helpers';
import { getMarketClient } from '../services/okxMarketV6';
import * as dex from '../services/dexScreener';
import { logger } from '../logger';

/**
 * DEX 策略数据端点（R1-R10，docs/requirements-infrax-dex-data.md）。
 *
 * 挂载：index.ts 中 `app.use('/api/v2/data', apiKeyAuth, marketQuotaEnforce, dexRoutes)`
 * → 实际路径 /api/v2/data/market/dex/*，与 /market/* 共用 dx_ key 鉴权 + 配额。
 *
 * 数据层（DexScreener，免费免 key）与交易层（OKX aggregator）解耦：
 *   - 榜单/池子/流动性 → DexScreener 单源聚合（R1b/R2/R7/R10）
 *   - 行情/社交/风险/资金面 → OKX OnchainOS v6（R1/R2/R3/R4/R5/R6/R8）
 *
 * 链枚举契约：ETH/BSC/BASE/SOL（需求文档字段规范）。
 */
const router = Router();
const m = () => getMarketClient();

/** 需求链枚举 → OKX chainIndex */
const OKX_CHAIN_INDEX: Record<string, string> = {
  ETH: '1',
  BSC: '56',
  BASE: '8453',
  SOL: '501',
};

/** 需求链枚举 → DexScreener 原始链名 */
function dexChainRaw(chain?: string): string | undefined {
  if (!chain) return undefined;
  const raw = dex.DEXSCREENER_CHAIN[chain.toUpperCase()];
  return raw;
}

function clampLimit(v: any, def = 20, max = 100): number {
  const n = parseInt(String(v ?? def), 10);
  if (Number.isNaN(n) || n < 1) return def;
  return Math.min(n, max);
}

// ================================================================
// R1 + R1b 统一热门代币榜
// GET /api/v2/data/market/dex/hot-tokens?source=all|okx|dexscreener&chain=ETH&ranking=trending&limit=20
// ================================================================
router.get('/market/dex/hot-tokens', asyncHandler(async (req, res) => {
  const { source = 'all', chain, ranking = 'trending', limit } = req.query as any;
  const chainEnum = chain ? String(chain).toUpperCase() : undefined;
  const n = clampLimit(limit, 20);
  const out: any = { source: String(source) };

  if (source === 'okx' || source === 'all') {
    // 双排行：trending（sortBy=15 tokenScore）/ x_mentions（sortBy=11 mentions）
    const chains = chainEnum ? [chainEnum] : Object.keys(OKX_CHAIN_INDEX);
    const rank = ranking === 'x_mentions' ? 'x_mentions' : 'trending';
    const okxItems: any[] = [];
    for (const c of chains) {
      const idx = OKX_CHAIN_INDEX[c];
      if (!idx) continue;
      try {
        const items = await m().getHotTokensRanked(idx, rank, n);
        okxItems.push(...items.map((it) => ({ ...it, chain: c })));
      } catch (e: any) {
        logger.warn(`[dex] okx hot-tokens chain=${c} failed: ${e.message}`);
      }
    }
    out.okx = okxItems;
  }

  if (source === 'dexscreener' || source === 'all') {
    const ds = await dex.getHotTokens(chainEnum, n);
    // 补充池子行情（真实成交量/TVL）：批量拉取该链各地址详情
    const withQuote = await enrichDsProfiles(chainEnum, ds, n);
    out.dexscreener = withQuote;
  }

  res.json(apiResponse(out));
}));

/** 为 DexScreener profiles/boosts 补充真实池行情并按 24h 成交量排序（R1b：按链真实成交量/TVL） */
async function enrichDsProfiles(chainEnum: string | undefined, profiles: Array<any>, n: number): Promise<any[]> {
  const results: any[] = [];
  for (const p of profiles) {
    const raw = dexChainRaw(chainEnum || p.chain);
    if (!raw) continue;
    try {
      // 逐 token 搜索补池行情（按链聚合；有 address 直接用 tokens 详情更快）
      const details = p.tokenAddress
        ? await dex.getTokensDetail(raw, [p.tokenAddress])
        : [];
      const d = details[0];
      results.push({
        symbol: d?.symbol || '',
        name: d?.name || '',
        chain: p.chain,
        chainId: p.chainId,
        tokenAddress: p.tokenAddress,
        price: d?.priceUsd ?? null,
        volume24h: d?.volume24h ?? null,
        liquidity: d?.liquidity ?? null,
        change24h: d?.priceChange24h ?? null,
        poolCount: d?.poolCount ?? null,
        poolCreatedAt: d?.poolCreatedAt ?? null,
        pairs: d?.pairs ?? [],
        score: p.score,
        source: 'dexscreener',
        rankType: 'volume',
        url: p.url,
        description: p.description,
      });
    } catch (e: any) {
      logger.debug(`[dex] ds enrich ${p.tokenAddress} failed: ${e.message}`);
      results.push({ ...p, source: 'dexscreener', rankType: 'volume' });
    }
    if (results.length >= n) break;
  }
  // 有池行情数据的按 24h 成交量降序（真实热门）；无行情数据的垫底（按 score）
  return results
    .sort((a, b) => (b.volume24h ?? -1) - (a.volume24h ?? -1) || (b.score ?? 0) - (a.score ?? 0))
    .slice(0, n);
}

// ================================================================
// R2 + R3 + R4 单币画像（行情/社交/风险聚合）
// GET /api/v2/data/market/dex/token?chain=ETH&address=0x...
// ================================================================
router.get('/market/dex/token', asyncHandler(async (req, res) => {
  const { chain, address } = req.query as any;
  const chainEnum = chain ? String(chain).toUpperCase() : '';
  const addr = address ? String(address).toLowerCase() : '';
  if (!chainEnum || !OKX_CHAIN_INDEX[chainEnum]) {
    res.status(400).json(apiResponse(null, 'chain must be ETH/BSC/BASE/SOL'));
    return;
  }
  if (!addr) {
    res.status(400).json(apiResponse(null, 'address required'));
    return;
  }
  const idx = OKX_CHAIN_INDEX[chainEnum];
  const raw = dexChainRaw(chainEnum);

  // OKX 侧：price-info（行情）+ advanced-info（基本面/风险）+ cluster-overview（rug/new addr）+ holders（数量）
  const [priceInfo, advanced, cluster] = await Promise.allSettled([
    m().getPriceInfo(idx, addr),
    m().getTokenAdvancedInfo(idx, addr),
    m().getClusterOverview(idx, addr),
  ]);

  const pi = priceInfo.status === 'fulfilled' ? priceInfo.value : null;
  const adv = advanced.status === 'fulfilled' ? advanced.value : null;
  const clu = cluster.status === 'fulfilled' ? cluster.value : null;
  // cluster-overview 返回数组（各聚类摘要），风险字段取首元素（总量口径）；原始字段为上游透传（any）
  const cluAny: any = Array.isArray(clu) ? clu[0] : clu;

  // DexScreener 侧：多池行情（liquidity/volume/txns/createdAt）
  const ds = raw ? await dex.getTokensDetail(raw, [addr]).catch(() => []) : [];
  const dsDetail = ds[0] || null;

  const data: any = {
    chain: chainEnum,
    tokenAddress: addr,
    // R2 行情
    quote: {
      priceUsd: dsDetail?.priceUsd ?? pi?.price ?? null,
      price: pi?.price ?? dsDetail?.priceUsd ?? null,
      volume24h: dsDetail?.volume24h ?? pi?.volume24h ?? null,
      marketCap: pi?.marketCap ?? dsDetail?.marketCap ?? null,
      liquidity: dsDetail?.liquidity ?? pi?.liquidity ?? null,
      fdv: pi?.fdv ?? null,
      change1h: pi?.priceChange1h ?? null,
      change6h: pi?.priceChange6h ?? null,
      change24h: pi?.priceChange24h ?? dsDetail?.priceChange24h ?? null,
      change7d: pi?.priceChange7d ?? null,
      ath: pi?.ath ?? null,
      atl: pi?.atl ?? null,
      holders: pi?.holders ?? null,
    },
    // R3 社交热度（OKX price-info/advanced 若带 mentions/social 字段）
    social: {
      xMentions24h: pi?.xMentions ?? adv?.xMentions ?? null,
      xMentionChange: pi?.xMentionChange ?? null,
      trendingScore: pi?.trendingScore ?? adv?.tokenScore ?? null,
      sentiment: pi?.sentiment ?? null,
      socialVolume: pi?.socialVolume ?? null,
    },
    // R4 风险画像
    risk: {
      riskLevel: adv?.riskLevel ?? pi?.riskLevel ?? null,
      isHoneypot: adv?.isHoneypot ?? false,
      isScam: adv?.isScam ?? false,
      rugRiskPct: cluAny?.rugPullPercent ?? cluAny?.rugRiskPct ?? null,
      newAddressPct: cluAny?.newAddressPercent ?? null,
      ownerInfo: adv?.ownerInfo ?? null,
      devStats: adv?.devStats ?? null,
      lockInfo: adv?.lockInfo ?? null,
    },
    // R7 池明细（DexScreener）
    pools: dsDetail?.pairs ?? [],
    poolCount: dsDetail?.poolCount ?? null,
    poolCreatedAt: dsDetail?.poolCreatedAt ?? null, // R10 池龄
    // R6 持有者（数量）
    holderCount: pi?.holders ?? null,
    cluster: clu,
  };
  res.json(apiResponse(data));
}));

// ================================================================
// 合并搜索（OKX + DexScreener）
// GET /api/v2/data/market/dex/search?keyword=pepe&chain=ETH
// ================================================================
router.get('/market/dex/search', asyncHandler(async (req, res) => {
  const { keyword, chain, limit } = req.query as any;
  if (!keyword) {
    res.status(400).json(apiResponse(null, 'keyword required'));
    return;
  }
  const chainEnum = chain ? String(chain).toUpperCase() : undefined;
  const n = clampLimit(limit, 20, 50);
  const out: any = { keyword: String(keyword) };

  // OKX 搜索
  try {
    const idx = chainEnum ? OKX_CHAIN_INDEX[chainEnum] : undefined;
    const items = await m().searchToken(String(keyword), idx, n);
    out.okx = items;
  } catch (e: any) {
    logger.warn(`[dex] okx search failed: ${e.message}`);
    out.okx = [];
  }

  // DexScreener 搜索（按链过滤）
  try {
    const pairs = await dex.searchTokens(String(keyword));
    const raw = dexChainRaw(chainEnum);
    const filtered = raw ? pairs.filter((p) => p.chainId === raw) : pairs;
    // 去重（按 tokenAddress）取流动性最高池
    const byToken = new Map<string, any>();
    for (const p of filtered) {
      const k = p.tokenAddress.toLowerCase();
      const prev = byToken.get(k);
      if (!prev || (p.liquidity || 0) > (prev.liquidity || 0)) {
        byToken.set(k, p);
      }
    }
    out.dexscreener = Array.from(byToken.values()).slice(0, n);
  } catch (e: any) {
    logger.warn(`[dex] dexscreener search failed: ${e.message}`);
    out.dexscreener = [];
  }

  res.json(apiResponse(out));
}));

// ================================================================
// P1：R5 巨鲸/聪明钱信号（OKX Signal API）
// GET /api/v2/data/market/dex/signal?chain=ETH&signalType=&limit=
// ================================================================
router.get('/market/dex/signal', asyncHandler(async (req, res) => {
  const { chain, signalType, limit, walletType, minAmountUsd } = req.query as any;
  const chainEnum = chain ? String(chain).toUpperCase() : '';
  const idx = chainEnum ? OKX_CHAIN_INDEX[chainEnum] : undefined;
  if (!idx) {
    res.status(400).json(apiResponse(null, 'chain must be ETH/BSC/BASE/SOL'));
    return;
  }
  const data = await m().getSignalList(idx, signalType, clampLimit(limit, 50, 100),
    walletType, minAmountUsd !== undefined ? Number(minAmountUsd) : undefined);
  res.json(apiResponse({ chain: chainEnum, items: data }));
}));

// ================================================================
// P1：R6 持有者结构（holders + cluster overview）
// GET /api/v2/data/market/dex/holders?chain=ETH&address=&limit=
// ================================================================
router.get('/market/dex/holders', asyncHandler(async (req, res) => {
  const { chain, address, limit } = req.query as any;
  const chainEnum = chain ? String(chain).toUpperCase() : '';
  const idx = chainEnum ? OKX_CHAIN_INDEX[chainEnum] : undefined;
  if (!idx || !address) {
    res.status(400).json(apiResponse(null, 'chain (ETH/BSC/BASE/SOL) and address required'));
    return;
  }
  const [holders, cluster] = await Promise.allSettled([
    m().getTokenHolders(idx, String(address), clampLimit(limit, 50, 100)),
    m().getClusterOverview(idx, String(address)),
  ]);
  res.json(apiResponse({
    holders: holders.status === 'fulfilled' ? holders.value : null,
    cluster: cluster.status === 'fulfilled' ? cluster.value : null,
  }));
}));

// ================================================================
// P1：R7 流动性池/深度（OKX top-liquidity + DexScreener 池明细）
// GET /api/v2/data/market/dex/liquidity?chain=ETH&address=
// ================================================================
router.get('/market/dex/liquidity', asyncHandler(async (req, res) => {
  const { chain, address } = req.query as any;
  const chainEnum = chain ? String(chain).toUpperCase() : '';
  const idx = chainEnum ? OKX_CHAIN_INDEX[chainEnum] : undefined;
  if (!idx || !address) {
    res.status(400).json(apiResponse(null, 'chain (ETH/BSC/BASE/SOL) and address required'));
    return;
  }
  const addr = String(address).toLowerCase();
  const raw = dexChainRaw(chainEnum);
  const [okxPools, dsDetail] = await Promise.allSettled([
    m().getTopLiquidity(idx, addr),
    raw ? dex.getTokensDetail(raw, [addr]) : Promise.resolve([]),
  ]);
  const ds = dsDetail.status === 'fulfilled' ? dsDetail.value : [];
  res.json(apiResponse({
    okx: okxPools.status === 'fulfilled' ? okxPools.value : null,
    dexscreener: ds[0]?.pairs ?? [],
    poolTvl: ds[0]?.liquidity ?? null,
  }));
}));

// ================================================================
// P1：R8 顶级交易者 + 近期交易
// GET /api/v2/data/market/dex/top-traders?chain=ETH&address=
// GET /api/v2/data/market/dex/trades?chain=ETH&address=&limit=
// ================================================================
router.get('/market/dex/top-traders', asyncHandler(async (req, res) => {
  const { chain, address } = req.query as any;
  const chainEnum = chain ? String(chain).toUpperCase() : '';
  const idx = chainEnum ? OKX_CHAIN_INDEX[chainEnum] : undefined;
  if (!idx || !address) {
    res.status(400).json(apiResponse(null, 'chain (ETH/BSC/BASE/SOL) and address required'));
    return;
  }
  try {
    const data = await m().getTopTraders(idx, String(address));
    res.json(apiResponse({ chain: chainEnum, items: data }));
  } catch (e: any) {
    // OKX Premium 付费端点：402/上游异常 → 结构化降级而非 500
    logger.warn(`[dex] top-traders failed: ${e.message}`);
    res.json(apiResponse({ chain: chainEnum, items: [], paymentRequired: e.status === 402, error: e.message }));
  }
}));

router.get('/market/dex/trades', asyncHandler(async (req, res) => {
  const { chain, address, limit } = req.query as any;
  const chainEnum = chain ? String(chain).toUpperCase() : '';
  const idx = chainEnum ? OKX_CHAIN_INDEX[chainEnum] : undefined;
  if (!idx || !address) {
    res.status(400).json(apiResponse(null, 'chain (ETH/BSC/BASE/SOL) and address required'));
    return;
  }
  try {
    const data = await m().getTrades(idx, String(address), clampLimit(limit, 50, 100));
    res.json(apiResponse({ chain: chainEnum, items: data }));
  } catch (e: any) {
    logger.warn(`[dex] trades failed: ${e.message}`);
    res.json(apiResponse({ chain: chainEnum, items: [], paymentRequired: e.status === 402, error: e.message }));
  }
}));

export default router;
