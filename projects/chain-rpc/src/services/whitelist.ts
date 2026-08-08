/**
 * 链上 RPC 读方法白名单。
 *
 * chain-rpc 作为全仓唯一链上 RPC 网关，只代理「只读」方法与「广播」方法：
 *  - 读方法走白名单（无状态、无副作用，安全）——按链类型查 ChainProfile（DC-8）
 *  - 广播仅 eth_sendRawTransaction / sendTransaction（调用方自持私钥签名，网关不持有任何私钥）
 *  - 其余方法（personal_* / eth_sendTransaction / admin_* 等）一律拒绝
 */
import { profileFor } from './chainProfiles';

export function isReadMethod(chain: string, method: string): boolean {
  const m = (method || '').trim();
  if (!m) return false;
  return profileFor(chain).readMethods.has(m);
}

// DC-4: 广播支持 EVM eth_sendRawTransaction + Solana sendTransaction
export const BROADCAST_METHODS = new Set(['eth_sendRawTransaction', 'sendTransaction']);

export function isBroadcastMethod(method: string): boolean {
  return BROADCAST_METHODS.has((method || '').trim());
}
