// ---------------------------------------------------------------------------
// @0xinfrax/payments — StablecoinAdapter (EIP-3009 / Permit2 rail)
// ---------------------------------------------------------------------------
// Verifies a stablecoin funding tx (submitted by the payer or a facilitator
// with an EIP-3009 / Permit2 authorization) by locating the `Transfer` event
// on the configured token contract (to == platform wallet, value ≥ price) and
// crediting the sender's per-asset balance. Amounts stay in the token's own
// atomic units (e.g. 6 decimals) — precision is preserved, never re-scaled.
//
// The EIP-712 signature formats live in protocol/stablecoin.ts (the module can
// pre-verify signatures before submission); the on-chain Transfer event is the
// authoritative credential here.
// ---------------------------------------------------------------------------

import { parseAbi } from 'viem'
import type { Address, PublicClient } from 'viem'
import type { ChainKey } from '../types'
import type { PaymentStore } from '../store'

export interface StablecoinConfig {
  enabled: boolean
  chain: ChainKey
  /** Token contract (USDC et al). */
  asset: string
  /** Token decimals (e.g. 6 for USDC) — informational; amounts stay atomic. */
  decimals: number
  /** Per-request price in the token's atomic units. */
  priceWei: string
  /** EIP-3009 domain name of the token (e.g. 'USD Coin'). */
  domainName?: string
  /** Permit2 contract address on this chain (optional — enables Permit2). */
  permit2?: string
}

export interface StablecoinDeps {
  store: PaymentStore
  getClient: (chain: ChainKey) => PublicClient
  chainIdOf: (chain: ChainKey) => number
}

export const TRANSFER_EVENT_ABI = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)'])

export class StablecoinAdapter {
  constructor(private cfg: StablecoinConfig, private deps: StablecoinDeps) {}

  available(): boolean {
    return this.cfg.enabled && Boolean(this.cfg.asset)
  }

  asset(): string {
    return this.cfg.asset
  }

  priceWei(): bigint {
    return BigInt(this.cfg.priceWei)
  }

  /** The `exact` accept for this stablecoin (appended to the x402 challenge). */
  accept(payTo: string): { scheme: 'exact'; network: string; amount: string; asset: string; payTo: string; maxTimeoutSeconds: number } {
    return {
      scheme: 'exact',
      network: `eip155:${this.deps.chainIdOf(this.cfg.chain)}`,
      amount: this.cfg.priceWei,
      asset: this.cfg.asset,
      payTo,
      maxTimeoutSeconds: 300,
    }
  }

  /**
   * Verify a stablecoin funding tx and credit the sender's token balance.
   * Locates `Transfer(from → payTo, value ≥ price)` on the configured token.
   * @returns verified payment, or null when the tx is not a valid token payment.
   */
  async verifyAndCredit(txHash: string, payTo: string, chain?: ChainKey): Promise<{ payer: string; creditedWei: string } | null> {
    if (!this.available()) return null
    const c = chain ?? this.cfg.chain
    const client = this.deps.getClient(c)
    const hash = txHash as `0x${string}`
    const receipt = await client.getTransactionReceipt({ hash }).catch(() => null)
    if (!receipt || receipt.status !== 'success') return null

    const token = this.cfg.asset.toLowerCase()
    const payToAddr = payTo.toLowerCase()
    for (const log of receipt.logs) {
      if (!log.address || log.address.toLowerCase() !== token) continue
      const parsed = parseTransfer(log)
      if (!parsed) continue
      if (parsed.to.toLowerCase() !== payToAddr) continue
      if (parsed.value < this.priceWei()) continue
      const payer = parsed.from.toLowerCase()
      await this.deps.store.credit({
        reference: txHash.toLowerCase(),
        payer,
        amountWei: parsed.value.toString(),
        asset: this.cfg.asset,
        chainId: this.deps.chainIdOf(c),
      })
      return { payer, creditedWei: parsed.value.toString() }
    }
    return null
  }

  chain(): ChainKey {
    return this.cfg.chain
  }
}

/** Decode an ERC-20 Transfer log (topics[1]=from, topics[2]=to, data=value). */
export function parseTransfer(
  log: { topics?: readonly unknown[]; data?: unknown }
): { from: string; to: string; value: bigint } | null {
  if (!log.topics || log.topics.length < 3) return null
  const from = topicsAddress(log.topics[1])
  const to = topicsAddress(log.topics[2])
  if (!from || !to) return null
  try {
    const value = BigInt(String(log.data))
    return { from, to, value }
  } catch {
    return null
  }
}

/** Convert a bytes32 topic into an address (the padded 20-byte form). */
function topicsAddress(topic: unknown): string | null {
  if (typeof topic !== 'string') return null
  const t = topic.replace(/^0x/, '').toLowerCase()
  if (t.length < 40) return null
  return `0x${t.slice(-40)}`
}
