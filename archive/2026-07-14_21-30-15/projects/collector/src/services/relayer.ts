import { ethers } from 'ethers';
import {
  Connection,
  VersionedTransaction,
  Transaction,
  clusterApiUrl,
} from '@solana/web3.js';
import { logger } from '../logger';

/**
 * Relayer Service
 * Broadcast signed raw transactions to multiple chains (EVM + Solana).
 *
 * EVM: eth_sendRawTransaction via ethers.JsonRpcProvider
 * Solana: sendRawTransaction via @solana/web3.js Connection
 */

// Chain → RPC URL (fallback providers — free tier)
const CHAIN_RPCS: Record<string, string[]> = {
  ethereum: ['https://eth.llamarpc.com', 'https://rpc.ankr.com/eth', 'https://ethereum-rpc.publicnode.com'],
  bsc: ['https://binance.llamarpc.com', 'https://rpc.ankr.com/bsc', 'https://bsc-rpc.publicnode.com'],
  base: ['https://mainnet.base.org', 'https://base.llamarpc.com', 'https://base-rpc.publicnode.com'],
  sepolia: ['https://ethereum-sepolia-rpc.publicnode.com', 'https://rpc2.sepolia.org', 'https://sepolia.gateway.tenderly.co'],
  solana: ['https://api.mainnet-beta.solana.com'],
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
 * Broadcast a Solana transaction (base58-encoded or base64-encoded bytes).
 * Accepts both:
 *   - base58-encoded wire format (pre-v0 transactions)
 *   - base64-encoded wire format (v0/versioned transactions)
 *
 * Tries each RPC endpoint until one succeeds.
 */
async function relaySolanaTx(txEncoded: string): Promise<string> {
  const rpcs = CHAIN_RPCS['solana'];
  let lastError: Error | null = null;

  // Determine encoding: base64 vs base58
  // base64 has limited charset (alnum + /=+) and may end with = padding
  const isBase64 = /^[A-Za-z0-9+/]+=*$/.test(txEncoded.trim());

  let buffer: Uint8Array;
  try {
    buffer = isBase64
      ? Buffer.from(txEncoded.trim(), 'base64')
      : require('bs58').default.decode(txEncoded.trim());
  } catch (decodeErr: any) {
    throw new Error(`Failed to decode Solana tx: ${decodeErr.message}`);
  }

  for (const rpcUrl of rpcs) {
    try {
      const connection = new Connection(rpcUrl, 'confirmed');
      const signature = await connection.sendRawTransaction(buffer, {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
      });
      return signature;
    } catch (err: any) {
      lastError = err;
      logger.warn('[relayer] Solana RPC attempt failed, trying next', {
        rpc: rpcUrl.slice(0, 40) + '...',
        error: err.message?.slice(0, 100),
      });
    }
  }

  throw new Error(lastError?.message || 'All Solana RPC endpoints failed');
}

/**
 * Broadcast a signed transaction to the target chain.
 * Route to EVM or Solana handler based on chain.
 *
 * EVM tx: 0x-prefixed hex string
 * Solana tx: base58 or base64 encoded wire format (no 0x prefix)
 */
export async function relayTx(chain: string, tx: string): Promise<string> {
  const chainLower = chain.toLowerCase();
  const rpcs = CHAIN_RPCS[chainLower];

  if (!rpcs) {
    throw new Error(`Unsupported chain: ${chain}. Supported: ${SUPPORTED_CHAINS.join(', ')}`);
  }

  // ── Solana ──
  if (chainLower === 'solana') {
    if (!tx || tx.length < 10) {
      throw new Error('Solana tx must be a base58 or base64 encoded wire format');
    }
    return relaySolanaTx(tx);
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
