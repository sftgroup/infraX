import { pool } from '../models/database';
import { logger } from '../utils/logger';

/**
 * Data Cleaner
 *
 * Scheduled job that purges expired events from the events table.
 *
 * Retention policy:
 *  - events: 72 hours (DELETE every 1h)
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
      // 1. Count events before cleanup
      const beforeResult = await pool.query('SELECT COUNT(*)::int as cnt FROM events');
      const beforeCount = beforeResult.rows[0].cnt;

      // 2. Delete events older than 72 hours
      // Only delete events whose payment_events records are already processed (or no payment linkage)
      const deleteResult = await pool.query(
        `DELETE FROM events
         WHERE created_at < NOW() - INTERVAL '72 hours'
         AND id NOT IN (
           SELECT event_id FROM payment_events
           WHERE event_id IS NOT NULL
         )`
      );

      // 3. Count remaining
      const afterResult = await pool.query('SELECT COUNT(*)::int as cnt FROM events');
      const afterCount = afterResult.rows[0].cnt;

      const duration = Date.now() - startTime;

      if (deleteResult.rowCount && deleteResult.rowCount > 0) {
        logger.info('[cleaner] Cleanup complete', {
          deleted: deleteResult.rowCount,
          remainingAfter: afterCount,
          duration: `${duration}ms`,
        });
      }
    } catch (err: any) {
      logger.error('[cleaner] Cleanup failed', { error: err.message });
    }
  }

  /**
   * Estimate storage used by the events table
   */
  async getStorageStats(): Promise<{
    totalRows: number;
    newestBlock: number;
    oldestBlock: number;
    chains: Record<string, number>;
  }> {
    try {
      const [{ rows: totalRows }, { rows: newest }, { rows: oldest }, { rows: chainRows }] = await Promise.all([
        pool.query('SELECT COUNT(*)::int as cnt FROM events'),
        pool.query('SELECT MAX(block_number)::bigint as max_block FROM events'),
        pool.query('SELECT MIN(block_number)::bigint as min_block FROM events'),
        pool.query(
          'SELECT chain, COUNT(*)::int as cnt FROM events GROUP BY chain ORDER BY cnt DESC'
        ),
      ]);

      const chains: Record<string, number> = {};
      for (const row of chainRows) {
        chains[row.chain] = row.cnt;
      }

      return {
        totalRows: totalRows[0].cnt,
        newestBlock: newest[0].max_block || 0,
        oldestBlock: oldest[0].min_block || 0,
        chains,
      };
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
