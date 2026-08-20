// ================================================================
// OE-6: InfraXEscrow 链上托管客户端（billing.ts 抽取，单一职责）
// 配置（systemd drop-in 注入，不入 git）：
//   ESCROW_MODE=true
//   ESCROW_RPC_URL=https://rpc.l1.oxachain.io     （或 rpc-oxa.0xainet.top）
//   ESCROW_ADDRESS=0x…                            （InfraXEscrow 代理地址）
//   ESCROW_RELAYER_KEY=0x…                        （授权 relayer 私钥，charge/refund 签名）
//   ESCROW_CHAIN_ID=19505
//   ESCROW_PER_TX_LIMIT_OXA / ESCROW_PER_DAY_LIMIT_OXA   （/v1/plans limits 透出，默认 1/10，须与链上合约默认一致）
// 计费语义：广播前 charge（固定费 + 预估 gas）→ 收据后 refund/extra 退差；
// 资金状态以链上 Escrow 为准（ledger 降级为索引/对账层，见 OE-8）。
// ================================================================
import { parseAbi, createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { AABillingError } from './errors.js';

/** OxaChain 主网 chainId（与 env 默认值共用，防魔法数漂移） */
export const DEFAULT_ESCROW_CHAIN_ID = 19505;

export const escrowAbi = parseAbi([
  'function balanceOf(address user) external view returns (uint256)',
  'function charge(address user, uint256 amount, string calldata ref) external returns (uint256 newBal)',
  'function refund(address user, uint256 amount, string calldata ref) external returns (uint256 newBal)',
  'function relayerEnabled(address relayer) external view returns (bool)',
]);

// EP v0.7 deposit（REQ-2b 资金总览）：子账户 UserOp gas 由 EP.deposit 支付，与 escrow 余额独立。
export const entryPointAbi = parseAbi([
  'function getDepositInfo(address account) external view returns (uint112 deposit, bool staked, uint112 stake, uint32 unstakeDelaySec, uint48 withdrawTime)',
]);

export function entryPointAddress(): `0x${string}` | '' {
  return (process.env.ESCROW_ENTRYPOINT || process.env.AA_OXACHAIN_ENTRYPOINT_V07 || '').toLowerCase() as `0x${string}` | '';
}

export const AA_ESCROW = {
  enabled: process.env.ESCROW_MODE === 'true',
  rpcUrl: process.env.ESCROW_RPC_URL || '',
  address: (process.env.ESCROW_ADDRESS || '').toLowerCase() as `0x${string}` | '',
  relayerKey: process.env.ESCROW_RELAYER_KEY || '',
  chainId: Number(process.env.ESCROW_CHAIN_ID || DEFAULT_ESCROW_CHAIN_ID),
  // P2-3: /v1/plans limits 透出（默认值与链上合约 DEFAULT_PER_TX_LIMIT/DEFAULT_PER_DAY_LIMIT 对齐，可 env 覆盖）
  perTxLimitOxa: process.env.ESCROW_PER_TX_LIMIT_OXA || '1',
  perDayLimitOxa: process.env.ESCROW_PER_DAY_LIMIT_OXA || '10',
};

export function escrowConfigured(): boolean {
  return Boolean(AA_ESCROW.enabled && AA_ESCROW.rpcUrl && AA_ESCROW.address && AA_ESCROW.relayerKey);
}

function escrowChain() {
  const chainId = AA_ESCROW.chainId;
  return {
    id: chainId,
    name: chainId === DEFAULT_ESCROW_CHAIN_ID ? 'OxaChain' : 'OxaChain-test',
    nativeCurrency: { name: 'OXA', symbol: 'OXA', decimals: 18 },
    rpcUrls: { default: { http: [AA_ESCROW.rpcUrl] } },
  } as const;
}

export function escrowClient() {
  const account = privateKeyToAccount(AA_ESCROW.relayerKey as `0x${string}`);
  const wallet = createWalletClient({ chain: escrowChain(), account, transport: http(AA_ESCROW.rpcUrl) });
  const publicClient = createPublicClient({ chain: escrowChain(), transport: http(AA_ESCROW.rpcUrl) });
  return { wallet, publicClient, account };
}

/** Escrow 用户余额（wei）；未配置 → null。 */
export async function escrowBalance(subscriber: string): Promise<bigint | null> {
  if (!escrowConfigured()) return null;
  try {
    const { publicClient } = escrowClient();
    return await publicClient.readContract({
      address: AA_ESCROW.address as `0x${string}`,
      abi: escrowAbi,
      functionName: 'balanceOf',
      args: [subscriber.toLowerCase() as `0x${string}`],
    }) as bigint;
  } catch (err: any) {
    throw new AABillingError(`escrow balance query failed: ${err?.shortMessage || err?.message}`, 503);
  }
}

/** Escrow 链上原子预扣（storage 记账）。 */
export async function escrowCharge(user: string, amountWei: bigint, ref: string): Promise<bigint> {
  if (!escrowConfigured()) throw new AABillingError('escrow not configured', 503);
  try {
    const { wallet, publicClient } = escrowClient();
    const txHash = await wallet.writeContract({
      address: AA_ESCROW.address as `0x${string}`,
      abi: escrowAbi,
      functionName: 'charge',
      args: [user.toLowerCase() as `0x${string}`, amountWei, ref],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== 'success') throw new AABillingError(`escrow charge tx failed: ${txHash}`, 503);
    return await escrowBalance(user) as bigint;
  } catch (err: any) {
    if (err instanceof AABillingError) throw err;
    // 合约 revert（余额不足/超限）→ 402 语义；RPC/网络故障 → 503
    const reason = err?.shortMessage || err?.message || '';
    if (/insufficient balance|exceeds per-/.test(reason)) {
      throw new AABillingError(`[402] 链上托管余额不足或超限额（${reason}）。充值路径：向托管合约 ${AA_ESCROW.address} 转账。`, 402);
    }
    throw new AABillingError(`escrow charge failed: ${reason}`, 503);
  }
}

/** Escrow 链上原子退差（storage 记账，回补余额 + 回退当日累计）。 */
export async function escrowRefund(user: string, amountWei: bigint, ref: string): Promise<bigint> {
  if (!escrowConfigured()) throw new AABillingError('escrow not configured', 503);
  try {
    const { wallet, publicClient } = escrowClient();
    const txHash = await wallet.writeContract({
      address: AA_ESCROW.address as `0x${string}`,
      abi: escrowAbi,
      functionName: 'refund',
      args: [user.toLowerCase() as `0x${string}`, amountWei, ref],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== 'success') throw new AABillingError(`escrow refund tx failed: ${txHash}`, 503);
    return await escrowBalance(user) as bigint;
  } catch (err: any) {
    if (err instanceof AABillingError) throw err;
    throw new AABillingError(`escrow refund failed: ${err?.shortMessage || err?.message}`, 503);
  }
}
