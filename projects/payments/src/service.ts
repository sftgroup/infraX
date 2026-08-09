// ---------------------------------------------------------------------------
// @0xinfrax/payments — PaymentsService (the payment engine)
// ---------------------------------------------------------------------------
// Single entry point shared by all deployment shapes:
//   - embedded in a host gateway (AgentX version B)
//   - standalone library behind a caller-owned router (generic version A)
// All persistence goes through the injected PaymentStore (+ optional
// MPPSessionStore seam); all host business (e.g.
// subscription registration) goes through the onWebhookEvent / onCredit
// callbacks — nothing AgentX-specific lives here.
// ---------------------------------------------------------------------------

import { randomUUID } from './crypto'
import { ChainAdapter } from './adapters/chain'
import { MPPAdapter } from './adapters/mpp'
import type { MPPConfig, MPPVoucherInput } from './adapters/mpp'
import { StripeAdapter } from './adapters/stripe'
import { X402Adapter } from './adapters/x402'
import { PaymentError } from './errors'
import type { MPPSessionRow, MPPSessionStore, PaymentStore } from './store'
import { PAYMENT_INTENT_STATUSES } from './store'
import type { PaymentIntentStatus } from './store'
import { NATIVE_ASSET } from './types'
import type {
  ChainKey,
  CreatePaymentInput,
  CreatePaymentResult,
  PaymentEvent,
  PaymentCredit,
  VerifiedPayment,
  WebhookEvent,
} from './types'

export interface ChainConfigInput {
  [key: string]: { rpcUrl: string; chainId: number; subscriptionManager: string; identityRegistry?: string }
}

export interface StripeOptions {
  secretKey: string
  webhookSecret: string
  apiBase?: string
  /** Native-token → USD price used for plan auto-pricing. */
  tokenUsdPrice?: number
}

export interface X402Options {
  enabled: boolean
  payTo: string
  priceWei: string
  chain: ChainKey
  maxAmountWei?: string
  /** Stablecoin accept + verification (P3). Chain defaults to `x402.chain`. */
  stablecoin?: {
    enabled: boolean
    asset: string
    decimals: number
    priceWei: string
    domainName?: string
    permit2?: string
    chain?: ChainKey
  }
}

export interface MPPOptions extends MPPConfig {}

export interface PaymentsServiceOptions {
  store: PaymentStore
  /** MPP sessions seam (payment channels). */
  mppStore?: MPPSessionStore
  chains: ChainConfigInput
  stripe?: StripeOptions
  x402?: X402Options
  mpp?: MPPOptions
  /** Host callback for normalized webhook events (e.g. Stripe). */
  onWebhookEvent?: (event: WebhookEvent) => Promise<void>
  /** Host callback after a payment is credited (idempotent; carries metadata). */
  onCredit?: (credit: PaymentCredit) => Promise<void>
  /** Shared logger (optional; console fallback). */
  logger?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void }
}

export class PaymentsService {
  readonly chain: ChainAdapter
  readonly stripe: StripeAdapter | null
  readonly x402: X402Adapter | null
  readonly mpp: MPPAdapter | null

  private logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void }

  constructor(private opts: PaymentsServiceOptions) {
    this.logger = opts.logger ?? {
      info: (m) => console.log(`[payments] ${m}`),
      warn: (m) => console.warn(`[payments] ${m}`),
      error: (m) => console.error(`[payments] ${m}`),
    }
    this.chain = new ChainAdapter(opts.chains as ChainAdapter['chains'])
    this.stripe = opts.stripe ? new StripeAdapter({ apiBase: opts.stripe.apiBase ?? 'https://api.stripe.com/v1', secretKey: opts.stripe.secretKey, webhookSecret: opts.stripe.webhookSecret }) : null
    this.x402 = opts.x402
      ? new X402Adapter(
          {
            enabled: opts.x402.enabled,
            payTo: opts.x402.payTo,
            priceWei: opts.x402.priceWei,
            chain: opts.x402.chain,
            maxAmountWei: opts.x402.maxAmountWei,
            stablecoin: opts.x402.stablecoin
              ? { ...opts.x402.stablecoin, chain: opts.x402.stablecoin.chain ?? opts.x402.chain }
              : undefined,
          },
          {
            store: opts.store,
            getClient: (c) => this.chain.getPublicClient(c),
            chainIdOf: (c) => this.chain.chainIdOf(c),
          }
        )
      : null
    this.mpp = opts.mpp && opts.mppStore
      ? new MPPAdapter(
          {
            enabled: opts.mpp.enabled,
            domain: opts.mpp.domain,
            payee: opts.mpp.payee,
            chain: opts.mpp.chain,
            settleThresholdWei: opts.mpp.settleThresholdWei,
            settleIntervalSec: opts.mpp.settleIntervalSec,
          },
          {
            store: opts.store,
            sessions: opts.mppStore,
            getClient: (c) => this.chain.getPublicClient(c),
            chainIdOf: (c) => this.chain.chainIdOf(c),
            log: (m) => this.logger.info(m),
          }
        )
      : null
  }

  // ── Create payment ─────────────────────────────────────────────────────

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    switch (input.method) {
      case 'fiat':
        return this._fiatCheckout(input)
      case 'chain': {
        // On-chain rail: the intent is registered here; the actual payment
        // happens on-chain and is later verified via verifyPayment.
        const paymentId = `pi_${randomUUID()}`
        await this.opts.store.recordIntent?.({
          paymentId,
          method: 'chain',
          subscriber: input.subscriber,
          chain: input.chain,
          status: 'created',
          metadata: input.metadata,
        })
        await this.emit('payment.intent.created', paymentId, {
          paymentId,
          method: 'chain',
          subscriber: input.subscriber,
          chain: input.chain,
          metadata: input.metadata,
        })
        return { method: 'chain', paymentId, reference: paymentId }
      }
      case 'mpp':
        return this._mppOpen(input)
      default:
        throw new PaymentError('UNSUPPORTED_METHOD', `createPayment(method="${input.method}") is not implemented yet — use verifyPayment for on-chain rails`, 400)
    }
  }

  /**
   * Advance a payment intent's lifecycle (audit trail).
   * - x402 intents are auto-marked `paid` by verifyPayment;
   * - fiat intents are driven by the host (typically inside onWebhookEvent):
   *   `created → paid | failed | closed`, `paid → closed`.
   * No-op when the injected store does not implement this optional seam.
   */
  async updateIntentStatus(paymentId: string, status: PaymentIntentStatus): Promise<void> {
    if (!this.opts.store.updateIntentStatus) return
    if (!PAYMENT_INTENT_STATUSES.includes(status)) {
      throw new PaymentError('INVALID_INPUT', `Unknown intent status "${status}"`, 400)
    }
    await this.opts.store.updateIntentStatus(paymentId, status)
    await this.emit('payment.intent.status', paymentId, { paymentId, status })
  }

  /** Append a lifecycle event to the outbound queue (no-op without emitEvent). */
  private async emit(type: PaymentEvent['type'], reference: string, payload: Record<string, unknown>): Promise<void> {
    await this.opts.store.emitEvent?.({ type, reference, payload })
  }

  private async _fiatCheckout(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    if (!this.stripe || !this.opts.stripe) {
      throw new PaymentError('NOT_CONFIGURED', 'Fiat checkout is not configured (stripe options missing)', 503)
    }
    const subscriber = input.subscriber
    if (!subscriber) throw new PaymentError('INVALID_INPUT', 'subscriber is required for fiat checkout', 400)
    const currency = input.currency ?? 'usd'
    const period = input.period ?? 'month'
    const planId = input.pricing?.planId
    // Opaque reference — the caller builds it (business encoding) and the
    // module only echoes it back through the provider webhook events.
    const clientReference = input.clientReference ?? subscriber

    let resolvedCents = Number(input.amountCents) || 0
    if (!resolvedCents && planId) {
      const chain = input.chain ?? 'oxachain'
      try {
        const plan = await this.chain.getPlan(chain, planId)
        const nativeTokens = Number(plan.price) / 1e18
        resolvedCents = Math.max(1, Math.round(nativeTokens * (this.opts.stripe.tokenUsdPrice ?? 1) * 100))
        this.logger.info(`checkout auto-pricing plan #${planId}: ${nativeTokens} native × $${this.opts.stripe.tokenUsdPrice ?? 1} → $${(resolvedCents / 100).toFixed(2)}`)
      } catch (err) {
        throw new PaymentError('AUTO_PRICE_FAILED', `Cannot auto-price plan #${planId}; send amountCents explicitly`, 400)
      }
    }
    if (!resolvedCents || resolvedCents < 50) {
      throw new PaymentError('AMOUNT_TOO_SMALL', 'amountCents must be at least 50 (Stripe minimum)', 400)
    }

    const session = await this.stripe.createCheckoutSession({
      amountCents: resolvedCents,
      currency,
      period,
      subscriber,
      resourceLabel: String(input.metadata?.resourceLabel ?? 'resource'),
      clientReference,
      successUrl: input.successUrl,
      cancelUrl: input.cancelUrl,
    })
    this.logger.info(`checkout(subscriber=${subscriber}, reference=${clientReference}, amountCents=${resolvedCents}, period=${period}) → session ${session.id}`)
    const paymentId = `pi_${randomUUID()}`
    await this.opts.store.recordIntent?.({
      paymentId,
      method: 'fiat',
      subscriber,
      currency,
      chain: input.chain,
      status: 'created',
      metadata: input.metadata,
    })
    await this.emit('payment.intent.created', paymentId, {
      paymentId,
      method: 'fiat',
      subscriber,
      sessionId: session.id,
      amountCents: resolvedCents,
      currency,
      clientReference,
      metadata: input.metadata,
    })
    return { method: 'fiat', paymentId, sessionUrl: session.url!, sessionId: session.id, clientReference, redirect: true }
  }

  // ── MPP rail (payment channels) ────────────────────────────────────────

  /** Open a payment channel: verify the deposit tx and freeze the deposit. */
  private async _mppOpen(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    if (!this.mpp) throw new PaymentError('NOT_CONFIGURED', 'MPP is not configured', 503)
    const subscriber = input.subscriber
    const depositWei = input.valueWei
    const salt = input.salt
    const txHash = input.txHash
    if (!subscriber || !depositWei || !salt || !txHash) {
      throw new PaymentError('INVALID_INPUT', 'mpp: subscriber, valueWei (deposit), salt and txHash are required', 400)
    }
    const opened = await this.mpp.open({
      payer: subscriber,
      depositWei,
      salt,
      txHash,
      chain: input.chain,
      asset: NATIVE_ASSET,
    })
    const payee = this.mpp.payeeOf()
    await this.opts.store.recordIntent?.({
      paymentId: opened.channelId,
      method: 'mpp',
      subscriber,
      amountWei: depositWei,
      asset: NATIVE_ASSET,
      chain: input.chain,
      status: 'created',
      metadata: input.metadata,
    })
    await this.emit('mpp.session.opened', opened.channelId, {
      channelId: opened.channelId,
      payer: subscriber,
      payee,
      depositWei: opened.depositWei,
      metadata: input.metadata,
    })
    return { method: 'mpp', channelId: opened.channelId, depositWei: opened.depositWei, payee }
  }

  /** Accept a cumulative voucher (signature reuse allowed). */
  async mppVoucher(input: MPPVoucherInput): Promise<{ accepted: boolean; mode: 'sign' | 'reuse'; channelId: string }> {
    if (!this.mpp) throw new PaymentError('NOT_CONFIGURED', 'MPP is not configured', 503)
    return this.mpp.voucher(input)
  }

  /** Top-up a channel with a new funding tx. */
  async mppTopUp(input: { channelId: string; txHash: string; additionalWei: string }): Promise<{ depositWei: string }> {
    if (!this.mpp) throw new PaymentError('NOT_CONFIGURED', 'MPP is not configured', 503)
    return this.mpp.topUp(input)
  }

  /** Settle: deduct un-settled consumption from the payer balance. */
  async mppSettle(channelId: string): Promise<{ consumedWei: string; spentWei: string; currentCum: string }> {
    if (!this.mpp) throw new PaymentError('NOT_CONFIGURED', 'MPP is not configured', 503)
    const result = await this.mpp.settle(channelId)
    await this.emit('mpp.settled', channelId, { channelId, ...result })
    return result
  }

  /** Close a channel (settles the tail first). */
  async mppClose(channelId: string): Promise<{ spentWei: string; refundWei: string; depositWei: string }> {
    if (!this.mpp) throw new PaymentError('NOT_CONFIGURED', 'MPP is not configured', 503)
    const result = await this.mpp.close(channelId)
    await this.emit('mpp.closed', channelId, { channelId, ...result })
    return result
  }

  /** Read a channel's current state. */
  async mppSession(channelId: string): Promise<MPPSessionRow | null> {
    if (!this.mpp) throw new PaymentError('NOT_CONFIGURED', 'MPP is not configured', 503)
    return this.mpp.session(channelId)
  }

  // ── Verify payment (x402 rail) ─────────────────────────────────────────

  /** Verify an on-chain payment tx and credit the payer's balance. */
  async verifyPayment(txHash: string, chain?: ChainKey): Promise<VerifiedPayment | null> {
    if (!this.x402) throw new PaymentError('NOT_CONFIGURED', 'x402 is not configured', 503)
    const verified = await this.x402.verifyAndCredit(txHash, chain)
    if (verified) {
      // Audit intent (idempotent — replaying a tx must not duplicate rows).
      await this.opts.store.recordIntent?.({
        paymentId: `x402:${txHash}`,
        method: 'x402',
        subscriber: verified.payer,
        amountWei: verified.creditedWei,
        asset: verified.asset,
        chain: verified.chain,
        status: 'paid',
      })
      await this.emit('payment.credited', verified.reference, {
        reference: verified.reference,
        payer: verified.payer,
        amountWei: verified.creditedWei,
        asset: verified.asset,
        chain: verified.chain,
        chainId: this.chain.chainIdOf(verified.chain),
      })
      await this.opts.onCredit?.({
        reference: verified.reference,
        payer: verified.payer,
        amountWei: verified.creditedWei,
        asset: verified.asset,
        chainId: this.chain.chainIdOf(verified.chain),
      })
    }
    return verified
  }

  // ── Webhook handling (fiat rail) ───────────────────────────────────────

  /**
   * Verify a provider webhook and forward the normalized event to the host.
   * Throws on invalid signature; resolves with { received: true } otherwise.
   */
  async handleWebhook(payload: string, signature: string): Promise<{ received: boolean }> {
    if (!this.stripe) throw new PaymentError('NOT_CONFIGURED', 'Fiat webhook is not configured', 503)
    if (!(await this.stripe.verifyWebhookSignature(payload, signature))) {
      this.logger.warn('webhook invalid signature')
      throw new PaymentError('INVALID_SIGNATURE', 'Invalid signature', 400)
    }
    const event = this.stripe.parseEvent(payload)
    await this.emit('payment.webhook.received', String(event.object?.id ?? event.type), {
      type: event.type,
      id: event.object?.id ?? null,
    })
    await this.opts.onWebhookEvent?.(event)
    return { received: true }
  }

  // ── Access & balances (delegated to the injected store) ─────────────────

  resolveAccess(
    subscriber: string,
    resource: string | number | Record<string, unknown>,
    opts?: { chain?: ChainKey }
  ): Promise<boolean> {
    return this.opts.store.resolveAccess(subscriber, resource, opts)
  }

  balanceOf(address: string, asset: string = NATIVE_ASSET): Promise<bigint> {
    return this.opts.store.balanceOf(address, asset)
  }

  deduct(address: string, amount: bigint, asset: string = NATIVE_ASSET): Promise<boolean> {
    return this.opts.store.deduct(address, amount, asset)
  }
}
