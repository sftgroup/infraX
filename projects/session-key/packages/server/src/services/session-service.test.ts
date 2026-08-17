import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Errors } from '@0xinfrax/session-key-core';
import { generateSessionKey } from '@0xinfrax/session-key-evm';
import { SessionService } from './session-service.js';

// ── SK-3：会话创建/撤销单测（mock repo + mock adapter；A-16 客户端提交 keypair）──

const USER = '0xUserMainWallet000000000000000000000000000001';

function makeKeypair() {
  const kp = generateSessionKey();
  return { publicKey: kp.address, privateKey: kp.privateKey };
}

function makeAdapter(overrides: Record<string, any> = {}) {
  return {
    verifySessionAuth: vi.fn(async () => true),
    encryptKey: vi.fn((pk: string) => `enc:${pk.slice(0, 10)}`),
    ...overrides,
  } as any;
}

function makeHarness(overrides: { adapter?: any; existing?: any } = {}) {
  const repo = {
    findById: vi.fn(async () => overrides.existing ?? null),
    findActiveByUserAndContracts: vi.fn(async () => overrides.existing ?? null),
    create: vi.fn(async (params: any) => ({
      id: 'ses_new', userId: params.userId, chain: params.chain,
      sessionAddress: params.sessionAddress, sessionKeyEnc: params.sessionKeyEnc,
      validUntil: params.validUntil, permissions: params.permissions,
      maxPerTx: params.maxPerTx, maxTotal: params.maxTotal, totalSpent: '0',
      status: 'active', createdAt: new Date(), revokedAt: null,
    })),
    revoke: vi.fn(async () => true),
    updateStatus: vi.fn(async () => {}),
    expireStale: vi.fn(async () => 0),
  };
  const adapter = overrides.adapter ?? makeAdapter();
  const svc = new SessionService(repo as any, adapter);
  return { svc, repo, adapter };
}

function baseParams(over: Record<string, any> = {}) {
  const kp = makeKeypair();
  return {
    signature: '0x' + 'ab'.repeat(65),
    chain: 'sepolia',
    permissions: { contracts: ['0xEscrow00000000000000000000000000000000001'], functions: ['0xd0e30db0'] },
    validDays: 30,
    maxPerTx: '100',
    maxTotal: '100',
    userAddress: USER,
    nonce: 'nonce_1',
    sessionPublicKey: kp.publicKey,
    sessionPrivateKey: kp.privateKey,
    validUntil: Math.floor(Date.now() / 1000) + 30 * 86400,
    ...over,
  };
}

describe('SessionService.create — 创建（A-16 客户端提交 keypair）', () => {
  beforeEach(() => vi.clearAllMocks());

  it('成功路径：派生一致 + 验签通过 → 加密存储并返回会话', async () => {
    const { svc, repo, adapter } = makeHarness();
    const params = baseParams();
    const session = await svc.create(params);
    expect(session.id).toBe('ses_new');
    expect(session.sessionAddress).toBe(params.sessionPublicKey);
    expect(adapter.verifySessionAuth).toHaveBeenCalledWith(
      expect.objectContaining({ sessionAddress: params.sessionPublicKey, userAddress: USER, validUntil: params.validUntil })
    );
    expect(adapter.encryptKey).toHaveBeenCalledWith(params.sessionPrivateKey);
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ sessionAddress: params.sessionPublicKey, sessionKeyEnc: `enc:${params.sessionPrivateKey.slice(0, 10)}` })
    );
  });

  it('同用户+链+合约已有活动会话 → DUPLICATE_SESSION', async () => {
    const existing = { id: 'ses_old' };
    const { svc, adapter } = makeHarness({ existing });
    await expect(svc.create(baseParams())).rejects.toMatchObject({ errorCode: Errors.DUPLICATE_SESSION.code });
    expect(adapter.verifySessionAuth).not.toHaveBeenCalled();
  });

  it('sessionPublicKey 非 0x40hex → SESSION_KEY_INVALID', async () => {
    const { svc } = makeHarness();
    await expect(svc.create(baseParams({ sessionPublicKey: '0x1234' })))
      .rejects.toMatchObject({ errorCode: 'SESSION_KEY_INVALID', statusCode: 400 });
  });

  it('sessionPrivateKey 非 0x64hex → SESSION_KEY_INVALID', async () => {
    const { svc } = makeHarness();
    await expect(svc.create(baseParams({ sessionPrivateKey: '0xzz' })))
      .rejects.toMatchObject({ errorCode: 'SESSION_KEY_INVALID', statusCode: 400 });
  });

  it('提交私钥派生地址 ≠ 提交公钥 → SESSION_KEY_MISMATCH', async () => {
    const { svc } = makeHarness();
    const a = makeKeypair();
    const b = makeKeypair();
    await expect(svc.create(baseParams({ sessionPublicKey: a.publicKey, sessionPrivateKey: b.privateKey })))
      .rejects.toMatchObject({ errorCode: 'SESSION_KEY_MISMATCH', statusCode: 400 });
  });

  it('validUntil 已过期（<= now）→ SESSION_KEY_EXPIRED', async () => {
    const { svc } = makeHarness();
    await expect(svc.create(baseParams({ validUntil: Math.floor(Date.now() / 1000) - 1 })))
      .rejects.toMatchObject({ errorCode: 'SESSION_KEY_EXPIRED', statusCode: 400 });
  });

  it('validUntil 超出 validDays 窗口 → SESSION_KEY_INVALID', async () => {
    const { svc } = makeHarness();
    const tooFar = Math.floor(Date.now() / 1000) + 31 * 86400;
    await expect(svc.create(baseParams({ validDays: 30, validUntil: tooFar })))
      .rejects.toMatchObject({ errorCode: 'SESSION_KEY_INVALID', statusCode: 400 });
  });

  it('EIP-712 验签失败 → INVALID_SIGNATURE', async () => {
    const { svc } = makeHarness({ adapter: makeAdapter({ verifySessionAuth: vi.fn(async () => false) }) });
    await expect(svc.create(baseParams())).rejects.toMatchObject({ errorCode: Errors.INVALID_SIGNATURE.code });
  });
});

describe('SessionService.revoke — 撤销', () => {
  beforeEach(() => vi.clearAllMocks());

  it('存在且 active → revoked: true', async () => {
    const { svc } = makeHarness({ existing: { id: 'ses_1' } });
    const result = await svc.revoke('ses_1');
    expect(result).toEqual({ revoked: true });
  });

  it('不存在 → SESSION_NOT_FOUND', async () => {
    const { svc } = makeHarness();
    await expect(svc.revoke('ses_missing')).rejects.toMatchObject({ errorCode: Errors.SESSION_NOT_FOUND.code });
  });
});
