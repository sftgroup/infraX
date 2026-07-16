import { ethers } from 'ethers';
import { logger } from '../logger';

/**
 * Relayer Service
 * Broadcast signed raw transactions to EVM chains.
 * EVM: eth_sendRawTransaction via ethers.JsonRpcProvider
 */

// Chain → RPC URL (fallback providers — free tier)
const CHAIN_RPCS: Record<string, string[]> = {
  ethereum: ['https://eth.llamarpc.com', 'https://rpc.ankr.com/eth', 'https://ethereum-rpc.publicnode.com'],
  bsc: ['https://binance.llamarpc.com', 'https://rpc.ankr.com/bsc', 'https://bsc-rpc.publicnode.com'],
  base: ['https://mainnet.base.org', 'https://base.llamarpc.com', 'https://base-rpc.publicnode.com'],
  sepolia: ['https://ethereum-sepolia-rpc.publicnode.com', 'https://rpc2.sepolia.org', 'https://sepolia.gateway.tenderly.co'],
};

const SUPPORTED_CHAINS = Object.keys(CHAIN_RPCS);

/**
 * Broadcast an EVM signed transaction (0x hex) to the target chain.
 * Tries each RPC endpoint until one succeeds.
 */
async function relayEvmTx(chain: string, txHex: string): Promise<string> {
  const rpcs = CHAIN_RPCS[chain];
  let lastError: Error | null = null;

  for (const rpcUrl of rpcs) {
    try {
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const result = await provider.broadcastTransaction(txHex);
      return result.hash;
    } catch (err: any) {
      lastError = err;
      logger.warn('[relayer] EVM RPC attempt failed, trying next', {
        chain,
        rpc: rpcUrl.slice(0, 40) + '...',
        error: err.message?.slice(0, 80),
      });
    }
  }

  throw new Error(lastError?.message || 'All RPC endpoints failed');
}

/**
 * Broadcast a signed transaction to the target EVM chain.
 */
export async function relayTx(chain: string, tx: string): Promise<string> {
  const chainLower = chain.toLowerCase();
  const rpcs = CHAIN_RPCS[chainLower];

  if (!rpcs) {
    throw new Error(`Unsupported chain: ${chain}. Supported: ${SUPPORTED_CHAINS.join(', ')}`);
  }

  // ── EVM ──
  if (!tx.startsWith('0x')) {
    throw new Error('EVM tx must be a 0x-prefixed hex string');
  }
  return relayEvmTx(chainLower, tx);
}

/**
 * Get supported chains
 */
export function getSupportedChains(): string[] {
  return [...SUPPORTED_CHAINS];
}
