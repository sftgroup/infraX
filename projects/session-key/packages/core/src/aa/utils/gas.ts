import type { UserOperationV7 } from '../types.js';
import { BundlerClient } from '../bundler.js';
import { PaymasterClient, type PaymasterRequestContext } from '../paymaster.js';

// ============================================================================
// gas 估算（对齐 §5.5：paymaster 模式流程）
// 流程：stubData(不计费) → eth_estimateUserOperationGas → 正式 paymasterData → 填充
// 实现（E-1a）：
//   - 无 paymaster：bundler eth_estimateUserOperationGas 一次填充
//   - 有 paymaster：stubData 填充 paymaster* 字段 → 估算（paymaster 参与验证）→
//     正式 paymasterData 覆盖 stub data → 返回待签名 UserOp
// ============================================================================

export interface GasEstimateResult {
  op: UserOperationV7;
}

export interface EstimateGasOptions {
  /** 链配置（entryPoint/chainId 供 paymaster 域与估算） */
  client: BundlerClient;
  /** 有 paymaster 时必传：estimate 流程编排 */
  paymaster?: PaymasterClient;
  /** paymaster RPC 上下文（chain 别名 + entryPoint + chainId + policyId） */
  paymasterCtx?: PaymasterRequestContext;
}

/** 估算并填充 UserOp 的全部 gas 字段（paymaster 模式下两次调用） */
export async function estimateUserOpGas(
  op: UserOperationV7,
  options: EstimateGasOptions,
): Promise<GasEstimateResult> {
  const { client, paymaster, paymasterCtx } = options;

  // ① paymaster 模式：先取 stub（paymaster 参与 gas 估算的验证阶段）
  let opWithPaymaster = op;
  if (paymaster && paymasterCtx) {
    const stub = await paymaster.getPaymasterStubData(op, paymasterCtx);
    opWithPaymaster = {
      ...op,
      ...stub.op,
    };
  }

  // ② eth_estimateUserOperationGas（含 paymaster 字段时验证阶段按 paymaster 校验）
  const gas = await client.estimateUserOperationGas(opWithPaymaster);
  let filled: UserOperationV7 = {
    ...opWithPaymaster,
    callGasLimit: gas.callGasLimit ?? opWithPaymaster.callGasLimit,
    verificationGasLimit: gas.verificationGasLimit ?? opWithPaymaster.verificationGasLimit,
    preVerificationGas: gas.preVerificationGas ?? opWithPaymaster.preVerificationGas,
  };

  // ③ paymaster 模式：正式 paymasterData 覆盖 stub（真实计费签名）
  if (paymaster && paymasterCtx) {
    const real = await paymaster.getPaymasterData(filled, paymasterCtx);
    filled = { ...filled, ...real.op };
  }

  return { op: filled };
}
