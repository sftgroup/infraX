import type { Chain } from '@0xinfrax/session-key-core';
import { privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, createWalletClient, http } from 'viem';
import { buildViemChain } from './rpc-registry.js';

export async function signAndBroadcast(params: {
  privateKey: string;
  chain: Chain;
  rpcUrl: string;
  to: string;
  data: string;
  value?: string;
  gasLimit?: string;
}): Promise<{ txHash: string; success: boolean; reason?: string; gasUsed?: string; blockNumber?: number }> {
  const account = privateKeyToAccount(params.privateKey as `0x${string}`);
  const viemChain = buildViemChain(params.chain, params.rpcUrl);

  const publicClient = createPublicClient({ transport: http(params.rpcUrl) });
  const walletClient = createWalletClient({ account, transport: http(params.rpcUrl) });

  try {
    let gas: bigint;
    if (params.gasLimit) {
      gas = BigInt(params.gasLimit);
    } else {
      gas = await publicClient.estimateGas({
        account: account.address,
        to: params.to as `0x${string}`,
        data: params.data as `0x${string}`,
        value: params.value ? BigInt(params.value) : undefined,
      });
    }

    const hash = await walletClient.sendTransaction({
      account,
      chain: viemChain,
      to: params.to as `0x${string}`,
      data: params.data as `0x${string}`,
      value: params.value ? BigInt(params.value) : 0n,
      gas,
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    return {
      txHash: hash,
      success: receipt.status === 'success',
      gasUsed: receipt.gasUsed.toString(),
      blockNumber: Number(receipt.blockNumber),
    };
  } catch (err: any) {
    return { txHash: '', success: false, reason: err.message || 'Unknown error' };
  }
}
