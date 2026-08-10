import type { Address } from 'viem';

// ============================================================================
// Kernel v3 nonce 编码（ValidatorLib.encodeAsNonceKey）
// EntryPoint nonce = nonceKey << 64 | sequence；Kernel v3 用 nonceKey 路由到
// 具体 validator 与验证模式：
//   nonceKey = (mode << 184) | (vType << 176) | (validator << 16) | nonceKey
// ENABLE-mode：一次 UserOp 完成"模块安装 + 用户签名"（enable 期间任意执行调用）。
// 已链上验证：direct handleOps 成功安装 session module（见 scripts/dbg-enable-revert.ts）。
// ============================================================================

/** ValidationMode.ENABLE（Kernel v3 types/Constants.sol） */
export const VALIDATION_MODE_ENABLE = 1;
/** ValidationMode.DEFAULT（常规验证） */
export const VALIDATION_MODE_DEFAULT = 0;
/** ValidationType.VALIDATOR（vId = 0x01 + 20B 地址） */
export const VALIDATION_TYPE_VALIDATOR = 1;
/** ValidationType.ROOT */
export const VALIDATION_TYPE_ROOT = 0;

/** ROOT validator 的 nonce key（= 0，即 EntryPoint 默认 nonce 序列） */
export const rootNonceKey = 0n;

/**
 * Kernel v3 nonce key 编码（对齐 ValidatorLib.encodeAsNonceKey assembly）：
 *   key = (mode << 184) | (vType << 176) | (validator << 16) | nonceKey
 * @param mode     验证模式（0=DEFAULT，1=ENABLE）
 * @param vType    验证类型（0=ROOT，1=VALIDATOR）
 * @param validator validator 地址（低 160 位）
 * @param nonceKey  模块内自定义 key（缺省 0）
 */
export function encodeAsNonceKey(mode: number, vType: number, validator: Address, nonceKey: number | bigint = 0): bigint {
  return (BigInt(mode) << 184n) | (BigInt(vType) << 176n) | (BigInt(validator) << 16n) | BigInt(nonceKey);
}

/**
 * ENABLE-mode validator nonce key：安装/启用 validator 的 UserOp 使用
 * （Kernel v3 在 enable 验证中安装模块并校验 EIP-712 enable digest）。
 */
export function enableNonceKey(validator: Address, nonceKey: number | bigint = 0): bigint {
  return encodeAsNonceKey(VALIDATION_MODE_ENABLE, VALIDATION_TYPE_VALIDATOR, validator, nonceKey);
}

/**
 * DEFAULT-mode validator nonce key：已安装 validator 的常规 UserOp 使用
 * （agent session key 调用走此 nonce 路由到 session validator）。
 */
export function validatorNonceKey(validator: Address, nonceKey: number | bigint = 0): bigint {
  return encodeAsNonceKey(VALIDATION_MODE_DEFAULT, VALIDATION_TYPE_VALIDATOR, validator, nonceKey);
}
