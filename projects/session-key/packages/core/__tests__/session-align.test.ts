// AA-2/AA-7 对齐单测：session-key 内嵌 aa-sdk 副本的新编码
// 覆盖：encodeExecuteBatch（BATCH execMode + Execution[]）、
//       encodeValidatorInstallData（Kernel v3.0-beta initData 包装）、
//       encodeEnableSessionCall（修复后 initData）、
//       encodeDisableSessionBatch（三段批量：disableSession + uninstall + invalidateNonce）。
import { describe, expect, it } from 'vitest';
import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeFunctionData,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';
import type { ChainAAConfig, SessionPolicy } from '../src/aa/types.js';
import { BATCH_EXEC_MODE, encodeExecuteBatch } from '../src/aa/userop.js';
import {
  encodeValidatorInstallData,
  encodeEnableSessionCall,
  encodeDisableSessionCall,
  encodeDisableSessionBatch,
  toBytes32,
  KernelV3SessionDataBuilder,
} from '../src/aa/session.js';

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

// 解码用 ABI（与 src/aa/session.ts 内部定义对齐）
const KernelExecuteAbi = parseAbi(['function execute(bytes32 execMode, bytes executionCalldata)']);
const SessionModuleAbi = parseAbi(['function disableSession(bytes32 sessionId)']);
const ERC7579Abi = parseAbi([
  'function installModule(uint256 moduleTypeId, address module, bytes initData)',
  'function uninstallModule(uint256 moduleTypeId, address module, bytes deInitData)',
]);
const KernelInvalidateNonceAbi = parseAbi(['function invalidateNonce(uint32 newNonce)']);
const ExecutionTuple = [
  { name: 'target', type: 'address' },
  { name: 'value', type: 'uint256' },
  { name: 'data', type: 'bytes' },
] as const;

describe('encodeExecuteBatch（对齐 aa-sdk AA-2）', () => {
  it('使用 BATCH execMode + abi.encode(Execution[])', () => {
    const callData = encodeExecuteBatch([
      { target: SESSION_MODULE, value: 0n, data: '0x1234' },
      { target: ACCOUNT, value: 0n, data: '0xabcd' },
    ]);
    const { functionName, args } = decodeFunctionData({ abi: KernelExecuteAbi, data: callData });
    expect(functionName).toBe('execute');
    const [execMode, executionCalldata] = args as [Hex, Hex];
    expect(execMode).toBe(BATCH_EXEC_MODE);
    const [executions] = decodeAbiParameters(
      [{ name: 'executions', type: 'tuple[]', components: ExecutionTuple }],
      executionCalldata,
    ) as [{ target: Address; value: bigint; data: Hex }[]];
    expect(executions).toHaveLength(2);
    expect(executions[0]).toEqual({ target: SESSION_MODULE, value: 0n, data: '0x1234' });
    expect(executions[1]).toEqual({ target: ACCOUNT, value: 0n, data: '0xabcd' });
  });
});

describe('encodeValidatorInstallData（对齐 aa-sdk，Kernel v3.0-beta initData）', () => {
  it('默认 hook=address(1)、hookData=0xff；返回 abi.encode(hook, validatorData, hookData)', () => {
    const enableData = KernelV3SessionDataBuilder.enableData(makePolicy());
    const initData = encodeValidatorInstallData(enableData);
    const [hook, validatorData, hookData] = decodeAbiParameters(
      [
        { type: 'address' },
        { type: 'bytes' },
        { type: 'bytes' },
      ],
      initData,
    ) as [Address, Hex, Hex];
    expect(hook.toLowerCase()).toBe('0x0000000000000000000000000000000000000001');
    expect(validatorData).toBe(enableData);
    expect(hookData).toBe('0xff');
  });
});

describe('encodeEnableSessionCall（修复后：initData 包装）', () => {
  it('installModule initData 解码为 (address(1), enableData, 0xff)，不再直传 enableData', () => {
    const callData = encodeEnableSessionCall({
      accountAddress: ACCOUNT,
      policy: makePolicy(),
      chainConfig: makeChainConfig(),
    });
    // execute(ACCOUNT, 0, installModule(...)) → executionCalldata = concat(target, value, data)
    const { args } = decodeFunctionData({ abi: KernelExecuteAbi, data: callData });
    const executionCalldata = args[1] as Hex;
    const installCalldata = `0x${executionCalldata.slice(2 + 40 + 64)}`;
    const install = decodeFunctionData({ abi: ERC7579Abi, data: installCalldata });
    expect(install.functionName).toBe('installModule');
    const [moduleTypeId, module, initData] = install.args as [bigint, Address, Hex];
    expect(moduleTypeId).toBe(1n);
    expect(module.toLowerCase()).toBe(SESSION_MODULE);
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
});

describe('encodeDisableSessionBatch（对齐 aa-sdk：三段批量）', () => {
  it('批量 [disableSession@module, uninstallModule, invalidateNonce(cur+1)]', () => {
    const currentNonce = 7;
    const callData = encodeDisableSessionBatch({
      accountAddress: ACCOUNT,
      sessionId: SESSION_ID,
      chainConfig: makeChainConfig(),
      currentNonce,
    });
    const { args } = decodeFunctionData({ abi: KernelExecuteAbi, data: callData });
    expect(args[0]).toBe(BATCH_EXEC_MODE);
    const [executions] = decodeAbiParameters(
      [{ name: 'executions', type: 'tuple[]', components: ExecutionTuple }],
      args[1] as Hex,
    ) as [{ target: Address; value: bigint; data: Hex }[]];
    expect(executions).toHaveLength(3);

    // ①a disableSession@module
    expect(executions[0].target.toLowerCase()).toBe(SESSION_MODULE);
    const disable = decodeFunctionData({ abi: SessionModuleAbi, data: executions[0].data });
    expect(disable.functionName).toBe('disableSession');
    expect(disable.args).toEqual([toBytes32(SESSION_ID)]);

    // ①b uninstallModule@account（deInitData = disableData(sessionId)）
    expect(executions[1].target.toLowerCase()).toBe(ACCOUNT);
    const uninstall = decodeFunctionData({ abi: ERC7579Abi, data: executions[1].data });
    expect(uninstall.functionName).toBe('uninstallModule');
    expect((uninstall.args as [bigint, Address, Hex])[0]).toBe(1n);
    expect((uninstall.args as [bigint, Address, Hex])[1].toLowerCase()).toBe(SESSION_MODULE);
    const deInit = decodeFunctionData({ abi: SessionModuleAbi, data: (uninstall.args as [bigint, Address, Hex])[2] });
    expect(deInit.functionName).toBe('disableSession');

    // ①c invalidateNonce(cur+1)@account
    expect(executions[2].target.toLowerCase()).toBe(ACCOUNT);
    const invalidate = decodeFunctionData({ abi: KernelInvalidateNonceAbi, data: executions[2].data });
    expect(invalidate.functionName).toBe('invalidateNonce');
    expect(invalidate.args).toEqual([currentNonce + 1]);
  });
});

describe('toBytes32', () => {
  it('0x+64 hex 原样返回；字符串左对齐补零', () => {
    expect(toBytes32(SESSION_ID)).toBe(SESSION_ID);
    expect(toBytes32('hello')).toBe(`0x${'68656c6c6f'.padEnd(64, '0')}`);
  });
});

describe('编码一致性：encodeDisableSessionCall 兼容保留', () => {
  it('旧单调用版本仍可解码（uninstallModule）', () => {
    const callData = encodeDisableSessionCall({
      accountAddress: ACCOUNT,
      sessionId: SESSION_ID,
      chainConfig: makeChainConfig(),
    });
    const { args } = decodeFunctionData({ abi: KernelExecuteAbi, data: callData });
    const executionCalldata = args[1] as Hex;
    const uninstallCalldata = `0x${executionCalldata.slice(2 + 40 + 64)}`;
    const decoded = decodeFunctionData({ abi: ERC7579Abi, data: uninstallCalldata });
    expect(decoded.functionName).toBe('uninstallModule');
  });
});
