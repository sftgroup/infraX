import winston from 'winston';
import { config } from './config';

/**
 * 高频重复日志限流（2026-08-22 磁盘事故防线 2）
 *
 * 事故背景：events 分区缺失时 normalizer 对每条失败事件打一条
 * '[normalizer] Failed to insert event'（message+error 完全相同），
 * 每秒刷屏数十~数百条 → combined.log 单日 9.7G 撑满磁盘。
 *
 * 机制：按 `level:message:error.message` 分组，每个 10s 窗口内同一分组只放行
 * 第一条，其余抑制；窗口放行的首条附带 `_suppressed`（上一窗口被抑制条数），
 * 既保证日志有界，又不丢失"某错误正在高频发生"的可观测性。
 */

export const RATE_WINDOW_MS = 10_000;

interface RateEntry {
  windowStart: number;
  suppressed: number;
  prevSuppressed: number;
  passed: number;
}

const rateCache = new Map<string, RateEntry>();

/**
 * 限流判定（纯函数，便于单测）。
 * @returns 放行时返回 info（可附带 _suppressed），抑制时返回 false。
 */
export function rateLimitInfo(
  info: any,
  now: number = Date.now(),
  windowMs: number = RATE_WINDOW_MS
): any | false {
  const key = `${info.level}:${info.message}:${(info.error && info.error.message) || ''}`;
  let entry = rateCache.get(key);
  if (!entry) {
    entry = { windowStart: now, suppressed: 0, prevSuppressed: 0, passed: 0 };
    rateCache.set(key, entry);
  } else if (now - entry.windowStart >= windowMs) {
    // 进入新窗口：上一窗口抑制数结转，窗口重置
    entry.prevSuppressed = entry.suppressed;
    entry.suppressed = 0;
    entry.passed = 0;
    entry.windowStart = now;
  }

  if (entry.passed === 0) {
    entry.passed++;
    if (entry.prevSuppressed > 0) {
      info._suppressed = entry.prevSuppressed;
    }
    entry.prevSuppressed = 0;
    return info;
  }
  entry.suppressed++;
  return false;
}

const rateLimitFormat = winston.format((info) => rateLimitInfo(info))();

// 定期清理过期分组，防止 Map 无限增长（不同 key 有限，兜底清理）
const cleanupTimer = setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS * 2;
  for (const [k, v] of rateCache) {
    if (v.windowStart < cutoff) rateCache.delete(k);
  }
}, 60_000);
if (cleanupTimer && 'unref' in cleanupTimer) cleanupTimer.unref?.();

export function __resetRateCacheForTest(): void {
  rateCache.clear();
}

export const logger = winston.createLogger({
  level: config.logLevel,
  format: winston.format.combine(
    rateLimitFormat,
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'infrax-backend' },
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ timestamp, level, message, ...meta }) => {
          const metaStr = Object.keys(meta).length > 1
            ? ` ${JSON.stringify(meta, null, 0)}`
            : '';
          return `${timestamp} [${level}]: ${message}${metaStr}`;
        })
      ),
    }),
    new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
    new winston.transports.File({ filename: 'logs/combined.log' }),
  ],
});
