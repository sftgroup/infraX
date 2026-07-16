import { pool } from '../database';
import { logger } from '../logger';

/**
 * Data Cleaner
 *
 * Uses TimescaleDB `drop_chunks()` for O(1) data retention — no DELETE scanning.
 *
 * Retention policy:
 *  - events: 72 hours (drop_chunks every 1h)
 *  - payment_events: permanent (never deleted)
 *  - event_checkpoints: permanent
 */

const CLEANUP_INTERVAL_MS = 3_600_000; // 1 hour
const RETENTION_HOURS = 72;

export class DataCleaner {
  private timer: NodeJS.Timeout | null = null;

  start(): void {
    logger.info('[cleaner] Data Cleaner started', {
      interval: '1h',
      retention: `${RETENTION_HOURS}h`,
      method: 'drop_chunks',
    });

    // Run immediately on startup, then every hour
    this.runCleanup();
    this.timer = setInterval(() => this.runCleanup(), CLEANUP_INTERVAL_MS);

    if (this.timer && 'unref' in this.timer) {
      this.timer.unref?.();
    }
  }

  async runCleanup(): Promise<void> {
    const startTime = Date.now();

    try {
      // Drop all chunks older than RETENTION_HOURS (TimescaleDB O(1) operation)
      const result = await pool.query(
        `SELECT drop_chunks(
          relation => 'events',
          older_than => INTERVAL '72 hours'
        )`
      );

      const duration = Date.now() - startTime;

      if (result.rows.length > 0) {
        const dropped = result.rows
          .filter((r: any) => r.drop_chunks)
          .map((r: any) => r.drop_chunks);
        logger.info('[cleaner] Chunks dropped', {
          chunks: dropped.length,
          names: dropped,
          duration: `${duration}ms`,
        });
      }
    } catch (err: any) {
      logger.error('[cleaner] Cleanup failed', { error: err.message });
    }
  }

  /**
   * Estimate storage used by the events table (O(1): reads from checkpoint counters, no full scan)
   */
  async getStorageStats(): Promise<{
    totalRows: number;
    newestBlock: number;
    oldestBlock: number;
    chains: Record<string, number>;
  }> {
    try {
      // All stats from event_checkpoints — O(1) indexed reads
      const { rows: cps } = await pool.query(
        'SELECT chain, event_count, last_block FROM event_checkpoints WHERE collector_name = $1',
        ['block_scanner']
      );

      let totalRows = 0;
      let newestBlock = 0;
      const chains: Record<string, number> = {};

      for (const cp of cps) {
        const count = parseInt(cp.event_count || '0', 10);
        const block = parseInt(cp.last_block || '0', 10);
        totalRows += count;
        if (block > newestBlock) newestBlock = block;
        chains[cp.chain] = count;
      }

      return { totalRows, newestBlock, oldestBlock: 0, chains };
    } catch (err: any) {
      logger.error('[cleaner] Failed to get storage stats', { error: err.message });
      return { totalRows: 0, newestBlock: 0, oldestBlock: 0, chains: {} };
    }
  }

  shutdown(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    logger.info('[cleaner] Data Cleaner shut down');
  }
}

// Singleton
let cleanerInstance: DataCleaner | null = null;

export function getCleaner(): DataCleaner {
  if (!cleanerInstance) {
    cleanerInstance = new DataCleaner();
  }
  return cleanerInstance;
}
