import { pool } from '../database';
import { logger } from '../logger';
import { config } from '../config';
import { getMarketClient } from './okxMarketV6';

// ================================================================
// OKX Market v6 Periodic Snapshot Scheduler
// ================================================================
// All intervals and limits are configurable via env vars
// (see config.ts okxMarket section).
// ================================================================

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

    const { schedulerHotTokensMs: hotMs, schedulerCandlesMs: candlesMs, schedulerIndexMs: indexMs } = config.okxMarket;

    // Initial snapshots (staggered)
    setTimeout(() => this.safeRun('hot-tokens', () => this.snapshotHotTokens()), 5_000).unref?.();
    setTimeout(() => this.safeRun('index-price', () => this.snapshotIndexPrices()), 8_000).unref?.();
    setTimeout(() => this.safeRun('candles', () => this.snapshotCandles()), 15_000).unref?.();

    // Periodic
    this.timers.push(
      setInterval(() => this.safeRun('hot-tokens', () => this.snapshotHotTokens()), hotMs),
      setInterval(() => this.safeRun('index-price', () => this.snapshotIndexPrices()), indexMs),
      setInterval(() => this.safeRun('candles', () => this.snapshotCandles()), candlesMs),
    );

    for (const t of this.timers) { if ('unref' in t) (t as any).unref?.(); }

    logger.info('[okx-sched] Scheduler started', {
      chains: this.chains.length,
      candleTokens: this.candleTokens,
      intervals: { hotTokens: hotMs, candles: candlesMs, indexPrice: indexMs },
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
  // POST /index/current-price requires tokenContractAddress per token,
  // so we resolve token addresses from the per-chain toplist first.
  private async snapshotIndexPrices(): Promise<void> {
    const maxTokens = Math.min(this.candleTokens, 30);
    const collectedAt = new Date();
    const client = await pool.connect();
    try {
      for (const chainIndex of this.chains) {
        try {
          const tokens = await this.client.getHotTokens(chainIndex, maxTokens);
          if (!tokens || !Array.isArray(tokens)) continue;

          const items = tokens
            .filter((t: any) => t?.tokenAddress)
            .map((t: any) => ({ chainIndex, tokenContractAddress: t.tokenAddress }))
            .slice(0, maxTokens);
          if (!items.length) continue;

          const data = await this.client.getIndexPriceBatch(items);
          if (!data || !Array.isArray(data)) continue;

          for (const item of data) {
            const price = parseFloat(item.price || '0');
            if (!price) continue;
            await client.query(
              `INSERT INTO okx_market_index_prices (chain, token_address, price, collected_at)
               VALUES ($1,$2,$3,$4)`,
              [item.chainIndex || chainIndex, item.tokenContractAddress || '', price, collectedAt]
            );
          }
        } catch (err: any) {
          logger.warn(`[okx-sched] index-price failed (${chainIndex})`, { error: err.message });
        }
      }
    } finally { client.release(); }
  }

  // ── Tracked Tokens (user-configured) ───────────────────────────
  private async loadTrackedTokens(): Promise<Array<{ chain: string; token_address: string }>> {
    try {
      const result = await pool.query(
        `SELECT chain, token_address FROM tracked_tokens WHERE enabled = true`
      );
      return result.rows;
    } catch { return []; }
  }

  // ── Candles ───────────────────────────────────────────────────
  private async snapshotCandles(): Promise<void> {
    const limit = this.candleTokens;
    const gathered = new Map<string, Set<string>>(); // chain → Set<tokenAddress>

    // 1. Hot tokens from OKX
    for (const chainIndex of this.chains) {
      try {
        const tokens = await this.client.getHotTokens(chainIndex, limit);
        if (tokens && Array.isArray(tokens)) {
          const set = new Set<string>();
          for (const t of tokens.slice(0, limit)) {
            if (t?.tokenAddress) set.add(t.tokenAddress);
          }
          gathered.set(chainIndex, set);
        }
      } catch { /* skip */ }
    }

    // 2. User-configured tracked tokens
    const tracked = await this.loadTrackedTokens();
    for (const t of tracked) {
      const set = gathered.get(t.chain) || new Set<string>();
      set.add(t.token_address);
      gathered.set(t.chain, set);
    }

    // 3. Pull candles for all gathered tokens
    for (const [chainIndex, addresses] of gathered) {
      for (const tokenAddress of addresses) {
        try {
          const candles = await this.client.getCandles(chainIndex, tokenAddress, config.okxMarket.schedulerCandlePeriod, config.okxMarket.schedulerCandleLimit);
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
                [chainIndex, tokenAddress, config.okxMarket.schedulerCandlePeriod,
                 new Date(parseInt(c.timestamp, 10)),
                 c.open || 0, c.high || 0, c.low || 0, c.close || 0, c.volume || 0]
              );
            }
          } finally { client.release(); }
        } catch { /* skip individual token errors */ }

        await new Promise(r => setTimeout(r, 100));
      }
    }
  }
}

// Singleton
let schedulerInstance: OkxMarketScheduler | null = null;
export function getMarketScheduler(): OkxMarketScheduler {
  if (!schedulerInstance) schedulerInstance = new OkxMarketScheduler();
  return schedulerInstance;
}
