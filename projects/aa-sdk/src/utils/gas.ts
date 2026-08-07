import type { UserOperationV7 } from '../types.js';

// ============================================================================
// gas 估算（对齐 §5.5：paymaster 模式流程）
// 流程：stubData(不计费) → eth_estimateUserOperationGas → 正式 paymasterData → 发送
// TODO(实现/M2): 填充真实估算逻辑（bundler.estimateUserOperationGas 之上编排）
// ============================================================================

export interface GasEstimateResult {
  op: UserOperationV7;
}

/** 估算并填充 UserOp 的全部 gas 字段（paymaster 模式下两次调用） */
export async function estimateUserOpGas(op: UserOperationV7): Promise<GasEstimateResult> {
  // TODO(实现/M2): 1) paymaster stubData → 2) eth_estimateUserOperationGas → 3) 填充字段
  void op;
  throw new Error('estimateUserOpGas not implemented yet (M2)');
}
