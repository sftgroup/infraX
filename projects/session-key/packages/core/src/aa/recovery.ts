import type { RecoveryConfig } from './types.js';

// ============================================================================
// 社交恢复（MVP 后置，接口预留，对齐 §12 边界）
// 邮箱恢复走 MPC（P0 差异化能力）；链上 guardian 恢复为远期扩展。
// ============================================================================

/** 读取当前恢复配置（guardians / threshold） */
export async function getRecoveryConfig(_accountAddress: `0x${string}`): Promise<RecoveryConfig | null> {
  // TODO(远期): 查询 Kernel recovery 模块状态
  throw new Error('getRecoveryConfig not implemented yet (post-MVP)');
}

/** 发起恢复流程（guardian 签名收集） */
export async function initiateRecovery(_config: RecoveryConfig): Promise<string> {
  // TODO(远期)
  throw new Error('initiateRecovery not implemented yet (post-MVP)');
}
