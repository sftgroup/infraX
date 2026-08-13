import { execFile } from 'child_process';
import { promisify } from 'util';
import { pool } from '../database';
import { logger } from '../logger';

const execFileAsync = promisify(execFile);

/**
 * Data Cleaner
 *
 * events 是普通表（TimescaleDB 扩展未安装，drop_chunks 不可用），
 * 改为分批 DELETE + VACUUM 保留策略：
 *  - 分批 DELETE 控制事务长度与锁粒度（每批 20 万行）
 *  - 非 FULL VACUUM：回收死元组空间供复用（不锁表、无需额外磁盘空间；
 *    VACUUM FULL 需要与表等大的临时空间，本盘不适用）
 *
 * Retention policy:
 *  - events: 默认 3 天（CLEANER_RETENTION_HOURS 可覆盖；2026-08-13 前为 7 天，
 *    实测写入约 30GB/天，7 天数据超出 196G 数据盘容量 → 降为 72h）
 *  - 磁盘守卫：数据盘可用空间 < 15% 时本轮强制按 24h 紧急保留清理，防再次堆满
 *  - payment_events: permanent (never deleted)
 *  - event_checkpoints: permanent
 */

const CLEANUP_INTERVAL_MS = 3_600_000; // 1 hour
const RETENTION_HOURS = parseInt(process.env.CLEANER_RETENTION_HOURS || '72', 10); // 保留 3 天
const EMERGENCY_RETENTION_HOURS = 24; // 磁盘紧张时的紧急保留窗口
const DISK_FREE_WARN_PCT = 15; // 数据盘可用空间低于该比例触发紧急清理
const DELETE_BATCH = 200_000; // 每批行数（控制锁粒度）
const MAX_BATCHES_PER_RUN = 20; // 单轮最多 400 万行，避免占用过久

export class DataCleaner {
  private timer: NodeJS.Timeout | null = null;

  private cleaning = false;

  start(): void {
    logger.info('[cleaner] Data Cleaner started', {
      interval: '1h',
      retention: `${RETENTION_HOURS}h`,
      emergencyRetention: `${EMERGENCY_RETENTION_HOURS}h`,
      diskFreeWarnPct: DISK_FREE_WARN_PCT,
      method: 'batch DELETE + VACUUM',
    });

    // Run immediately on startup, then every hour
    this.runCleanup();
    this.timer = setInterval(() => this.runCleanup(), CLEANUP_INTERVAL_MS);

    if (this.timer && 'unref' in this.timer) {
      this.timer.unref?.();
    }
  }

  /**
   * 数据盘（PG data_directory 所在挂载点）可用空间百分比；
   * 失败时返回 100（不触发紧急清理，避免误伤）。
   */
  private async getDiskFreePct(): Promise<number> {
    try {
      const { rows } = await pool.query(`SELECT current_setting('data_directory') AS dir`);
      const dir: string | undefined = rows[0]?.dir;
      if (!dir) return 100;
      const { stdout } = await execFileAsync('df', ['-P', dir]);
      const line = stdout.trim().split('\n').pop() ?? '';
      const parts = line.split(/\s+/);
      // df -P 输出: Filesystem 1024-blocks Used Available Capacity Mounted on
      const usedPct = parseInt(parts[4], 10); // 例如 "85%"
      return Number.isFinite(usedPct) ? 100 - usedPct : 100;
    } catch (err: any) {
      logger.warn('[cleaner] Failed to probe disk free space', { error: err.message });
      return 100;
    }
  }

  async runCleanup(): Promise<void> {
    if (this.cleaning) return; // 防重叠：上一轮未结束时跳过

    this.cleaning = true;
    const startTime = Date.now();
    let deletedTotal = 0;

    try {
      // 磁盘守卫：可用空间不足时临时收紧保留窗口，防止事件表再次堆满数据盘
      const diskFreePct = await this.getDiskFreePct();
      const retentionHours =
        diskFreePct < DISK_FREE_WARN_PCT ? EMERGENCY_RETENTION_HOURS : RETENTION_HOURS;

      if (retentionHours !== RETENTION_HOURS) {
        logger.warn('[cleaner] Disk nearly full, using emergency retention', {
          diskFreePct: `${diskFreePct.toFixed(1)}%`,
          retentionHours,
        });
      }

      for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch++) {
        // 分批 DELETE：PG 的 DELETE 不支持 LIMIT，用 ctid 子查询控制每批行数
        const result = await pool.query(
          `DELETE FROM events
           WHERE ctid IN (
             SELECT ctid FROM events
             WHERE collected_at < NOW() - INTERVAL '${retentionHours} hours'
             LIMIT ${DELETE_BATCH}
           )`
        );
        const deleted = result.rowCount ?? 0;
        deletedTotal += deleted;

        if (deleted === 0) break; // 没有更老的数据了
      }

      // 非 FULL VACUUM：回收死元组空间（不锁表、不占用额外磁盘空间）
      if (deletedTotal > 0) {
        await pool.query('VACUUM events');
      }

      const duration = Date.now() - startTime;
      logger.info('[cleaner] Cleanup finished', {
        deleted: deletedTotal,
        retentionHours,
        diskFreePct: `${diskFreePct.toFixed(1)}%`,
        duration: `${duration}ms`,
      });
    } catch (err: any) {
      logger.error('[cleaner] Cleanup failed', { error: err.message });
    } finally {
      this.cleaning = false;
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
