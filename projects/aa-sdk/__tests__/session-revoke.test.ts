// AA-1/AA-2/AA-3 单测：批量 execute 编码 + disable 批量撤销 + isModuleInstalled 探测 + 签名校验
import { describe, expect, it } from 'vitest';
import {
  decodeAbiParameters,
  decodeFunctionData,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { ChainAAConfig, UserOperationV7 } from '../src/types.js';
import { encodeExecuteBatch, getUserOpHash, type Execution } from '../src/userop.js';
import {
  encodeDisableSessionBatch,
  isSessionModuleInstalled,
  MODULE_TYPE_VALIDATOR,
  toBytes32,
} from '../src/session-module.js';
import { buildDisableSessionUserOp, verifyDisableSignature } from '../src/session-revoke.js';
import { ConfigError } from '../src/errors.js';

const ACCOUNT = '0x2222222222222222222222222222222222222222' as Address;
const SESSION_MODULE = '0x3333333333333333333333333333333333333333' as Address;
const ENTRYPOINT_V07 = '0x0000000071727De22E5E9d8BAf0edAc6f37da032' as Address;
const OWNER_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

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

const ExecutionTuple = [
  { name: 'target', type: 'address' },
  { name: 'value', type: 'uint256' },
  { name: 'data', type: 'bytes' },
] as const;

// ============================================================================
// AA-2：encodeExecuteBatch —— Kernel v3 批量 execute(BATCH, abi.encode(Execution[]))
// ============================================================================

describe('encodeExecuteBatch (AA-2)', () => {
  it('encodes execute with BATCH_EXEC_MODE and Execution[] tuple array', () => {
    const executions: Execution[] = [
      { target: ACCOUNT, value: 0n, data: '0x1111' },
      { target: ACCOUNT, value: 1n, data: '0x2222' },
    ];
    const callData = encodeExecuteBatch(executions);

    const outer = decodeFunctionData({
      abi: [
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
      ] as const,
      data: callData,
    });
    expect(outer.functionName).toBe('execute');
    expect(outer.args[0]).toBe('0x0100000000000000000000000000000000000000000000000000000000000000'); // CALLTYPE_BATCH

    const inner = outer.args[1] as Hex;
    const [decoded] = decodeAbiParameters(
      [{ name: 'executions', type: 'tuple[]', components: ExecutionTuple }],
      inner,
    ) as [Execution[]];
    expect(decoded).toHaveLength(2);
    expect(decoded[0].target.toLowerCase()).toBe(ACCOUNT.toLowerCase());
    expect(decoded[0].value).toBe(0n);
    expect(decoded[0].data).toBe('0x1111');
    expect(decoded[1].value).toBe(1n);
    expect(decoded[1].data).toBe('0x2222');
  });

  it('defaults missing value to 0n', () => {
    const callData = encodeExecuteBatch([{ target: ACCOUNT, data: '0x' }]);
    const outer = decodeFunctionData({
      abi: [
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
      ] as const,
      data: callData,
    });
    const [decoded] = decodeAbiParameters(
      [{ name: 'executions', type: 'tuple[]', components: ExecutionTuple }],
      outer.args[1] as Hex,
    ) as [Execution[]];
    expect(decoded[0].value).toBe(0n);
  });
});

// ============================================================================
// AA-1：encodeDisableSessionBatch —— 批量 uninstallModule + invalidateNonce
// ============================================================================

const UninstallAbi = [
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

const InvalidateAbi = [
  {
    type: 'function',
    name: 'invalidateNonce',
    inputs: [{ name: 'newNonce', type: 'uint32' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;

const DisableSessionAbi = [
  {
    type: 'function',
    name: 'disableSession',
    inputs: [{ name: 'sessionId', type: 'bytes32' }],
    outputs: [],
    stateMutability: 'nonpayable',
  },
] as const;

describe('encodeDisableSessionBatch (AA-1 批量撤销)', () => {
  it('encodes execute(BATCH, [disableSession@module, uninstallModule, invalidateNonce(cur+1)])', () => {
    const sessionId = `0x${'cd'.repeat(32)}`;
    const callData = encodeDisableSessionBatch({
      accountAddress: ACCOUNT,
      sessionId,
      chainConfig: makeChainConfig(),
      currentNonce: 5,
    });

    const outer = decodeFunctionData({
      abi: [
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
      ] as const,
      data: callData,
    });
    const [executions] = decodeAbiParameters(
      [{ name: 'executions', type: 'tuple[]', components: ExecutionTuple }],
      outer.args[1] as Hex,
    ) as [Execution[]];
    // 三段：① disableSession@module ② uninstallModule ③ invalidateNonce
    expect(executions).toHaveLength(3);

    // ① disableSession(sessionId) 直接调用模块（deployed onUninstall 为空实现，
    //    必须显式删除 session 记录，否则卸载+重装后旧 session 仍可验证）
    const disable = executions[0];
    expect(disable.target.toLowerCase()).toBe(SESSION_MODULE.toLowerCase());
    const ds = decodeFunctionData({ abi: DisableSessionAbi, data: disable.data });
    expect(ds.functionName).toBe('disableSession');
    expect((ds.args[0] as Hex).toLowerCase()).toBe(toBytes32(sessionId).toLowerCase());

    // ② uninstallModule(VALIDATOR, sessionModule, disableSession(sessionId))
    const uninstall = executions[1];
    expect(uninstall.target.toLowerCase()).toBe(ACCOUNT.toLowerCase());
    const u = decodeFunctionData({ abi: UninstallAbi, data: uninstall.data });
    expect(u.functionName).toBe('uninstallModule');
    expect(u.args[0]).toBe(MODULE_TYPE_VALIDATOR);
    expect((u.args[1] as Address).toLowerCase()).toBe(SESSION_MODULE.toLowerCase());

    // ③ invalidateNonce(currentNonce + 1)
    const invalidate = executions[2];
    expect(invalidate.target.toLowerCase()).toBe(ACCOUNT.toLowerCase());
    const inv = decodeFunctionData({ abi: InvalidateAbi, data: invalidate.data });
    expect(inv.functionName).toBe('invalidateNonce');
    expect(inv.args[0]).toBe(6); // 5 + 1 (uint32 → number)
  });

  it('throws ConfigError when sessionModule not configured', () => {
    expect(() =>
      encodeDisableSessionBatch({
        accountAddress: ACCOUNT,
        sessionId: `0x${'cd'.repeat(32)}`,
        chainConfig: makeChainConfig({ sessionModule: undefined }),
        currentNonce: 1,
      }),
    ).toThrow(ConfigError);
  });
});

// ============================================================================
// AA-3：isSessionModuleInstalled —— ERC-7579 视图探测
// ============================================================================

function mockClient(getCode: Hex | undefined, installed?: boolean): PublicClient {
  return {
    getCode: async () => getCode,
    readContract: async () => installed,
  } as unknown as PublicClient;
}

describe('isSessionModuleInstalled (AA-3)', () => {
  it('returns false for undeployed account (no code) without calling readContract', async () => {
    let readCalled = false;
    const client = {
      getCode: async () => '0x',
      readContract: async () => {
        readCalled = true;
        return false;
      },
    } as unknown as PublicClient;
    expect(await isSessionModuleInstalled({ client, chainConfig: makeChainConfig(), account: ACCOUNT })).toBe(false);
    expect(readCalled).toBe(false);
  });

  it('returns true when isModuleInstalled view returns true', async () => {
    expect(
      await isSessionModuleInstalled({ client: mockClient('0x1234', true), chainConfig: makeChainConfig(), account: ACCOUNT }),
    ).toBe(true);
  });

  it('returns false when isModuleInstalled view returns false', async () => {
    expect(
      await isSessionModuleInstalled({ client: mockClient('0x1234', false), chainConfig: makeChainConfig(), account: ACCOUNT }),
    ).toBe(false);
  });

  it('throws ConfigError when sessionModule not configured', async () => {
    await expect(
      isSessionModuleInstalled({ client: mockClient('0x1234', false), chainConfig: makeChainConfig({ sessionModule: undefined }), account: ACCOUNT }),
    ).rejects.toThrow(ConfigError);
  });
});

// ============================================================================
// AA-1：buildDisableSessionUserOp —— draft 构建（root nonce + 批量撤销 callData）
// ============================================================================

describe('buildDisableSessionUserOp (AA-1 draft)', () => {
  const sessionId = `0x${'ef'.repeat(32)}`;

  it('builds unsigned draft with root nonce + batch callData + sessionIdBytes', async () => {
    const client = {
      readContract: async ({ functionName }: { functionName: string }) => {
        if (functionName === 'currentNonce') return 7;
        if (functionName === 'getNonce') return 123n;
        throw new Error(`unexpected ${functionName}`);
      },
    } as unknown as PublicClient;

    const draft = await buildDisableSessionUserOp({
      client,
      chainConfig: makeChainConfig(),
      account: ACCOUNT,
      sessionId,
      gas: { callGasLimit: 1_000_000n, verificationGasLimit: 200_000n },
    });

    expect(draft.currentNonce).toBe(7);
    expect(draft.sessionIdBytes).toBe(toBytes32(sessionId));
    expect(draft.op.sender.toLowerCase()).toBe(ACCOUNT.toLowerCase());
    expect(draft.op.nonce).toBe(123n);
    expect(draft.op.callGasLimit).toBe(1_000_000n);
    expect(draft.op.signature).toBe('0x');

    // callData = 批量 disableSession@module + uninstall + invalidateNonce(8)
    const outer = decodeFunctionData({
      abi: [
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
      ] as const,
      data: draft.op.callData,
    });
    const [executions] = decodeAbiParameters(
      [{ name: 'executions', type: 'tuple[]', components: ExecutionTuple }],
      outer.args[1] as Hex,
    ) as [Execution[]];
    expect(executions).toHaveLength(3);
    expect(executions[0].target.toLowerCase()).toBe(SESSION_MODULE.toLowerCase()); // disableSession@module
    const inv = decodeFunctionData({ abi: InvalidateAbi, data: executions[2].data });
    expect(inv.args[0]).toBe(8); // currentNonce 7 + 1 (uint32 → number)

    // userOpHash 与 getUserOpHash 重算一致（绑定构建时 nonce/gas）
    expect(draft.userOpHash).toBe(getUserOpHash(draft.op, ENTRYPOINT_V07, 84532));
  });
});

// ============================================================================
// AA-1：verifyDisableSignature —— owner 对 userOpHash 的 ECDSA 校验
// ============================================================================

describe('verifyDisableSignature (AA-1 revoke)', () => {
  it('accepts owner ECDSA signature over userOpHash', async () => {
    const owner = privateKeyToAccount(OWNER_PK);
    const hash = getUserOpHash(
      { sender: ACCOUNT, nonce: 123n, callData: '0x', callGasLimit: 1n, verificationGasLimit: 1n, preVerificationGas: 1n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, signature: '0x' },
      ENTRYPOINT_V07,
      84532,
    );
    const sig = await owner.sign({ hash });
    expect(await verifyDisableSignature({ userOpHash: hash, signature: sig, owner: owner.address })).toBe(true);
  });

  it('rejects signature from a different owner', async () => {
    const signer = privateKeyToAccount(OWNER_PK);
    const other = privateKeyToAccount('0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6');
    const hash = getUserOpHash(
      { sender: ACCOUNT, nonce: 1n, callData: '0x', callGasLimit: 1n, verificationGasLimit: 1n, preVerificationGas: 1n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, signature: '0x' },
      ENTRYPOINT_V07,
      84532,
    );
    const sig = await signer.sign({ hash });
    expect(await verifyDisableSignature({ userOpHash: hash, signature: sig, owner: other.address })).toBe(false);
  });

  it('rejects tampered userOpHash (signature over different digest)', async () => {
    const owner = privateKeyToAccount(OWNER_PK);
    const op = (nonce: bigint): UserOperationV7 => ({
      sender: ACCOUNT, nonce, callData: '0x', callGasLimit: 1n, verificationGasLimit: 1n, preVerificationGas: 1n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, signature: '0x',
    });
    const hashA = getUserOpHash(op(1n), ENTRYPOINT_V07, 84532);
    const hashB = getUserOpHash(op(2n), ENTRYPOINT_V07, 84532);
    const sig = await owner.sign({ hash: hashA });
    expect(await verifyDisableSignature({ userOpHash: hashB, signature: sig, owner: owner.address })).toBe(false);
  });

  it('returns false (not throw) for malformed signature', async () => {
    const owner = privateKeyToAccount(OWNER_PK);
    const hash = getUserOpHash(
      { sender: ACCOUNT, nonce: 1n, callData: '0x', callGasLimit: 1n, verificationGasLimit: 1n, preVerificationGas: 1n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, signature: '0x' },
      ENTRYPOINT_V07,
      84532,
    );
    expect(await verifyDisableSignature({ userOpHash: hash, signature: '0xdeadbeef' as Hex, owner: owner.address })).toBe(false);
  });
});
