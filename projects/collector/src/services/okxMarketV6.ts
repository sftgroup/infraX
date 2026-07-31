import { config } from '../config';
import { pool } from '../database';
import { logger } from '../logger';
import crypto from 'crypto';

// ================================================================
// OKX OnchainOS Market v6 API Client
// ================================================================
// Base URL:  https://web3.okx.com
// Auth:      HMAC-SHA256 (same as v5 wallet API)
// Docs:      https://web3.okx.com/onchainos/dev-docs/market/
//
// Pricing (per-call after free monthly quota of 100K Basic + 100K Premium):
//   Free     — $0
//   Basic    — $0.0001
//   Premium  — $0.0002
// ================================================================

interface OkxAccount {
  id: number;
  label: string;
  api_key: string;
  api_secret: string;
  api_passphrase: string;
  enabled: boolean;
}

// ── Shared types ──────────────────────────────────────────────────

export interface OkxTokenInfo {
  chain: string;
  tokenAddress: string;
  symbol: string;
  name: string;
  price: number;
  volume24h: number;
  marketCap: number;
  liquidity: number;
  fdv: number;
  supply: number;
  holders: number;
  dexName: string;
  poolAddress: string;
  change24h: number;
}

export interface OkxCandle {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface OkxBalance {
  address: string;
  chain: string;
  tokenAddress: string;
  symbol: string;
  name: string;
  balance: string;
  priceUsd: number;
  valueUsd: number;
}

export interface OkxTxHistory {
  txHash: string;
  chain: string;
  blockHeight: number;
  txTime: string;
  fromAddress: string;
  toAddress: string;
  value: string;
  gasUsed: string;
  gasPrice: string;
  status: string;
  method: string;
}

export interface OkxMemeToken {
  chain: string;
  tokenAddress: string;
  symbol: string;
  name: string;
  createdAt: string;
  liquidity: number;
  volume24h: number;
  priceChange24h: number;
  holderCount: number;
  devAddress: string;
  devHoldingPercent: number;
  isHoneypot: boolean;
  bundledPercent: number;
}

export interface OkxSignal {
  signalId: string;
  chain: string;
  tokenAddress: string;
  symbol: string;
  signalType: string;       // whale_buy, smart_money, kol_entry, etc
  address: string;
  amount: number;
  valueUsd: number;
  timestamp: string;
}

export interface OkxLeaderboardEntry {
  rank: number;
  address: string;
  pnl: number;
  pnlPercent: number;
  winRate: number;
  tradeCount: number;
  volumeUsd: number;
}

export interface OkxHolderCluster {
  clusterName: string;
  holderCount: number;
  totalPercent: number;
  avgHoldingUsd: number;
}

// ================================================================
// Client
// ================================================================

export class OkxMarketV6Client {
  private accounts: OkxAccount[] = [];
  private accountIndex = 0;

  private signRequest(account: OkxAccount, method: string, path: string, body: string = ''): Record<string, string> {
    const timestamp = new Date().toISOString();
    const prehash = timestamp + method + path + body;
    const sign = crypto.createHmac('sha256', account.api_secret).update(prehash).digest('base64');
    return {
      'OK-ACCESS-KEY': account.api_key,
      'OK-ACCESS-SIGN': sign,
      'OK-ACCESS-TIMESTAMP': timestamp,
      'OK-ACCESS-PASSPHRASE': account.api_passphrase,
      'Content-Type': 'application/json',
    };
  }

  private async request(account: OkxAccount, method: string, path: string, body?: any): Promise<any> {
    const bodyStr = body ? JSON.stringify(body) : '';
    const headers = this.signRequest(account, method, path, bodyStr);
    const url = `${config.okxMarket.apiBase}${path}`;

    const resp = await fetch(url, { method, headers, body: bodyStr || undefined });

    if (resp.status === 429) {
      throw new Error(`OKX Market rate-limited`);
    }
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`OKX Market ${resp.status}: ${text.slice(0, 200)}`);
    }

    const json = await resp.json() as any;
    if (json.code !== '0') {
      throw new Error(`OKX Market error ${json.code}: ${json.msg}`);
    }

    return json.data;
  }

  private nextAccount(): OkxAccount | null {
    if (this.accounts.length === 0) return null;
    const acct = this.accounts[this.accountIndex % this.accounts.length];
    this.accountIndex++;
    return acct;
  }

  // ── Account management ────────────────────────────────────────

  async init(): Promise<number> {
    // Load from DB first, fallback to env
    try {
      const result = await pool.query(
        `SELECT id, label, api_key, api_secret, api_passphrase, enabled
         FROM admin_okx_accounts WHERE enabled = true ORDER BY is_default DESC`
      );
      if (result.rows.length > 0) {
        this.accounts = result.rows;
      }
    } catch {}

    if (this.accounts.length === 0) {
      if (config.okxMarket.apiKey) {
        this.accounts = [{
          id: 0, label: 'env-default',
          api_key: config.okxMarket.apiKey,
          api_secret: config.okxMarket.apiSecret,
          api_passphrase: config.okxMarket.apiPassphrase,
          enabled: true,
        }];
      }
    }

    logger.info('[okx-market] Initialised', { accounts: this.accounts.length });
    return this.accounts.length;
  }

  // ==============================================================
  // P1 — Free Tier (零成本)
  // ==============================================================

  /** GET /api/v6/dex/index/current-price — current index price */
  async getIndexPrice(chainIndex: string, tokenAddress?: string): Promise<any> {
    const acct = this.nextAccount(); if (!acct) throw new Error('No OKX account');
    let path = `/api/v6/dex/index/current-price?chainIndex=${chainIndex}`;
    if (tokenAddress) path += `&tokenAddress=${tokenAddress}`;
    return this.request(acct, 'GET', path);
  }

  /** GET /api/v6/dex/index/historical-price */
  async getHistoricalIndexPrice(chainIndex: string, tokenAddress?: string, limit = 100): Promise<any> {
    const acct = this.nextAccount(); if (!acct) throw new Error('No OKX account');
    let path = `/api/v6/dex/index/historical-price?chainIndex=${chainIndex}&limit=${limit}`;
    if (tokenAddress) path += `&tokenAddress=${tokenAddress}`;
    return this.request(acct, 'GET', path);
  }

  /** GET /api/v6/dex/balance/total-value-by-address */
  async getTotalValue(address: string, chains?: string[]): Promise<any> {
    const acct = this.nextAccount(); if (!acct) throw new Error('No OKX account');
    let path = `/api/v6/dex/balance/total-value-by-address?address=${address}`;
    if (chains?.length) path += `&chains=${chains.join(',')}`;
    return this.request(acct, 'GET', path);
  }

  /** GET /api/v6/dex/balance/all-token-balances-by-address */
  async getAllBalances(address: string, chains?: string[]): Promise<OkxBalance[]> {
    const acct = this.nextAccount(); if (!acct) throw new Error('No OKX account');
    let path = `/api/v6/dex/balance/all-token-balances-by-address?address=${address}`;
    if (chains?.length) path += `&chains=${chains.join(',')}`;
    return this.request(acct, 'GET', path);
  }

  /** GET /api/v6/dex/balance/token-balances-by-address */
  async getTokenBalance(address: string, chainIndex: string, tokenAddress: string): Promise<any> {
    const acct = this.nextAccount(); if (!acct) throw new Error('No OKX account');
    const path = `/api/v6/dex/balance/token-balances-by-address?address=${address}&chainIndex=${chainIndex}&tokenAddress=${tokenAddress}`;
    return this.request(acct, 'GET', path);
  }

  /** GET /api/v6/dex/balance/supported/chain */
  async getBalanceSupportedChains(): Promise<any> {
    const acct = this.nextAccount(); if (!acct) throw new Error('No OKX account');
    return this.request(acct, 'GET', '/api/v6/dex/balance/supported/chain');
  }

  /** GET /api/v6/dex/post-transaction/transactions-by-address */
  async getTransactions(address: string, chains?: string[], limit = 50): Promise<OkxTxHistory[]> {
    const acct = this.nextAccount(); if (!acct) throw new Error('No OKX account');
    let path = `/api/v6/dex/post-transaction/transactions-by-address?address=${address}&limit=${limit}`;
    if (chains?.length) path += `&chains=${chains.join(',')}`;
    return this.request(acct, 'GET', path);
  }

  /** GET /api/v6/dex/post-transaction/transaction-detail-by-txhash */
  async getTransactionDetail(chainIndex: string, txHash: string): Promise<any> {
    const acct = this.nextAccount(); if (!acct) throw new Error('No OKX account');
    const path = `/api/v6/dex/post-transaction/transaction-detail-by-txhash?chainIndex=${chainIndex}&txHash=${txHash}`;
    return this.request(acct, 'GET', path);
  }

  // ==============================================================
  // P2 — Basic Tier ($0.0001/call)
  // ==============================================================

  /** GET /api/v6/dex/market/token/search — token search by keyword */
  async searchToken(keyword: string, chainIndex?: string, limit = 20): Promise<OkxTokenInfo[]> {
    const acct = this.nextAccount(); if (!acct) throw new Error('No OKX account');
    let path = `/api/v6/dex/market/token/search?keyword=${encodeURIComponent(keyword)}&limit=${limit}`;
    if (chainIndex) path += `&chainIndex=${chainIndex}`;
    return this.request(acct, 'GET', path);
  }

  /** GET /api/v6/dex/market/token/basic-info */
  async getTokenBasicInfo(chainIndex: string, tokenAddress: string): Promise<any> {
    const acct = this.nextAccount(); if (!acct) throw new Error('No OKX account');
    const path = `/api/v6/dex/market/token/basic-info?chainIndex=${chainIndex}&tokenAddress=${tokenAddress}`;
    return this.request(acct, 'GET', path);
  }

  /** GET /api/v6/dex/market/token/hot-token — trending tokens
   *
   * @param chainIndex  Chain ID (1=ETH, 56=BSC, 8453=Base, 501=Solana)
   * @param limit       Max results (default 50, max 100)
   * @param opts        Optional filters:
   *   rankingType       4=Trending(token score), 5=Xmentioned(Twitter)
   *   rankingTimeFrame  1=5min, 2=1h(default), 3=4h, 4=24h
   *   rankBy            1=price, 2=priceChange%, 3=txs, 4=uniqueTraders,
   *                     5=volumeUSD, 6=mcap, 7=liquidity, 8=createdAt,
   *                     9=OKXsearch, 10=holders, 11=mentions, 12=socialScore,
   *                     14=netInflow, 15=tokenScore
   *   riskFilter        Hide risky tokens (default true)
   *   stableTokenFilter Hide stablecoins (default true)
   *   protocolId        Filter by protocol (e.g. "120596" for Pump.fun)
   *   priceChangePercentMin/Max, tradeAmountMin/Max, volumeMin/Max,
   *   txsMin/Max, uniqueTraderMin/Max, marketCapMin/Max, liquidityMin/Max,
   *   holdersMin/Max, mentionedCountMin/Max, socialScoreMin/Max, inflowUsdMin/Max,
   *   fdvMin/Max, isLpBurnt, isMint, isFreeze, cursor
   */
  async getHotTokens(chainIndex: string, limit = 50, opts?: Record<string, string>): Promise<OkxTokenInfo[]> {
    const acct = this.nextAccount(); if (!acct) throw new Error('No OKX account');
    const q = new URLSearchParams({ chainIndex, limit: String(limit) });
    if (opts) {
      for (const [k, v] of Object.entries(opts)) {
        if (v !== undefined && v !== '') q.set(k, String(v));
      }
    }
    const path = `/api/v6/dex/market/token/hot-token?${q.toString()}`;
    return this.request(acct, 'GET', path);
  }

  /** GET /api/v6/dex/market/token/top-liquidity — top liquidity pools */
  async getTopLiquidity(chainIndex: string, tokenAddress: string): Promise<any> {
    const acct = this.nextAccount(); if (!acct) throw new Error('No OKX account');
    const path = `/api/v6/dex/market/token/top-liquidity?chainIndex=${chainIndex}&tokenAddress=${tokenAddress}`;
    return this.request(acct, 'GET', path);
  }

  /** GET /api/v6/dex/market/candles — K-line candles */
  async getCandles(chainIndex: string, tokenAddress: string, period = '15m', limit = 100): Promise<OkxCandle[]> {
    const acct = this.nextAccount(); if (!acct) throw new Error('No OKX account');
    const path = `/api/v6/dex/market/candles?chainIndex=${chainIndex}&tokenAddress=${tokenAddress}&period=${period}&limit=${limit}`;
    return this.request(acct, 'GET', path);
  }

  /** GET /api/v6/dex/market/price — real-time price */
  async getPrice(chainIndex: string, tokenAddress: string): Promise<any> {
    const acct = this.nextAccount(); if (!acct) throw new Error('No OKX account');
    const path = `/api/v6/dex/market/price?chainIndex=${chainIndex}&tokenAddress=${tokenAddress}`;
    return this.request(acct, 'GET', path);
  }

  /** GET /api/v6/dex/market/trades — recent trades */
  async getTrades(chainIndex: string, tokenAddress: string, limit = 50): Promise<any> {
    const acct = this.nextAccount(); if (!acct) throw new Error('No OKX account');
    const path = `/api/v6/dex/market/trades?chainIndex=${chainIndex}&tokenAddress=${tokenAddress}&limit=${limit}`;
    return this.request(acct, 'GET', path);
  }

  // ==============================================================
  // P3 — Premium Tier ($0.0002/call)
  // ==============================================================

  /** GET /api/v6/dex/market/token/advanced-info */
  async getTokenAdvancedInfo(chainIndex: string, tokenAddress: string): Promise<any> {
    const acct = this.nextAccount(); if (!acct) throw new Error('No OKX account');
    const path = `/api/v6/dex/market/token/advanced-info?chainIndex=${chainIndex}&tokenAddress=${tokenAddress}`;
    return this.request(acct, 'GET', path);
  }

  /** GET /api/v6/dex/market/token/holder */
  async getTokenHolders(chainIndex: string, tokenAddress: string, limit = 50): Promise<any> {
    const acct = this.nextAccount(); if (!acct) throw new Error('No OKX account');
    const path = `/api/v6/dex/market/token/holder?chainIndex=${chainIndex}&tokenAddress=${tokenAddress}&limit=${limit}`;
    return this.request(acct, 'GET', path);
  }

  /** GET /api/v6/dex/market/token/top-trader */
  async getTopTraders(chainIndex: string, tokenAddress: string): Promise<any> {
    const acct = this.nextAccount(); if (!acct) throw new Error('No OKX account');
    const path = `/api/v6/dex/market/token/top-trader?chainIndex=${chainIndex}&tokenAddress=${tokenAddress}`;
    return this.request(acct, 'GET', path);
  }

  /** GET /api/v6/dex/market/price-info */
  async getPriceInfo(chainIndex: string, tokenAddress: string): Promise<any> {
    const acct = this.nextAccount(); if (!acct) throw new Error('No OKX account');
    const path = `/api/v6/dex/market/price-info?chainIndex=${chainIndex}&tokenAddress=${tokenAddress}`;
    return this.request(acct, 'GET', path);
  }

  /** GET /api/v6/dex/market/historical-candles */
  async getHistoricalCandles(chainIndex: string, tokenAddress: string, period = '1H', limit = 100): Promise<OkxCandle[]> {
    const acct = this.nextAccount(); if (!acct) throw new Error('No OKX account');
    const path = `/api/v6/dex/market/historical-candles?chainIndex=${chainIndex}&tokenAddress=${tokenAddress}&period=${period}&limit=${limit}`;
    return this.request(acct, 'GET', path);
  }

  // ── MemePump ─────────────────────────────────────────────────

  /** GET /api/v6/dex/market/memepump/supported/chainsProtocol — Free */
  async getMemePumpSupportedChains(): Promise<any> {
    const acct = this.nextAccount(); if (!acct) throw new Error('No OKX account');
    return this.request(acct, 'GET', '/api/v6/dex/market/memepump/supported/chainsProtocol');
  }

  /** GET /api/v6/dex/market/memepump/tokenList — Premium */
  async getMemePumpTokenList(chainIndex: string, protocol?: string, sortBy = 'volume24h', limit = 50): Promise<OkxMemeToken[]> {
    const acct = this.nextAccount(); if (!acct) throw new Error('No OKX account');
    let path = `/api/v6/dex/market/memepump/tokenList?chainIndex=${chainIndex}&sortBy=${sortBy}&limit=${limit}`;
    if (protocol) path += `&protocol=${protocol}`;
    return this.request(acct, 'GET', path);
  }

  /** GET /api/v6/dex/market/memepump/tokenDetails — Premium */
  async getMemePumpTokenDetails(chainIndex: string, tokenAddress: string): Promise<any> {
    const acct = this.nextAccount(); if (!acct) throw new Error('No OKX account');
    const path = `/api/v6/dex/market/memepump/tokenDetails?chainIndex=${chainIndex}&tokenAddress=${tokenAddress}`;
    return this.request(acct, 'GET', path);
  }

  /** GET /api/v6/dex/market/memepump/tokenDevInfo — Premium */
  async getMemePumpDevInfo(chainIndex: string, tokenAddress: string): Promise<any> {
    const acct = this.nextAccount(); if (!acct) throw new Error('No OKX account');
    const path = `/api/v6/dex/market/memepump/tokenDevInfo?chainIndex=${chainIndex}&tokenAddress=${tokenAddress}`;
    return this.request(acct, 'GET', path);
  }

  /** GET /api/v6/dex/market/memepump/similarToken — Basic */
  async getMemePumpSimilarTokens(chainIndex: string, tokenAddress: string): Promise<any> {
    const acct = this.nextAccount(); if (!acct) throw new Error('No OKX account');
    const path = `/api/v6/dex/market/memepump/similarToken?chainIndex=${chainIndex}&tokenAddress=${tokenAddress}`;
    return this.request(acct, 'GET', path);
  }

  /** GET /api/v6/dex/market/memepump/tokenBundleInfo — Premium */
  async getMemePumpBundleInfo(chainIndex: string, tokenAddress: string): Promise<any> {
    const acct = this.nextAccount(); if (!acct) throw new Error('No OKX account');
    const path = `/api/v6/dex/market/memepump/tokenBundleInfo?chainIndex=${chainIndex}&tokenAddress=${tokenAddress}`;
    return this.request(acct, 'GET', path);
  }

  /** GET /api/v6/dex/market/memepump/apedWallet — Premium */
  async getMemePumpApedWallets(chainIndex: string, tokenAddress: string): Promise<any> {
    const acct = this.nextAccount(); if (!acct) throw new Error('No OKX account');
    const path = `/api/v6/dex/market/memepump/apedWallet?chainIndex=${chainIndex}&tokenAddress=${tokenAddress}`;
    return this.request(acct, 'GET', path);
  }

  // ── Signal / Leaderboard ──────────────────────────────────────

  /** GET /api/v6/dex/market/signal/list — Premium */
  async getSignalList(chainIndex: string, signalType?: string, limit = 50): Promise<OkxSignal[]> {
    const acct = this.nextAccount(); if (!acct) throw new Error('No OKX account');
    let path = `/api/v6/dex/market/signal/list?chainIndex=${chainIndex}&limit=${limit}`;
    if (signalType) path += `&signalType=${signalType}`;
    return this.request(acct, 'GET', path);
  }

  /** GET /api/v6/dex/market/signal/supported/chain — Free */
  async getSignalSupportedChains(): Promise<any> {
    const acct = this.nextAccount(); if (!acct) throw new Error('No OKX account');
    return this.request(acct, 'GET', '/api/v6/dex/market/signal/supported/chain');
  }

  /** GET /api/v6/dex/market/leaderboard/list — Premium */
  async getLeaderboard(chainIndex: string, leaderboardType = 'pnl', limit = 50): Promise<OkxLeaderboardEntry[]> {
    const acct = this.nextAccount(); if (!acct) throw new Error('No OKX account');
    const path = `/api/v6/dex/market/leaderboard/list?chainIndex=${chainIndex}&leaderboardType=${leaderboardType}&limit=${limit}`;
    return this.request(acct, 'GET', path);
  }

  /** GET /api/v6/dex/market/leaderboard/supported/chain — Free */
  async getLeaderboardSupportedChains(): Promise<any> {
    const acct = this.nextAccount(); if (!acct) throw new Error('No OKX account');
    return this.request(acct, 'GET', '/api/v6/dex/market/leaderboard/supported/chain');
  }

  // ── Holder Cluster (BubbleMap) ────────────────────────────────

  /** GET /api/v6/dex/market/token/cluster/overview — Premium */
  async getClusterOverview(chainIndex: string, tokenAddress: string): Promise<OkxHolderCluster[]> {
    const acct = this.nextAccount(); if (!acct) throw new Error('No OKX account');
    const path = `/api/v6/dex/market/token/cluster/overview?chainIndex=${chainIndex}&tokenAddress=${tokenAddress}`;
    return this.request(acct, 'GET', path);
  }

  /** GET /api/v6/dex/market/token/cluster/list — Premium */
  async getClusterList(chainIndex: string, tokenAddress: string, clusterName?: string, limit = 50): Promise<any> {
    const acct = this.nextAccount(); if (!acct) throw new Error('No OKX account');
    let path = `/api/v6/dex/market/token/cluster/list?chainIndex=${chainIndex}&tokenAddress=${tokenAddress}&limit=${limit}`;
    if (clusterName) path += `&clusterName=${clusterName}`;
    return this.request(acct, 'GET', path);
  }

  /** GET /api/v6/dex/market/token/cluster/top-holders — Premium */
  async getClusterTopHolders(chainIndex: string, tokenAddress: string, minPercent?: number, limit = 50): Promise<any> {
    const acct = this.nextAccount(); if (!acct) throw new Error('No OKX account');
    let path = `/api/v6/dex/market/token/cluster/top-holders?chainIndex=${chainIndex}&tokenAddress=${tokenAddress}&limit=${limit}`;
    if (minPercent) path += `&minPercent=${minPercent}`;
    return this.request(acct, 'GET', path);
  }

  // ── Portfolio (address analysis) ──────────────────────────────

  /** GET /api/v6/dex/market/portfolio/overview — Premium */
  async getPortfolioOverview(address: string, chains?: string[]): Promise<any> {
    const acct = this.nextAccount(); if (!acct) throw new Error('No OKX account');
    let path = `/api/v6/dex/market/portfolio/overview?address=${address}`;
    if (chains?.length) path += `&chains=${chains.join(',')}`;
    return this.request(acct, 'GET', path);
  }

  /** GET /api/v6/dex/market/portfolio/recent-pnl — Premium */
  async getRecentPnl(address: string, chains?: string[], limit = 50): Promise<any> {
    const acct = this.nextAccount(); if (!acct) throw new Error('No OKX account');
    let path = `/api/v6/dex/market/portfolio/recent-pnl?address=${address}&limit=${limit}`;
    if (chains?.length) path += `&chains=${chains.join(',')}`;
    return this.request(acct, 'GET', path);
  }

  /** GET /api/v6/dex/market/portfolio/token/latest-pnl — Basic */
  async getTokenLatestPnl(address: string, chainIndex: string, tokenAddress: string): Promise<any> {
    const acct = this.nextAccount(); if (!acct) throw new Error('No OKX account');
    const path = `/api/v6/dex/market/portfolio/token/latest-pnl?address=${address}&chainIndex=${chainIndex}&tokenAddress=${tokenAddress}`;
    return this.request(acct, 'GET', path);
  }

  /** GET /api/v6/dex/market/portfolio/dex-history — Basic */
  async getDexHistory(address: string, chains?: string[], limit = 50): Promise<any> {
    const acct = this.nextAccount(); if (!acct) throw new Error('No OKX account');
    let path = `/api/v6/dex/market/portfolio/dex-history?address=${address}&limit=${limit}`;
    if (chains?.length) path += `&chains=${chains.join(',')}`;
    return this.request(acct, 'GET', path);
  }

  // ── Utility ───────────────────────────────────────────────────

  /** GET /api/v6/dex/market/supported/chain — Free */
  async getMarketSupportedChains(): Promise<any> {
    const acct = this.nextAccount(); if (!acct) throw new Error('No OKX account');
    return this.request(acct, 'GET', '/api/v6/dex/market/supported/chain');
  }
}

// Singleton
let clientInstance: OkxMarketV6Client | null = null;
export function getMarketClient(): OkxMarketV6Client {
  if (!clientInstance) clientInstance = new OkxMarketV6Client();
  return clientInstance;
}

// ================================================================
// Convenience functions (can be called directly from routes)
// ================================================================

const c = () => getMarketClient();

// P1 — Free
export const getIndexPrice = (c: string, t?: string) => getMarketClient().getIndexPrice(c, t);
export const getHistoricalIndexPrice = (c: string, t?: string, l?: number) => getMarketClient().getHistoricalIndexPrice(c, t, l);
export const getTotalValue = (a: string, c?: string[]) => getMarketClient().getTotalValue(a, c);
export const getAllBalances = (a: string, c?: string[]) => getMarketClient().getAllBalances(a, c);
export const getTokenBalance = (a: string, c: string, t: string) => getMarketClient().getTokenBalance(a, c, t);
export const getTransactions = (a: string, c?: string[], l?: number) => getMarketClient().getTransactions(a, c, l);
export const getTransactionDetail = (c: string, t: string) => getMarketClient().getTransactionDetail(c, t);

// P2 — Basic
export const searchToken = (k: string, c?: string, l?: number) => getMarketClient().searchToken(k, c, l);
export const getTokenBasicInfo = (c: string, t: string) => getMarketClient().getTokenBasicInfo(c, t);
export const getHotTokens = (c: string, l?: number, o?: Record<string, string>) => getMarketClient().getHotTokens(c, l, o);
export const getTopLiquidity = (c: string, t: string) => getMarketClient().getTopLiquidity(c, t);
export const getCandles = (c: string, t: string, p?: string, l?: number) => getMarketClient().getCandles(c, t, p, l);
export const getMarketPrice = (c: string, t: string) => getMarketClient().getPrice(c, t);
export const getTrades = (c: string, t: string, l?: number) => getMarketClient().getTrades(c, t, l);

// P3 — Premium
export const getTokenAdvancedInfo = (c: string, t: string) => getMarketClient().getTokenAdvancedInfo(c, t);
export const getTokenHolders = (c: string, t: string, l?: number) => getMarketClient().getTokenHolders(c, t, l);
export const getTopTraders = (c: string, t: string) => getMarketClient().getTopTraders(c, t);
export const getPriceInfo = (c: string, t: string) => getMarketClient().getPriceInfo(c, t);
export const getHistoricalCandles = (c: string, t: string, p?: string, l?: number) => getMarketClient().getHistoricalCandles(c, t, p, l);

// P3 — MemePump
export const getMemePumpSupportedChains = () => getMarketClient().getMemePumpSupportedChains();
export const getMemePumpTokenList = (c: string, p?: string, s?: string, l?: number) => getMarketClient().getMemePumpTokenList(c, p, s, l);
export const getMemePumpTokenDetails = (c: string, t: string) => getMarketClient().getMemePumpTokenDetails(c, t);
export const getMemePumpDevInfo = (c: string, t: string) => getMarketClient().getMemePumpDevInfo(c, t);
export const getMemePumpSimilarTokens = (c: string, t: string) => getMarketClient().getMemePumpSimilarTokens(c, t);
export const getMemePumpBundleInfo = (c: string, t: string) => getMarketClient().getMemePumpBundleInfo(c, t);
export const getMemePumpApedWallets = (c: string, t: string) => getMarketClient().getMemePumpApedWallets(c, t);

// P3 — Signal / Leaderboard
export const getSignalList = (c: string, s?: string, l?: number) => getMarketClient().getSignalList(c, s, l);
export const getSignalSupportedChains = () => getMarketClient().getSignalSupportedChains();
export const getLeaderboard = (c: string, t?: string, l?: number) => getMarketClient().getLeaderboard(c, t, l);
export const getLeaderboardSupportedChains = () => getMarketClient().getLeaderboardSupportedChains();

// P3 — Holder Cluster
export const getClusterOverview = (c: string, t: string) => getMarketClient().getClusterOverview(c, t);
export const getClusterList = (c: string, t: string, cn?: string, l?: number) => getMarketClient().getClusterList(c, t, cn, l);
export const getClusterTopHolders = (c: string, t: string, mp?: number, l?: number) => getMarketClient().getClusterTopHolders(c, t, mp, l);

// P3 — Portfolio
export const getPortfolioOverview = (a: string, c?: string[]) => getMarketClient().getPortfolioOverview(a, c);
export const getRecentPnl = (a: string, c?: string[], l?: number) => getMarketClient().getRecentPnl(a, c, l);
export const getTokenLatestPnl = (a: string, c: string, t: string) => getMarketClient().getTokenLatestPnl(a, c, t);
export const getDexHistory = (a: string, c?: string[], l?: number) => getMarketClient().getDexHistory(a, c, l);

// Utility
export const getMarketSupportedChains = () => getMarketClient().getMarketSupportedChains();
