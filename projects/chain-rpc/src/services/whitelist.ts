/**
 * 链上 RPC 读方法白名单。
 *
 * chain-rpc 作为全仓唯一链上 RPC 网关，只代理「只读」方法与「广播」方法：
 *  - 读方法走白名单（无状态、无副作用，安全）
 *  - 广播仅 eth_sendRawTransaction（调用方自持私钥签名，网关不持有任何私钥）
 *  - 其余方法（personal_* / eth_sendTransaction / admin_* 等）一律拒绝
 */

export const EVM_READ_METHODS = new Set([
  'web3_clientVersion',
  'net_version',
  'eth_chainId',
  'eth_blockNumber',
  'eth_gasPrice',
  'eth_maxPriorityFeePerGas',
  'eth_feeHistory',
  'eth_getBalance',
  'eth_getTransactionCount',
  'eth_getCode',
  'eth_getStorageAt',
  'eth_call',
  'eth_estimateGas',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
  'eth_getLogs',
  'eth_getUncleCountByBlockNumber',
  'eth_getBlockTransactionCountByNumber',
]);

export const SOLANA_READ_METHODS = new Set([
  'getVersion',
  'getHealth',
  'getSlot',
  'getBlockHeight',
  'getBlock',
  'getBlockTime',
  'getBalance',
  'getAccountInfo',
  'getTransaction',
  'getSignaturesForAddress',
  'getTokenAccountsByOwner',
  'getRecentPrioritizationFees',
]);

export function isReadMethod(chain: string, method: string): boolean {
  const m = (method || '').trim();
  if (!m) return false;
  if (chain === 'solana') return SOLANA_READ_METHODS.has(m);
  return EVM_READ_METHODS.has(m);
}

export const BROADCAST_METHODS = new Set(['eth_sendRawTransaction']);
