import { Router } from 'express';
import { asyncHandler, apiResponse } from '../helpers';
import { getMarketClient } from '../services/okxMarketV6';

const router = Router();
const m = () => getMarketClient();

// ================================================================
// Utility
// ================================================================

/** GET /api/v2/data/market/supported-chains */
router.get('/market/supported-chains', asyncHandler(async (_req, res) => {
  const data = await m().getMarketSupportedChains();
  res.json(apiResponse(data));
}));

// ================================================================
// P1 — Free Tier
// ================================================================

/** GET /api/v2/data/market/index-price — Index price (current) */
router.get('/market/index-price', asyncHandler(async (req, res) => {
  const { chainIndex, tokenAddress } = req.query as any;
  if (!chainIndex) { res.status(400).json(apiResponse(null, 'chainIndex required')); return; }
  const data = await m().getIndexPrice(chainIndex, tokenAddress);
  res.json(apiResponse(data));
}));

/** GET /api/v2/data/market/index-price-history */
router.get('/market/index-price-history', asyncHandler(async (req, res) => {
  const { chainIndex, tokenAddress, limit } = req.query as any;
  if (!chainIndex) { res.status(400).json(apiResponse(null, 'chainIndex required')); return; }
  const data = await m().getHistoricalIndexPrice(chainIndex, tokenAddress, parseInt(limit || '100'));
  res.json(apiResponse(data));
}));

/** GET /api/v2/data/market/balance-total — Total portfolio value for address */
router.get('/market/balance-total', asyncHandler(async (req, res) => {
  const { address, chains } = req.query as any;
  if (!address) { res.status(400).json(apiResponse(null, 'address required')); return; }
  const data = await m().getTotalValue(address, chains ? chains.split(',') : undefined);
  res.json(apiResponse(data));
}));

/** GET /api/v2/data/market/balances — All token balances for address */
router.get('/market/balances', asyncHandler(async (req, res) => {
  const { address, chains } = req.query as any;
  if (!address) { res.status(400).json(apiResponse(null, 'address required')); return; }
  const data = await m().getAllBalances(address, chains ? chains.split(',') : undefined);
  res.json(apiResponse(data));
}));

/** GET /api/v2/data/market/token-balance — Single token balance */
router.get('/market/token-balance', asyncHandler(async (req, res) => {
  const { address, chainIndex, tokenAddress } = req.query as any;
  if (!address || !chainIndex || !tokenAddress) {
    res.status(400).json(apiResponse(null, 'address, chainIndex, tokenAddress required'));
    return;
  }
  const data = await m().getTokenBalance(address, chainIndex, tokenAddress);
  res.json(apiResponse(data));
}));

/** GET /api/v2/data/market/transactions — Transaction history by address */
router.get('/market/transactions', asyncHandler(async (req, res) => {
  const { address, chains, limit } = req.query as any;
  if (!address) { res.status(400).json(apiResponse(null, 'address required')); return; }
  const data = await m().getTransactions(address, chains ? chains.split(',') : undefined, parseInt(limit || '50'));
  res.json(apiResponse(data));
}));

/** GET /api/v2/data/market/transaction-detail — Single transaction detail */
router.get('/market/transaction-detail', asyncHandler(async (req, res) => {
  const { chainIndex, txHash } = req.query as any;
  if (!chainIndex || !txHash) { res.status(400).json(apiResponse(null, 'chainIndex and txHash required')); return; }
  const data = await m().getTransactionDetail(chainIndex, txHash);
  res.json(apiResponse(data));
}));

// ================================================================
// P2 — Basic Tier
// ================================================================

/** GET /api/v2/data/market/token-search — Search tokens */
router.get('/market/token-search', asyncHandler(async (req, res) => {
  const { keyword, chainIndex, limit } = req.query as any;
  if (!keyword) { res.status(400).json(apiResponse(null, 'keyword required')); return; }
  const data = await m().searchToken(keyword, chainIndex, parseInt(limit || '20'));
  res.json(apiResponse(data));
}));

/** GET /api/v2/data/market/token-info — Token basic info */
router.get('/market/token-info', asyncHandler(async (req, res) => {
  const { chainIndex, tokenAddress } = req.query as any;
  if (!chainIndex || !tokenAddress) { res.status(400).json(apiResponse(null, 'chainIndex and tokenAddress required')); return; }
  const data = await m().getTokenBasicInfo(chainIndex, tokenAddress);
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
  const data = await m().getHotTokens(chainIndex, parseInt(limit || '50'), Object.keys(opts).length > 0 ? opts : undefined);
  res.json(apiResponse(data));
}));

/** GET /api/v2/data/market/top-liquidity — Top liquidity pools */
router.get('/market/top-liquidity', asyncHandler(async (req, res) => {
  const { chainIndex, tokenAddress } = req.query as any;
  if (!chainIndex || !tokenAddress) { res.status(400).json(apiResponse(null, 'chainIndex and tokenAddress required')); return; }
  const data = await m().getTopLiquidity(chainIndex, tokenAddress);
  res.json(apiResponse(data));
}));

/** GET /api/v2/data/market/candles — K-line candles */
router.get('/market/candles', asyncHandler(async (req, res) => {
  const { chainIndex, tokenAddress, period, limit } = req.query as any;
  if (!chainIndex || !tokenAddress) { res.status(400).json(apiResponse(null, 'chainIndex and tokenAddress required')); return; }
  const data = await m().getCandles(chainIndex, tokenAddress, period || '15m', parseInt(limit || '100'));
  res.json(apiResponse(data));
}));

/** GET /api/v2/data/market/price — Real-time DEX price */
router.get('/market/price', asyncHandler(async (req, res) => {
  const { chainIndex, tokenAddress } = req.query as any;
  if (!chainIndex || !tokenAddress) { res.status(400).json(apiResponse(null, 'chainIndex and tokenAddress required')); return; }
  const data = await m().getPrice(chainIndex, tokenAddress);
  res.json(apiResponse(data));
}));

/** GET /api/v2/data/market/trades — Recent trades */
router.get('/market/trades', asyncHandler(async (req, res) => {
  const { chainIndex, tokenAddress, limit } = req.query as any;
  if (!chainIndex || !tokenAddress) { res.status(400).json(apiResponse(null, 'chainIndex and tokenAddress required')); return; }
  const data = await m().getTrades(chainIndex, tokenAddress, parseInt(limit || '50'));
  res.json(apiResponse(data));
}));

// ================================================================
// P3 — Premium Tier: Token Analysis
// ================================================================

/** GET /api/v2/data/market/token-advanced — Token advanced info */
router.get('/market/token-advanced', asyncHandler(async (req, res) => {
  const { chainIndex, tokenAddress } = req.query as any;
  if (!chainIndex || !tokenAddress) { res.status(400).json(apiResponse(null, 'chainIndex and tokenAddress required')); return; }
  const data = await m().getTokenAdvancedInfo(chainIndex, tokenAddress);
  res.json(apiResponse(data));
}));

/** GET /api/v2/data/market/token-holders — Token holder list */
router.get('/market/token-holders', asyncHandler(async (req, res) => {
  const { chainIndex, tokenAddress, limit } = req.query as any;
  if (!chainIndex || !tokenAddress) { res.status(400).json(apiResponse(null, 'chainIndex and tokenAddress required')); return; }
  const data = await m().getTokenHolders(chainIndex, tokenAddress, parseInt(limit || '50'));
  res.json(apiResponse(data));
}));

/** GET /api/v2/data/market/token-top-traders — Top traders for token */
router.get('/market/token-top-traders', asyncHandler(async (req, res) => {
  const { chainIndex, tokenAddress } = req.query as any;
  if (!chainIndex || !tokenAddress) { res.status(400).json(apiResponse(null, 'chainIndex and tokenAddress required')); return; }
  const data = await m().getTopTraders(chainIndex, tokenAddress);
  res.json(apiResponse(data));
}));

/** GET /api/v2/data/market/price-info — Detailed price info */
router.get('/market/price-info', asyncHandler(async (req, res) => {
  const { chainIndex, tokenAddress } = req.query as any;
  if (!chainIndex || !tokenAddress) { res.status(400).json(apiResponse(null, 'chainIndex and tokenAddress required')); return; }
  const data = await m().getPriceInfo(chainIndex, tokenAddress);
  res.json(apiResponse(data));
}));

/** GET /api/v2/data/market/historical-candles */
router.get('/market/historical-candles', asyncHandler(async (req, res) => {
  const { chainIndex, tokenAddress, period, limit } = req.query as any;
  if (!chainIndex || !tokenAddress) { res.status(400).json(apiResponse(null, 'chainIndex and tokenAddress required')); return; }
  const data = await m().getHistoricalCandles(chainIndex, tokenAddress, period || '1H', parseInt(limit || '100'));
  res.json(apiResponse(data));
}));

// ================================================================
// P3 — Premium Tier: MemePump
// ================================================================

/** GET /api/v2/data/market/mempump/chains — Supported chains */
router.get('/market/mempump/chains', asyncHandler(async (_req, res) => {
  const data = await m().getMemePumpSupportedChains();
  res.json(apiResponse(data));
}));

/** GET /api/v2/data/market/mempump/list — Meme token list */
router.get('/market/mempump/list', asyncHandler(async (req, res) => {
  const { chainIndex, protocol, sortBy, limit } = req.query as any;
  if (!chainIndex) { res.status(400).json(apiResponse(null, 'chainIndex required')); return; }
  const data = await m().getMemePumpTokenList(chainIndex, protocol, sortBy, parseInt(limit || '50'));
  res.json(apiResponse(data));
}));

/** GET /api/v2/data/market/mempump/details — Meme token details */
router.get('/market/mempump/details', asyncHandler(async (req, res) => {
  const { chainIndex, tokenAddress } = req.query as any;
  if (!chainIndex || !tokenAddress) { res.status(400).json(apiResponse(null, 'chainIndex and tokenAddress required')); return; }
  const data = await m().getMemePumpTokenDetails(chainIndex, tokenAddress);
  res.json(apiResponse(data));
}));

/** GET /api/v2/data/market/mempump/devinfo — Developer info */
router.get('/market/mempump/devinfo', asyncHandler(async (req, res) => {
  const { chainIndex, tokenAddress } = req.query as any;
  if (!chainIndex || !tokenAddress) { res.status(400).json(apiResponse(null, 'chainIndex and tokenAddress required')); return; }
  const data = await m().getMemePumpDevInfo(chainIndex, tokenAddress);
  res.json(apiResponse(data));
}));

/** GET /api/v2/data/market/mempump/similar — Similar tokens */
router.get('/market/mempump/similar', asyncHandler(async (req, res) => {
  const { chainIndex, tokenAddress } = req.query as any;
  if (!chainIndex || !tokenAddress) { res.status(400).json(apiResponse(null, 'chainIndex and tokenAddress required')); return; }
  const data = await m().getMemePumpSimilarTokens(chainIndex, tokenAddress);
  res.json(apiResponse(data));
}));

/** GET /api/v2/data/market/mempump/bundle — Bundle detection */
router.get('/market/mempump/bundle', asyncHandler(async (req, res) => {
  const { chainIndex, tokenAddress } = req.query as any;
  if (!chainIndex || !tokenAddress) { res.status(400).json(apiResponse(null, 'chainIndex and tokenAddress required')); return; }
  const data = await m().getMemePumpBundleInfo(chainIndex, tokenAddress);
  res.json(apiResponse(data));
}));

/** GET /api/v2/data/market/mempump/apedwallets — Aped wallets */
router.get('/market/mempump/apedwallets', asyncHandler(async (req, res) => {
  const { chainIndex, tokenAddress } = req.query as any;
  if (!chainIndex || !tokenAddress) { res.status(400).json(apiResponse(null, 'chainIndex and tokenAddress required')); return; }
  const data = await m().getMemePumpApedWallets(chainIndex, tokenAddress);
  res.json(apiResponse(data));
}));

// ================================================================
// P3 — Premium Tier: Signal / Leaderboard
// ================================================================

/** GET /api/v2/data/market/signals — Signal list */
router.get('/market/signals', asyncHandler(async (req, res) => {
  const { chainIndex, signalType, limit } = req.query as any;
  if (!chainIndex) { res.status(400).json(apiResponse(null, 'chainIndex required')); return; }
  const data = await m().getSignalList(chainIndex, signalType, parseInt(limit || '50'));
  res.json(apiResponse(data));
}));

/** GET /api/v2/data/market/signal-chains — Supported signal chains */
router.get('/market/signal-chains', asyncHandler(async (_req, res) => {
  const data = await m().getSignalSupportedChains();
  res.json(apiResponse(data));
}));

/** GET /api/v2/data/market/leaderboard — Leaderboard */
router.get('/market/leaderboard', asyncHandler(async (req, res) => {
  const { chainIndex, leaderboardType, limit } = req.query as any;
  if (!chainIndex) { res.status(400).json(apiResponse(null, 'chainIndex required')); return; }
  const data = await m().getLeaderboard(chainIndex, leaderboardType, parseInt(limit || '50'));
  res.json(apiResponse(data));
}));

/** GET /api/v2/data/market/leaderboard-chains — Supported leaderboard chains */
router.get('/market/leaderboard-chains', asyncHandler(async (_req, res) => {
  const data = await m().getLeaderboardSupportedChains();
  res.json(apiResponse(data));
}));

// ================================================================
// P3 — Premium Tier: Holder Cluster (BubbleMap)
// ================================================================

/** GET /api/v2/data/market/cluster-overview */
router.get('/market/cluster-overview', asyncHandler(async (req, res) => {
  const { chainIndex, tokenAddress } = req.query as any;
  if (!chainIndex || !tokenAddress) { res.status(400).json(apiResponse(null, 'chainIndex and tokenAddress required')); return; }
  const data = await m().getClusterOverview(chainIndex, tokenAddress);
  res.json(apiResponse(data));
}));

/** GET /api/v2/data/market/cluster-list */
router.get('/market/cluster-list', asyncHandler(async (req, res) => {
  const { chainIndex, tokenAddress, clusterName, limit } = req.query as any;
  if (!chainIndex || !tokenAddress) { res.status(400).json(apiResponse(null, 'chainIndex and tokenAddress required')); return; }
  const data = await m().getClusterList(chainIndex, tokenAddress, clusterName, parseInt(limit || '50'));
  res.json(apiResponse(data));
}));

/** GET /api/v2/data/market/cluster-top-holders */
router.get('/market/cluster-top-holders', asyncHandler(async (req, res) => {
  const { chainIndex, tokenAddress, minPercent, limit } = req.query as any;
  if (!chainIndex || !tokenAddress) { res.status(400).json(apiResponse(null, 'chainIndex and tokenAddress required')); return; }
  const data = await m().getClusterTopHolders(chainIndex, tokenAddress, minPercent ? parseFloat(minPercent) : undefined, parseInt(limit || '50'));
  res.json(apiResponse(data));
}));

// ================================================================
// P3 — Premium Tier: Portfolio (Address Analysis)
// ================================================================

/** GET /api/v2/data/market/portfolio-overview */
router.get('/market/portfolio-overview', asyncHandler(async (req, res) => {
  const { address, chains } = req.query as any;
  if (!address) { res.status(400).json(apiResponse(null, 'address required')); return; }
  const data = await m().getPortfolioOverview(address, chains ? chains.split(',') : undefined);
  res.json(apiResponse(data));
}));

/** GET /api/v2/data/market/portfolio-pnl */
router.get('/market/portfolio-pnl', asyncHandler(async (req, res) => {
  const { address, chains, limit } = req.query as any;
  if (!address) { res.status(400).json(apiResponse(null, 'address required')); return; }
  const data = await m().getRecentPnl(address, chains ? chains.split(',') : undefined, parseInt(limit || '50'));
  res.json(apiResponse(data));
}));

/** GET /api/v2/data/market/portfolio-token-pnl */
router.get('/market/portfolio-token-pnl', asyncHandler(async (req, res) => {
  const { address, chainIndex, tokenAddress } = req.query as any;
  if (!address || !chainIndex || !tokenAddress) {
    res.status(400).json(apiResponse(null, 'address, chainIndex, tokenAddress required'));
    return;
  }
  const data = await m().getTokenLatestPnl(address, chainIndex, tokenAddress);
  res.json(apiResponse(data));
}));

/** GET /api/v2/data/market/portfolio-dex-history */
router.get('/market/portfolio-dex-history', asyncHandler(async (req, res) => {
  const { address, chains, limit } = req.query as any;
  if (!address) { res.status(400).json(apiResponse(null, 'address required')); return; }
  const data = await m().getDexHistory(address, chains ? chains.split(',') : undefined, parseInt(limit || '50'));
  res.json(apiResponse(data));
}));

export default router;
