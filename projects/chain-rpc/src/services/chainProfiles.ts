/**
 * DC-8: 链类型 Profile 抽象。
 *
 * 每链类型（EVM / Solana / 未来 Cosmos、Polkadot…）定义其 RPC 语义差异：
 * 健康检查方法、最新块/槽方法、广播方法、确认轮询方法、读方法白名单。
 * rpcPool 与 whitelist 中的 EVM/Solana 特判改为查表，接入新链只需新增
 * 一个 profile（并补充 normalizeChain 别名与端点配置），无需改业务分支。
 */
import { normalizeChain } from './rpcPoolConfig';

export interface ChainProfile {
  key: string;                       // evm | solana | …
  readMethods: Set<string>;          // 读方法白名单
  healthMethod: string;              // 健康检查 RPC 方法
  healthOk: (result: any) => boolean;
  latestBlockMethod: string;         // 最新块（EVM）/ 最新槽（Solana）
  latestBlockParse: (result: any) => number;
  broadcastMethod: string;           // 广播方法
  receiptMethod: string;             // 确认轮询方法
  receiptParams: (txHash: string) => any[];
  receiptConfirmed: (result: any) => boolean;
}

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
  'getSignatureStatuses',
  'getSignaturesForAddress',
  'getTokenAccountsByOwner',
  'getRecentPrioritizationFees',
]);

const EVM_PROFILE: ChainProfile = {
  key: 'evm',
  readMethods: EVM_READ_METHODS,
  healthMethod: 'eth_blockNumber',
  healthOk: (r) => parseInt(r, 16) > 0,
  latestBlockMethod: 'eth_blockNumber',
  latestBlockParse: (r) => parseInt(r, 16),
  broadcastMethod: 'eth_sendRawTransaction',
  receiptMethod: 'eth_getTransactionReceipt',
  receiptParams: (h) => [h],
  receiptConfirmed: (r) => !!r,
};

const SOLANA_PROFILE: ChainProfile = {
  key: 'solana',
  readMethods: SOLANA_READ_METHODS,
  healthMethod: 'getHealth',
  healthOk: (r) => r === 'ok',
  latestBlockMethod: 'getSlot',
  latestBlockParse: (r) => parseInt(r, 10) || 0,
  broadcastMethod: 'sendTransaction',
  receiptMethod: 'getSignatureStatuses',
  receiptParams: (h) => [[h]],
  receiptConfirmed: (r) => {
    const s = r?.value?.[0] || null;
    return s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized';
  },
};

/** 按链名（支持别名，先 normalize）取 profile；未知链默认 EVM */
export function profileFor(chain: string): ChainProfile {
  const norm = normalizeChain(chain);
  return norm === 'solana' ? SOLANA_PROFILE : EVM_PROFILE;
}
