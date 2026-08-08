// ---------------------------------------------------------------------------
// @0xinfrax/payments — ChainAdapter (pure viem, no AgentX SDK)
// ---------------------------------------------------------------------------
// Read-only on-chain access used for pricing (getPlan) and access checks
// (hasActiveSubscription / platformFeeBps). Chain config is injected so the
// module never depends on any deployment's environment.
// ---------------------------------------------------------------------------

import { createPublicClient, http } from 'viem'
import type { Address, PublicClient } from 'viem'
import { NATIVE_ASSET } from '../types'
import type { ChainKey, PlanInfo } from '../types'

export interface ChainInfo {
  rpcUrl: string
  chainId: number
  subscriptionManager: string
  identityRegistry?: string
}

export type ChainConfig = Record<ChainKey, ChainInfo>

/** getPlan(uint256) → SubscriptionPlan struct (dynamic tuple — must be a tuple ABI). */
const GET_PLAN_ABI = [
  {
    type: 'function',
    name: 'getPlan',
    stateMutability: 'view',
    inputs: [{ name: 'planId', type: 'uint256' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'planId', type: 'uint256' },
          { name: 'agentId', type: 'uint256' },
          { name: 'creator', type: 'address' },
          { name: 'price', type: 'uint256' },
          { name: 'period', type: 'string' },
          { name: 'active', type: 'bool' },
          { name: 'payToken', type: 'address' },
          { name: 'trialDays', type: 'uint256' },
        ],
      },
    ],
  },
] as const

const HAS_ACTIVE_SUBSCRIPTION_ABI = [
  {
    type: 'function',
    name: 'hasActiveSubscription',
    stateMutability: 'view',
    inputs: [
      { name: 'subscriber', type: 'address' },
      { name: 'agentId', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const

const PLATFORM_FEE_BPS_ABI = [
  {
    type: 'function',
    name: 'platformFeeBps',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

export class ChainAdapter {
  private clients: Partial<Record<ChainKey, PublicClient>> = {}

  constructor(private chains: ChainConfig) {}

  private resolve(chain: ChainKey): ChainInfo {
    const info = this.chains[chain]
    if (!info) throw new Error(`Unknown chain: "${chain}"`)
    return info
  }

  getPublicClient(chain: ChainKey): PublicClient {
    if (!this.clients[chain]) {
      const info = this.resolve(chain)
      this.clients[chain] = createPublicClient({ transport: http(info.rpcUrl) }) as unknown as PublicClient
    }
    return this.clients[chain]!
  }

  chainIdOf(chain: ChainKey): number {
    return this.resolve(chain).chainId
  }

  nativeAsset(): string {
    return NATIVE_ASSET
  }

  /** Read an on-chain plan (used for fiat auto-pricing and price checks). */
  async getPlan(chain: ChainKey, planId: number): Promise<PlanInfo> {
    const info = this.resolve(chain)
    const plan = await this.getPublicClient(chain).readContract({
      address: info.subscriptionManager as Address,
      abi: GET_PLAN_ABI,
      functionName: 'getPlan',
      args: [BigInt(planId)],
    }) as unknown as {
      planId: bigint
      agentId: bigint
      creator: string
      price: bigint
      period: string
      active: boolean
      payToken: string
      trialDays: bigint
    }
    return {
      planId: Number(plan.planId),
      agentId: Number(plan.agentId),
      creator: plan.creator,
      price: plan.price,
      period: plan.period,
      active: plan.active,
      payToken: plan.payToken,
      trialDays: Number(plan.trialDays),
    }
  }

  /** On-chain subscription status for a subscriber + resource. */
  async hasActiveSubscription(chain: ChainKey, subscriber: string, resourceId: number): Promise<boolean> {
    const info = this.resolve(chain)
    return this.getPublicClient(chain).readContract({
      address: info.subscriptionManager as Address,
      abi: HAS_ACTIVE_SUBSCRIPTION_ABI,
      functionName: 'hasActiveSubscription',
      args: [subscriber as Address, BigInt(resourceId)],
    })
  }

  /** Platform fee in basis points (0-2000). */
  async platformFeeBps(chain: ChainKey): Promise<number> {
    const info = this.resolve(chain)
    const bps = await this.getPublicClient(chain).readContract({
      address: info.subscriptionManager as Address,
      abi: PLATFORM_FEE_BPS_ABI,
      functionName: 'platformFeeBps',
      args: [],
    })
    return Number(bps)
  }
}
