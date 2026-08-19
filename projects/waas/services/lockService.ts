import { pool } from '../models/database';
import { logger } from '../utils/logger';

/**
 * W-9: 分布式锁（PG advisory lock，多实例防重复执行，无额外依赖）。
 *
 * 用 PostgreSQL `pg_try_advisory_lock(int8)` 实现跨实例互斥：
 *   - 抢到锁 → 执行 fn → 释放锁；
 *   - 抢不到 → 返回 null（另一实例正在执行），不阻塞。
 * 连接随 client.release() 归还连接池；锁先显式释放再归还，避免会话残留。
 */

function hashKey(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) & 0x7fffffff;
  }
  return h === 0 ? 1 : h;
}

/**
 * 在锁内执行 fn。抢锁失败返回 null；执行期间抛错向上传递（finally 中释放锁）。
 */
export async function withLock<T>(
  name: string,
  fn: () => Promise<T>,
  _timeoutMs = 60000
): Promise<T | null> {
  const client = await pool.connect();
  const key = hashKey(name);
  try {
    const res = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [key]);
    if (!res.rows[0]?.locked) {
      logger.debug('Distributed lock busy, skipping', { name });
      return null;
    }
    logger.debug('Distributed lock acquired', { name });
    try {
      return await fn();
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [key]).catch((err: any) => {
        logger.warn('Failed to release advisory lock', { name, error: err.message });
      });
    }
  } finally {
    client.release();
  }
}
