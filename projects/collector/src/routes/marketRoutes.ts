import { Router } from 'express';
import { asyncHandler, apiResponse } from '../helpers';
import {
  getMarketSupportedChains,
  getIndexPrice,
  getHistoricalIndexPrice,
  getTotalValue,
  getAllBalances,
  getTokenBalance,
  getTransactions,
  getTransactionDetail,
  searchToken,
  getTokenBasicInfo,
  getHotTokens,
  getTopLiquidity,
  getCandles,
  getMarketPrice,
  getTrades,
  getTokenAdvancedInfo,
  getTokenHolders,
  getTopTraders,
  getPriceInfo,
  getHistoricalCandles,
  getMemePumpSupportedChains,
  getMemePumpTokenList,
  getMemePumpTokenDetails,
  getMemePumpDevInfo,
  getMemePumpSimilarTokens,
  getMemePumpBundleInfo,
  getMemePumpApedWallets,
  getSignalList,
  getSignalSupportedChains,
  getLeaderboard,
  getLeaderboardSupportedChains,
  getClusterOverview,
  getClusterList,
  getClusterTopHolders,
  getPortfolioOverview,
  getRecentPnl,
  getTokenLatestPnl,
  getDexHistory,
} from '../services/okxMarketV6';

const router = Router();

// ================================================================
// Utility
// ================================================================

/** GET /api/v2/data/market/supported-chains */
router.get('/market/supported-chains', asyncHandler(async (_req, res) => {
  const data = await getMarketSupportedChains();
  res.json(apiResponse(data));
}));

// ================================================================
// P1 — Free Tier
// ================================================================

/** GET /api/v2/data/market/index-price — Index price (current) */
router.get('/market/index-price', asyncHandler(async (req, res) => {
  const { chainIndex, tokenAddress } = req.query as any;
  if (!chainIndex) { res.status(400).json(apiResponse(null, 'chainIndex required')); return; }
  const data = await getIndexPrice(chainIndex, tokenAddress);
  res.json(apiResponse(data));
}));

/** GET /api/v2/data/market/index-price-history */
router.get('/market/index-price-history', asyncHandler(async (req, res) => {
  const { chainIndex, tokenAddress, limit } = req.query as any;
  if (!chainIndex) { res.status(400).json(apiResponse(null, 'chainIndex required')); return; }
  const data = await getHistoricalIndexPrice(chainIndex, tokenAddress, parseInt(limit || '100'));
  res.json(apiResponse(data));
}));

/** GET /api/v2/data/market/balance-total — Total portfolio value for address */
router.get('/market/balance-total', asyncHandler(async (req, res) => {
  const { address, chains } = req.query as any;
  if (!address) { res.status(400).json(apiResponse(null, 'address required')); return; }
  const data = await getTotalValue(address, chains ? chains.split(',') : undefined);
  res.json(apiResponse(data));
}));

/** GET /api/v2/data/market/balances — All token balances for address */
router.get('/market/balances', asyncHandler(async (req, res) => {
  const { address, chains } = req.query as any;
  if (!address) { res.status(400).json(apiResponse(null, 'address required')); return; }
  const data = await getAllBalances(address, chains ? chains.split(',') : undefined);
  res.json(apiResponse(data));
}));

/** GET /api/v2/data/market/token-balance — Single token balance */
router.get('/market/token-balance', asyncHandler(async (req, res) => {
  const { address, chainIndex, tokenAddress } = req.query as any;
  if (!address || !chainIndex || !tokenAddress) {
    res.status(400).json(apiResponse(null, 'address, chainIndex, tokenAddress required'));
    return;
  }
  const data = await getTokenBalance(address, chainIndex, tokenAddress);
  res.json(apiResponse(data));
}));

/** GET /api/v2/data/market/transactions — Transaction history by address */
router.get('/market/transactions', asyncHandler(async (req, res) => {
  const { address, chains, limit } = req.query as any;
  if (!address) { res.status(400).json(apiResponse(null, 'address required')); return; }
  const data = await getTransactions(address, chains ? chains.split(',') : undefined, parseInt(limit || '50'));
  res.json(apiResponse(data));
}));

/** GET /api/v2/data/market/transaction-detail — Single transaction detail */
router.get('/market/transaction-detail', asyncHandler(async (req, res) => {
  const { chainIndex, txHash } = req.query as any;
  if (!chainIndex || !txHash) { res.status(400).json(apiResponse(null, 'chainIndex and txHash required')); return; }
  const data = await getTransactionDetail(chainIndex, txHash);
  res.json(apiResponse(data));
}));

// ================================================================
// P2 — Basic Tier
// ================================================================

/** GET /api/v2/data/market/token-search — Search tokens */
router.get('/market/token-search', asyncHandler(async (req, res) => {
  const { keyword, chainIndex, limit } = req.query as any;
  if (!keyword) { res.status(400).json(apiResponse(null, 'keyword required')); return; }
  const data = await searchToken(keyword, chainIndex, parseInt(limit || '20'));
  res.json(apiResponse(data));
}));

/** GET /api/v2/data/market/token-info — Token basic info */
router.get('/market/token-info', asyncHandler(async (req, res) => {
  const { chainIndex, tokenAddress } = req.query as any;
  if (!chainIndex || !tokenAddress) { res.status(400).json(apiResponse(null, 'chainIndex and tokenAddress required')); return; }
  const data = await getTokenBasicInfo(chainIndex, tokenAddress);
  res.json(apiResponse(data));
}));

/** GET /api/v2/data/market/hot-tokens — Trending tokens (30+ filter params) */
router.get('/market/hot-tokens', asyncHandler(async (req, res) => {
  const { chainIndex, limit, ...rest } = req.query as any;
  if (!chainIndex) { res.status(400).json(apiResponse(null, 'chainIndex required')); return; }
  const opts: Record<string, string> = {};
  for (const [k, v] of Object.entries(rest)) {
    if (v !== undefined && v !== '') opts[k] = String(v);
  }
  const data = await getHotTokens(chainIndex, parseInt(limit || '50'), Object.keys(opts).length > 0 ? opts : undefined);
  res.json(apiResponse(data));
}));

/** GET /api/v2/data/market/top-liquidity — Top liquidity pools */
router.get('/market/top-liquidity', asyncHandler(async (req, res) => {
  const { chainIndex, tokenAddress } = req.query as any;
  if (!chainIndex || !tokenAddress) { res.status(400).json(apiResponse(null, 'chainIndex and tokenAddress required')); return; }
  const data = await getTopLiquidity(chainIndex, tokenAddress);
  res.json(apiResponse(data));
}));

/** GET /api/v2/data/market/candles — K-line candles */
router.get('/market/candles', asyncHandler(async (req, res) => {
  const { chainIndex, tokenAddress, period, limit } = req.query as any;
  if (!chainIndex || !tokenAddress) { res.status(400).json(apiResponse(null, 'chainIndex and tokenAddress required')); return; }
  const data = await getCandles(chainIndex, tokenAddress, period || '15m', parseInt(limit || '100'));
  res.json(apiResponse(data));
}));

/** GET /api/v2/data/market/price — Real-time DEX price */
router.get('/market/price', asyncHandler(async (req, res) => {
  const { chainIndex, tokenAddress } = req.query as any;
  if (!chainIndex || !tokenAddress) { res.status(400).json(apiResponse(null, 'chainIndex and tokenAddress required')); return; }
  const data = await getMarketPrice(chainIndex, tokenAddress);
  res.json(apiResponse(data));
}));

/** GET /api/v2/data/market/trades — Recent trades */
router.get('/market/trades', asyncHandler(async (req, res) => {
  const { chainIndex, tokenAddress, limit } = req.query as any;
  if (!chainIndex || !tokenAddress) { res.status(400).json(apiResponse(null, 'chainIndex and tokenAddress required')); return; }
  const data = await getTrades(chainIndex, tokenAddress, parseInt(limit || '50'));
  res.json(apiResponse(data));
}));

// ================================================================
// P3 — Premium Tier: Token Analysis
// ================================================================

/** GET /api/v2/data/market/token-advanced — Token advanced info */
router.get('/market/token-advanced', asyncHandler(async (req, res) => {
  const { chainIndex, tokenAddress } = req.query as any;
  if (!chainIndex || !tokenAddress) { res.status(400).json(apiResponse(null, 'chainIndex and tokenAddress required')); return; }
  const data = await getTokenAdvancedInfo(chainIndex, tokenAddress);
  res.json(apiResponse(data));
}));

/** GET /api/v2/data/market/token-holders — Token holder list */
router.get('/market/token-holders', asyncHandler(async (req, res) => {
  const { chainIndex, tokenAddress, limit } = req.query as any;
  if (!chainIndex || !tokenAddress) { res.status(400).json(apiResponse(null, 'chainIndex and tokenAddress required')); return; }
  const data = await getTokenHolders(chainIndex, tokenAddress, parseInt(limit || '50'));
  res.json(apiResponse(data));
}));

/** GET /api/v2/data/market/token-top-traders — Top traders for token */
router.get('/market/token-top-traders', asyncHandler(async (req, res) => {
  const { chainIndex, tokenAddress } = req.query as any;
  if (!chainIndex || !tokenAddress) { res.status(400).json(apiResponse(null, 'chainIndex and tokenAddress required')); return; }
  const data = await getTopTraders(chainIndex, tokenAddress);
  res.json(apiResponse(data));
}));

/** GET /api/v2/data/market/price-info — Detailed price info */
router.get('/market/price-info', asyncHandler(async (req, res) => {
  const { chainIndex, tokenAddress } = req.query as any;
  if (!chainIndex || !tokenAddress) { res.status(400).json(apiResponse(null, 'chainIndex and tokenAddress required')); return; }
  const data = await getPriceInfo(chainIndex, tokenAddress);
  res.json(apiResponse(data));
}));

/** GET /api/v2/data/market/historical-candles */
router.get('/market/historical-candles', asyncHandler(async (req, res) => {
  const { chainIndex, tokenAddress, period, limit } = req.query as any;
  if (!chainIndex || !tokenAddress) { res.status(400).json(apiResponse(null, 'chainIndex and tokenAddress required')); return; }
  const data = await getHistoricalCandles(chainIndex, tokenAddress, period || '1H', parseInt(limit || '100'));
  res.json(apiResponse(data));
}));

// ================================================================
// P3 — Premium Tier: MemePump
// ================================================================

/** GET /api/v2/data/market/mempump/chains — Supported chains */
router.get('/market/mempump/chains', asyncHandler(async (_req, res) => {
  const data = await getMemePumpSupportedChains();
  res.json(apiResponse(data));
}));

/** GET /api/v2/data/market/mempump/list — Meme token list */
router.get('/market/mempump/list', asyncHandler(async (req, res) => {
  const { chainIndex, protocol, sortBy, limit } = req.query as any;
  if (!chainIndex) { res.status(400).json(apiResponse(null, 'chainIndex required')); return; }
  const data = await getMemePumpTokenList(chainIndex, protocol, sortBy, parseInt(limit || '50'));
  res.json(apiResponse(data));
}));

/** GET /api/v2/data/market/mempump/details — Meme token details */
router.get('/market/mempump/details', asyncHandler(async (req, res) => {
  const { chainIndex, tokenAddress } = req.query as any;
  if (!chainIndex || !tokenAddress) { res.status(400).json(apiResponse(null, 'chainIndex and tokenAddress required')); return; }
  const data = await getMemePumpTokenDetails(chainIndex, tokenAddress);
  res.json(apiResponse(data));
}));

/** GET /api/v2/data/market/mempump/devinfo — Developer info */
router.get('/market/mempump/devinfo', asyncHandler(async (req, res) => {
  const { chainIndex, tokenAddress } = req.query as any;
  if (!chainIndex || !tokenAddress) { res.status(400).json(apiResponse(null, 'chainIndex and tokenAddress required')); return; }
  const data = await getMemePumpDevInfo(chainIndex, tokenAddress);
  res.json(apiResponse(data));
}));

/** GET /api/v2/data/market/mempump/similar — Similar tokens */
router.get('/market/mempump/similar', asyncHandler(async (req, res) => {
  const { chainIndex, tokenAddress } = req.query as any;
  if (!chainIndex || !tokenAddress) { res.status(400).json(apiResponse(null, 'chainIndex and tokenAddress required')); return; }
  const data = await getMemePumpSimilarTokens(chainIndex, tokenAddress);
  res.json(apiResponse(data));
}));

/** GET /api/v2/data/market/mempump/bundle — Bundle detection */
router.get('/market/mempump/bundle', asyncHandler(async (req, res) => {
  const { chainIndex, tokenAddress } = req.query as any;
  if (!chainIndex || !tokenAddress) { res.status(400).json(apiResponse(null, 'chainIndex and tokenAddress required')); return; }
  const data = await getMemePumpBundleInfo(chainIndex, tokenAddress);
  res.json(apiResponse(data));
}));

/** GET /api/v2/data/market/mempump/apedwallets — Aped wallets */
router.get('/market/mempump/apedwallets', asyncHandler(async (req, res) => {
  const { chainIndex, tokenAddress } = req.query as any;
  if (!chainIndex || !tokenAddress) { res.status(400).json(apiResponse(null, 'chainIndex and tokenAddress required')); return; }
  const data = await getMemePumpApedWallets(chainIndex, tokenAddress);
  res.json(apiResponse(data));
}));

// ================================================================
// P3 — Premium Tier: Signal / Leaderboard
// ================================================================

/** GET /api/v2/data/market/signals — Signal list */
router.get('/market/signals', asyncHandler(async (req, res) => {
  const { chainIndex, signalType, limit } = req.query as any;
  if (!chainIndex) { res.status(400).json(apiResponse(null, 'chainIndex required')); return; }
  const data = await getSignalList(chainIndex, signalType, parseInt(limit || '50'));
  res.json(apiResponse(data));
}));

/** GET /api/v2/data/market/signal-chains — Supported signal chains */
router.get('/market/signal-chains', asyncHandler(async (_req, res) => {
  const data = await getSignalSupportedChains();
  res.json(apiResponse(data));
}));

/** GET /api/v2/data/market/leaderboard — Leaderboard */
router.get('/market/leaderboard', asyncHandler(async (req, res) => {
  const { chainIndex, leaderboardType, limit } = req.query as any;
  if (!chainIndex) { res.status(400).json(apiResponse(null, 'chainIndex required')); return; }
  const data = await getLeaderboard(chainIndex, leaderboardType, parseInt(limit || '50'));
  res.json(apiResponse(data));
}));

/** GET /api/v2/data/market/leaderboard-chains — Supported leaderboard chains */
router.get('/market/leaderboard-chains', asyncHandler(async (_req, res) => {
  const data = await getLeaderboardSupportedChains();
  res.json(apiResponse(data));
}));

// ================================================================
// P3 — Premium Tier: Holder Cluster (BubbleMap)
// ================================================================

/** GET /api/v2/data/market/cluster-overview */
router.get('/market/cluster-overview', asyncHandler(async (req, res) => {
  const { chainIndex, tokenAddress } = req.query as any;
  if (!chainIndex || !tokenAddress) { res.status(400).json(apiResponse(null, 'chainIndex and tokenAddress required')); return; }
  const data = await getClusterOverview(chainIndex, tokenAddress);
  res.json(apiResponse(data));
}));

/** GET /api/v2/data/market/cluster-list */
router.get('/market/cluster-list', asyncHandler(async (req, res) => {
  const { chainIndex, tokenAddress, clusterName, limit } = req.query as any;
  if (!chainIndex || !tokenAddress) { res.status(400).json(apiResponse(null, 'chainIndex and tokenAddress required')); return; }
  const data = await getClusterList(chainIndex, tokenAddress, clusterName, parseInt(limit || '50'));
  res.json(apiResponse(data));
}));

/** GET /api/v2/data/market/cluster-top-holders */
router.get('/market/cluster-top-holders', asyncHandler(async (req, res) => {
  const { chainIndex, tokenAddress, minPercent, limit } = req.query as any;
  if (!chainIndex || !tokenAddress) { res.status(400).json(apiResponse(null, 'chainIndex and tokenAddress required')); return; }
  const data = await getClusterTopHolders(chainIndex, tokenAddress, minPercent ? parseFloat(minPercent) : undefined, parseInt(limit || '50'));
  res.json(apiResponse(data));
}));

// ================================================================
// P3 — Premium Tier: Portfolio (Address Analysis)
// ================================================================

/** GET /api/v2/data/market/portfolio-overview */
router.get('/market/portfolio-overview', asyncHandler(async (req, res) => {
  const { address, chains } = req.query as any;
  if (!address) { res.status(400).json(apiResponse(null, 'address required')); return; }
  const data = await getPortfolioOverview(address, chains ? chains.split(',') : undefined);
  res.json(apiResponse(data));
}));

/** GET /api/v2/data/market/portfolio-pnl */
router.get('/market/portfolio-pnl', asyncHandler(async (req, res) => {
  const { address, chains, limit } = req.query as any;
  if (!address) { res.status(400).json(apiResponse(null, 'address required')); return; }
  const data = await getRecentPnl(address, chains ? chains.split(',') : undefined, parseInt(limit || '50'));
  res.json(apiResponse(data));
}));

/** GET /api/v2/data/market/portfolio-token-pnl */
router.get('/market/portfolio-token-pnl', asyncHandler(async (req, res) => {
  const { address, chainIndex, tokenAddress } = req.query as any;
  if (!address || !chainIndex || !tokenAddress) {
    res.status(400).json(apiResponse(null, 'address, chainIndex, tokenAddress required'));
    return;
  }
  const data = await getTokenLatestPnl(address, chainIndex, tokenAddress);
  res.json(apiResponse(data));
}));

/** GET /api/v2/data/market/portfolio-dex-history */
router.get('/market/portfolio-dex-history', asyncHandler(async (req, res) => {
  const { address, chains, limit } = req.query as any;
  if (!address) { res.status(400).json(apiResponse(null, 'address required')); return; }
  const data = await getDexHistory(address, chains ? chains.split(',') : undefined, parseInt(limit || '50'));
  res.json(apiResponse(data));
}));

export default router;
