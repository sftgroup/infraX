import { pool } from '../database';
import { config } from '../config';
import { logger } from '../logger';
import crypto from 'crypto';

interface OkxAccount {
  id: number;
  label: string;
  api_key: string;
  api_secret: string;
  api_passphrase: string;
  enabled: boolean;
}

interface OkxTokenInfo {
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

/**
 * OKX ChainOS Collector — DEX token data
 * - Multi-account support (configured via admin panel)
 * - Hourly snapshots → okx_token_snapshots table (permanent)
 */
export class OkxChainOSCollector {
  private running = false;
  private snapshotTimer: NodeJS.Timeout | null = null;
  private accounts: OkxAccount[] = [];
  private accountIndex = 0;

  get isRunning(): boolean { return this.running; }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Load accounts from DB
    await this.loadAccounts();
    await this.takeSnapshot(); // immediate first snapshot

    const ms = config.okx.snapshotIntervalMs;
    this.snapshotTimer = setInterval(() => this.takeSnapshot(), ms);
    logger.info('[okx-chainos] Collector started', { accounts: this.accounts.length, intervalMs: ms });
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.snapshotTimer) { clearInterval(this.snapshotTimer); this.snapshotTimer = null; }
    logger.info('[okx-chainos] Collector stopped');
  }

  private async loadAccounts(): Promise<void> {
    try {
      const result = await pool.query(
        `SELECT id, label, api_key, api_secret, api_passphrase, enabled FROM admin_okx_accounts WHERE enabled = true ORDER BY is_default DESC`
      );
      this.accounts = result.rows;
      if (this.accounts.length === 0) {
        // Fallback to env var
        if (config.okx.apiKey) {
          this.accounts = [{
            id: 0, label: 'env-default',
            api_key: config.okx.apiKey,
            api_secret: config.okx.apiSecret,
            api_passphrase: config.okx.apiPassphrase,
            enabled: true,
          }];
        }
      }
      logger.info('[okx-chainos] Loaded accounts', { count: this.accounts.length });
    } catch (err: any) {
      logger.error('[okx-chainos] Failed to load accounts', { error: err.message });
    }
  }

  /**
   * OKX API signing (v5)
   */
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

  private async okxRequest(account: OkxAccount, method: string, path: string, body?: any): Promise<any> {
    const bodyStr = body ? JSON.stringify(body) : '';
    const headers = this.signRequest(account, method, path, bodyStr);
    const url = `https://www.okx.com${path}`;

    const resp = await fetch(url, {
      method,
      headers,
      body: bodyStr || undefined,
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`OKX API ${resp.status}: ${text.slice(0, 200)}`);
    }

    const json = await resp.json() as any;
    if (json.code !== '0') {
      throw new Error(`OKX API error ${json.code}: ${json.msg}`);
    }

    return json.data;
  }

  /**
   * Rotate accounts for rate limit distribution
   */
  async callOkxApi(account: OkxAccount, method: string, path: string, body?: any): Promise<any> {
    return this.okxRequest(account, method, path, body);
  }

  getNextAccount(): OkxAccount | null {
    return this.nextAccount();
  }

  private nextAccount(): OkxAccount | null {
    if (this.accounts.length === 0) return null;
    const acct = this.accounts[this.accountIndex % this.accounts.length];
    this.accountIndex++;
    return acct;
  }

  /**
   * Take a full snapshot of tracked tokens
   */
  async takeSnapshot(): Promise<{ tokens: number; errors: number }> {
    const chains = ['ethereum', 'bsc', 'base', 'solana'];
    let tokens = 0;
    let errors = 0;
    const collectedAt = new Date();

    for (const chain of chains) {
      try {
        const acct = this.nextAccount();
        if (!acct) { errors++; continue; }

        // Fetch token ranking list (top tokens by volume)
        const rankings = await this.okxRequest(
          acct, 'GET',
          `/api/v5/wallet/token/token-ranking?chainIndex=${chain}&limit=${Math.min(config.okx.tokenLimit, 200)}&sortBy=volume24h`
        );

        if (!rankings || !Array.isArray(rankings)) { errors++; continue; }

        const rows: any[][] = [];
        for (const token of rankings.slice(0, config.okx.tokenLimit)) {
          const addr = token.tokenAddress || token.tokenContractAddress || '';
          if (!addr) continue;

          rows.push([
            chain,
            addr,
            token.tokenSymbol || token.symbol || '',
            token.tokenName || token.token || '',
            parseFloat(token.priceUsd || token.price || '0') || 0,
            parseFloat(token.volume24h || token.volume || '0') || 0,
            parseFloat(token.marketCap || token.mcap || '0') || 0,
            parseFloat(token.liquidityUsd || token.liquidity || '0') || 0,
            parseFloat(token.fullyDilutedValuation || token.fdv || '0') || 0,
            parseFloat(token.totalSupply || token.supply || '0') || 0,
            parseInt(token.holderCount || token.holders || '0', 10) || 0,
            token.dexName || token.dex || '',
            token.poolAddress || token.pool || '',
            parseFloat(token.priceChange24h || token.change24h || '0') || 0,
            collectedAt,
          ]);
          tokens++;
        }

        if (rows.length > 0) {
          const client = await pool.connect();
          try {
            for (const row of rows) {
              await client.query(
                `INSERT INTO okx_token_snapshots
                   (chain, token_address, token_symbol, token_name, price_usd, volume_24h, market_cap, liquidity_usd, fdv, supply, holder_count, dex_name, pool_address, price_change_24h, collected_at)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
                row
              );
            }
          } finally {
            client.release();
          }
        }

        // Rate limit: 100ms between chain calls
        await new Promise((r) => setTimeout(r, 200));
      } catch (err: any) {
        errors++;
        logger.warn('[okx-chainos] Chain fetch failed', { chain, error: err.message });
      }
    }

    if (tokens > 0) {
      logger.info('[okx-chainos] Snapshot saved', { tokens, errors, chains: chains.length });
    }
    return { tokens, errors };
  }

  /**
   * Health check
   */
  getHealth(): { running: boolean; accounts: number; active: boolean; chains: number; snapshotIntervalMs: number } {
    const uniqueChains = new Set<string>();
    for (const a of this.accounts) {
      for (const c of (a as any).chains || ['ethereum', 'bsc', 'base', 'solana']) uniqueChains.add(c);
    }
    return {
      running: this.running,
      accounts: this.accounts.length,
      active: this.running && this.accounts.length > 0,
      chains: uniqueChains.size,
      snapshotIntervalMs: config.okx.snapshotIntervalMs,
    };
  }
}

// Singleton
let instance: OkxChainOSCollector | null = null;
export function getOkxCollector(): OkxChainOSCollector {
  if (!instance) instance = new OkxChainOSCollector();
  return instance;
}

// ── Token search helper (for API/UI queries) ──

export async function searchTokenSnapshots(
  chain?: string,
  tokenAddress?: string,
  symbol?: string,
  limit = 50
): Promise<any[]> {
  let query = `SELECT DISTINCT ON (token_address) * FROM okx_token_snapshots WHERE 1=1`;
  const params: any[] = [];
  let i = 1;

  if (chain) { query += ` AND chain = $${i++}`; params.push(chain); }
  if (tokenAddress) { query += ` AND token_address = $${i++}`; params.push(tokenAddress); }
  if (symbol) { query += ` AND token_symbol ILIKE $${i++}`; params.push(`%${symbol}%`); }

  query += ` ORDER BY token_address, collected_at DESC LIMIT $${i}`;
  params.push(limit);

  const result = await pool.query(query, params);
  return result.rows;
}

export async function getTokenHistory(
  chain: string,
  tokenAddress: string,
  hours = 24,
  limit = 100
): Promise<any[]> {
  const result = await pool.query(
    `SELECT * FROM okx_token_snapshots
     WHERE chain = $1 AND token_address = $2 AND collected_at > NOW() - INTERVAL '1 hour' * $3
     ORDER BY collected_at DESC LIMIT $4`,
    [chain, tokenAddress, hours, limit]
  );
  return result.rows;
}

/**
 * Fetch a single token price from OKX DEX API on demand.
 * Uses the configured OKX account (first enabled one).
 * Caches result in okx_token_snapshots table.
 */
export async function fetchOnDemandTokenPrice(
  chain: string,
  tokenAddress: string
): Promise<{
  chain: string;
  token_symbol: string;
  token_name: string;
  token_address: string;
  price_usd: number;
  volume_24h: number;
  market_cap: number;
  liquidity_usd: number;
  holder_count: number;
  price_change_24h: number;
  dex_name: string;
  collected_at: string;
} | null> {
  const collector = getOkxCollector();
  const account = collector.getNextAccount();
  if (!account) {
    logger.warn('[okx] No OKX account configured for on-demand price lookup');
    return null;
  }

  try {
    const tokenInfo = await collector.callOkxApi(
      account,
      'GET',
      `/api/v5/wallet/token/token-detail?chainIndex=${chain}&tokenAddress=${tokenAddress}`
    );

    if (!tokenInfo || !tokenInfo.tokenAddress) return null;

    const collectedAt = new Date();
    const row = {
      chain,
      token_symbol: tokenInfo.tokenSymbol || tokenInfo.symbol || '',
      token_name: tokenInfo.tokenName || tokenInfo.token || '',
      token_address: tokenInfo.tokenAddress,
      price_usd: parseFloat(tokenInfo.priceUsd || tokenInfo.price || '0') || 0,
      volume_24h: parseFloat(tokenInfo.volume24h || tokenInfo.volume || '0') || 0,
      market_cap: parseFloat(tokenInfo.marketCap || tokenInfo.mcap || '0') || 0,
      liquidity_usd: parseFloat(tokenInfo.liquidityUsd || tokenInfo.liquidity || '0') || 0,
      holder_count: parseInt(tokenInfo.holderCount || tokenInfo.holders || '0', 10) || 0,
      price_change_24h: parseFloat(tokenInfo.priceChange24h || tokenInfo.change24h || '0') || 0,
      dex_name: tokenInfo.dexName || tokenInfo.dex || '',
      collected_at: collectedAt.toISOString(),
    };

    // Cache to DB (fire-and-forget)
    pool.query(
      `INSERT INTO okx_token_snapshots
         (chain, token_address, token_symbol, token_name, price_usd, volume_24h, market_cap, liquidity_usd, fdv, supply, holder_count, dex_name, pool_address, price_change_24h, collected_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        row.chain, row.token_address, row.token_symbol, row.token_name,
        row.price_usd, row.volume_24h, row.market_cap, row.liquidity_usd,
        0, 0, row.holder_count, row.dex_name, '', row.price_change_24h,
        collectedAt,
      ]
    ).catch(() => {});

    return row;
  } catch (err: any) {
    logger.warn('[okx] On-demand price fetch failed', { chain, tokenAddress, error: err.message });
    return null;
  }
}
