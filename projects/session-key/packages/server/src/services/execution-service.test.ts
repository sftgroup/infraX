import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Errors } from '@0xinfrax/session-key-core';
import { ExecutionService } from './execution-service.js';
import type { SessionKey } from '@0xinfrax/session-key-core';

// ── MQ-5：Session Key 执行/额度/过期 集成测试（mock adapter + in-memory repo）──

function makeSession(overrides: Partial<SessionKey> = {}): SessionKey {
  return {
    id: 'ses_1',
    userId: 'user_1',
    chain: 'sepolia',
    sessionAddress: '0xSessionKeyAddress00000000000000000000000000001',
    sessionKeyEnc: 'enc:1',
    validFrom: new Date(Date.now() - 60_000),
    validUntil: new Date(Date.now() + 3_600_000),
    permissions: { contracts: ['0xContract000000000000000000000000000000000001'], functions: [] },
    maxPerTx: '0.05',
    maxTotal: '0.1',
    totalSpent: '0',
    status: 'active',
    createdAt: new Date(),
    revokedAt: null,
    ...overrides,
  };
}

function makeAdapter(overrides: Partial<ReturnType<typeof makeAdapterShape>> = {}) {
  return {
    decryptKey: vi.fn(() => '0xpriv'),
    signAndBroadcast: vi.fn(async () => ({ txHash: '0xabc', success: true, gasUsed: '21000' })),
    ...overrides,
  } as any;
}

function makeAdapterShape() { return { decryptKey: vi.fn(), signAndBroadcast: vi.fn() }; }

function makeHarness(overrides: { session?: SessionKey | null; repoOverrides?: any; adapter?: any } = {}) {
  const sessions = new Map<string, SessionKey>();
  const session = overrides.session === undefined ? makeSession() : overrides.session;
  if (session) sessions.set(session.id, session);

  const sessionRepo = {
    findById: vi.fn(async (id: string) => sessions.get(id) || null),
    updateStatus: vi.fn(async (id: string, status: any) => {
      const s = sessions.get(id);
      if (s) { s.status = status; sessions.set(id, s); }
    }),
    addSpent: vi.fn(async (id: string, amount: string) => {
      const s = sessions.get(id);
      if (s) { s.totalSpent = String(parseFloat(s.totalSpent || '0') + parseFloat(amount)); sessions.set(id, s); }
    }),
    expireStale: vi.fn(async () => 0),
    ...overrides.repoOverrides,
  };
  const executionRepo = { insert: vi.fn(async () => ({})) } as any;
  const redis = {
    set: vi.fn(async () => 'OK'),
    del: vi.fn(async () => 1),
  } as any;
  const adapter = overrides.adapter || makeAdapter();
  const svc = new ExecutionService(sessionRepo as any, executionRepo, adapter, redis);
  return { svc, sessionRepo, executionRepo, adapter, sessions, redis };
}

const execParams = {
  sessionId: 'ses_1',
  chain: 'sepolia' as const,
  to: '0xContract000000000000000000000000000000000001',
  data: '0x',
  value: '10000000000000000', // 0.01 ETH (wei)
};

describe('ExecutionService.execute — 执行路径', () => {
  beforeEach(() => vi.clearAllMocks());

  it('成功路径：签名广播 + 记账 + 返回 executionId', async () => {
    const { svc, sessionRepo, executionRepo, adapter, sessions } = makeHarness();
    const res = await svc.execute(execParams);
    expect(adapter.signAndBroadcast).toHaveBeenCalledTimes(1);
    expect(executionRepo.insert).toHaveBeenCalled();
    expect(sessionRepo.addSpent).toHaveBeenCalledWith('ses_1', '0.010000000000000000');
    expect(sessions.get('ses_1')!.totalSpent).toBe('0.01');
    expect(res.txHash).toBe('0xabc');
    expect(res.status).toBe('success');
    expect(res.executionId).toBeTruthy();
  });

  it('不存在的 session → SESSION_NOT_FOUND', async () => {
    const { svc, adapter } = makeHarness({ session: null });
    await expect(svc.execute(execParams)).rejects.toMatchObject({ errorCode: Errors.SESSION_NOT_FOUND.code });
    expect(adapter.signAndBroadcast).not.toHaveBeenCalled();
  });

  it('status=expired → SESSION_EXPIRED（不做额外调用）', async () => {
    const { svc, sessionRepo, adapter } = makeHarness({ session: makeSession({ status: 'expired' }) });
    await expect(svc.execute(execParams)).rejects.toMatchObject({ errorCode: Errors.SESSION_EXPIRED.code });
    expect(adapter.signAndBroadcast).not.toHaveBeenCalled();
  });

  it('status=revoked → SESSION_REVOKED', async () => {
    const { svc, adapter } = makeHarness({ session: makeSession({ status: 'revoked' }) });
    await expect(svc.execute(execParams)).rejects.toMatchObject({ errorCode: Errors.SESSION_REVOKED.code });
    expect(adapter.signAndBroadcast).not.toHaveBeenCalled();
  });

  it('status=quota_exhausted → QUOTA_EXHAUSTED', async () => {
    const { svc, adapter } = makeHarness({ session: makeSession({ status: 'quota_exhausted' }) });
    await expect(svc.execute(execParams)).rejects.toMatchObject({ errorCode: Errors.QUOTA_EXHAUSTED.code });
    expect(adapter.signAndBroadcast).not.toHaveBeenCalled();
  });
});

describe('ExecutionService.execute — 额度三重校验（MQ-4/MQ-5）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('validUntil 已过 → 置 expired 并抛 SESSION_EXPIRED', async () => {
    const { svc, sessionRepo, adapter } = makeHarness({
      session: makeSession({ validUntil: new Date(Date.now() - 1000) }),
    });
    await expect(svc.execute(execParams)).rejects.toMatchObject({ errorCode: Errors.SESSION_EXPIRED.code });
    expect(sessionRepo.updateStatus).toHaveBeenCalledWith('ses_1', 'expired');
    expect(adapter.signAndBroadcast).not.toHaveBeenCalled();
  });

  it('value 超 maxPerTx → PER_TX_EXCEEDED', async () => {
    // 0.06 ETH > maxPerTx 0.05
    const { svc, adapter } = makeHarness();
    await expect(svc.execute({ ...execParams, value: '60000000000000000' }))
      .rejects.toMatchObject({ errorCode: Errors.PER_TX_EXCEEDED.code });
    expect(adapter.signAndBroadcast).not.toHaveBeenCalled();
  });

  it('totalSpent + value 超 maxTotal → 置 quota_exhausted 并抛 QUOTA_EXHAUSTED', async () => {
    // totalSpent=0.095 + 0.01 > maxTotal 0.1
    const { svc, sessionRepo, adapter } = makeHarness({
      session: makeSession({ totalSpent: '0.095' }),
    });
    await expect(svc.execute(execParams)).rejects.toMatchObject({ errorCode: Errors.QUOTA_EXHAUSTED.code });
    expect(sessionRepo.updateStatus).toHaveBeenCalledWith('ses_1', 'quota_exhausted');
    expect(adapter.signAndBroadcast).not.toHaveBeenCalled();
  });

  it('连续执行累计记账：第二次执行触发 QUOTA_EXHAUSTED', async () => {
    const { svc, adapter, sessions } = makeHarness({ session: makeSession({ totalSpent: '0.09' }) });
    await svc.execute(execParams); // 0.09 + 0.01 → 0.099999…（浮点边界 ≤ 0.1，首次放行）
    await expect(svc.execute(execParams)).rejects.toMatchObject({ errorCode: Errors.QUOTA_EXHAUSTED.code });
    expect(adapter.signAndBroadcast).toHaveBeenCalledTimes(1);
  });

  it('交易失败（success=false）不记账', async () => {
    const { svc, sessionRepo, adapter } = makeHarness({
      adapter: makeAdapter({ signAndBroadcast: vi.fn(async () => ({ txHash: '', success: false, reason: 'reverted' })) }),
    });
    const res = await svc.execute(execParams);
    expect(res.status).toBe('failed');
    expect(sessionRepo.addSpent).not.toHaveBeenCalled();
  });
});

describe('SessionRepo.expireStale — 过期清理（MQ-4/MQ-5）', () => {
  it('将过期 active session 置为 expired 并返回清理行数', async () => {
    const rows = new Map<string, SessionKey>();
    rows.set('old', makeSession({ id: 'old', validUntil: new Date(Date.now() - 1000) }));
    rows.set('fresh', makeSession({ id: 'fresh', validUntil: new Date(Date.now() + 3600_000) }));

    const expireStale = vi.fn(async () => {
      let n = 0;
      for (const [id, s] of rows) {
        if (s.status === 'active' && new Date(s.validUntil).getTime() < Date.now()) {
          s.status = 'expired'; rows.set(id, s); n++;
        }
      }
      return n;
    });

    const n = await expireStale();
    expect(n).toBe(1);
    expect(rows.get('old')!.status).toBe('expired');
    expect(rows.get('fresh')!.status).toBe('active');
    expect(expireStale).toHaveBeenCalled();
  });
});
