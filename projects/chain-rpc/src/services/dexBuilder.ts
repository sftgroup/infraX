/**
 * A-11.2: DEX 未签名交易构建器（dex.approve / dex.swap）。
 *
 * 安全约束（与需求单一致）：
 *   - 只构建 rawTransaction 字段（to/data/value/chainId/gasLimit），不签名、不持有私钥；
 *   - rawTransaction 由调用方补齐 nonce/gasPrice 后本地签名（MPC sign-digest 或钱包），
 *     再交 /v1/broadcast/:chain 广播；
 *   - A-11.6：gasLimit 预估上限保护（approve ≤ dexMaxApproveGas、swap ≤ dexMaxSwapGas，
 *     防超长 calldata 滥用）；预估失败回退保守默认值并在响应标注 estimated。
 */
import { ethers } from 'ethers';
import { config } from '../config';
import { ChainRpcError, RpcPoolManager } from './rpcPool';
import { CHAIN_IDS, normalizeChain } from './rpcPoolConfig';

export interface RawTransaction {
  to: string;
  data: string;
  value: string;      // wei 字符串
  chainId: number;
  gasLimit?: string;  // 十进制
  estimated?: boolean; // true = 预估失败回退默认值
}

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
];

/** 预估地址（调用方未传时）：EVM 对零地址的 estimateGas 基本等价 */
const DUMMY_FROM = '0x0000000000000000000000000000000000000001';

/**
 * 链上 gas 预估（eth_estimateGas，走池）。失败返回 null（上层回退保守默认）。
 */
export async function estimateGas(
  pool: RpcPoolManager,
  chain: string,
  tx: { from?: string; to: string; data: string; value?: string },
): Promise<bigint | null> {
  try {
    const res = await pool.call(chain, 'eth_estimateGas', [
      {
        from: tx.from || DUMMY_FROM,
        to: tx.to,
        data: tx.data,
        value: tx.value && tx.value !== '0' ? tx.value : undefined,
      },
    ]);
    if (typeof res === 'string' && /^0x[0-9a-fA-F]+$/.test(res)) return BigInt(res);
  } catch {
    /* 预估失败回退默认 */
  }
  return null;
}

/**
 * dex.approve：构建 ERC20 approve 未签名 tx。
 * amount=0（或 '0'）→ max uint256；否则按给定 wei。
 */
export async function buildApproveTx(
  pool: RpcPoolManager,
  chain: string,
  params: { token: string; spender: string; amount?: string; from?: string },
): Promise<RawTransaction> {
  const norm = normalizeChain(chain);
  const chainId = norm ? CHAIN_IDS[norm] : undefined;
  if (!chainId) throw new ChainRpcError(`Unsupported chain: ${chain}`, 'unsupported_chain', 400);
  if (!/^0x[0-9a-fA-F]{40}$/.test(params.token) || !/^0x[0-9a-fA-F]{40}$/.test(params.spender)) {
    throw new ChainRpcError('token/spender must be valid 0x address', 'invalid_address', 400);
  }
  const amount = params.amount === undefined || params.amount === '' || params.amount === '0'
    ? ethers.MaxUint256
    : BigInt(params.amount);
  const iface = new ethers.Interface(ERC20_ABI);
  const data = iface.encodeFunctionData('approve', [params.spender, amount]);

  const est = await estimateGas(pool, chain, { from: params.from, to: params.token, data });
  const cap = BigInt(config.dexMaxApproveGas);
  const gasLimit = est && est <= cap ? est : (est && est > cap ? cap : 60_000n);
  return {
    to: params.token,
    data,
    value: '0',
    chainId,
    gasLimit: gasLimit.toString(),
    estimated: !est || est > cap,
  };
}

/**
 * dex.swap：包装聚合器 swap 构建结果为未签名 tx 字段，gasLimit 上限保护。
 * tx 源 = 聚合器返回（OKX/1inch swap API 的 tx 字段）。
 */
export async function buildSwapTx(
  pool: RpcPoolManager,
  chain: string,
  tx: { to: string; data: string; value?: string; gasLimit?: string },
  opts: { from?: string; maxGas?: number } = {},
): Promise<RawTransaction> {
  const norm = normalizeChain(chain);
  const chainId = norm ? CHAIN_IDS[norm] : undefined;
  if (!chainId) throw new ChainRpcError(`Unsupported chain: ${chain}`, 'unsupported_chain', 400);
  if (!/^0x[0-9a-fA-F]{40}$/.test(tx.to) || !tx.data || !/^0x/.test(tx.data)) {
    throw new ChainRpcError('invalid swap tx (to/data)', 'invalid_swap_tx', 400);
  }
  const cap = BigInt(opts.maxGas ?? config.dexMaxSwapGas);
  // 聚合器自带 gas → 直接用（超限拒绝）；否则链上预估 → 失败回退默认
  let gasLimit: bigint;
  let estimated = false;
  if (tx.gasLimit && /^\d+$/.test(tx.gasLimit)) {
    gasLimit = BigInt(tx.gasLimit);
  } else {
    const est = await estimateGas(pool, chain, { from: opts.from, to: tx.to, data: tx.data, value: tx.value });
    gasLimit = est ?? 500_000n;
    estimated = !est;
  }
  if (gasLimit > cap) {
    throw new ChainRpcError(`gasLimit ${gasLimit} exceeds cap ${cap}`, 'dex_gas_cap_exceeded', 400);
  }
  return {
    to: tx.to,
    data: tx.data,
    value: tx.value || '0',
    chainId,
    gasLimit: gasLimit.toString(),
    estimated,
  };
}
