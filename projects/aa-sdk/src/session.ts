// ============================================================================
// Session Key 权限管理 barrel（对齐 §7.2-§7.3，角色 B 免确认交易核心）
// 按职责拆分（原 721 行单文件 → 4 个内聚模块）：
//   - session-store.ts   本地登记表 + 生命周期（create/revoke/list）
//   - session-module.ts  链上 enable/disable 编码（模块 ABI + data builder）
//   - session-enable.ts  ENABLE-mode enable（EIP-712 digest）+ agent 调用 UserOp
//   - session-validate.ts 权限校验（纯函数）
// 安全边界：白名单 + 单笔/日限额 + 有效期；session key 无权改 owner。
// ============================================================================

export * from './session-store.js';
export * from './session-module.js';
export * from './session-enable.js';
export * from './session-revoke.js';
export * from './session-validate.js';
