import { Router } from 'express';
import { asyncHandler, apiResponse } from '../helpers';
import { getMarketClient } from '../services/okxMarketV6';
import { pool } from '../database';

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

/**
 * POST /api/v2/data/market/index-price-batch — batch index prices
 * body: [{ chainIndex, tokenAddress }]（tokenAddress 兼容 tokenContractAddress）
 * 每链 1 次调用拿多 token 价格，配额友好（对比逐 token GET index-price）。
 * 供 data 服务 okx_chainos 采集器按轮批量拉取头部代币指数价格。
 */
router.post('/market/index-price-batch', asyncHandler(async (req, res) => {
  const body = req.body as Array<{ chainIndex?: string | number; tokenAddress?: string; tokenContractAddress?: string }>;
  if (!Array.isArray(body) || body.length === 0) {
    res.status(400).json(apiResponse(null, 'body must be a non-empty array of { chainIndex, tokenAddress }'));
    return;
  }
  const normalized = body
    .filter((it) => it && it.chainIndex != null && (it.tokenAddress || it.tokenContractAddress))
    .map((it) => ({
      chainIndex: String(it.chainIndex),
      tokenContractAddress: it.tokenContractAddress || it.tokenAddress!,
    }));
  if (normalized.length === 0) {
    res.status(400).json(apiResponse(null, 'each item requires chainIndex and tokenAddress'));
    return;
  }
  const data = await m().getIndexPriceBatch(normalized);
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

// ================================================================
// Tracked Tokens (api-key auth for SDK/MCP access)
// ================================================================

router.get('/market/tracked-tokens', asyncHandler(async (req, res) => {
  const { chain, enabled } = req.query as any;
  let query = 'SELECT * FROM tracked_tokens WHERE 1=1';
  const params: any[] = [];
  let i = 1;
  if (chain) { query += ` AND chain = $${i++}`; params.push(chain); }
  if (enabled !== undefined) { query += ` AND enabled = $${i++}`; params.push(enabled === 'true'); }
  query += ' ORDER BY created_at DESC';
  const result = await pool.query(query, params);
  res.json(apiResponse(result.rows));
}));

router.post('/market/tracked-tokens', asyncHandler(async (req, res) => {
  const { chain, tokenAddress, tokenSymbol, tokenName, label } = req.body || {};
  if (!chain || !tokenAddress) {
    res.status(400).json(apiResponse(null, 'chain and tokenAddress required'));
    return;
  }
  const result = await pool.query(
    `INSERT INTO tracked_tokens (chain, token_address, token_symbol, token_name, label)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (chain, token_address) DO UPDATE
     SET token_symbol = EXCLUDED.token_symbol, token_name = EXCLUDED.token_name, enabled = true, updated_at = NOW()
     RETURNING *`,
    [chain, tokenAddress, tokenSymbol || null, tokenName || null, label || null]
  );
  res.json(apiResponse(result.rows[0], 'Token added'));
}));

router.delete('/market/tracked-tokens', asyncHandler(async (req, res) => {
  const chain = (req.query as any).chain || (req.body as any)?.chain;
  const tokenAddress = (req.query as any).tokenAddress || (req.body as any)?.tokenAddress;
  if (!chain || !tokenAddress) {
    res.status(400).json(apiResponse(null, 'chain and tokenAddress required'));
    return;
  }
  const result = await pool.query(
    'DELETE FROM tracked_tokens WHERE chain = $1 AND token_address = $2 RETURNING *',
    [chain, tokenAddress]
  );
  res.json(apiResponse(result.rows[0] || null, result.rows.length > 0 ? 'Removed' : 'Not found'));
}));

// ================================================================
// Custom Event Signatures (api-key auth for SDK/MCP access)
// ================================================================

router.get('/market/custom-sigs', asyncHandler(async (req, res) => {
  const { chain, enabled } = req.query as any;
  let query = 'SELECT * FROM custom_event_sigs WHERE 1=1';
  const params: any[] = [];
  let i = 1;
  if (chain) { query += ` AND chain = $${i++}`; params.push(chain); }
  if (enabled !== undefined) { query += ` AND enabled = $${i++}`; params.push(enabled === 'true'); }
  query += ' ORDER BY created_at DESC';
  const result = await pool.query(query, params);
  res.json(apiResponse(result.rows));
}));

router.post('/market/custom-sigs', asyncHandler(async (req, res) => {
  const { chain, topicHash, eventType, eventName, abi } = req.body || {};
  if (!chain || !topicHash || !eventType) {
    res.status(400).json(apiResponse(null, 'chain, topicHash, eventType required'));
    return;
  }
  if (!/^0x[a-fA-F0-9]{64}$/.test(topicHash)) {
    res.status(400).json(apiResponse(null, 'topicHash must be 0x + 64 hex chars'));
    return;
  }
  const result = await pool.query(
    `INSERT INTO custom_event_sigs (chain, topic_hash, event_type, event_name, abi)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (chain, topic_hash) DO UPDATE
     SET event_type = EXCLUDED.event_type, event_name = COALESCE(EXCLUDED.event_name, custom_event_sigs.event_name),
         abi = COALESCE(EXCLUDED.abi, custom_event_sigs.abi), enabled = true, updated_at = NOW()
     RETURNING *`,
    [chain, topicHash.toLowerCase(), eventType, eventName || null, abi ? JSON.stringify(abi) : null]
  );
  res.json(apiResponse(result.rows[0], 'Custom event signature registered'));
}));

router.delete('/market/custom-sigs', asyncHandler(async (req, res) => {
  const chain = (req.query as any).chain || (req.body as any)?.chain;
  const topicHash = (req.query as any).topicHash || (req.body as any)?.topicHash;
  if (!chain || !topicHash) {
    res.status(400).json(apiResponse(null, 'chain and topicHash required'));
    return;
  }
  const result = await pool.query(
    'DELETE FROM custom_event_sigs WHERE chain = $1 AND topic_hash = $2 RETURNING *',
    [chain, topicHash.toLowerCase()]
  );
  res.json(apiResponse(result.rows[0] || null, result.rows.length > 0 ? 'Removed' : 'Not found'));
}));

export default router;
