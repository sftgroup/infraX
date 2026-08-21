/**
 * logger 高频重复日志限流单测（2026-08-22 磁盘事故防线 2）。
 */
import { rateLimitInfo, __resetRateCacheForTest, RATE_WINDOW_MS } from '../src/logger';

const makeInfo = (message: string, error?: string, level = 'warn') =>
  ({ level, message, error: error ? { message: error } : undefined });

beforeEach(() => {
  __resetRateCacheForTest();
});

describe('rateLimitInfo', () => {
  it('同一分组首条放行，后续抑制（返回 false）', () => {
    const info = makeInfo('[normalizer] Failed to insert event', 'no partition found');
    expect(rateLimitInfo(info, 1000)).toBe(info);
    expect(rateLimitInfo(makeInfo('[normalizer] Failed to insert event', 'no partition found'), 1001)).toBe(false);
    expect(rateLimitInfo(makeInfo('[normalizer] Failed to insert event', 'no partition found'), 1002)).toBe(false);
  });

  it('不同 message 或不同 error 互不影响', () => {
    const a = makeInfo('[normalizer] Failed to insert event', 'no partition found');
    const b = makeInfo('[scanner] Sync progress', undefined, 'info');
    expect(rateLimitInfo(a, 1000)).toBe(a);
    expect(rateLimitInfo(b, 1001)).toBe(b); // 不同 key 放行
    // 同 message 不同 error：各自独立放行
    const c = makeInfo('[normalizer] Failed to insert event', 'connection refused');
    expect(rateLimitInfo(c, 1002)).toBe(c);
  });

  it('窗口滚动后重新放行，并附带上一窗口被抑制计数', () => {
    const msg = makeInfo('[normalizer] Failed to insert event', 'no partition found');
    expect(rateLimitInfo(msg, 1000)).toBe(msg);
    expect(rateLimitInfo(makeInfo('[normalizer] Failed to insert event', 'no partition found'), 1005)).toBe(false);
    expect(rateLimitInfo(makeInfo('[normalizer] Failed to insert event', 'no partition found'), 1009)).toBe(false);

    // 窗口结束（1000 + RATE_WINDOW_MS），下一条重新放行且 _suppressed=2
    const next = makeInfo('[normalizer] Failed to insert event', 'no partition found');
    const res = rateLimitInfo(next, 1000 + RATE_WINDOW_MS + 1);
    expect(res).toBe(next);
    expect(res._suppressed).toBe(2);
  });

  it('窗口内被抑制的条数计入下一条放行日志', () => {
    const msg = makeInfo('fixed-error', 'boom');
    rateLimitInfo(msg, 0);
    for (let i = 1; i <= 50; i++) {
      expect(rateLimitInfo(makeInfo('fixed-error', 'boom'), i)).toBe(false);
    }
    const res = rateLimitInfo(makeInfo('fixed-error', 'boom'), RATE_WINDOW_MS);
    expect(res._suppressed).toBe(50);
  });

  it('正常低频日志不受影响', () => {
    for (let i = 0; i < 5; i++) {
      const info = makeInfo(`block ${i} scanned`, undefined, 'info');
      expect(rateLimitInfo(info, 1000 + i)).toBe(info);
    }
  });
});
