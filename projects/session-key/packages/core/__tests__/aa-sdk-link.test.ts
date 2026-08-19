// aa-sdk 链接冒烟测试（2026-08-20 重构：内嵌副本 → 依赖 @0xinfrax/aa-sdk）
// 验证 file: 依赖链路 + AA-2/AA-7 对齐修复已随 aa-sdk 生效（三段批量 disable + initData）。
import { describe, expect, it } from 'vitest';
import {
  decodeAbiParameters,
  decodeFunctionData,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';
import {
  BATCH_EXEC_MODE,
  encodeDisableSessionBatch,
  encodeExecuteBatch,
  encodeValidatorInstallData,
  KernelV3SessionDataBuilder,
  toBytes32,
} from '@0xinfrax/aa-sdk';
import type { ChainAAConfig, SessionPolicy } from '@0xinfrax/aa-sdk';

const ACCOUNT = '0x2222222222222222222222222222222222222222' as Address;
const SESSION_MODULE = '0x3333333333333333333333333333333333333333' as Address;
const SESSION_ID = '0x' + 'ab'.repeat(32);

function makeChainConfig(): ChainAAConfig {
  return {
    network: 'evm',
    chainId: 19505,
    entryPointVersion: '0.7',
    entryPoint: '0x0000000071727De22E5E9d8BAf0edAc6f37da032' as Address,
    rpcUrl: 'https://mock.invalid',
    bundlers: [],
    sessionModule: SESSION_MODULE,
  };
}

function makePolicy(): SessionPolicy {
  return {
    network: 'evm',
    sessionId: SESSION_ID,
    signer: '0x4444444444444444444444444444444444444444' as Address,
    validAfter: 0n,
    validUntil: 1893456000n,
    permissions: [
      {
        targets: ['0x5555555555555555555555555555555555555555' as Address],
        selectors: ['0x095ea7b3'],
        valueLimit: 10n ** 18n,
      },
    ],
  };
}

const KernelExecuteAbi = parseAbi(['function execute(bytes32 execMode, bytes executionCalldata)']);
const SessionModuleAbi = parseAbi(['function disableSession(bytes32 sessionId)']);
const ERC7579Abi = parseAbi([
  'function uninstallModule(uint256 moduleTypeId, address module, bytes deInitData)',
]);
const KernelInvalidateNonceAbi = parseAbi(['function invalidateNonce(uint32 newNonce)']);
const ExecutionTuple = [
  { name: 'target', type: 'address' },
  { name: 'value', type: 'uint256' },
  { name: 'data', type: 'bytes' },
] as const;

describe('aa-sdk 链接（@0xinfrax/aa-sdk）', () => {
  it('BATCH execMode + abi.encode(Execution[])', () => {
    const callData = encodeExecuteBatch([
      { target: SESSION_MODULE, value: 0n, data: '0x1234' },
    ]);
    const { args } = decodeFunctionData({ abi: KernelExecuteAbi, data: callData });
    expect(args[0]).toBe(BATCH_EXEC_MODE);
    const [executions] = decodeAbiParameters(
      [{ name: 'executions', type: 'tuple[]', components: ExecutionTuple }],
      args[1] as Hex,
    ) as [{ target: Address; value: bigint; data: Hex }[]];
    expect(executions).toHaveLength(1);
  });

  it('encodeValidatorInstallData 默认 hook=address(1)（Kernel v3.0-beta initData）', () => {
    const initData = encodeValidatorInstallData(KernelV3SessionDataBuilder.enableData(makePolicy()));
    const [hook, , hookData] = decodeAbiParameters(
      [
        { type: 'address' },
        { type: 'bytes' },
        { type: 'bytes' },
      ],
      initData,
    ) as [Address, Hex, Hex];
    expect(hook.toLowerCase()).toBe('0x0000000000000000000000000000000000000001');
    expect(hookData).toBe('0xff');
  });

  it('encodeDisableSessionBatch 三段批量 [disableSession, uninstallModule, invalidateNonce(cur+1)]', () => {
    const callData = encodeDisableSessionBatch({
      accountAddress: ACCOUNT,
      sessionId: SESSION_ID,
      chainConfig: makeChainConfig(),
      currentNonce: 3,
    });
    const { args } = decodeFunctionData({ abi: KernelExecuteAbi, data: callData });
    expect(args[0]).toBe(BATCH_EXEC_MODE);
    const [executions] = decodeAbiParameters(
      [{ name: 'executions', type: 'tuple[]', components: ExecutionTuple }],
      args[1] as Hex,
    ) as [{ target: Address; value: bigint; data: Hex }[]];
    expect(executions).toHaveLength(3);
    expect(executions[0].target.toLowerCase()).toBe(SESSION_MODULE);
    expect(decodeFunctionData({ abi: SessionModuleAbi, data: executions[0].data }).functionName).toBe('disableSession');
    expect(executions[1].target.toLowerCase()).toBe(ACCOUNT);
    expect(decodeFunctionData({ abi: ERC7579Abi, data: executions[1].data }).functionName).toBe('uninstallModule');
    expect(executions[2].target.toLowerCase()).toBe(ACCOUNT);
    expect(decodeFunctionData({ abi: KernelInvalidateNonceAbi, data: executions[2].data }).args).toEqual([4]);
  });

  it('toBytes32 原样透传 bytes32', () => {
    expect(toBytes32(SESSION_ID)).toBe(SESSION_ID);
  });
});
