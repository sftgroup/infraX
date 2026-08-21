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
   * 数据盘可用空间估算（百分比）。
   * 2026-08-16 M-3 迁移后 PG 位于新机 10.3.8.6，collector 所在机器无本地
   * data_directory，也无到新机的 SSH 免密 → 无法直接 df。
   * 等效信号：events 是数据盘唯一大增长源，用 pg_total_relation_size(events)
   * 估算占用比例（其余库 + WAL + 系统预留由 CLEANER_DISK_CAPACITY_GB 覆盖，
   * 默认按 196G 数据盘口径）。失败返回 100（不触发紧急清理）。
   */
  private async getDiskFreePct(): Promise<number> {
    try {
      const { rows } = await pool.query(`SELECT pg_total_relation_size('events') AS ev_size`);
      const evSize = Number(rows[0]?.ev_size ?? 0);
      const capacity = (parseInt(process.env.CLEANER_DISK_CAPACITY_GB || '196', 10) || 196) * 1024 ** 3;
      if (capacity <= 0 || evSize <= 0) return 100;
      const usedPct = (evSize / capacity) * 100;
      return Math.max(0, 100 - usedPct);
    } catch (err: any) {
      logger.warn('[cleaner] Failed to estimate disk free space', { error: err.message });
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

      // 分区感知清理：events 为分区父表（relkind='p'）时，整分区早于保留窗口
      // 直接 DROP TABLE（物理删除文件，无死元组）；残余行按分区逐批 DELETE。
      // EPF-3（2026-08-22）：分区表路径不再走父表 DELETE——父表 DELETE 需跨分区
      // 扫描路由，20 万批实测 14+ 分钟持锁，曾阻塞新进程 migration（ALTER TABLE
      // 等 AccessExclusiveLock）导致服务启动假死。改为每个子分区本地 DELETE（走
      // 分区内索引，快且锁粒度小）。
      const isPartitioned = await this.isPartitioned();
      if (isPartitioned) {
        const dropped = await this.dropExpiredPartitions(retentionHours);
        deletedTotal += dropped;
        logger.info('[cleaner] Partition-aware cleanup', { droppedPartitions: dropped });

        const boundarySql = `NOW() - INTERVAL '${retentionHours} hours'`;
        for (const part of await this.listPartitions()) {
          const r = await pool.query(
            `DELETE FROM ${part}
             WHERE ctid IN (
               SELECT ctid FROM ${part}
               WHERE collected_at < ${boundarySql}
               LIMIT ${DELETE_BATCH}
             )`
          );
          deletedTotal += r.rowCount ?? 0;
        }
      } else {
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
      }

      // 非 FULL VACUUM：仅普通表需要回收死元组空间；分区表已 DROP 物理回收
      if (deletedTotal > 0 && !isPartitioned) {
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
   * events 是否为分区父表（native partition，relkind='p'）。
   * TimescaleDB hypertable 的 relkind 为 'r'，不会被误判。
   */
  private async isPartitioned(): Promise<boolean> {
    try {
      const { rows } = await pool.query(
        `SELECT c.relkind FROM pg_class c WHERE c.relname = 'events' AND c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema())`
      );
      return rows.length > 0 && rows[0].relkind === 'p';
    } catch {
      return false;
    }
  }

  /**
   * events 的全部子分区名（白名单校验 ^events_p_[0-9]{8}$，防御性防注入）。
   */
  private async listPartitions(): Promise<string[]> {
    const { rows } = await pool.query(
      `SELECT c.relname AS part
         FROM pg_inherits i
         JOIN pg_class c  ON c.oid = i.inhrelid
         JOIN pg_class p  ON p.oid = i.inhparent
         JOIN pg_namespace n ON n.oid = p.relnamespace
        WHERE p.relname = 'events' AND n.nspname = current_schema()`
    );
    return rows
      .map((r: any) => r.part)
      .filter((p: string) => /^events_p_[0-9]{8}$/.test(p));
  }

  /**
   * DROP 整分区早于保留窗口的 events 子分区（物理回收，无死元组）。
   * @returns 删除的分区数
   */
  private async dropExpiredPartitions(retentionHours: number): Promise<number> {
    try {
      const parts = await this.listPartitions();
      if (parts.length === 0) return 0;

      let dropped = 0;
      for (const part of parts) {
        const maxRow = await pool.query(
          `SELECT max(collected_at) AS max_ts FROM ${part}`
        );
        const maxTs: Date | null = maxRow.rows[0]?.max_ts ?? null;
        if (!maxTs) {
          // 空分区不回收：迁移预建的未来分区（events_p_YYYYMMDD）被 DROP 后，
          // collector 写入父表时无分区路由会报 "no partition found for row"。
          // 空分区仅占 32kB，留待有数据后由下方 maxTs 边界判断决定是否回收。
          continue;
        }
        const boundary = new Date(Date.now() - retentionHours * 3_600_000);
        if (maxTs.getTime() < boundary.getTime()) {
          await pool.query(`DROP TABLE IF EXISTS ${part}`);
          dropped++;
          logger.info('[cleaner] Dropped expired partition', { partition: part, maxCollectedAt: maxTs.toISOString() });
        }
      }
      return dropped;
    } catch (err: any) {
      logger.warn('[cleaner] Partition drop failed, falling back to row DELETE', { error: err.message });
      return 0;
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
