// AA-6 单测：B2 session 复用策略兼容判定（isPolicySuperset / permissionCovers）
import { describe, expect, it } from 'vitest';
import type { SessionPolicy } from '../src/types.js';
import { isPolicySuperset, permissionCovers } from '../src/session-reuse.js';

const TARGET_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TARGET_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const TARGET_C = '0xcccccccccccccccccccccccccccccccccccccccc';
const TOKEN1 = '0x1111111111111111111111111111111111111111';
const TOKEN2 = '0x2222222222222222222222222222222222222222';
const NOW = 1_700_000_000n;

function policy(overrides: Partial<SessionPolicy> = {}): SessionPolicy {
  return {
    network: 'evm',
    sessionId: `0x${'aa'.repeat(32)}`,
    signer: '0x0000000000000000000000000000000000000001',
    validAfter: 0n,
    validUntil: NOW + 3_600_000n,
    permissions: [{ targets: [TARGET_A], valueLimit: 100n, dailyLimit: 1000n }],
    ...overrides,
  };
}

const request = (overrides: Partial<SessionPolicy> = {}) =>
  policy({ sessionId: `0x${'bb'.repeat(32)}`, signer: '0x0000000000000000000000000000000000000002', ...overrides });

describe('permissionCovers (AA-6 单条覆盖)', () => {
  it('covers identical permission', () => {
    const ep = { targets: [TARGET_A], selectors: ['0x12345678'], valueLimit: 100n, dailyLimit: 1000n, countLimit: 5 };
    const rp = { targets: [TARGET_A], selectors: ['0x12345678'], valueLimit: 50n, dailyLimit: 500n, countLimit: 3 };
    expect(permissionCovers(ep, rp)).toBe(true);
  });

  it('existing empty selectors = allow all (covers any requested selectors)', () => {
    expect(
      permissionCovers({ targets: [TARGET_A], selectors: [] }, { targets: [TARGET_A], selectors: ['0x12345678'] }),
    ).toBe(true);
  });

  it('rejects target not in whitelist', () => {
    expect(permissionCovers({ targets: [TARGET_A] }, { targets: [TARGET_B] })).toBe(false);
  });

  it('rejects selector not covered', () => {
    expect(
      permissionCovers({ targets: [TARGET_A], selectors: ['0x11111111'] }, { targets: [TARGET_A], selectors: ['0x22222222'] }),
    ).toBe(false);
  });

  it('rejects valueLimit exceeded', () => {
    expect(permissionCovers({ targets: [TARGET_A], valueLimit: 10n }, { targets: [TARGET_A], valueLimit: 20n })).toBe(false);
  });

  it('existing unlimited (0) covers any valueLimit', () => {
    expect(permissionCovers({ targets: [TARGET_A], valueLimit: 0n }, { targets: [TARGET_A], valueLimit: 10_000n })).toBe(true);
  });

  it('rejects token limit exceeded (per token)', () => {
    const ep = {
      targets: [TOKEN1],
      tokenLimits: [{ token: TOKEN1 as `0x${string}`, maxPerTx: 10n, maxDaily: 100n }],
    };
    const rp = {
      targets: [TOKEN1],
      tokenLimits: [{ token: TOKEN1 as `0x${string}`, maxPerTx: 20n, maxDaily: 50n }],
    };
    expect(permissionCovers(ep, rp)).toBe(false);
  });

  it('rejects allowAnyTransfer not present in existing', () => {
    expect(
      permissionCovers({ targets: [TARGET_A] }, { targets: [TARGET_A], allowAnyTransfer: { maxPerTx: 1n, maxDaily: 5n } }),
    ).toBe(false);
  });

  it('covers allowAnyTransfer within limits', () => {
    expect(
      permissionCovers(
        { targets: [TARGET_A], allowAnyTransfer: { maxPerTx: 10n, maxDaily: 50n } },
        { targets: [TARGET_A], allowAnyTransfer: { maxPerTx: 5n, maxDaily: 20n } },
      ),
    ).toBe(true);
  });
});

describe('isPolicySuperset (AA-6 复用判定)', () => {
  it('reuses when existing session covers requested policy', () => {
    const existing = policy({
      permissions: [{ targets: [TARGET_A, TARGET_B], valueLimit: 100n, dailyLimit: 1000n }],
    });
    const requested = request({
      permissions: [{ targets: [TARGET_A], valueLimit: 50n, dailyLimit: 500n }],
    });
    expect(isPolicySuperset({ existing, requested, nowSec: NOW })).toBe(true);
  });

  it('reuses with multiple requested permissions covered by distinct existing entries', () => {
    const existing = policy({
      permissions: [
        { targets: [TARGET_A], valueLimit: 100n },
        { targets: [TARGET_B], valueLimit: 200n },
      ],
    });
    const requested = request({
      permissions: [
        { targets: [TARGET_A], valueLimit: 50n },
        { targets: [TARGET_B], valueLimit: 100n },
      ],
    });
    expect(isPolicySuperset({ existing, requested, nowSec: NOW })).toBe(true);
  });

  it('rejects when a requested target has no covering existing permission', () => {
    const existing = policy({ permissions: [{ targets: [TARGET_A] }] });
    const requested = request({ permissions: [{ targets: [TARGET_C] }] });
    expect(isPolicySuperset({ existing, requested, nowSec: NOW })).toBe(false);
  });

  it('rejects when existing session expired', () => {
    const existing = policy({ validUntil: NOW - 1n, permissions: [{ targets: [TARGET_A] }] });
    const requested = request({ permissions: [{ targets: [TARGET_A] }] });
    expect(isPolicySuperset({ existing, requested, nowSec: NOW })).toBe(false);
  });

  it('rejects when existing window is shorter than requested (cannot extend without on-chain)', () => {
    const existing = policy({ validUntil: NOW + 1_000n, permissions: [{ targets: [TARGET_A] }] });
    const requested = request({ validUntil: NOW + 5_000n, permissions: [{ targets: [TARGET_A] }] });
    expect(isPolicySuperset({ existing, requested, nowSec: NOW })).toBe(false);
  });

  it('rejects when existing not yet active (validAfter > now)', () => {
    const existing = policy({ validAfter: NOW + 100n, permissions: [{ targets: [TARGET_A] }] });
    const requested = request({ permissions: [{ targets: [TARGET_A] }] });
    expect(isPolicySuperset({ existing, requested, nowSec: NOW })).toBe(false);
  });

  it('uses Date.now when nowSec omitted', () => {
    const existing = policy({ validUntil: BigInt(Math.floor(Date.now() / 1000)) + 3600n, permissions: [{ targets: [TARGET_A] }] });
    const requested = request({ permissions: [{ targets: [TARGET_A] }] });
    expect(isPolicySuperset({ existing, requested })).toBe(true);
  });

  it('rejects when existing token limit does not cover requested', () => {
    const existing = policy({
      permissions: [
        { targets: [TARGET_A], tokenLimits: [{ token: TOKEN1 as `0x${string}`, maxPerTx: 10n, maxDaily: 100n }] },
      ],
    });
    const requested = request({
      permissions: [
        { targets: [TARGET_A], tokenLimits: [{ token: TOKEN1 as `0x${string}`, maxPerTx: 20n, maxDaily: 100n }] },
      ],
    });
    expect(isPolicySuperset({ existing, requested, nowSec: NOW })).toBe(false);
  });

  it('rejects when requested allowAnyTransfer not covered', () => {
    const existing = policy({ permissions: [{ targets: [TARGET_A] }] });
    const requested = request({
      permissions: [{ targets: [TARGET_A], allowAnyTransfer: { maxPerTx: 1n, maxDaily: 5n } }],
    });
    expect(isPolicySuperset({ existing, requested, nowSec: NOW })).toBe(false);
  });
});
