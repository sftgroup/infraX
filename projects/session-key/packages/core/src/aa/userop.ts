import {
  concatHex,
  encodeAbiParameters,
  encodeFunctionData,
  toHex,
  type Address,
  type Hex,
} from 'viem';
import { getUserOperationHash, type UserOperation } from 'viem/account-abstraction';
import type { Signer, UserOperationV7 } from './types.js';

// ============================================================================
// UserOp 构建 / 编码 / 签名（ERC-4337 v0.7，对齐 §5.1-§5.3，M2 实现）
// callData = Kernel v3 execute(execMode, executionCalldata)（ERC-7579 单调用模式）
// userOpHash = viem getUserOperationHash（v0.7 EIP-712，含 chainId 防跨链重放）
// 批量（batchcall）见 encodeExecuteBatch（AA-2 对齐 aa-sdk）。
// ============================================================================

/** Kernel v3 execute ABI（ERC-7579：execMode + executionCalldata） */
const KernelV3ExecuteAbi = [
  {
    type: 'function',
    name: 'execute',
    inputs: [
      { name: 'execMode', type: 'bytes32', internalType: 'ExecMode' },
      { name: 'executionCalldata', type: 'bytes', internalType: 'bytes' },
    ],
    outputs: [],
    stateMutability: 'payable',
  },
] as const;

/**
 * DEFAULT execMode（ERC-7579 root / call / no-revert-on-error）：
 * callType=0x00 + revertOnError=0x00 + selector=0 + context=0 → 全零 bytes32。
 */
const DEFAULT_EXEC_MODE =
  '0x0000000000000000000000000000000000000000000000000000000000000000' as Hex;

/**
 * 编码 Kernel v3 单调用 callData（ERC-7579 DEFAULT 模式）：
 *   executionCalldata = concatHex([target, toHex(value, 32), data])
 * 批量（batchcall，多个 call）见 encodeExecuteBatch。
 */
export function encodeExecute(target: Address, value: bigint, data: Hex): Hex {
  return encodeFunctionData({
    abi: KernelV3ExecuteAbi,
    functionName: 'execute',
    args: [
      DEFAULT_EXEC_MODE,
      concatHex([target, toHex(value ?? 0n, { size: 32 }), data ?? '0x']),
    ],
  });
}

/** 批量执行单条（ERC-7579 Execution = (target, value, data)） */
export interface Execution {
  target: Address;
  value?: bigint;
  data: Hex;
}

/**
 * BATCH execMode（Kernel v3 ExecLib.encodeSimpleBatch()，AA-2/AA-7 链上实证）：
 *   CALLTYPE_BATCH(0x01) | EXECTYPE_DEFAULT(0x00) → 高 2 字节 0x0100，其余 0（MSB 布局）。
 */
export const BATCH_EXEC_MODE =
  '0x0100000000000000000000000000000000000000000000000000000000000000' as Hex;

/** ERC-7579 Execution 结构体（abi.encode(Execution[])） */
const ExecutionTuple = [
  { name: 'target', type: 'address' },
  { name: 'value', type: 'uint256' },
  { name: 'data', type: 'bytes' },
] as const;

/**
 * 编码 Kernel v3 批量调用 callData（AA-2，会话轮换/disable 上链用）：
 *   callData = execute(BATCH_EXEC_MODE, abi.encode(Execution[]))
 * ⚠️ Kernel v3 无独立 executeBatch —— 批量只能走 execute(execMode, calldata)
 *   （链上实证，见 docs/aa-relay-session-rollover-fix-infrax.md §2.4）。
 */
export function encodeExecuteBatch(executions: Execution[]): Hex {
  const normalized = executions.map((e) => ({ target: e.target, value: e.value ?? 0n, data: e.data }));
  return encodeFunctionData({
    abi: KernelV3ExecuteAbi,
    functionName: 'execute',
    args: [
      BATCH_EXEC_MODE,
      encodeAbiParameters(
        [{ name: 'executions', type: 'tuple[]', components: ExecutionTuple }],
        [normalized],
      ),
    ],
  });
}

export interface BuildUserOpParams {
  sender: Address;
  nonce: bigint;
  /** 交易意图：execute(target, value, data) */
  call: {
    target: Address;
    value?: bigint;
    data: Hex;
  };
  /** 首次部署时携带（§5.4 counterfactual） */
  factory?: Address;
  factoryData?: Hex;
  gas?: Partial<
    Pick<
      UserOperationV7,
      'callGasLimit' | 'verificationGasLimit' | 'preVerificationGas' | 'maxFeePerGas' | 'maxPriorityFeePerGas'
    >
  >;
}

/**
 * 构建 UserOp v0.7（未签名）。
 * gas 字段缺省时走估算（见 utils/gas.ts + bundler.estimateUserOperationGas，M3）。
 */
export function buildUserOp(params: BuildUserOpParams): UserOperationV7 {
  return {
    sender: params.sender,
    nonce: params.nonce,
    factory: params.factory,
    factoryData: params.factoryData,
    callData: encodeExecute(params.call.target, params.call.value ?? 0n, params.call.data),
    callGasLimit: params.gas?.callGasLimit ?? 0n,
    verificationGasLimit: params.gas?.verificationGasLimit ?? 0n,
    preVerificationGas: params.gas?.preVerificationGas ?? 0n,
    maxFeePerGas: params.gas?.maxFeePerGas ?? 0n,
    maxPriorityFeePerGas: params.gas?.maxPriorityFeePerGas ?? 0n,
    signature: '0x',
  };
}

/**
 * 计算 EIP-712 userOpHash（v0.7 标准 EIP-712，区别于 v0.6 特殊 prefix）。
 * 参数含 chainId —— 防跨链重放（§5.3）。
 */
export function getUserOpHash(op: UserOperationV7, entryPoint: Address, chainId: number): Hex {
  return getUserOperationHash({
    chainId,
    entryPointAddress: entryPoint,
    entryPointVersion: '0.7',
    userOperation: op as unknown as UserOperation<'0.7'>,
  });
}

/** 完整流程：build → hash → sign → 返回带签名 UserOp */
export async function signUserOp(
  op: UserOperationV7,
  entryPoint: Address,
  chainId: number,
  signer: Signer,
): Promise<UserOperationV7> {
  const hash = getUserOpHash(op, entryPoint, chainId);
  const signature = await signer.signUserOp(hash);
  return { ...op, signature };
}

// --- v0.7 PackedUserOperation（EntryPoint.handleOps / v0.7 bundler RPC） -------

/**
 * v0.7 PackedUserOperation（9 字段，全 hex）：
 *   accountGasLimits = verificationGasLimit(16B) + callGasLimit(16B)
 *   gasFees          = maxPriorityFeePerGas(16B) + maxFeePerGas(16B)
 *   initCode         = factory + factoryData（无部署则 '0x'）
 *   paymasterAndData = paymaster + paymasterData（无 paymaster 则 '0x'）
 * 用途：EntryPoint.handleOps 直接上链（绕过 bundler）、v0.7 bundler eth_sendUserOperation。
 */
export interface PackedUserOperationV7 {
  sender: Address;
  nonce: Hex;
  initCode: Hex;
  callData: Hex;
  accountGasLimits: Hex;
  preVerificationGas: Hex;
  gasFees: Hex;
  paymasterAndData: Hex;
  signature: Hex;
}

export function packUserOpV7(op: UserOperationV7): PackedUserOperationV7 {
  const verificationGasLimit = op.verificationGasLimit + (op.paymasterVerificationGasLimit ?? 0n);
  const callGasLimit = op.callGasLimit + (op.paymasterPostOpGasLimit ?? 0n);
  return {
    sender: op.sender,
    nonce: toHex(op.nonce),
    initCode: op.factory && op.factoryData ? concatHex([op.factory, op.factoryData]) : '0x',
    callData: op.callData,
    accountGasLimits: concatHex([toHex(verificationGasLimit, { size: 16 }), toHex(callGasLimit, { size: 16 })]),
    preVerificationGas: toHex(op.preVerificationGas),
    gasFees: concatHex([toHex(op.maxPriorityFeePerGas, { size: 16 }), toHex(op.maxFeePerGas, { size: 16 })]),
    paymasterAndData: op.paymaster ? concatHex([op.paymaster, op.paymasterData ?? '0x']) : '0x',
    signature: op.signature,
  };
}
