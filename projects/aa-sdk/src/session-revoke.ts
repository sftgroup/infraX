import { parseAbi, type Address, type Hex, type PublicClient } from 'viem';
import type { ChainAAConfig, SessionPolicy, UserOperationV7 } from './types.js';
import { entryPointAbi } from './activate.js';
import { rootNonceKey } from './nonce.js';
import { getUserOpHash } from './userop.js';
import {
  encodeDisableSessionBatch,
  encodeReplaceSessionBatch,
  toBytes32,
  type SessionModuleDataBuilder,
} from './session-module.js';

// ============================================================================
// AA-1：disable 上链闭环 —— 撤销 UserOp draft 构建（root nonce + 批量撤销）
// 调用方（aa-relay / 业务方）先构建 draft（估 gas 后可重调注入 gas 重算 hash），
// owner 对 userOpHash 签名后回传，relay 校验签名并广播（见 aa-relay /v1/session/revoke）。
// 对齐 AgentX 修复文档（docs/aa-relay-session-rollover-fix-infrax.md §2.4/§3 路径 A）：
//   callData = execute(BATCH, [uninstallModule, invalidateNonce(cur+1)])
// ============================================================================

export interface BuildDisableSessionUserOpParams {
  /** viem PublicClient（链上读 currentNonce / EntryPoint.getNonce） */
  client: PublicClient;
  chainConfig: ChainAAConfig;
  account: Address;
  sessionId: string;
  /** gas/fee 覆盖（建议先估算再注入重算 hash；缺省 0 = 调用方自行补） */
  gas?: Partial<
    Pick<
      UserOperationV7,
      'callGasLimit' | 'verificationGasLimit' | 'preVerificationGas' | 'maxFeePerGas' | 'maxPriorityFeePerGas'
    >
  >;
  dataBuilder?: SessionModuleDataBuilder;
}

export interface DisableSessionDraft {
  /** 未签名 UserOp（signature='0x'；callData = 批量 uninstall + invalidateNonce） */
  op: UserOperationV7;
  /** owner 需签名的 userOpHash（EIP-712 v0.7） */
  userOpHash: Hex;
  /** 账户 currentNonce()（uint32）；invalidate 目标 = currentNonce + 1 */
  currentNonce: number;
  sessionIdBytes: Hex;
}

/** Kernel currentNonce() ABI（uint32） */
const KernelCurrentNonceAbi = parseAbi(['function currentNonce() view returns (uint32)']);

/**
 * 构建 disable UserOp draft（root nonce key = 0，owner ECDSA 签名上链）。
 * 注意：EIP-712 digest 绑定构建时 nonce/gas —— gas 估算后必须**重新调用本函数
 * （传入估算 gas）以重算 userOpHash**，再交给 owner 签名。
 */
export async function buildDisableSessionUserOp(
  p: BuildDisableSessionUserOpParams,
): Promise<DisableSessionDraft> {
  // ① 当前账户 nonce（invalidateNonce 目标 = cur + 1）
  const currentNonce = (await p.client.readContract({
    address: p.account,
    abi: KernelCurrentNonceAbi,
    functionName: 'currentNonce',
  })) as number;

  // ② root nonce（EntryPoint 常规序列 key=0，ROOT validator 上链）
  const nonce = (await p.client.readContract({
    address: p.chainConfig.entryPoint,
    abi: entryPointAbi,
    functionName: 'getNonce',
    args: [p.account, rootNonceKey],
  })) as bigint;

  // ③ 批量撤销 callData（uninstall + invalidateNonce）
  const callData = encodeDisableSessionBatch({
    accountAddress: p.account,
    sessionId: p.sessionId,
    chainConfig: p.chainConfig,
    currentNonce,
    dataBuilder: p.dataBuilder,
  });

  const op: UserOperationV7 = {
    sender: p.account,
    nonce,
    callData,
    callGasLimit: p.gas?.callGasLimit ?? 0n,
    verificationGasLimit: p.gas?.verificationGasLimit ?? 0n,
    preVerificationGas: p.gas?.preVerificationGas ?? 0n,
    maxFeePerGas: p.gas?.maxFeePerGas ?? 0n,
    maxPriorityFeePerGas: p.gas?.maxPriorityFeePerGas ?? 0n,
    signature: '0x',
  };
  const userOpHash = getUserOpHash(op, p.chainConfig.entryPoint, p.chainConfig.chainId);
  return { op, userOpHash, currentNonce, sessionIdBytes: toBytes32(p.sessionId) };
}

export interface BuildReplaceSessionUserOpParams {
  /** viem PublicClient（链上读 currentNonce / EntryPoint.getNonce） */
  client: PublicClient;
  chainConfig: ChainAAConfig;
  account: Address;
  /** 当前链上绑定的旧 sessionId（uninstall + 推进 nonce 目标） */
  oldSessionId: string;
  /** 新 session 策略（install + enableSession 目标，AA-7 轮换） */
  policy: SessionPolicy;
  /** gas/fee 覆盖（建议先估算再注入重算 hash；缺省 0 = 调用方自行补） */
  gas?: Partial<
    Pick<
      UserOperationV7,
      'callGasLimit' | 'verificationGasLimit' | 'preVerificationGas' | 'maxFeePerGas' | 'maxPriorityFeePerGas'
    >
  >;
  dataBuilder?: SessionModuleDataBuilder;
}

export interface ReplaceSessionDraft {
  /** 未签名 UserOp（signature='0x'；callData = 批量 uninstall + invalidateNonce + install） */
  op: UserOperationV7;
  /** owner 需签名的 userOpHash（EIP-712 v0.7） */
  userOpHash: Hex;
  /** 账户 currentNonce()（uint32）；invalidate 目标 = currentNonce + 1 */
  currentNonce: number;
  oldSessionIdBytes: Hex;
}

/**
 * AA-7：构建"单笔轮换"UserOp draft（root nonce key = 0，owner ECDSA 签名上链）。
 * 一次 UserOp 完成 撤销旧 session + 推进 nonce + 安装新 session（C1 幂等覆盖的 SDK
 * 层等价实现，不改合约）：owner 仅签一次，链上原子完成轮换。
 * 注意：EIP-712 digest 绑定构建时 nonce/gas —— gas 估算后必须**重新调用本函数
 * （传入估算 gas）以重算 userOpHash**，再交给 owner 签名。
 */
export async function buildReplaceSessionUserOp(
  p: BuildReplaceSessionUserOpParams,
): Promise<ReplaceSessionDraft> {
  // ① 当前账户 nonce（invalidateNonce 目标 = cur + 1）
  const currentNonce = (await p.client.readContract({
    address: p.account,
    abi: KernelCurrentNonceAbi,
    functionName: 'currentNonce',
  })) as number;

  // ② root nonce（EntryPoint 常规序列 key=0，ROOT validator 上链）
  const nonce = (await p.client.readContract({
    address: p.chainConfig.entryPoint,
    abi: entryPointAbi,
    functionName: 'getNonce',
    args: [p.account, rootNonceKey],
  })) as bigint;

  // ③ 单笔轮换 callData（uninstall + invalidateNonce + install）
  const callData = encodeReplaceSessionBatch({
    accountAddress: p.account,
    oldSessionId: p.oldSessionId,
    policy: p.policy,
    chainConfig: p.chainConfig,
    currentNonce,
    dataBuilder: p.dataBuilder,
  });

  const op: UserOperationV7 = {
    sender: p.account,
    nonce,
    callData,
    callGasLimit: p.gas?.callGasLimit ?? 0n,
    verificationGasLimit: p.gas?.verificationGasLimit ?? 0n,
    preVerificationGas: p.gas?.preVerificationGas ?? 0n,
    maxFeePerGas: p.gas?.maxFeePerGas ?? 0n,
    maxPriorityFeePerGas: p.gas?.maxPriorityFeePerGas ?? 0n,
    signature: '0x',
  };
  const userOpHash = getUserOpHash(op, p.chainConfig.entryPoint, p.chainConfig.chainId);
  return { op, userOpHash, currentNonce, oldSessionIdBytes: toBytes32(p.oldSessionId) };
}

/** 校验 owner 对 disable userOpHash 的 ECDSA 签名是否有效（供 relay revoke 校验） */
export async function verifyDisableSignature(params: {
  userOpHash: Hex;
  signature: Hex;
  owner: Address;
}): Promise<boolean> {
  const { recoverAddress } = await import('viem');
  try {
    const recovered = await recoverAddress({ hash: params.userOpHash, signature: params.signature });
    return recovered.toLowerCase() === params.owner.toLowerCase();
  } catch {
    return false;
  }
}
