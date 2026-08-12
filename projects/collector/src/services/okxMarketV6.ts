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
    // x402 支付门控（HTTP 402）：保留结构化信息供路由层显式返回 payment_required
    if (resp.status === 402) {
      const text = await resp.text();
      const err: any = new Error(`OKX Market 402: ${text.slice(0, 500)}`);
      err.status = 402;
      err.x402 = true;
      throw err;
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

  /** Parse a v6 positional candle row [ts, open, high, low, close, vol, volUsd, confirm] */
  private parseCandleRow(row: any): OkxCandle | null {
    if (!Array.isArray(row) || row.length < 6) return null;
    return {
      timestamp: String(row[0]),
      open: parseFloat(row[1]) || 0,
      high: parseFloat(row[2]) || 0,
      low: parseFloat(row[3]) || 0,
      close: parseFloat(row[4]) || 0,
      volume: parseFloat(row[5]) || 0,
    };
  }

  /** Map a v6 token/toplist row onto the shared OkxTokenInfo shape */
  private mapTokenRow(row: any): OkxTokenInfo {
    return {
      chain: String(row.chainIndex || ''),
      tokenAddress: row.tokenContractAddress || row.tokenAddress || '',
      symbol: row.tokenSymbol || '',
      name: row.tokenName || '',
      price: parseFloat(row.price) || 0,
      volume24h: parseFloat(row.volume || row.volume24h || row.volume24H) || 0,
      marketCap: parseFloat(row.marketCap) || 0,
      liquidity: parseFloat(row.liquidity) || 0,
      fdv: parseFloat(row.fdv) || 0,
      supply: parseFloat(row.supply) || 0,
      holders: parseInt(row.holders || row.holderCount, 10) || 0,
      dexName: row.dexName || '',
      poolAddress: row.poolAddress || '',
      change24h: parseFloat(row.change || row.priceChange24h || row.priceChange24H) || 0,
    };
  }

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

  /** POST /api/v6/dex/index/current-price — current index price (body is JSON array) */
  async getIndexPrice(chainIndex: string, tokenAddress?: string): Promise<any> {
    const acct = this.nextAccount(); if (!acct) throw new Error('No OKX account');
    if (!tokenAddress) throw new Error('index/current-price requires tokenContractAddress');
    return this.request(acct, 'POST', '/api/v6/dex/index/current-price', [
      { chainIndex, tokenContractAddress: tokenAddress },
    ]);
  }

  /** POST /api/v6/dex/index/current-price — batch index price for multiple tokens */
  async getIndexPriceBatch(items: Array<{ chainIndex: string; tokenContractAddress: string }>): Promise<any> {
    const acct = this.nextAccount(); if (!acct) throw new Error('No OKX account');
    if (!items.length) return [];
    return this.request(acct, 'POST', '/api/v6/dex/index/current-price', items);
  }

  /** GET /api/v6/dex/index/historical-price */
  async getHistoricalIndexPrice(chainIndex: string, tokenAddress?: string, limit = 100): Promise<any> {
    const acct = this.nextAccount(); if (!acct) throw new Error('No OKX account');
    const q = new URLSearchParams({ chainIndex, limit: String(limit) });
    if (tokenAddress) q.set('tokenContractAddress', tokenAddress);
    return this.request(acct, 'GET', `/api/v6/dex/index/historical-price?${q.toString()}`);
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

  /** GET /api/v6/dex/market/token/search — token search by keyword (chains: comma-separated chainIndex) */
  async searchToken(keyword: string, chainIndex?: string, limit = 20): Promise<OkxTokenInfo[]> {
    const acct = this.nextAccount(); if (!acct) throw new Error('No OKX account');
    const q = new URLSearchParams({ search: keyword, limit: String(limit) });
    q.set('chains', chainIndex || '1,56,8453');
    const data = await this.request(acct, 'GET', `/api/v6/dex/market/token/search?${q.toString()}`);
    return Array.isArray(data) ? data.map((r: any) => this.mapTokenRow(r)) : [];
  }

  /** POST /api/v6/dex/market/token/basic-info — token metadata (body is JSON array) */
  async getTokenBasicInfo(chainIndex: string, tokenAddress: string): Promise<any> {
    const acct = this.nextAccount(); if (!acct) throw new Error('No OKX account');
    return this.request(acct, 'POST', '/api/v6/dex/market/token/basic-info', [
      { chainIndex, tokenContractAddress: tokenAddress },
    ]);
  }

  /** GET /api/v6/dex/market/token/toplist — trending tokens (okx-dex-token skill)
   *
   * @param chainIndex  Chain ID (1=ETH, 56=BSC, 8453=Base, 501=Solana)
   * @param limit       Max results
   * @param opts        Optional filters:
   *   sortBy            1=price, 2=priceChange%, 3=txs, 4=uniqueTraders,
   *                     5=volumeUSD (default), 6=mcap, 7=liquidity, 8=createdAt,
   *                     9=OKXsearch, 10=holders, 11=mentions, 12=socialScore,
   *                     14=netInflow, 15=tokenScore
   *   timeFrame         1=5min, 2=1h, 3=4h, 4=24h (default)
   */
  async getHotTokens(chainIndex: string, limit = 50, opts?: Record<string, string>): Promise<OkxTokenInfo[]> {
    const acct = this.nextAccount(); if (!acct) throw new Error('No OKX account');
    const q = new URLSearchParams({ chains: chainIndex, limit: String(limit) });
    q.set('sortBy', opts?.sortBy || '5');
    q.set('timeFrame', opts?.timeFrame || '4');
    if (opts) {
      for (const [k, v] of Object.entries(opts)) {
        if (k !== 'sortBy' && k !== 'timeFrame' && v !== undefined && v !== '') q.set(k, String(v));
      }
    }
    const data = await this.request(acct, 'GET', `/api/v6/dex/market/token/toplist?${q.toString()}`);
    return Array.isArray(data) ? data.map((r: any) => this.mapTokenRow(r)) : [];
  }

  /** GET /api/v6/dex/market/token/top-liquidity — top liquidity pools */
  async getTopLiquidity(chainIndex: string, tokenAddress: string): Promise<any> {
    const acct = this.nextAccount(); if (!acct) throw new Error('No OKX account');
    const path = `/api/v6/dex/market/token/top-liquidity?chainIndex=${chainIndex}&tokenAddress=${tokenAddress}`;
    return this.request(acct, 'GET', path);
  }

  /** GET /api/v6/dex/market/candles — K-line candles (response is positional arrays) */
  async getCandles(chainIndex: string, tokenAddress: string, period = '15m', limit = 100): Promise<OkxCandle[]> {
    const acct = this.nextAccount(); if (!acct) throw new Error('No OKX account');
    const q = new URLSearchParams({ chainIndex, tokenContractAddress: tokenAddress, bar: period, limit: String(limit) });
    const data = await this.request(acct, 'GET', `/api/v6/dex/market/candles?${q.toString()}`);
    return Array.isArray(data)
      ? data.map((row: any) => this.parseCandleRow(row)).filter((c: OkxCandle | null): c is OkxCandle => c !== null)
      : [];
  }

  /** POST /api/v6/dex/market/price — real-time price (body is JSON array) */
  async getPrice(chainIndex: string, tokenAddress: string): Promise<any> {
    const acct = this.nextAccount(); if (!acct) throw new Error('No OKX account');
    return this.request(acct, 'POST', '/api/v6/dex/market/price', [
      { chainIndex, tokenContractAddress: tokenAddress },
    ]);
  }

  /** POST /api/v6/dex/market/price — batch real-time prices */
  async getPriceBatch(items: Array<{ chainIndex: string; tokenContractAddress: string }>): Promise<any> {
    const acct = this.nextAccount(); if (!acct) throw new Error('No OKX account');
    if (!items.length) return [];
    return this.request(acct, 'POST', '/api/v6/dex/market/price', items);
  }

  /** GET /api/v6/dex/market/trades — recent trades */
  async getTrades(chainIndex: string, tokenAddress: string, limit = 50): Promise<any> {
    const acct = this.nextAccount(); if (!acct) throw new Error('No OKX account');
    const q = new URLSearchParams({ chainIndex, tokenContractAddress: tokenAddress, limit: String(limit) });
    return this.request(acct, 'GET', `/api/v6/dex/market/trades?${q.toString()}`);
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
    const q = new URLSearchParams({ chainIndex, tokenContractAddress: tokenAddress, limit: String(limit) });
    return this.request(acct, 'GET', `/api/v6/dex/market/token/holder?${q.toString()}`);
  }

  /** GET /api/v6/dex/market/token/top-trader */
  async getTopTraders(chainIndex: string, tokenAddress: string): Promise<any> {
    const acct = this.nextAccount(); if (!acct) throw new Error('No OKX account');
    const path = `/api/v6/dex/market/token/top-trader?chainIndex=${chainIndex}&tokenAddress=${tokenAddress}`;
    return this.request(acct, 'GET', path);
  }

  /** POST /api/v6/dex/market/price-info — price + market cap + liquidity (body is JSON array) */
  async getPriceInfo(chainIndex: string, tokenAddress: string): Promise<any> {
    const acct = this.nextAccount(); if (!acct) throw new Error('No OKX account');
    return this.request(acct, 'POST', '/api/v6/dex/market/price-info', [
      { chainIndex, tokenContractAddress: tokenAddress },
    ]);
  }

  /** GET /api/v6/dex/market/historical-candles */
  async getHistoricalCandles(chainIndex: string, tokenAddress: string, period = '1H', limit = 100): Promise<OkxCandle[]> {
    const acct = this.nextAccount(); if (!acct) throw new Error('No OKX account');
    const q = new URLSearchParams({ chainIndex, tokenContractAddress: tokenAddress, bar: period, limit: String(limit) });
    const data = await this.request(acct, 'GET', `/api/v6/dex/market/historical-candles?${q.toString()}`);
    return Array.isArray(data)
      ? data.map((row: any) => this.parseCandleRow(row)).filter((c: OkxCandle | null): c is OkxCandle => c !== null)
      : [];
  }

  // ── MemePump ─────────────────────────────────────────────────

  /** GET /api/v6/dex/market/memepump/supported/chainsProtocol — Free */
  async getMemePumpSupportedChains(): Promise<any> {
    const acct = this.nextAccount(); if (!acct) throw new Error('No OKX account');
    return this.request(acct, 'GET', '/api/v6/dex/market/memepump/supported/chainsProtocol');
  }

  /** GET /api/v6/dex/market/memepump/tokenList — Premium */
  async getMemePumpTokenList(chainIndex: string, protocol?: string, sortBy = 'volume24h', limit = 50, stage?: string): Promise<OkxMemeToken[]> {
    const acct = this.nextAccount(); if (!acct) throw new Error('No OKX account');
    let path = `/api/v6/dex/market/memepump/tokenList?chainIndex=${chainIndex}&sortBy=${sortBy}&limit=${limit}`;
    if (stage) path += `&stage=${stage}`;
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

  /** POST /api/v6/dex/market/signal/list — Premium（上游为 POST + JSON body）
   *
   * @param chainIndex  chainIndex（signal 支持链：1/56/196/501/8453/4663…）
   * @param walletType  逗号分隔钱包类型（1,2,3…），可选
   * @param minAmountUsd 最小金额 USD 过滤，可选
   * @param limit       Max results
   */
  async getSignalList(chainIndex: string, signalType?: string, limit = 50, walletType?: string, minAmountUsd?: number): Promise<OkxSignal[]> {
    const acct = this.nextAccount(); if (!acct) throw new Error('No OKX account');
    const body: Record<string, unknown> = { chainIndex, limit };
    if (signalType) body.signalType = signalType;
    if (walletType) body.walletType = walletType;
    if (minAmountUsd !== undefined) body.minAmountUsd = minAmountUsd;
    return this.request(acct, 'POST', '/api/v6/dex/market/signal/list', body);
  }

  /** GET /api/v6/dex/market/signal/supported/chain — Free */
  async getSignalSupportedChains(): Promise<any> {
    const acct = this.nextAccount(); if (!acct) throw new Error('No OKX account');
    return this.request(acct, 'GET', '/api/v6/dex/market/signal/supported/chain');
  }

  /** GET /api/v6/dex/market/leaderboard/list — Premium
   *
   * 上游必填：sortBy（整数：1=pnl, 2=profitRate…）+ timeFrame（整数：1=5m, 2=1h, 3=4h, 4=24h）
   * @param chainIndex  chainIndex（leaderboard 支持链：1/56/196/501/8453/4663…）
   * @param leaderboardType 兼容旧参数名（忽略，上游以 sortBy 为准）
   * @param limit       Max results
   * @param sortBy      上游排序字段整数（默认 1=pnl）
   * @param timeFrame   上游时间窗整数（默认 4=24h）
   */
  async getLeaderboard(chainIndex: string, leaderboardType = 'pnl', limit = 50, sortBy = 1, timeFrame = 4): Promise<OkxLeaderboardEntry[]> {
    const acct = this.nextAccount(); if (!acct) throw new Error('No OKX account');
    const path = `/api/v6/dex/market/leaderboard/list?chainIndex=${chainIndex}&sortBy=${sortBy}&timeFrame=${timeFrame}&limit=${limit}`;
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
