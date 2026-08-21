/**
 * DataCleaner 单测（EPF-3，2026-08-22）。
 * 重点：分区表路径走 DROP 过期分区 + 分区级 DELETE（不再对父表 DELETE，杜绝慢查询持锁）。
 */
import { pool } from '../src/database';
import { DataCleaner } from '../src/services/cleaner';

jest.mock('../src/database', () => ({
  pool: { query: jest.fn() },
}));

const mockQuery = pool.query as jest.Mock;

interface MockOpts {
  relkind?: string;
  partitions?: string[];
  maxTs?: string | null; // 分区 max(collected_at) 值；null 表示空分区
  rows?: number;
}

function setup(opts: MockOpts = {}) {
  mockQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('pg_total_relation_size')) {
      return { rows: [{ ev_size: 100 * 1024 ** 2 }] }; // 100MB → diskFreePct≈99.95 → 常规 72h 保留
    }
    if (sql.includes('pg_class') && sql.includes('relkind')) {
      return { rows: [{ relkind: opts.relkind ?? 'p' }] };
    }
    if (sql.includes('pg_inherits')) {
      return { rows: (opts.partitions ?? ['events_p_20260822']).map((p) => ({ part: p })) };
    }
    if (sql.includes('max(collected_at)')) {
      return { rows: [{ max_ts: opts.maxTs ? new Date(opts.maxTs) : null }] };
    }
    if (sql.includes('DROP TABLE')) {
      return { rowCount: 1 };
    }
    if (sql.includes('DELETE FROM')) {
      return { rowCount: opts.rows ?? 1 };
    }
    if (sql.includes('VACUUM')) {
      return { rowCount: 0 };
    }
    throw new Error(`unexpected sql: ${sql}`);
  });
}

const queries = (): string[] => mockQuery.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(new Date('2026-08-22T10:00:00Z'));
});

afterEach(() => {
  jest.useRealTimers();
  mockQuery.mockReset();
});

describe('DataCleaner.runCleanup（分区表路径）', () => {
  it('过期分区（max < 72h 边界）被 DROP，剩余分区走分区级 DELETE，无父表 DELETE', async () => {
    // 8/22 10:00 - 72h = 8/19 10:00；8/19 分区 max=8/19 09:00（过期）→ DROP；
    // 8/20 分区 max=8/20 23:00（保留）→ 分区级 DELETE
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('max(collected_at)') && sql.includes('events_p_20260819')) {
        return { rows: [{ max_ts: new Date('2026-08-19T09:00:00Z') }] };
      }
      if (sql.includes('max(collected_at)') && sql.includes('events_p_20260820')) {
        return { rows: [{ max_ts: new Date('2026-08-20T23:00:00Z') }] };
      }
      if (sql.includes('pg_total_relation_size')) return { rows: [{ ev_size: 100 * 1024 ** 2 }] };
      if (sql.includes('pg_class') && sql.includes('relkind')) return { rows: [{ relkind: 'p' }] };
      if (sql.includes('pg_inherits')) return { rows: [{ part: 'events_p_20260819' }, { part: 'events_p_20260820' }] };
      if (sql.includes('DROP TABLE')) return { rowCount: 1 };
      if (sql.includes('DELETE FROM')) return { rowCount: 0 };
      throw new Error(`unexpected sql: ${sql}`);
    });

    await new DataCleaner().runCleanup();

    const q = queries();
    // DROP 仅针对过期分区 8/19
    expect(q.filter((s) => s.includes('DROP TABLE'))).toEqual(['DROP TABLE IF EXISTS events_p_20260819']);
    // 分区级 DELETE：对保留分区执行，绝无父表 events DELETE
    const del = q.filter((s) => s.includes('DELETE FROM'));
    expect(del.length).toBeGreaterThan(0);
    expect(del.every((s) => /^DELETE FROM events_p_[0-9]{8}/.test(s))).toBe(true);
    expect(q.some((s) => s.includes('VACUUM'))).toBe(false); // 分区表不 VACUUM
  });

  it('空分区不 DROP（防止未来分区被删后写入无路由）', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('max(collected_at)')) return { rows: [{ max_ts: null }] };
      if (sql.includes('pg_total_relation_size')) return { rows: [{ ev_size: 100 * 1024 ** 2 }] };
      if (sql.includes('pg_class') && sql.includes('relkind')) return { rows: [{ relkind: 'p' }] };
      if (sql.includes('pg_inherits')) return { rows: [{ part: 'events_p_20260822' }] };
      if (sql.includes('DELETE FROM')) return { rowCount: 0 };
      throw new Error(`unexpected sql: ${sql}`);
    });

    await new DataCleaner().runCleanup();
    expect(queries().some((s) => s.includes('DROP TABLE'))).toBe(false);
  });

  it('恶意/非标准分区名被白名单过滤，不参与任何 DDL/DML', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('max(collected_at)')) return { rows: [{ max_ts: new Date('2026-08-01T00:00:00Z') }] };
      if (sql.includes('pg_total_relation_size')) return { rows: [{ ev_size: 100 * 1024 ** 2 }] };
      if (sql.includes('pg_class') && sql.includes('relkind')) return { rows: [{ relkind: 'p' }] };
      if (sql.includes('pg_inherits')) return { rows: [{ part: 'events_p_20260820' }, { part: 'evil; DROP TABLE users' }] };
      if (sql.includes('DROP TABLE')) return { rowCount: 1 };
      if (sql.includes('DELETE FROM')) return { rowCount: 0 };
      throw new Error(`unexpected sql: ${sql}`);
    });

    await new DataCleaner().runCleanup();
    const q = queries().join('\n');
    expect(q).not.toContain('evil');
    expect(q).toContain('events_p_20260820');
  });
});

describe('DataCleaner.runCleanup（普通表路径）', () => {
  it('relkind=r 时走父表分批 DELETE（每批 20 万，命中 0 行即停）', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_total_relation_size')) return { rows: [{ ev_size: 100 * 1024 ** 2 }] };
      if (sql.includes('pg_class') && sql.includes('relkind')) return { rows: [{ relkind: 'r' }] };
      if (sql.includes('DELETE FROM events')) return { rowCount: 0 };
      if (sql.includes('VACUUM')) return { rowCount: 0 };
      throw new Error(`unexpected sql: ${sql}`);
    });

    await new DataCleaner().runCleanup();
    const q = queries();
    expect(q.some((s) => /DELETE FROM events\s+WHERE/.test(s))).toBe(true);
    // 无 DROP TABLE
    expect(q.some((s) => s.includes('DROP TABLE'))).toBe(false);
  });
});
