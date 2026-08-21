import { pool } from '../database';
import { logger } from '../logger';

/**
 * events 分区父表自动建分区（2026-08-22 磁盘事故修复）
 *
 * 背景：events 为 native partition 父表（RANGE(collected_at)），但代码中无自动建分区
 * 逻辑，分区依赖手工创建；cleaner 每小时按保留窗口 DROP 过期分区。一旦某天分区缺失，
 * collector INSERT 报 "no partition of relation \"events\" found for row" →
 * normalizer 无限重试 → combined.log 刷屏堆满磁盘（曾 9.7G）。
 *
 * 本模块：启动时 + 每小时确保 [今天, 今天+PARTITION_HORIZON_DAYS) 分区存在。
 * - 唯一索引 (event_id, collected_at) 由父表 UNIQUE 约束自动传播到子分区，无需手动建；
 * - 查询索引 _ca / _cb / _ce 与现有分区保持一致；
 * - pg_try_advisory_lock 防多实例并发重复建分区；
 * - 全程幂等（IF NOT EXISTS），失败仅告警不阻断主流程。
 */

const CHECK_INTERVAL_MS = 3_600_000; // 1 hour
// 预建未来分区天数：覆盖 cleaner 72h 保留窗口 + 提前量（默认 6 天）
const HORIZON_DAYS = parseInt(process.env.PARTITION_HORIZON_DAYS || '6', 10);
// 固定 advisory lock key（同一套 PG 内唯一）
const PARTITION_LOCK_KEY = 8150001;

function formatDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

export class EventPartitionManager {
  private timer: NodeJS.Timeout | null = null;
  private ensuring = false;
  private horizonDays: number;

  constructor(horizonDays: number = HORIZON_DAYS) {
    this.horizonDays = horizonDays;
  }

  start(): void {
    logger.info('[partition] Event partition manager started', { horizonDays: this.horizonDays, interval: '1h' });
    this.ensurePartitions().catch((e: any) => {
      logger.error('[partition] Initial ensure failed', { error: e.message });
    });
    this.timer = setInterval(() => {
      this.ensurePartitions().catch((e: any) => {
        logger.error('[partition] Ensure failed', { error: e.message });
      });
    }, CHECK_INTERVAL_MS);
    if (this.timer && 'unref' in this.timer) {
      this.timer.unref?.();
    }
  }

  shutdown(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * 确保未来 HORIZON_DAYS 天的 events 分区存在。
   * @returns 新建的分区数
   */
  async ensurePartitions(): Promise<number> {
    if (this.ensuring) return 0; // 防重叠
    this.ensuring = true;
    const startTime = Date.now();
    try {
      // 1. events 必须是分区父表（relkind='p'）才处理；普通表（未迁移）直接跳过
      const rel = await pool.query(
        `SELECT c.relkind FROM pg_class c
          WHERE c.relname = 'events'
            AND c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema())`
      );
      const relkind = rel.rows[0]?.relkind;
      if (relkind !== 'p') {
        logger.debug('[partition] events is not partitioned, skip');
        return 0;
      }

      // 2. 并发防护：多实例同时建分区会冲突（CREATE TABLE IF NOT EXISTS ... PARTITION OF
      //    在 PG14 并发下仍可能抛 duplicate），try lock 失败则本轮跳过
      const locked = await pool
        .query(`SELECT pg_try_advisory_lock(${PARTITION_LOCK_KEY}) AS ok`)
        .then((r) => r.rows[0]?.ok === true)
        .catch(() => false);
      if (!locked) {
        logger.warn('[partition] Advisory lock busy, skip this round');
        return 0;
      }

      try {
        // 3. 已存在的子分区名集合
        const { rows } = await pool.query(
          `SELECT c.relname AS part
             FROM pg_inherits i
             JOIN pg_class c  ON c.oid = i.inhrelid
             JOIN pg_class p  ON p.oid = i.inhparent
             JOIN pg_namespace n ON n.oid = p.relnamespace
            WHERE p.relname = 'events' AND n.nspname = current_schema()`
        );
        const existing = new Set(rows.map((r: any) => r.part));

        // 4. 补齐缺失的未来分区（含查询索引；唯一索引由父表约束自动传播）
        const today = new Date();
        let created = 0;
        for (let i = 0; i < this.horizonDays; i++) {
          const d = new Date(today);
          d.setDate(today.getDate() + i);
          const pname = `events_p_${formatDay(d)}`;
          if (existing.has(pname)) continue;

          const fromDay = formatDay(d);
          const nextDay = formatDay(new Date(d.getTime() + 86_400_000));
          await pool.query(
            `CREATE TABLE IF NOT EXISTS ${pname} PARTITION OF events
               FOR VALUES FROM ('${fromDay} 00:00:00') TO ('${nextDay} 00:00:00')`
          );
          await pool.query(`CREATE INDEX IF NOT EXISTS ${pname}_ca ON ${pname} USING btree (collected_at)`);
          await pool.query(`CREATE INDEX IF NOT EXISTS ${pname}_cb ON ${pname} USING btree (chain, block_number DESC)`);
          await pool.query(`CREATE INDEX IF NOT EXISTS ${pname}_ce ON ${pname} USING btree (chain, event_type)`);
          created++;
          logger.info('[partition] Created event partition', { partition: pname });
        }

        if (created > 0) {
          logger.info('[partition] Partitions ensured', {
            created,
            duration: `${Date.now() - startTime}ms`,
          });
        }
        return created;
      } finally {
        await pool.query(`SELECT pg_advisory_unlock(${PARTITION_LOCK_KEY})`).catch(() => {});
      }
    } catch (err: any) {
      logger.error('[partition] Ensure partitions failed', { error: err.message });
      return 0;
    } finally {
      this.ensuring = false;
    }
  }
}

// Singleton
let partitionManagerInstance: EventPartitionManager | null = null;

export function getPartitionManager(): EventPartitionManager {
  if (!partitionManagerInstance) {
    partitionManagerInstance = new EventPartitionManager();
  }
  return partitionManagerInstance;
}
