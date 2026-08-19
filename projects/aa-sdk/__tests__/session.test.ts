// Session Key 权限策略校验单测（对齐 §7.3 安全边界 + §10.1）
import { describe, expect, it } from 'vitest';
import { decodeAbiParameters, decodeFunctionData, sliceHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { ChainAAConfig, SessionPolicy } from '../src/types.js';
import {
  InMemorySessionStore,
  assertValidPolicy,
  createSessionKey,
  encodeEnableSessionCall,
  listSessions,
  revokeSessionKey,
  validateSessionCall,
} from '../src/session.js';
import { ConfigError } from '../src/errors.js';

const TARGET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as Address;
const SELECTOR = '0x095ea7b3' as Hex; // approve(address,uint256)
const OTHER_SELECTOR = '0xa9059cbb' as Hex; // transfer(address,uint256)
const SESSION_SIGNER = '0x1111111111111111111111111111111111111111' as Address;
const ACCOUNT = '0x2222222222222222222222222222222222222222' as Address;
const SESSION_MODULE = '0x3333333333333333333333333333333333333333' as Address;

function makePolicy(overrides: Partial<SessionPolicy> = {}): SessionPolicy {
  return {
    network: 'evm',
    sessionId: 's1',
    signer: SESSION_SIGNER,
    validAfter: 1000n,
    validUntil: 2000n,
    permissions: [
      { targets: [TARGET], selectors: [SELECTOR], valueLimit: 1n, dailyLimit: 5n },
    ],
    ...overrides,
  };
}

describe('validateSessionCall', () => {
  it('allows compliant call (whitelisted target + selector + within limits)', () => {
    const res = validateSessionCall(makePolicy(), { target: TARGET, selector: SELECTOR, value: 1n }, 1500n, 4n);
    expect(res).toEqual({ ok: true });
  });

  it('rejects non-whitelisted target', () => {
    const res = validateSessionCall(
      makePolicy(),
      { target: '0x2222222222222222222222222222222222222222' as Address, selector: SELECTOR, value: 1n },
      1500n,
      0n,
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('no matching permission');
  });

  it('rejects non-whitelisted selector', () => {
    const res = validateSessionCall(makePolicy(), { target: TARGET, selector: OTHER_SELECTOR, value: 1n }, 1500n, 0n);
    expect(res.ok).toBe(false);
  });

  it('rejects value exceeding single-tx limit', () => {
    const res = validateSessionCall(makePolicy(), { target: TARGET, selector: SELECTOR, value: 2n }, 1500n, 0n);
    expect(res).toEqual({ ok: false, reason: 'value exceeds single-tx limit' });
  });

  it('rejects daily accumulation over limit', () => {
    // value=1n 不触发单笔限额(≤1n)，todayUsed=5n + 1n > dailyLimit=5n → 触发日限额
    const res = validateSessionCall(makePolicy(), { target: TARGET, selector: SELECTOR, value: 1n }, 1500n, 5n);
    expect(res).toEqual({ ok: false, reason: 'exceeds daily limit' });
  });

  it('rejects before validAfter', () => {
    const res = validateSessionCall(makePolicy(), { target: TARGET, selector: SELECTOR, value: 1n }, 999n, 0n);
    expect(res).toEqual({ ok: false, reason: 'session expired' });
  });

  it('rejects after validUntil', () => {
    const res = validateSessionCall(makePolicy(), { target: TARGET, selector: SELECTOR, value: 1n }, 2001n, 0n);
    expect(res).toEqual({ ok: false, reason: 'session expired' });
  });

  it('rejects empty permissions', () => {
    const res = validateSessionCall(makePolicy({ permissions: [] }), { target: TARGET, selector: SELECTOR, value: 1n }, 1500n, 0n);
    expect(res.ok).toBe(false);
  });

  it('rejects empty targets list (nothing allowed)', () => {
    const res = validateSessionCall(
      makePolicy({ permissions: [{ targets: [], selectors: [], valueLimit: 10n, dailyLimit: 10n }] }),
      { target: TARGET, selector: SELECTOR, value: 1n },
      1500n,
      0n,
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('no matching permission');
  });

  it('valueLimit 0 = unlimited value', () => {
    const policy = makePolicy({
      permissions: [{ targets: [TARGET], selectors: [SELECTOR], valueLimit: 0n, dailyLimit: 0n }],
    });
    const res = validateSessionCall(policy, { target: TARGET, selector: SELECTOR, value: 999n }, 1500n, 0n);
    expect(res).toEqual({ ok: true });
  });
});

// ============================================================================
// P0.4：Session Key 生命周期 + ERC-7579 validator 模块编码
// ============================================================================

/** 测试内联 ABI（与 session.ts 保持一致） */
const ExecuteAbi = [
  {
    type: 'function',
    name: 'execute',
    inputs: [
      { name: 'execMode', type: 'bytes32' },
      { name: 'executionCalldata', type: 'bytes' },
    ],
    outputs: [],
    stateMutability: 'payable',
  },
] as const;

const ModuleManagerAbi = [
  {
    type: 'function',
    name: 'installModule',
    inputs: [
      { name: 'moduleTypeId', type: 'uint256' },
      { name: 'module', type: 'address' },
      { name: 'initData', type: 'bytes' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'uninstallModule',
    inputs: [
      { name: 'moduleTypeId', type: 'uint256' },
      { name: 'module', type: 'address' },
      { name: 'deInitData', type: 'bytes' },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;

const SessionModuleDecodeAbi = [
  {
    type: 'function',
    name: 'enableSession',
    inputs: [
      { name: 'sessionId', type: 'bytes32' },
      { name: 'sessionKey', type: 'address' },
      { name: 'validUntil', type: 'uint48' },
      { name: 'validAfter', type: 'uint48' },
      {
        name: 'calls',
        type: 'tuple[]',
        components: [
          { name: 'target', type: 'address' },
          { name: 'selectors', type: 'bytes4[]' },
          { name: 'valueLimit', type: 'uint256' },
          { name: 'countLimit', type: 'uint256' },
        ],
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
  {
    type: 'function',
    name: 'disableSession',
    inputs: [{ name: 'sessionId', type: 'bytes32' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;

const ENTRYPOINT_V07 = '0x0000000071727De22E5E9d8BAf0edAc6f37da032' as Address;

function makeChainConfig(overrides: Partial<ChainAAConfig> = {}): ChainAAConfig {
  return {
    network: 'evm',
    chainId: 84532,
    entryPointVersion: '0.7',
    entryPoint: ENTRYPOINT_V07,
    rpcUrl: 'https://mock.invalid',
    bundlers: [],
    sessionModule: SESSION_MODULE,
    ...overrides,
  };
}

/** 解码 Kernel execute 外层，返回内层模块管理调用（跳过 target+value 头） */
function decodeExecutedInner(callData: Hex): { inner: Hex; account: Address } {
  const outer = decodeFunctionData({ abi: ExecuteAbi, data: callData });
  const executionCalldata = outer.args[1] as Hex;
  const account = sliceHex(executionCalldata, 0, 20) as Address;
  const inner = sliceHex(executionCalldata, 52); // 20B target + 32B value
  return { inner, account };
}

describe('createSessionKey (本地密钥对 + 登记)', () => {
  it('generates keypair, persists policy, and matches signer address', async () => {
    const store = new InMemorySessionStore();
    const { policy, privateKey } = await createSessionKey(
      { validUntil: 2000n, validAfter: 1000n, permissions: [{ targets: [TARGET], selectors: [SELECTOR] }] },
      ACCOUNT,
      store,
    );
    expect(privateKey).toBeDefined();
    expect(privateKey!.startsWith('0x')).toBe(true);
    expect(policy.signer).toBe(privateKeyToAccount(privateKey!).address);
    expect(policy.sessionId).toMatch(/^0x[0-9a-f]{64}$/i); // bytes32
    expect(policy.validAfter).toBe(1000n);
    const listed = await listSessions(ACCOUNT, 'evm', store);
    expect(listed).toHaveLength(1);
    expect(listed[0].sessionId).toBe(policy.sessionId);
  });

  it('uses provided external signer (no local private key)', async () => {
    const store = new InMemorySessionStore();
    const { policy, privateKey } = await createSessionKey(
      { signer: SESSION_SIGNER, validUntil: 2000n, validAfter: 1000n, permissions: [{ targets: [TARGET] }] },
      ACCOUNT,
      store,
    );
    expect(policy.signer).toBe(SESSION_SIGNER);
    expect(privateKey).toBeUndefined();
  });

  it('rejects invalid policy (validUntil <= validAfter)', async () => {
    const store = new InMemorySessionStore();
    await expect(
      createSessionKey({ validUntil: 1000n, validAfter: 2000n, permissions: [{ targets: [TARGET] }] }, ACCOUNT, store),
    ).rejects.toThrow(/validUntil must be > validAfter/);
  });

  it('rejects empty permissions', () => {
    expect(() => assertValidPolicy({ validUntil: 2000n, validAfter: 1000n, permissions: [] })).toThrow(/at least one permission/);
  });

  it('rejects empty targets (nothing allowed)', () => {
    expect(() =>
      assertValidPolicy({ validUntil: 2000n, validAfter: 1000n, permissions: [{ targets: [] }] }),
    ).toThrow(/targets must be non-empty/);
  });
});

describe('revokeSessionKey + listSessions (登记表生命周期)', () => {
  it('removes session so it no longer appears in list', async () => {
    const store = new InMemorySessionStore();
    const { policy } = await createSessionKey(
      { validUntil: 2000n, validAfter: 1000n, permissions: [{ targets: [TARGET] }] },
      ACCOUNT,
      store,
    );
    await revokeSessionKey(policy.sessionId, 'evm', store);
    expect(await listSessions(ACCOUNT, 'evm', store)).toHaveLength(0);
  });

  it('isolates sessions per account', async () => {
    const store = new InMemorySessionStore();
    const other = '0x4444444444444444444444444444444444444444' as Address;
    await createSessionKey({ validUntil: 2000n, validAfter: 1000n, permissions: [{ targets: [TARGET] }] }, ACCOUNT, store);
    await createSessionKey({ validUntil: 2000n, validAfter: 1000n, permissions: [{ targets: [TARGET] }] }, other, store);
    expect(await listSessions(ACCOUNT, 'evm', store)).toHaveLength(1);
    expect(await listSessions(other, 'evm', store)).toHaveLength(1);
  });

  it('isolates sessions per network (multi-network authorization)', async () => {
    const store = new InMemorySessionStore();
    await createSessionKey(
      { network: 'evm', validUntil: 2000n, validAfter: 1000n, permissions: [{ targets: [TARGET] }] },
      ACCOUNT,
      store,
    );
    await createSessionKey(
      { network: 'solana', validUntil: 2000n, validAfter: 1000n, permissions: [{ targets: [TARGET] }] },
      ACCOUNT,
      store,
    );
    const evmList = await listSessions(ACCOUNT, 'evm', store);
    const solList = await listSessions(ACCOUNT, 'solana', store);
    expect(evmList).toHaveLength(1);
    expect(solList).toHaveLength(1);
    expect(evmList[0].network).toBe('evm');
    expect(solList[0].network).toBe('solana');
  });

  it('defaults network to evm when unspecified', async () => {
    const store = new InMemorySessionStore();
    const { policy } = await createSessionKey(
      { validUntil: 2000n, validAfter: 1000n, permissions: [{ targets: [TARGET] }] },
      ACCOUNT,
      store,
    );
    expect(policy.network).toBe('evm');
  });
});

describe('encodeEnableSessionCall (ERC-7579 installModule → enableSession)', () => {
  it('wraps installModule(VALIDATOR, sessionModule, enableSession data) inside Kernel execute', () => {
    const policy = makePolicy({ sessionId: `0x${'ab'.repeat(32)}` });
    const callData = encodeEnableSessionCall({ accountAddress: ACCOUNT, policy, chainConfig: makeChainConfig() });

    const { inner, account } = decodeExecutedInner(callData);
    expect(account.toLowerCase()).toBe(ACCOUNT.toLowerCase());

    const decoded = decodeFunctionData({ abi: ModuleManagerAbi, data: inner });
    expect(decoded.functionName).toBe('installModule');
    const [moduleTypeId, module, initData] = decoded.args;
    expect(moduleTypeId).toBe(1n); // MODULE_TYPE_VALIDATOR
    expect(module.toLowerCase()).toBe(SESSION_MODULE.toLowerCase());

    // initData = abi.encode(hook, validatorData, hookData)（Kernel v3.0-beta installModule 格式）
    const [hook, validatorData] = decodeAbiParameters(
      [
        { name: 'hook', type: 'address' },
        { name: 'validatorData', type: 'bytes' },
        { name: 'hookData', type: 'bytes' },
      ],
      initData as Hex,
    ) as [Address, Hex, Hex];
    expect(hook.toLowerCase()).toBe('0x0000000000000000000000000000000000000001'); // address(1) = 无 hook
    const enable = decodeFunctionData({ abi: SessionModuleDecodeAbi, data: validatorData });
    expect(enable.functionName).toBe('enableSession');
    expect(enable.args[0]).toBe(policy.sessionId);
    expect((enable.args[1] as Address).toLowerCase()).toBe(policy.signer.toLowerCase());
  });

  it('throws ConfigError when sessionModule not configured', () => {
    const policy = makePolicy({ sessionId: `0x${'ab'.repeat(32)}` });
    expect(() =>
      encodeEnableSessionCall({ accountAddress: ACCOUNT, policy, chainConfig: makeChainConfig({ sessionModule: undefined }) }),
    ).toThrow(ConfigError);
  });
});

// ============================================================================
// P0.12：ERC-20 金额级限额（§7.5）+ 任意地址转账（§7.6）校验
// ============================================================================

describe('validateSessionCall: ERC-20 金额级限额（tokenLimits）', () => {
  const tokenPolicy = (overrides: Partial<SessionPolicy> = {}) =>
    makePolicy({
      permissions: [
        {
          targets: [TARGET],
          selectors: [SELECTOR],
          valueLimit: 0n,
          dailyLimit: 0n,
          tokenLimits: [{ token: TARGET, maxPerTx: 10n, maxDaily: 50n }],
        },
      ],
      ...overrides,
    });

  it('allows amount within single-tx and daily limits', () => {
    const res = validateSessionCall(
      tokenPolicy(),
      { target: TARGET, selector: SELECTOR, value: 0n, amount: 5n },
      1500n,
      0n,
      { [TARGET.toLowerCase()]: 10n },
    );
    expect(res).toEqual({ ok: true });
  });

  it('rejects when amount missing for limited token', () => {
    const res = validateSessionCall(tokenPolicy(), { target: TARGET, selector: SELECTOR, value: 0n }, 1500n);
    expect(res).toEqual({ ok: false, reason: 'token amount required for limited token' });
  });

  it('rejects amount exceeding single-tx limit', () => {
    const res = validateSessionCall(
      tokenPolicy(),
      { target: TARGET, selector: SELECTOR, value: 0n, amount: 11n },
      1500n,
    );
    expect(res).toEqual({ ok: false, reason: 'token amount exceeds single-tx limit' });
  });

  it('rejects amount pushing daily usage over limit', () => {
    const res = validateSessionCall(
      tokenPolicy(),
      { target: TARGET, selector: SELECTOR, value: 0n, amount: 5n },
      1500n,
      0n,
      { [TARGET.toLowerCase()]: 46n },
    );
    expect(res).toEqual({ ok: false, reason: 'token exceeds daily limit' });
  });

  it('ignores daily token usage of other tokens (per-token isolation)', () => {
    const res = validateSessionCall(
      tokenPolicy(),
      { target: TARGET, selector: SELECTOR, value: 0n, amount: 5n },
      1500n,
      0n,
      { '0x9999999999999999999999999999999999999999': 999n },
    );
    expect(res).toEqual({ ok: true });
  });
});

describe('validateSessionCall: 任意地址转账（allowAnyTransfer）', () => {
  const anyTransferPolicy = (overrides: Partial<SessionPolicy> = {}) =>
    makePolicy({
      permissions: [
        {
          targets: [TARGET],
          selectors: [SELECTOR],
          allowAnyTransfer: { maxPerTx: 1n, maxDaily: 5n },
        },
      ],
      ...overrides,
    });

  it('allows any-transfer call within limits', () => {
    const res = validateSessionCall(
      anyTransferPolicy(),
      {
        target: '0x5555555555555555555555555555555555555555' as Address,
        selector: '0x00000000' as Hex,
        value: 1n,
        anyTransfer: true,
      },
      1500n,
      4n,
    );
    expect(res).toEqual({ ok: true });
  });

  it('rejects value exceeding single-tx limit', () => {
    const res = validateSessionCall(
      anyTransferPolicy(),
      {
        target: '0x5555555555555555555555555555555555555555' as Address,
        selector: '0x00000000' as Hex,
        value: 2n,
        anyTransfer: true,
      },
      1500n,
      0n,
    );
    expect(res).toEqual({ ok: false, reason: 'transfer exceeds single-tx limit' });
  });

  it('rejects daily accumulation over limit', () => {
    const res = validateSessionCall(
      anyTransferPolicy(),
      {
        target: '0x5555555555555555555555555555555555555555' as Address,
        selector: '0x00000000' as Hex,
        value: 1n,
        anyTransfer: true,
      },
      1500n,
      5n,
    );
    expect(res).toEqual({ ok: false, reason: 'transfer exceeds daily limit' });
  });

  it('falls back to whitelist rules when anyTransfer not declared', () => {
    const res = validateSessionCall(
      anyTransferPolicy(),
      {
        target: '0x5555555555555555555555555555555555555555' as Address,
        selector: '0x00000000' as Hex,
        value: 1n,
      },
      1500n,
      0n,
    );
    expect(res).toEqual({ ok: false, reason: 'no matching permission' });
  });
});

// ============================================================================
// P0.12：增强 enableSession 6 参数编码（tokenLimits + 哨兵条目）
// ============================================================================

const EnhancedSessionModuleDecodeAbi = [
  {
    type: 'function',
    name: 'enableSession',
    inputs: [
      { name: 'sessionId', type: 'bytes32' },
      { name: 'sessionKey', type: 'address' },
      { name: 'validUntil', type: 'uint48' },
      { name: 'validAfter', type: 'uint48' },
      {
        name: 'tokenLimits',
        type: 'tuple[]',
        components: [
          { name: 'token', type: 'address' },
          { name: 'maxPerTx', type: 'uint256' },
          { name: 'maxDaily', type: 'uint256' },
        ],
      },
      {
        name: 'calls',
        type: 'tuple[]',
        components: [
          { name: 'target', type: 'address' },
          { name: 'selectors', type: 'bytes4[]' },
          { name: 'valueLimit', type: 'uint256' },
          { name: 'countLimit', type: 'uint256' },
        ],
      },
    ],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;

describe('encodeEnableSessionCall (P0.12 增强编码)', () => {
  it('uses 6-arg enhanced encoding with on-chain selector 0xc620957b when tokenLimits present', () => {
    const policy = makePolicy({
      sessionId: `0x${'ab'.repeat(32)}`,
      permissions: [
        {
          targets: [TARGET],
          selectors: [SELECTOR],
          tokenLimits: [{ token: TARGET, maxPerTx: 10n, maxDaily: 50n }],
        },
      ],
    });
    const callData = encodeEnableSessionCall({ accountAddress: ACCOUNT, policy, chainConfig: makeChainConfig() });

    const { inner } = decodeExecutedInner(callData);
    const decoded = decodeFunctionData({ abi: ModuleManagerAbi, data: inner });
    // initData = abi.encode(hook, validatorData, hookData)（Kernel v3.0-beta installModule 格式）
    const [hook, validatorData] = decodeAbiParameters(
      [
        { name: 'hook', type: 'address' },
        { name: 'validatorData', type: 'bytes' },
        { name: 'hookData', type: 'bytes' },
      ],
      decoded.args[2] as Hex,
    ) as [Address, Hex, Hex];
    expect(hook.toLowerCase()).toBe('0x0000000000000000000000000000000000000001'); // address(1) = 无 hook
    // 关键：selector 必须与链上 KernelSessionWithTokenLimitModule 6 参数 enableSession 一致
    expect(validatorData.slice(0, 10)).toBe('0xc620957b');
    const enable = decodeFunctionData({ abi: EnhancedSessionModuleDecodeAbi, data: validatorData });
    expect(enable.functionName).toBe('enableSession');
    expect(enable.args[0]).toBe(policy.sessionId);

    const tokenLimits = enable.args[4] as { token: Address; maxPerTx: bigint; maxDaily: bigint }[];
    expect(tokenLimits).toHaveLength(1);
    expect(tokenLimits[0].token.toLowerCase()).toBe(TARGET.toLowerCase());
    expect(tokenLimits[0].maxPerTx).toBe(10n);
    expect(tokenLimits[0].maxDaily).toBe(50n);

    const calls = enable.args[5] as { target: Address; selectors: Hex[]; valueLimit: bigint; countLimit: bigint }[];
    expect(calls).toHaveLength(1);
    expect(calls[0].target.toLowerCase()).toBe(TARGET.toLowerCase());
    expect(calls[0].valueLimit).toBe(0n);
  });

  it('appends sentinel tokenLimits + calls entries for allowAnyTransfer', () => {
    const policy = makePolicy({
      sessionId: `0x${'ab'.repeat(32)}`,
      permissions: [
        {
          targets: [TARGET],
          selectors: [SELECTOR],
          allowAnyTransfer: { maxPerTx: 1n, maxDaily: 5n },
        },
      ],
    });
    const callData = encodeEnableSessionCall({ accountAddress: ACCOUNT, policy, chainConfig: makeChainConfig() });

    const { inner } = decodeExecutedInner(callData);
    const decoded = decodeFunctionData({ abi: ModuleManagerAbi, data: inner });
    // initData = abi.encode(hook, validatorData, hookData)（Kernel v3.0-beta installModule 格式）
    const [hook, validatorData, hookData] = decodeAbiParameters(
      [
        { name: 'hook', type: 'address' },
        { name: 'validatorData', type: 'bytes' },
        { name: 'hookData', type: 'bytes' },
      ],
      decoded.args[2] as Hex,
    ) as [Address, Hex, Hex];
    expect(hook.toLowerCase()).toBe('0x0000000000000000000000000000000000000001'); // address(1) = 无 hook
    expect(hookData).toBe('0xff');
    expect(validatorData.slice(0, 10)).toBe('0xc620957b'); // 增强 6 参数 selector
    const enable = decodeFunctionData({ abi: EnhancedSessionModuleDecodeAbi, data: validatorData });

    const tokenLimits = enable.args[4] as { token: Address; maxPerTx: bigint; maxDaily: bigint }[];
    expect(tokenLimits).toHaveLength(1);
    expect(tokenLimits[0].token.toLowerCase()).toBe('0x0000000000000000000000000000000000000001'); // ANY_TRANSFER_SENTINEL
    expect(tokenLimits[0].maxPerTx).toBe(1n);
    expect(tokenLimits[0].maxDaily).toBe(5n);

    const calls = enable.args[5] as { target: Address; selectors: Hex[]; valueLimit: bigint; countLimit: bigint }[];
    expect(calls).toHaveLength(2); // 白名单 target + 哨兵 target
    const sentinelCall = calls[1];
    expect(sentinelCall.target.toLowerCase()).toBe('0x0000000000000000000000000000000000000001');
    expect(sentinelCall.valueLimit).toBe(1n); // anyTransfer.maxPerTx
  });

  it('keeps 5-arg encoding with on-chain selector 0x7d993787 when no tokenLimits / allowAnyTransfer', () => {
    const policy = makePolicy({ sessionId: `0x${'ab'.repeat(32)}` });
    const callData = encodeEnableSessionCall({ accountAddress: ACCOUNT, policy, chainConfig: makeChainConfig() });

    const { inner } = decodeExecutedInner(callData);
    const decoded = decodeFunctionData({ abi: ModuleManagerAbi, data: inner });
    // initData = abi.encode(hook, validatorData, hookData)（Kernel v3.0-beta installModule 格式）
    const [hook, validatorData] = decodeAbiParameters(
      [
        { name: 'hook', type: 'address' },
        { name: 'validatorData', type: 'bytes' },
        { name: 'hookData', type: 'bytes' },
      ],
      decoded.args[2] as Hex,
    ) as [Address, Hex, Hex];
    expect(hook.toLowerCase()).toBe('0x0000000000000000000000000000000000000001'); // address(1) = 无 hook
    expect(validatorData.slice(0, 10)).toBe('0x7d993787'); // 5 参数 enableSession(CallPermission[])
    const enable = decodeFunctionData({ abi: SessionModuleDecodeAbi, data: validatorData });
    expect(enable.functionName).toBe('enableSession');
    const calls = enable.args[4] as { target: Address; selectors: Hex[]; valueLimit: bigint; countLimit: bigint }[];
    expect(calls).toHaveLength(1);
    expect(calls[0].target.toLowerCase()).toBe(TARGET.toLowerCase());
    expect(calls[0].selectors).toEqual([SELECTOR]);
  });
});
