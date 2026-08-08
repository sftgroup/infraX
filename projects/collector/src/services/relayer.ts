/**
 * Relayer Service
 * Broadcast signed raw transactions to EVM chains.
 * EVM: eth_sendRawTransaction 统一经 chain-rpc 网关广播（唯一广播入口，禁止直连上游 RPC）。
 */

// MQ-10 DC-2/DC-9: 广播统一走 chain-rpc 网关（broadcast key）；网关不可用直接抛错，
// 禁止回退直连上游 RPC（全链统一汇总分发）。
const CHAIN_RPC_URL = (process.env.CHAIN_RPC_URL || '').replace(/\/+$/, '');
const CHAIN_RPC_BROADCAST_KEY = process.env.CHAIN_RPC_BROADCAST_KEY || '';

// 支持的 EVM 链（入参校验；链与端点权威链表在网关侧维护）
const SUPPORTED_CHAINS = ['ethereum', 'bsc', 'base', 'sepolia'];

/**
 * Broadcast an EVM signed transaction (0x hex) to the target chain via the gateway.
 */
async function relayEvmTx(chain: string, txHex: string): Promise<string> {
  if (!CHAIN_RPC_URL) {
    throw new Error('[relayer] CHAIN_RPC_URL not configured: gateway is the only broadcast entry');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const r = await fetch(`${CHAIN_RPC_URL}/v1/broadcast/${encodeURIComponent(chain)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Service-Key': CHAIN_RPC_BROADCAST_KEY || '' },
      body: JSON.stringify({ rawTransaction: txHex, wait: false }),
      signal: controller.signal,
    });
    const j: any = await r.json();
    if (!r.ok) throw new Error(j.detail || `gateway ${r.status}`);
    // chain-rpc 统一信封 {code, message, data:{chain, txHash, ...}}
    if (j.code !== 0) throw new Error(j.message || 'gateway error');
    if (!j.data?.txHash) throw new Error('gateway broadcast returned no txHash');
    return j.data.txHash;
  } finally { clearTimeout(timeout); }
}

/**
 * Broadcast a signed transaction to the target EVM chain.
 */
export async function relayTx(chain: string, tx: string): Promise<string> {
  const chainLower = chain.toLowerCase();
  if (!SUPPORTED_CHAINS.includes(chainLower)) {
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
