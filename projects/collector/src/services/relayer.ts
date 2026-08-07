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

// MQ-10 DC-2: 广播优先走 chain-rpc 网关（统一广播入口，broadcast key）；
// 未配置 CHAIN_RPC_URL 或网关失败回退直连 CHAIN_RPCS（兼容旧行为）。
const CHAIN_RPC_URL = process.env.CHAIN_RPC_URL || '';
const CHAIN_RPC_BROADCAST_KEY = process.env.CHAIN_RPC_BROADCAST_KEY || '';

/**
 * Broadcast an EVM signed transaction (0x hex) to the target chain.
 * Prefers chain-rpc gateway; falls back to direct RPC endpoints until one succeeds.
 */
async function relayEvmTx(chain: string, txHex: string): Promise<string> {
  // ── 优先走 chain-rpc 网关 ──
  if (CHAIN_RPC_URL) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        const r = await fetch(`${CHAIN_RPC_URL.replace(/\/$/, '')}/v1/broadcast/${encodeURIComponent(chain)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Service-Key': CHAIN_RPC_BROADCAST_KEY || '' },
          body: JSON.stringify({ rawTransaction: txHex, wait: false }),
          signal: controller.signal,
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j.detail || `gateway ${r.status}`);
        // chain-rpc 统一信封 {code, message, data:{chain, txHash, ...}}
        if (j.code !== 0) throw new Error(j.message || 'gateway error');
        if (!j.data?.txHash) throw new Error('gateway broadcast returned no txHash');
        return j.data.txHash;
      } finally { clearTimeout(timeout); }
    } catch (err: any) {
      logger.warn('[relayer] chain-rpc gateway broadcast failed, falling back to direct RPC', {
        chain,
        error: err.message?.slice(0, 120),
      });
    }
  }

  // ── 直连 fallback（原有逻辑） ──
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
