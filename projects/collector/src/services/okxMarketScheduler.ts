import { pool } from '../database';
import { logger } from '../logger';
import { config } from '../config';
import { getMarketClient } from './okxMarketV6';

// ================================================================
// OKX Market v6 Periodic Snapshot Scheduler
// ================================================================
// Periodically collects time-series data from OKX Market v6 API
// and stores it in local database tables for historical analysis
// without repeated API calls.
//
// All intervals and limits are configurable via env vars:
//   OKX_MARKET_SCHED_CHAINS     — comma-separated chainIndex (default "1,56,8453")
//   OKX_MARKET_CANDLE_TOKENS   — tokens per chain for candles (default 10)
//   OKX_MARKET_HOT_INTERVAL_MS  — hot-tokens interval (default 60000)
//   OKX_MARKET_CANDLE_INTERVAL_MS — candles interval (default 300000)
//   OKX_MARKET_INDEX_INTERVAL_MS  — index-price interval (default 60000)
//   OKX_MARKET_MEMPUMP_INTERVAL_MS — mempump interval (default 300000)
// ================================================================

const CANDLE_PERIOD = '15m';
const CANDLE_LIMIT = 4;   // last 1h worth of 15m candles

export class OkxMarketScheduler {
  private running = false;
  private timers: NodeJS.Timeout[] = [];
  private client = getMarketClient();

  private get chains(): string[] { return config.okxMarket.schedulerChains; }
  private get candleTokens(): number { return config.okxMarket.schedulerCandleTokens; }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    await this.client.init();

    const { schedulerHotTokensMs: hotMs, schedulerCandlesMs: candlesMs, schedulerIndexMs: indexMs, schedulerMempumpMs: mempumpMs } = config.okxMarket;

    // Initial snapshots (staggered)
    setTimeout(() => this.safeRun('hot-tokens', () => this.snapshotHotTokens()), 5_000).unref?.();
    setTimeout(() => this.safeRun('index-price', () => this.snapshotIndexPrices()), 8_000).unref?.();
    setTimeout(() => this.safeRun('candles', () => this.snapshotCandles()), 15_000).unref?.();
    setTimeout(() => this.safeRun('mempump', () => this.snapshotMemePump()), 20_000).unref?.();

    // Periodic
    this.timers.push(
      setInterval(() => this.safeRun('hot-tokens', () => this.snapshotHotTokens()), hotMs),
      setInterval(() => this.safeRun('index-price', () => this.snapshotIndexPrices()), indexMs),
      setInterval(() => this.safeRun('candles', () => this.snapshotCandles()), candlesMs),
      setInterval(() => this.safeRun('mempump', () => this.snapshotMemePump()), mempumpMs),
    );

    for (const t of this.timers) { if ('unref' in t) (t as any).unref?.(); }

    logger.info('[okx-sched] Scheduler started', {
      chains: this.chains.length,
      candleTokens: this.candleTokens,
      intervals: { hotTokens: hotMs, candles: candlesMs, indexPrice: indexMs, mempump: mempumpMs },
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
    for (const chainIndex of this.chains) {
      const tokens = await this.client.getHotTokens(chainIndex, this.candleTokens);
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
    for (const chainIndex of this.chains) {
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
    const limit = this.candleTokens;
    for (const chainIndex of this.chains) {
      let tokens: any[] = [];
      try {
        tokens = await this.client.getHotTokens(chainIndex, limit);
      } catch { continue; }
      if (!tokens || !Array.isArray(tokens)) continue;

      for (const token of tokens.slice(0, limit)) {
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
    for (const chainIndex of this.chains) {
      try {
        const tokens = await this.client.getMemePumpTokenList(chainIndex, undefined, 'volume24h', this.candleTokens);
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
