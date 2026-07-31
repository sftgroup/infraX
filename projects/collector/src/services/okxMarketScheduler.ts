import { pool } from '../database';
import { logger } from '../logger';
import { getMarketClient } from './okxMarketV6';

// ================================================================
// OKX Market v6 Periodic Snapshot Scheduler
// ================================================================
// Periodically collects time-series data from OKX Market v6 API
// and stores it in local database tables for historical analysis
// without repeated API calls.
//
// Tables:
//   okx_market_candles      — K-line OHLCV
//   okx_market_index_prices  — index prices
//   okx_market_hot_tokens   — trending token snapshots
//   okx_market_mempump      — meme token snapshots
// ================================================================

const HOT_TOKENS_INTERVAL_MS = 60_000;    // 1 min
const CANDLES_INTERVAL_MS = 300_000;      // 5 min
const INDEX_PRICE_INTERVAL_MS = 60_000;   // 1 min
const MEMPUMP_INTERVAL_MS = 300_000;      // 5 min

const CHAINS = ['1', '56', '8453'];       // ethereum, bsc, base
const CANDLE_PERIOD = '15m';
const CANDLE_LIMIT = 4;                   // last 1h worth of 15m candles
const TRACKED_TOKENS_LIMIT = 20;          // top N tokens to track candles for

export class OkxMarketScheduler {
  private running = false;
  private timers: NodeJS.Timeout[] = [];
  private client = getMarketClient();

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    await this.client.init();

    // Initial snapshots (staggered)
    setTimeout(() => this.safeRun('hot-tokens', () => this.snapshotHotTokens()), 5_000).unref?.();
    setTimeout(() => this.safeRun('index-price', () => this.snapshotIndexPrices()), 8_000).unref?.();
    setTimeout(() => this.safeRun('candles', () => this.snapshotCandles()), 15_000).unref?.();
    setTimeout(() => this.safeRun('mempump', () => this.snapshotMemePump()), 20_000).unref?.();

    // Periodic
    this.timers.push(
      setInterval(() => this.safeRun('hot-tokens', () => this.snapshotHotTokens()), HOT_TOKENS_INTERVAL_MS),
      setInterval(() => this.safeRun('index-price', () => this.snapshotIndexPrices()), INDEX_PRICE_INTERVAL_MS),
      setInterval(() => this.safeRun('candles', () => this.snapshotCandles()), CANDLES_INTERVAL_MS),
      setInterval(() => this.safeRun('mempump', () => this.snapshotMemePump()), MEMPUMP_INTERVAL_MS),
    );

    for (const t of this.timers) { if ('unref' in t) (t as any).unref?.(); }

    logger.info('[okx-sched] Scheduler started', {
      chains: CHAINS.length,
      intervals: { hotTokens: HOT_TOKENS_INTERVAL_MS, candles: CANDLES_INTERVAL_MS, indexPrice: INDEX_PRICE_INTERVAL_MS, mempump: MEMPUMP_INTERVAL_MS },
    });
  }

  stop(): void {
    this.running = false;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    logger.info('[okx-sched] Scheduler stopped');
  }

  private async safeRun(name: string, fn: () => Promise<void>): Promise<void> {
    try { await fn(); } catch (err: any) {
      logger.warn(`[okx-sched] ${name} failed`, { error: err.message });
    }
  }

  // ── Hot Tokens ────────────────────────────────────────────────
  private async snapshotHotTokens(): Promise<void> {
    for (const chainIndex of CHAINS) {
      const tokens = await this.client.getHotTokens(chainIndex, TRACKED_TOKENS_LIMIT);
      if (!tokens || !Array.isArray(tokens)) continue;

      const collectedAt = new Date();
      const client = await pool.connect();
      try {
        for (let i = 0; i < tokens.length; i++) {
          const t = tokens[i];
          if (!t?.tokenAddress) continue;
          await client.query(
            `INSERT INTO okx_market_hot_tokens
               (chain, token_address, token_symbol, token_name, price_usd, volume_24h, market_cap, price_change_24h, rank, collected_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [chainIndex, t.tokenAddress, t.symbol || '', t.name || '', t.price || 0,
             t.volume24h || 0, t.marketCap || 0, t.change24h || 0, i + 1, collectedAt]
          );
        }
      } finally { client.release(); }
    }
  }

  // ── Index Prices ──────────────────────────────────────────────
  private async snapshotIndexPrices(): Promise<void> {
    for (const chainIndex of CHAINS) {
      const data = await this.client.getIndexPrice(chainIndex);
      if (!data) continue;

      const items = Array.isArray(data) ? data : [data];
      const collectedAt = new Date();
      const client = await pool.connect();
      try {
        for (const item of items) {
          const price = parseFloat(item.price || item.indexPrice || '0') || 0;
          if (price === 0) continue;
          await client.query(
            `INSERT INTO okx_market_index_prices (chain, token_address, price, collected_at)
             VALUES ($1,$2,$3,$4)`,
            [chainIndex, item.tokenAddress || item.symbol || '', price, collectedAt]
          );
        }
      } finally { client.release(); }
    }
  }

  // ── Candles ───────────────────────────────────────────────────
  private async snapshotCandles(): Promise<void> {
    // First get hot tokens to know what to track
    for (const chainIndex of CHAINS) {
      let tokens: any[] = [];
      try {
        tokens = await this.client.getHotTokens(chainIndex, TRACKED_TOKENS_LIMIT);
      } catch { continue; }
      if (!tokens || !Array.isArray(tokens)) continue;

      for (const token of tokens.slice(0, TRACKED_TOKENS_LIMIT)) {
        if (!token?.tokenAddress) continue;
        try {
          const candles = await this.client.getCandles(chainIndex, token.tokenAddress, CANDLE_PERIOD, CANDLE_LIMIT);
          if (!candles || !Array.isArray(candles)) continue;

          const client = await pool.connect();
          try {
            for (const c of candles) {
              if (!c.timestamp) continue;
              await client.query(
                `INSERT INTO okx_market_candles
                   (chain, token_address, period, bucket, open_price, high_price, low_price, close_price, volume)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
                 ON CONFLICT DO NOTHING`,
                [chainIndex, token.tokenAddress, CANDLE_PERIOD,
                 new Date(parseInt(c.timestamp, 10)),
                 c.open || 0, c.high || 0, c.low || 0, c.close || 0, c.volume || 0]
              );
            }
          } finally { client.release(); }
        } catch { /* skip individual token errors */ }

        // Rate limit between tokens
        await new Promise(r => setTimeout(r, 100));
      }
    }
  }

  // ── MemePump ──────────────────────────────────────────────────
  private async snapshotMemePump(): Promise<void> {
    for (const chainIndex of CHAINS) {
      try {
        const tokens = await this.client.getMemePumpTokenList(chainIndex, undefined, 'volume24h', TRACKED_TOKENS_LIMIT);
        if (!tokens || !Array.isArray(tokens)) continue;

        const collectedAt = new Date();
        const client = await pool.connect();
        try {
          for (const t of tokens) {
            if (!t?.tokenAddress) continue;
            await client.query(
              `INSERT INTO okx_market_mempump
                 (chain, token_address, token_symbol, token_name, liquidity, volume_24h, price_change_24h, holder_count, dev_address, dev_holding_pct, bundled_pct, is_honeypot, created_at_ts, collected_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
              [chainIndex, t.tokenAddress, t.symbol || '', t.name || '',
               t.liquidity || 0, t.volume24h || 0, t.priceChange24h || 0,
               t.holderCount || 0, t.devAddress || '', t.devHoldingPercent || 0,
               t.bundledPercent || 0, t.isHoneypot || false,
               t.createdAt ? parseInt(t.createdAt, 10) : 0, collectedAt]
            );
          }
        } finally { client.release(); }
      } catch { /* skip chain errors */ }
    }
  }
}

// Singleton
let schedulerInstance: OkxMarketScheduler | null = null;
export function getMarketScheduler(): OkxMarketScheduler {
  if (!schedulerInstance) schedulerInstance = new OkxMarketScheduler();
  return schedulerInstance;
}
