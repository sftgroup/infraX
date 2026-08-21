/**
 * EventPartitionManager 单测（2026-08-22 磁盘事故修复）。
 * 全部通过 mock pg pool 验证：非分区表跳过、缺失分区补齐、幂等、并发锁、异常兜底。
 */
import { pool } from '../src/database';
import { EventPartitionManager } from '../src/services/partitionManager';

jest.mock('../src/database', () => ({
  pool: { query: jest.fn() },
}));

const mockQuery = pool.query as jest.Mock;

function setup(opts: { relkind?: string; partitions?: string[]; lockOk?: boolean } = {}) {
  mockQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('pg_class') && sql.includes('relkind')) {
      return { rows: [{ relkind: opts.relkind ?? 'p' }] };
    }
    if (sql.includes('pg_try_advisory_lock')) {
      return { rows: [{ ok: opts.lockOk ?? true }] };
    }
    if (sql.includes('pg_inherits')) {
      return { rows: (opts.partitions ?? []).map((p) => ({ part: p })) };
    }
    if (sql.includes('pg_advisory_unlock')) {
      return { rows: [] };
    }
    if (sql.includes('CREATE TABLE') || sql.includes('CREATE INDEX')) {
      return { rows: [] };
    }
    throw new Error(`unexpected sql: ${sql}`);
  });
}

const createdPartitions = (): string[] =>
  mockQuery.mock.calls
    .map((c) => String(c[0]))
    .filter((sql) => sql.includes('PARTITION OF events'))
    .map((sql) => sql.match(/CREATE TABLE IF NOT EXISTS (\w+)/)?.[1])
    .filter(Boolean) as string[];

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(new Date('2026-08-22T10:00:00Z'));
});

afterEach(() => {
  jest.useRealTimers();
  mockQuery.mockReset();
});

describe('EventPartitionManager.ensurePartitions', () => {
  it('events 非分区父表（relkind=r）时直接跳过，不创建任何分区', async () => {
    setup({ relkind: 'r' });
    const created = await new EventPartitionManager(6).ensurePartitions();
    expect(created).toBe(0);
    expect(createdPartitions()).toHaveLength(0);
  });

  it('补齐缺失的未来分区：每个分区建表 + 3 个查询索引', async () => {
    setup({ relkind: 'p', partitions: [] });
    const created = await new EventPartitionManager(3).ensurePartitions();

    expect(created).toBe(3);
    expect(createdPartitions()).toEqual([
      'events_p_20260822',
      'events_p_20260823',
      'events_p_20260824',
    ]);

    // 每个分区都建 _ca / _cb / _ce 索引（6 天 horizon 内 3 天全建）
    const indexCalls = mockQuery.mock.calls.map((c) => String(c[0])).filter((s) => s.includes('CREATE INDEX'));
    expect(indexCalls).toHaveLength(9);
    expect(indexCalls.some((s) => s.includes('events_p_20260822_ca') && s.includes('USING btree (collected_at)'))).toBe(true);
    expect(indexCalls.some((s) => s.includes('events_p_20260823_cb') && s.includes('(chain, block_number DESC)'))).toBe(true);
    expect(indexCalls.some((s) => s.includes('events_p_20260824_ce') && s.includes('(chain, event_type)'))).toBe(true);
  });

  it('已存在的分区被跳过，只创建缺失的', async () => {
    setup({ relkind: 'p', partitions: ['events_p_20260822', 'events_p_20260823'] });
    const created = await new EventPartitionManager(3).ensurePartitions();

    expect(created).toBe(1);
    expect(createdPartitions()).toEqual(['events_p_20260824']);
  });

  it('并发防护：advisory lock 未获取到时本轮跳过', async () => {
    setup({ relkind: 'p', partitions: [], lockOk: false });
    const created = await new EventPartitionManager(3).ensurePartitions();

    expect(created).toBe(0);
    expect(createdPartitions()).toHaveLength(0);
  });

  it('重复调用幂等：第二次无新分区可建', async () => {
    setup({ relkind: 'p', partitions: [] });
    const mgr = new EventPartitionManager(2);
    expect(await mgr.ensurePartitions()).toBe(2);

    // 第二次调用时"已有"分区需包含第一次创建的（模拟真实库状态）；清历史只统计本轮
    mockQuery.mockClear();
    setup({ relkind: 'p', partitions: ['events_p_20260822', 'events_p_20260823'] });
    expect(await mgr.ensurePartitions()).toBe(0);
    expect(createdPartitions()).toHaveLength(0);
  });

  it('数据库异常时不抛出，返回 0', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection refused'));
    const created = await new EventPartitionManager(3).ensurePartitions();
    expect(created).toBe(0);
  });
});
