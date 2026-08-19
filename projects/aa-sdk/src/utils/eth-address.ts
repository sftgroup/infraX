import { isAddress as viemIsAddress, getAddress } from 'viem';

// ============================================================================
// 地址工具（viem 封装）
// ============================================================================

/** 校验地址合法性（含 checksum） */
export function isAddress(address: unknown): address is `0x${string}` {
  return typeof address === 'string' && viemIsAddress(address);
}

/** 规范化地址（EIP-55 checksum） */
export function toChecksummedAddress(address: string): `0x${string}` {
  return getAddress(address);
}

/** 大小写不敏感比较两个地址 */
export function addressesEqual(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
