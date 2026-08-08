// ---------------------------------------------------------------------------
// @0xinfrax/payments — shared types (zero AgentX coupling)
// ---------------------------------------------------------------------------
// This module ONLY understands money: methods, assets, amounts, credentials.
// Business context (e.g. agentId) travels through the `metadata` field and is
// never interpreted here.
// ---------------------------------------------------------------------------

/** Payment rails supported by the module. */
export type PaymentMethod = 'chain' | 'fiat' | 'x402' | 'mpp' | 'a2a'

export type PaymentPeriod = 'day' | 'week' | 'month' | 'year'

/** Chain slots the module can talk to. Injected per deployment (CAIP-2 later). */
export type ChainKey = 'oxachain' | 'sepolia'

/** address(0) — native token sentinel for `asset`. */
export const NATIVE_ASSET = '0x0000000000000000000000000000000000000000'

/** Input for creating a payment intent. Business params go to `metadata`. */
export interface CreatePaymentInput {
  method: PaymentMethod
  /** Who is paying (wallet address). */
  subscriber?: string
  period?: PaymentPeriod
  /** Fiat: amount in minor units (cents). Optional when `pricing` is set. */
  amountCents?: number
  currency?: string
  chain?: ChainKey
  /** Chain / MPP rail: native value override (defaults to the plan price / deposit). */
  valueWei?: string
  /** Asset for valueWei (NATIVE_ASSET default; token address for a2a/stablecoin). */
  asset?: string
  /** MPP rail: receiving wallet for the deposit (defaults to the deployment payee). */
  payee?: string
  /** MPP rail: channel salt (binds the channel to a fresh context). */
  salt?: string
  /** MPP / a2a rail: the funding/credential tx to verify on open/settle. */
  txHash?: string
  /** Item used for auto-pricing (e.g. an on-chain plan id). */
  pricing?: { planId: number }
  /** Opaque business context passed through unchanged (e.g. { agentId }). */
  metadata?: Record<string, unknown>
  /** Fiat: opaque reference echoed back by the provider in webhook events.
   *  Built by the caller (e.g. `subscriber|agentId|planId`) and never parsed here. */
  clientReference?: string
  /** Fiat: redirect targets after checkout. */
  successUrl?: string
  cancelUrl?: string
}

export type CreatePaymentResult =
  | {
      method: 'fiat'
      /** Payment-intent id (audit trail; stored in payment_intents). */
      paymentId: string
      sessionUrl: string
      sessionId: string
      /** Opaque reference echoed back (caller-built). */
      clientReference: string
      redirect: true
    }
  | { method: 'chain'; paymentId: string; reference: string }
  | { method: 'x402'; reference: string }
  | { method: 'mpp'; channelId: string; depositWei: string; payee: string }
  | { method: 'a2a'; paymentId: string; amountWei: string; payee: string }

/** A verified incoming payment credited to the payer's balance (idempotent). */
export interface PaymentCredit {
  /** Idempotency key: tx hash / provider subscription id / payment id. */
  reference: string
  payer: string
  /** Atomic units as a decimal string (never floats). */
  amountWei: string
  /** NATIVE_ASSET or an ERC-20 contract address. */
  asset: string
  chainId: number
  metadata?: Record<string, unknown>
}

/** Result of verifying an on-chain payment. */
export interface VerifiedPayment {
  reference: string
  payer: string
  creditedWei: string
  asset: string
  chain: ChainKey
}

/** Normalized provider webhook event (Stripe and friends). */
export interface WebhookEvent {
  type: string
  object: Record<string, any>
}

/** Stripe checkout session response shape. */
export interface StripeSession {
  id: string
  url: string | null
  subscription: string | null
  amount_total: number | null
  currency: string | null
  /** Caller-built opaque reference echoed back by the provider. */
  client_reference_id: string | null
}

/** On-chain plan detail (read from the SubscriptionManager contract). */
export interface PlanInfo {
  planId: number
  /** Plan owner resource id (on-chain plan field). */
  agentId: number
  creator: string
  price: bigint
  period: string
  active: boolean
  payToken: string
  trialDays: number
}

/** x402 protocol discovery payload. */
export interface X402Info {
  enabled: boolean
  priceWei: string
  payTo: string
  network: string
  chain: ChainKey
}

/** Module-level lifecycle events written to the outbound event queue. */
export type PaymentEventType =
  | 'payment.intent.created'
  | 'payment.credited'
  | 'payment.intent.status'
  | 'payment.webhook.received'
  | 'mpp.session.opened'
  | 'mpp.settled'
  | 'mpp.closed'
  | 'a2a.created'
  | 'a2a.settled'
  | 'authorization.charged'

/** An outbound payment event (module writes; host consumes). */
export interface PaymentEvent {
  type: PaymentEventType
  /** Correlation id: paymentId / tx hash / provider reference. */
  reference: string
  /** Opaque JSON payload (business context travels inside metadata). */
  payload: Record<string, unknown>
}
