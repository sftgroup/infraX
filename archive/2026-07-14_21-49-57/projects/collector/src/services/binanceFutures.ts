import { pool } from '../database';
import { config } from '../config';
import { logger } from '../logger';

interface BinanceSymbol {
  symbol: string;
  markPrice?: string;
  indexPrice?: string;
  lastFundingRate?: string;
  nextFundingTime?: number;
}

interface OHLCAggregate {
  symbol: string;
  bucket: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  mark: number;
  index: number;
  fundingRate: number;
  nextFundingTime: number;
  tickCount: number;
}

/**
 * BinanceFuturesCollector
 * - WebSocket: real-time mark price stream (wss://fstream.binance.com)
 * - 5-minute OHLCV aggregation → TimescaleDB hypertable
 */
export class BinanceFuturesCollector {
  private ws: WebSocket | null = null;
  private running = false;
  private symbols: string[] = [];
  private tickers: Map<string, BinanceSymbol> = new Map();
  private aggregates: Map<string, OHLCAggregate> = new Map();
  private flushTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;

  get isRunning(): boolean { return this.running; }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Load top symbols from Binance REST
    await this.loadSymbols();
    if (this.symbols.length === 0) {
      logger.warn('[binance] No symbols loaded, skipping');
      this.running = false;
      return;
    }

    logger.info('[binance] Starting futures collector', { symbols: this.symbols.length });
    this.connect();
    this.startFlushTimer();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.ws) { this.ws.close(); this.ws = null; }
    if (this.flushTimer) { clearInterval(this.flushTimer); this.flushTimer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    logger.info('[binance] Collector stopped');
  }

  private async loadSymbols(): Promise<void> {
    try {
      const url = `${config.binance.futuresRestBase}/fapi/v1/ticker/price`;
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json() as Array<{ symbol: string }>;
      this.symbols = data
        .filter((s) => s.symbol.endsWith('USDT'))
        .slice(0, config.binance.symbolLimit)
        .map((s) => s.symbol.toLowerCase());
      // Ensure BTC and ETH are always included (they may not be in first N by exchange order)
      for (const must of ['btcusdt', 'ethusdt']) {
        if (!this.symbols.includes(must)) {
          this.symbols.unshift(must);
        }
      }
      // Trim to symbolLimit to stay within budget
      this.symbols = this.symbols.slice(0, config.binance.symbolLimit);
      logger.info('[binance] Loaded symbols', { count: this.symbols.length });
    } catch (err: any) {
      logger.error('[binance] Failed to load symbols, using fallback', { error: err.message });
      this.symbols = ['btcusdt', 'ethusdt'];
    }
  }

  private connect(): void {
    const streams = this.symbols.map((s) => `${s}@markPrice@1s`).join('/');
    const url = `${config.binance.futuresWsBase}/${streams}`;

    try {
      // @ts-ignore
      this.ws = new (require('ws'))(url);
    } catch {
      logger.warn('[binance] WebSocket module unavailable, using REST polling fallback');
      this.pollRest();
      return;
    }

    // Detect stale connection (e.g. behind firewall where WS opens but no data flows)
    let dataReceived = false;
    const staleCheck = setTimeout(() => {
      if (!dataReceived) {
        logger.warn('[binance] WS connected but no data received (possible firewall), switching to REST');
        try { this.ws?.close(); } catch {}
        this.ws = null;
        this.pollRest();
      }
    }, 10000);

    // @ts-ignore
    this.ws.on('message', (raw: any) => {
      dataReceived = true;
      clearTimeout(staleCheck);
      try {
        const data = JSON.parse(raw.toString());
        this.handleMarkPrice(data);
      } catch { /* skip malformed */ }
    });
    // @ts-ignore
    this.ws.on('error', (err: any) => {
      logger.warn('[binance] WS error', { error: err?.message || String(err) });
    });
    // @ts-ignore
    this.ws.on('close', () => {
      clearTimeout(staleCheck);
      if (!dataReceived) {
        logger.warn('[binance] WS closed without data, falling back to REST');
        this.pollRest();
        return;
      }
      if (this.running) {
        logger.info('[binance] WS closed, reconnecting in 10s');
        this.reconnectTimer = setTimeout(() => this.connect(), 10000);
      }
    });
  }

  private handleMarkPrice(data: any): void {
    // Binance streams: { stream: "btcusdt@markPrice@1s", data: { s, p, i, r, T } }
    const d = data.data || data;
    if (!d || !d.s) return;

    const symbol = d.s.toLowerCase();
    this.tickers.set(symbol, {
      symbol,
      markPrice: d.p,
      indexPrice: d.i,
      lastFundingRate: d.r,
      nextFundingTime: d.T,
    });
    this.aggregateTick(symbol, parseFloat(d.p || '0'), parseFloat(d.i || '0'), parseFloat(d.r || '0'), d.T || 0);
  }

  private aggregateTick(symbol: string, markPrice: number, indexPrice: number, fundingRate: number, nextFundingTime: number): void {
    const now = new Date();
    const bucketMs = config.binance.aggregateIntervalMs;
    const bucketTs = Math.floor(now.getTime() / bucketMs) * bucketMs;
    const bucket = new Date(bucketTs);
    const key = `${symbol}:${bucketTs}`;

    let agg = this.aggregates.get(key);
    if (!agg) {
      agg = {
        symbol, bucket,
        open: markPrice,
        high: markPrice,
        low: markPrice,
        close: markPrice,
        mark: markPrice,
        index: indexPrice,
        fundingRate,
        nextFundingTime,
        tickCount: 1,
      };
      this.aggregates.set(key, agg);
    } else {
      agg.high = Math.max(agg.high, markPrice);
      agg.low = Math.min(agg.low, markPrice);
      agg.close = markPrice;
      agg.mark = markPrice;
      agg.index = indexPrice;
      agg.fundingRate = fundingRate;
      agg.nextFundingTime = nextFundingTime;
      agg.tickCount++;
    }

    // Keep map size bounded (max 2 buckets per symbol)
    if (this.aggregates.size > this.symbols.length * 3) {
      const cutoff = bucketTs - bucketMs * 3;
      for (const [k, v] of this.aggregates) {
        if (v.bucket.getTime() < cutoff) this.aggregates.delete(k);
      }
    }
  }

  private startFlushTimer(): void {
    const ms = config.binance.aggregateIntervalMs;
    // Flush just after bucket boundary
    const now = Date.now();
    const nextFlush = ms - (now % ms) + 1000;
    setTimeout(() => {
      this.flushAggregates();
      this.flushTimer = setInterval(() => this.flushAggregates(), ms);
    }, nextFlush);
  }

  private async flushAggregates(): Promise<void> {
    if (this.aggregates.size === 0) return;
    const batch = [...this.aggregates.values()].filter((a) => a.tickCount > 0);
    this.aggregates.clear();

    if (batch.length === 0) return;

    const client = await pool.connect();
    try {
      for (const agg of batch) {
        await client.query(
          `INSERT INTO binance_futures_prices
             (symbol, bucket, open_price, high_price, low_price, close_price, mark_price, index_price, funding_rate, next_funding_time, tick_count)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           ON CONFLICT (symbol, bucket) DO UPDATE SET
             open_price = EXCLUDED.open_price, high_price = EXCLUDED.high_price, low_price = EXCLUDED.low_price,
             close_price = EXCLUDED.close_price, mark_price = EXCLUDED.mark_price, index_price = EXCLUDED.index_price,
             funding_rate = EXCLUDED.funding_rate, next_funding_time = EXCLUDED.next_funding_time,
             tick_count = binance_futures_prices.tick_count + EXCLUDED.tick_count`,
          [agg.symbol, agg.bucket, agg.open, agg.high, agg.low, agg.close, agg.mark, agg.index, agg.fundingRate, agg.nextFundingTime, agg.tickCount]
        );
      }
      logger.debug('[binance] Flushed aggregates', { count: batch.length });
    } catch (err: any) {
      logger.error('[binance] Flush failed', { error: err.message });
    } finally {
      client.release();
    }
  }

  /**
   * REST polling fallback when WebSocket is unavailable
   */
  private pollTimer: NodeJS.Timeout | null = null;

  private pollRest(): void {
    if (this.pollTimer) return; // already polling
    logger.info('[binance] Starting REST polling fallback');
    const { aggregateIntervalMs, futuresRestBase } = config.binance;
    this.pollTimer = setInterval(async () => {
      try {
        const resp = await fetch(`${futuresRestBase}/fapi/v1/premiumIndex`);
        if (!resp.ok) return;
        const data = await resp.json() as any[];
        const now = Date.now();
        for (const item of data) {
          if (!item.symbol?.endsWith('USDT')) continue;
          const symbol = item.symbol.toLowerCase();
          if (!this.symbols.includes(symbol)) continue;
          this.aggregateTick(symbol, parseFloat(item.markPrice || '0'), parseFloat(item.indexPrice || '0'), parseFloat(item.lastFundingRate || '0'), item.nextFundingTime || 0);
        }
      } catch (err: any) {
        logger.warn('[binance] REST poll error', { error: err.message });
      }
    }, aggregateIntervalMs);
  }

  /**
   * Health check
   */
  getHealth(): { running: boolean; symbols: number; tickers: number; wsConnected: boolean } {
    return {
      running: this.running,
      symbols: this.symbols.length,
      tickers: this.tickers.size,
      wsConnected: this.ws?.readyState === 1, // WebSocket.OPEN = 1
    };
  }
}

// Singleton
let instance: BinanceFuturesCollector | null = null;
export function getBinanceCollector(): BinanceFuturesCollector {
  if (!instance) instance = new BinanceFuturesCollector();
  return instance;
}
