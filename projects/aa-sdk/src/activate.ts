import { parseAbi, type Address, type Hex, type Transport } from 'viem';
import type { ChainAAConfig, Signer, UserOperationV7 } from './types.js';
import { createKernelAccount, createAAClient } from './smart-account.js';
import { buildUserOp, signUserOp } from './userop.js';
import { BundlerClient } from './bundler.js';
import { rootNonceKey } from './nonce.js';

// ============================================================================
// 智能账户激活编排（对齐 §5.2 完整执行流程 + AA_UI_STATE_MACHINE 状态机）
// 单次调用完成：地址预测 → 部署状态 → nonce → gas/fee 估算 → 构建 → 签名 → 广播 → 收据
// counterfactual 懒部署：首笔 UserOp 携带 factory/factoryData 顺带部署（§5.4）。
// 零硬编码：全部地址/端点来自 ChainAAConfig（env 注入）。
// ============================================================================

/** 激活阶段（E1：UI 展示 signing/broadcasting 子状态信号） */
export type ActivateStage = 'sign' | 'broadcast' | 'confirmed';

export interface ActivateSmartAccountParams {
  /** Kernel owner（签名器：私钥 / MPC / MetaMask 等） */
  owner: Signer;
  chainConfig: ChainAAConfig;
  /** 激活后的首个调用（缺省 = 空调用，仅完成账户部署） */
  call?: { target: Address; value?: bigint; data?: Hex };
  /** create2 salt（缺省 0） */
  salt?: bigint;
  /** 等待收据超时（ms，缺省 120s） */
  waitTimeoutMs?: number;
  /** 阶段回调（可选：sign → broadcast → confirmed；UI 据此展示子状态） */
  onStage?: (stage: ActivateStage) => void;
  /** 测试注入 transport */
  transport?: Transport;
}

export interface ActivateSmartAccountResult {
  /** Kernel 智能账户地址（create2 预测地址） */
  address: Address;
  /** 是否本次新部署（false = 账户已存在，仅发起交易） */
  deployed: boolean;
  /** 部署工厂（未部署时首笔 UserOp 携带） */
  factory?: Address;
  /** UserOp 哈希 */
  userOpHash: Hex;
  /** 交易哈希（收据确认后） */
  txHash?: Hex;
  /** 实际使用的 bundler 端点 */
  bundlerUrl: string;
  /** 收据状态（收据轮询成功后；undefined = 未确认/幂等返回） */
  receiptStatus?: 'success' | 'failed';
}

/** EntryPoint v0.7 getNonce（sender, key=0 常规 nonce 序列） */
export const entryPointAbi = parseAbi([
  'function getNonce(address sender, uint192 key) view returns (uint256)',
]);

/** 估算失败时的保守 gas 兜底（避免 0 被 bundler 拒绝；UI 展示时标注为估算失败兜底） */
const FALLBACK_GAS = {
  callGasLimit: 1_500_000n,
  verificationGasLimit: 500_000n,
  preVerificationGas: 50_000n,
} as const;

/** baseFee / gas price 估算兜底（1 gwei；避免 fee 为零被 bundler 拒绝） */
const DEFAULT_GAS_PRICE = 1_000_000_000n;

/** 从链上读取 EIP-1559 fee（eth_maxPriorityFeePerGas + latest block baseFee） */
export async function estimateFeesPerGas(
  chainConfig: ChainAAConfig,
  transport?: Transport,
): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
  const client = createAAClient(chainConfig, transport);
  const tip = (await client.request({ method: 'eth_maxPriorityFeePerGas' })) as Hex;
  const block = (await client.request({
    method: 'eth_getBlockByNumber',
    params: ['latest', false],
  })) as { baseFeePerGas?: Hex } | null;
  const baseFee = block?.baseFeePerGas ? BigInt(block.baseFeePerGas) : DEFAULT_GAS_PRICE;
  const maxPriorityFeePerGas = BigInt(tip);
  return { maxFeePerGas: baseFee * 2n + maxPriorityFeePerGas, maxPriorityFeePerGas };
}

/**
 * 激活智能账户：一次调用完成 地址预测→nonce→gas/fee→签名→广播→收据。
 * 已部署账户跳过部署成本（首笔交易照常发起）；未部署账户首笔 UserOp 顺带部署。
 */
export async function activateSmartAccount(
  params: ActivateSmartAccountParams,
): Promise<ActivateSmartAccountResult> {
  const { owner, chainConfig } = params;

  // ① 地址预测 + 部署状态 + factory（counterfactual，无需上链）
  const account = await createKernelAccount(
    { owner, chainConfig, salt: params.salt },
    params.transport,
  );
  const { address, factory, factoryData } = account;

  // ② nonce（EntryPoint 管理的常规序列 key=0，即 ROOT validator nonce key）
  const client = createAAClient(chainConfig, params.transport);
  const nonce = (await client.readContract({
    address: chainConfig.entryPoint,
    abi: entryPointAbi,
    functionName: 'getNonce',
    args: [address, rootNonceKey],
  })) as bigint;

  // ③ 默认调用：空转账给自己（仅触发部署；Kernel 不限制 self call）
  const call = params.call ?? { target: address, value: 0n, data: '0x' as Hex };
  const activationCall = { target: call.target, value: call.value ?? 0n, data: call.data ?? ('0x' as Hex) };

  // ④ 构建未签名 UserOp（未部署时携带 factory/factoryData）
  let op: UserOperationV7 = buildUserOp({
    sender: address,
    nonce,
    call: activationCall,
    factory: account.isDeployed ? undefined : factory,
    factoryData: account.isDeployed ? undefined : factoryData,
  });

  // ⑤ gas + fee 估算（估算失败用保守兜底，不阻断激活）
  const bundler = new BundlerClient(chainConfig);
  try {
    const est = await bundler.estimateUserOperationGas(op);
    op = { ...op, ...est };
  } catch {
    op = { ...op, ...FALLBACK_GAS };
  }
  try {
    const fee = await estimateFeesPerGas(chainConfig, params.transport);
    op = { ...op, ...fee };
  } catch {
    op = { ...op, maxFeePerGas: DEFAULT_GAS_PRICE, maxPriorityFeePerGas: DEFAULT_GAS_PRICE };
  }

  // ⑥ 签名（owner 对 EIP-712 userOpHash 签名）
  op = await signUserOp(op, chainConfig.entryPoint, chainConfig.chainId, owner);
  params.onStage?.('sign');

  // ⑦ 广播 + 轮询收据（内置多端点容灾；广播成功回调用于 UI broadcasting 子状态）
  const result = await bundler.sendUserOperation(op, {
    waitTimeoutMs: params.waitTimeoutMs,
    onBroadcast: () => params.onStage?.('broadcast'),
  });
  params.onStage?.('confirmed');

  return {
    address,
    deployed: !account.isDeployed,
    factory,
    userOpHash: result.userOpHash,
    txHash: result.receipt?.txHash,
    bundlerUrl: result.bundlerUrl,
    receiptStatus: result.receipt ? (result.receipt.success ? 'success' : 'failed') : undefined,
  };
}
