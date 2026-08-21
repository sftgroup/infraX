import { Pool } from 'pg';
import { config } from './config';
import { logger } from './logger';

export const pool = new Pool({
  connectionString: config.databaseUrl,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  // EPF-7（2026-08-22）：启用 TCP keepalive。进程异常退出时 PG 能尽快感知断连，
  // 避免孤儿后端继续执行慢查询持锁阻塞（曾两次因孤儿父表 DELETE 阻塞新进程 migration）。
  keepAlive: true,
  keepAliveInitialDelayMillis: 30000,
});

pool.on('error', (err) => {
  logger.error('Unexpected database pool error', { error: err.message });
});
