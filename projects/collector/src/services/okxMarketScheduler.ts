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

    const { schedulerHotTokensMs: hotMs, schedulerCandlesMs: candlesMs, schedulerIndexMs: indexMs, schedulerMempumpMs: mempumpMs, schedulerProfileMs: profileMs } = config.okxMarket;

    // Initial snapshots (staggered)
    setTimeout(() => this.safeRun('hot-tokens', () => this.snapshotHotTokens()), 5_000).unref?.();
    setTimeout(() => this.safeRun('index-price', () => this.snapshotIndexPrices()), 8_000).unref?.();
    setTimeout(() => this.safeRun('candles', () => this.snapshotCandles()), 15_000).unref?.();
    setTimeout(() => this.safeRun('mempump', () => this.snapshotMempump()), 20_000).unref?.();
    setTimeout(() => this.safeRun('profiles', () => this.snapshotTokenProfiles()), 25_000).unref?.();

    // Periodic
    this.timers.push(
      setInterval(() => this.safeRun('hot-tokens', () => this.snapshotHotTokens()), hotMs),
      setInterval(() => this.safeRun('index-price', () => this.snapshotIndexPrices()), indexMs),
      setInterval(() => this.safeRun('candles', () => this.snapshotCandles()), candlesMs),
      setInterval(() => this.safeRun('mempump', () => this.snapshotMempump()), mempumpMs),
      setInterval(() => this.safeRun('profiles', () => this.snapshotTokenProfiles()), profileMs),
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

  // ── MemePump ─────────────────────────────────────────────────
  // DQ-7: 启用 mempump 定时器（OKX_MARKET_MEMPUMP_INTERVAL_MS，默认 5min）
  // 快照每链 meme 代币 pump/trench 数据 → okx_market_mempump 表。
  // v6 memepump API 需要 stage 参数且仅支持部分链（bsc/base），按 supported 过滤。
  private async snapshotMempump(): Promise<void> {
    let mempumpChains = this.chains;
    try {
      const supported = await this.client.getMemePumpSupportedChains();
      const supportedSet = new Set<string>();
      if (Array.isArray(supported)) {
        for (const s of supported) {
          if (s && s.chainIndex) supportedSet.add(String(s.chainIndex));
        }
      }
      if (supportedSet.size > 0) {
        mempumpChains = this.chains.filter(c => supportedSet.has(c));
      }
    } catch (err: any) {
      logger.warn('[okx-sched] mempump supported-chains fetch failed, snapshot all', { error: err.message });
    }

    for (const chainIndex of mempumpChains) {
      try {
        const tokens = await this.client.getMemePumpTokenList(chainIndex, undefined, 'volume24h', this.candleTokens, 'NEW');
        if (!tokens || !Array.isArray(tokens)) continue;

        const client = await pool.connect();
        try {
          for (const t of tokens) {
            if (!t?.tokenAddress) continue;
            await client.query(
              `INSERT INTO okx_market_mempump
                 (chain, protocol, token_address, token_symbol, token_name, liquidity, volume_24h, price_change_24h, holder_count, dev_address, dev_holding_pct, bundled_pct, is_honeypot, created_at_ts)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
               ON CONFLICT DO NOTHING`,
              [t.chain || chainIndex, '', t.tokenAddress, t.symbol || '', t.name || '',
               t.liquidity || 0, t.volume24h || 0, t.priceChange24h || 0,
               t.holderCount || 0, t.devAddress || '', t.devHoldingPercent || 0,
               t.bundledPercent || 0, t.isHoneypot ?? false,
               parseInt(t.createdAt || '0', 10) || 0]
            );
          }
        } finally { client.release(); }
      } catch (err: any) {
        logger.warn(`[okx-sched] mempump failed (${chainIndex})`, { error: err.message });
      }
      await new Promise(r => setTimeout(r, 150));
    }
  }

  // ── Token Profiles (画像快照：价格多时间窗 + 流动性 + 持有者) ──
  // 热门代币（每链 top N）→ price-info 批量（免费）→ okx_market_token_profiles 时间序列
  private async snapshotTokenProfiles(): Promise<void> {
    const limit = Math.min(this.candleTokens, 30);
    const client = await pool.connect();
    try {
      for (const chainIndex of this.chains) {
        try {
          const tokens = await this.client.getHotTokens(chainIndex, limit);
          if (!tokens || !Array.isArray(tokens)) continue;

          const items = tokens
            .filter((t: any) => t?.tokenAddress)
            .map((t: any) => ({ chainIndex, tokenContractAddress: t.tokenAddress }))
            .slice(0, limit);
          if (!items.length) continue;

          const rows = await this.client.getPriceInfoBatch(items);
          if (!Array.isArray(rows)) continue;

          const byAddr = new Map<string, any>();
          for (const t of tokens) { if (t?.tokenAddress) byAddr.set(String(t.tokenAddress).toLowerCase(), t); }

          const collectedAt = new Date();
          for (const r of rows) {
            const addr = String(r.tokenContractAddress || '').toLowerCase();
            const meta = byAddr.get(addr);
            const price = parseFloat(r.price || '0');
            if (!price) continue;
            await client.query(
              `INSERT INTO okx_market_token_profiles
                 (chain, token_address, token_symbol, token_name, price_usd, price_change_5m, price_change_1h, price_change_4h, price_change_24h, market_cap, volume_24h, liquidity_usd, circ_supply, max_price, min_price, holder_count, collected_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
              [chainIndex, addr, meta?.symbol || '', meta?.name || '',
               price, parseFloat(r.priceChange5M || '0'), parseFloat(r.priceChange1H || '0'),
               parseFloat(r.priceChange4H || '0'), parseFloat(r.priceChange24H || '0'),
               parseFloat(r.marketCap || '0'), meta?.volume24h || 0,
               parseFloat(r.liquidity || '0'), parseFloat(r.circSupply || '0'),
               parseFloat(r.maxPrice || '0'), parseFloat(r.minPrice || '0'),
               parseInt(r.holders || '0', 10) || null, collectedAt]
            );
          }
        } catch (err: any) {
          logger.warn(`[okx-sched] profiles failed (${chainIndex})`, { error: err.message });
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
