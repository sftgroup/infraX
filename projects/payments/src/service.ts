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
import type {
  AuthorizationStore,
  BatchStore,
  InviteStore,
  MPPSessionRow,
  MPPSessionStore,
  PaymentAuthorization,
  PaymentInvite,
  PaymentStore,
  PaymentTransfer,
  TransferStore,
} from './store'
import { PAYMENT_INTENT_STATUSES } from './store'
import type { PaymentIntentStatus } from './store'
import { NATIVE_ASSET } from './types'
import type {
  BatchItemResult,
  Capabilities,
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

/** a2a rail toggle (defaults to on whenever the x402 verification engine is on). */
export interface A2AOptions {
  enabled?: boolean
}

export interface PaymentsServiceOptions {
  store: PaymentStore
  /** MPP sessions seam (payment channels). */
  mppStore?: MPPSessionStore
  /** Period-authorization seam (subscription billing). */
  authorizations?: AuthorizationStore
  /** Batch seam (one-shot multi-payee collection). */
  batch?: BatchStore
  /** Billing-invitation seam (agent → agent charge invitations). */
  invites?: InviteStore
  /** Ledger-internal transfer seam (balance → balance, no new signature). */
  transfers?: TransferStore
  chains: ChainConfigInput
  stripe?: StripeOptions
  x402?: X402Options
  mpp?: MPPOptions
  /** a2a rail toggle (default on with x402). */
  a2a?: A2AOptions
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
  /** Batch rail store seam (null when the capability is off). */
  readonly batch: BatchStore | null
  /** Invite capability store seam. */
  readonly invites: InviteStore | null
  /** Transfer capability store seam. */
  readonly transfers: TransferStore | null

  private logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void }

  constructor(private opts: PaymentsServiceOptions) {
    this.logger = opts.logger ?? {
      info: (m) => console.log(`[payments] ${m}`),
      warn: (m) => console.warn(`[payments] ${m}`),
      error: (m) => console.error(`[payments] ${m}`),
    }
    this.batch = opts.batch ?? null
    this.invites = opts.invites ?? null
    this.transfers = opts.transfers ?? null
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
      case 'a2a':
        return this._a2aCreate(input)
      case 'batch':
        return this._batchCreate(input)
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

  // ── a2a rail (paymentId two-phase: intent → on-chain tx → settle) ──────

  /** Phase 1: create an a2a intent → return paymentId + amount + payee. */
  private async _a2aCreate(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    if (!this.x402 || (this.opts.a2a?.enabled ?? true) === false) {
      throw new PaymentError('NOT_CONFIGURED', 'a2a rail is not configured', 503)
    }
    const subscriber = input.subscriber
    const payee = input.payee ?? this.x402.payTo()
    const amountWei = input.valueWei
    if (!subscriber || !payee || !amountWei) {
      throw new PaymentError('INVALID_INPUT', 'a2a: subscriber, payee (or x402 payTo) and valueWei are required', 400)
    }
    const paymentId = `a2a_${randomUUID()}`
    const asset = input.asset ?? NATIVE_ASSET
    await this.opts.store.recordIntent?.({
      paymentId,
      method: 'a2a',
      subscriber,
      amountWei,
      asset,
      chain: input.chain,
      status: 'created',
      metadata: input.metadata,
    })
    await this.emit('a2a.created', paymentId, {
      paymentId,
      payer: subscriber,
      payee,
      amountWei,
      asset,
      metadata: input.metadata,
    })
    return { method: 'a2a', paymentId, amountWei, payee }
  }

  /**
   * Phase 2: verify the payer's on-chain payment tx for an a2a intent and
   * credit it (idempotent per tx hash). The tx must be a valid payment to the
   * deployment payee wallet — the module then credits the payer's ledger
   * balance and lets the host route funds via onCredit / webhook events.
   */
  async a2aSettle(input: { paymentId: string; txHash: string; chain?: ChainKey }): Promise<VerifiedPayment | null> {
    if (!this.x402) throw new PaymentError('NOT_CONFIGURED', 'x402 is not configured', 503)
    const verified = await this.x402.verifyAndCredit(input.txHash, input.chain)
    if (!verified) return null
    await this.opts.store.updateIntentStatus?.(input.paymentId, 'paid')
    await this.emit('a2a.settled', input.paymentId, {
      paymentId: input.paymentId,
      reference: verified.reference,
      payer: verified.payer,
      creditedWei: verified.creditedWei,
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
    return verified
  }

  // ── Batch rail (one-shot multi-payee collection) ───────────────────────

  /**
   * Create a batch of a2a intents: one payer, N payees. Each item carries its
   * own paymentId and settles through a2aSettle (or POST /a2a/settle) with
   * its own on-chain tx. The batch flips to `completed` once every item is
   * paid.
   */
  private async _batchCreate(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    if (!this.batch || !this.x402 || (this.opts.a2a?.enabled ?? true) === false) {
      throw new PaymentError('NOT_CONFIGURED', 'Batch rail is not configured', 503)
    }
    const subscriber = input.subscriber
    const items = input.items
    if (!subscriber || !items?.length) {
      throw new PaymentError('INVALID_INPUT', 'batch: subscriber and items (non-empty payee list) are required', 400)
    }
    const chain = input.chain ?? 'oxachain'
    const batchId = `batch_${randomUUID()}`
    const results: BatchItemResult[] = []
    for (const item of items) {
      const payee = String(item.payee ?? '').toLowerCase()
      const amountWei = String(item.amountWei ?? '')
      if (!payee || !amountWei) {
        throw new PaymentError('INVALID_INPUT', 'batch: each item needs payee and amountWei', 400)
      }
      const paymentId = `a2a_${randomUUID()}`
      const asset = (item.asset ?? NATIVE_ASSET).toLowerCase()
      results.push({ itemId: randomUUID(), paymentId, payee, amountWei, asset })
      await this.opts.store.recordIntent?.({
        paymentId,
        method: 'a2a',
        subscriber,
        amountWei,
        asset,
        chain,
        status: 'created',
        metadata: item.metadata,
      })
    }
    await this.batch.createBatch({
      batchId,
      payer: subscriber.toLowerCase(),
      chain,
      status: 'open',
      items: results.map((r) => ({ ...r, status: 'pending' })),
      metadata: input.metadata,
    })
    await this.emit('batch.created', batchId, {
      batchId,
      payer: subscriber,
      chain,
      itemCount: results.length,
      items: results,
      metadata: input.metadata,
    })
    return { method: 'batch', batchId, items: results }
  }

  /**
   * Settle one batch item: verify the payer's tx for that item's paymentId and
   * mark the item paid (flipping the batch to `completed` when all are paid).
   */
  async settleBatchItem(input: { batchId: string; itemId: string; txHash: string; chain?: ChainKey }): Promise<VerifiedPayment | null> {
    if (!this.batch) throw new PaymentError('NOT_CONFIGURED', 'Batch rail is not configured', 503)
    const verified = await this.a2aSettle({ paymentId: input.itemId, txHash: input.txHash, chain: input.chain })
    if (!verified) return null
    await this.batch.settleItem(input.batchId, input.itemId, verified.reference)
    const batch = await this.batch.getBatch(input.batchId)
    await this.emit('batch.item.settled', input.batchId, {
      batchId: input.batchId,
      itemId: input.itemId,
      reference: verified.reference,
    })
    if (batch?.status === 'completed') {
      await this.emit('batch.completed', input.batchId, {
        batchId: input.batchId,
        payer: batch.payer,
        itemCount: batch.items.length,
      })
    }
    return verified
  }

  /** Read a batch's current state. */
  async getBatch(batchId: string): Promise<import('./store').PaymentBatch | null> {
    if (!this.batch) throw new PaymentError('NOT_CONFIGURED', 'Batch rail is not configured', 503)
    return this.batch.getBatch(batchId)
  }

  /** Cancel a batch (items that were never paid). */
  async cancelBatch(batchId: string): Promise<void> {
    if (!this.batch) throw new PaymentError('NOT_CONFIGURED', 'Batch rail is not configured', 503)
    await this.batch.cancelBatch(batchId)
    await this.emit('batch.completed', batchId, { batchId, cancelled: true })
  }

  // ── Period authorizations (subscription billing) ───────────────────────

  /**
   * Charge one period of an authorization. Idempotent guard: a host renews
   * subscriptions on each period boundary by calling this; the authorization
   * drains without any new signature.
   */
  async chargePeriod(authorizationId: string): Promise<{ renewed: boolean; remainingWei: string }> {
    if (!this.opts.authorizations) throw new PaymentError('NOT_CONFIGURED', 'Period rail is not configured', 503)
    const result = await this.opts.authorizations.chargePeriod(authorizationId)
    await this.emit('authorization.charged', authorizationId, { authorizationId, ...result })
    return result
  }

  /** Read a period authorization. */
  async getAuthorization(authorizationId: string): Promise<PaymentAuthorization | null> {
    if (!this.opts.authorizations) throw new PaymentError('NOT_CONFIGURED', 'Period rail is not configured', 503)
    return this.opts.authorizations.getAuthorization(authorizationId)
  }

  // ── Billing invitations (agent → agent charge invites) ─────────────────

  /**
   * Create a billing invitation: an a2a intent with a business bill on top.
   * The payee (collecting agent) is the invite owner; the payer settles either
   * on-chain (settleInvite) or from their ledger balance (payInviteByBalance).
   */
  async createInvite(input: {
    payer: string
    payee: string
    valueWei: string
    asset?: string
    chain?: ChainKey
    dueAt?: Date | string
    memo?: string
    metadata?: Record<string, unknown>
  }): Promise<{ inviteId: string; paymentId: string; amountWei: string; payee: string; dueAt: string | null }> {
    if (!this.invites) throw new PaymentError('NOT_CONFIGURED', 'Invite rail is not configured', 503)
    // NOTE: creating an invite and settling it from the payer's ledger balance
    // (payInviteByBalance) do NOT need x402 — only the on-chain settle path
    // does (a2aSettle checks it internally). This lets hosts run invitation
    // billing with balance transfers alone.
    const payer = String(input.payer ?? '').toLowerCase()
    const payee = String(input.payee ?? '').toLowerCase()
    const amountWei = String(input.valueWei ?? '')
    if (!payer || !payee || !amountWei) {
      throw new PaymentError('INVALID_INPUT', 'invite: payer, payee and valueWei are required', 400)
    }
    const chain = input.chain ?? 'oxachain'
    const dueAt = input.dueAt ? new Date(input.dueAt) : null
    if (dueAt && Number.isNaN(dueAt.getTime())) {
      throw new PaymentError('INVALID_INPUT', 'dueAt is not a valid date', 400)
    }
    const inviteId = `inv_${randomUUID()}`
    // Underlying a2a intent, recorded without the x402 engine (creation and
    // balance settlement need no on-chain verification — only settleInvite's
    // chain path does, and a2aSettle checks that internally).
    const paymentId = `a2a_${randomUUID()}`
    const asset = (input.asset ?? NATIVE_ASSET).toLowerCase()
    await this.opts.store.recordIntent?.({
      paymentId,
      method: 'a2a',
      subscriber: payer,
      amountWei,
      asset,
      chain,
      status: 'created',
      metadata: input.metadata,
    })
    await this.emit('a2a.created', paymentId, {
      paymentId,
      payer,
      payee,
      amountWei,
      asset,
      metadata: input.metadata,
    })
    await this.invites.createInvite({
      inviteId,
      paymentId,
      payer,
      payee,
      asset,
      chain,
      amountWei,
      memo: input.memo ?? null,
      dueAt,
      status: 'created',
      metadata: input.metadata,
    })
    await this.emit('invite.created', inviteId, {
      inviteId,
      paymentId,
      payer,
      payee,
      amountWei,
      dueAt: dueAt?.toISOString() ?? null,
      memo: input.memo,
      metadata: input.metadata,
    })
    return { inviteId, paymentId, amountWei, payee, dueAt: dueAt?.toISOString() ?? null }
  }

  /** Read one invite (past-due invites flip to `expired` lazily). */
  async getInvite(inviteId: string): Promise<PaymentInvite | null> {
    if (!this.invites) throw new PaymentError('NOT_CONFIGURED', 'Invite rail is not configured', 503)
    await this.invites.expireDue(inviteId)
    return this.invites.getInvite(inviteId)
  }

  /** List invitations for an address (payer=issued, payee=owed). */
  async listInvites(address: string, role: 'payer' | 'payee', status?: 'open' | 'created' | 'sent' | 'settled' | 'expired' | 'cancelled'): Promise<PaymentInvite[]> {
    if (!this.invites) throw new PaymentError('NOT_CONFIGURED', 'Invite rail is not configured', 503)
    await this.invites.expireDue()
    return this.invites.listInvites(address, { role, status })
  }

  /** Cancel an open invitation (created/sent only). */
  async cancelInvite(inviteId: string): Promise<{ cancelled: boolean }> {
    if (!this.invites) throw new PaymentError('NOT_CONFIGURED', 'Invite rail is not configured', 503)
    const cancelled = await this.invites.markCancelled(inviteId)
    await this.emit('invite.cancelled', inviteId, { inviteId })
    return { cancelled }
  }

  /**
   * Settle an invitation on-chain: verify the payer's tx for the wrapped a2a
   * intent and mark the invite settled. Returns null when the tx is not a
   * valid platform payment.
   */
  async settleInvite(inviteId: string, txHash: string, chain?: ChainKey): Promise<{ settled: boolean; reference?: string } | null> {
    if (!this.invites) throw new PaymentError('NOT_CONFIGURED', 'Invite rail is not configured', 503)
    const invite = await this.getInvite(inviteId)
    if (!invite) throw new PaymentError('NOT_FOUND', `Invite ${inviteId} not found`, 404)
    if (invite.status === 'expired') throw new PaymentError('EXPIRED', 'Invite has expired', 410)
    if (invite.status === 'settled') return { settled: false }
    const verified = await this.a2aSettle({ paymentId: invite.paymentId, txHash, chain })
    if (!verified) return null
    const settled = await this.invites.markSettled(inviteId, 'chain', verified.reference)
    await this.emit('invite.settled', inviteId, {
      inviteId,
      method: 'chain',
      reference: verified.reference,
      payer: verified.payer,
      amountWei: verified.creditedWei,
    })
    return { settled, reference: verified.reference }
  }

  /**
   * Settle an invitation from the payer's ledger balance (no new signature).
   * Internally creates + confirms a transfer keyed by the invite id; the
   * transfer id becomes the invite's settled reference.
   */
  async payInviteByBalance(inviteId: string): Promise<{ settled: boolean; transferId?: string }> {
    if (!this.invites || !this.transfers) throw new PaymentError('NOT_CONFIGURED', 'Invite/transfer rail is not configured', 503)
    const invite = await this.getInvite(inviteId)
    if (!invite) throw new PaymentError('NOT_FOUND', `Invite ${inviteId} not found`, 404)
    if (invite.status === 'settled') return { settled: false }
    if (invite.status === 'expired') throw new PaymentError('EXPIRED', 'Invite has expired', 410)
    const created = await this.createTransfer({
      from: invite.payer,
      to: invite.payee,
      valueWei: invite.amountWei,
      asset: invite.asset,
      reference: inviteId, // idempotency: one invite → at most one transfer
      metadata: { inviteId },
    })
    const exec = await this.confirmTransfer(created.transferId)
    if (!exec.ok) {
      throw new PaymentError('INSUFFICIENT_BALANCE', `Balance payment failed: ${exec.reason}`, 400)
    }
    await this.invites.markSettled(inviteId, 'balance', created.transferId)
    await this.emit('invite.settled', inviteId, { inviteId, method: 'balance', reference: created.transferId })
    return { settled: true, transferId: created.transferId }
  }

  // ── Ledger-internal transfers (balance → balance) ───────────────────────

  /**
   * Request a ledger transfer. Idempotent on `reference`: a reference already
   * used returns the existing transfer instead of creating a second one.
   */
  async createTransfer(input: { from: string; to: string; valueWei: string; asset?: string; reference?: string; metadata?: Record<string, unknown> }): Promise<{ transferId: string; status: PaymentTransfer['status'] }> {
    if (!this.transfers) throw new PaymentError('NOT_CONFIGURED', 'Transfer rail is not configured', 503)
    const from = String(input.from ?? '').toLowerCase()
    const to = String(input.to ?? '').toLowerCase()
    const amountWei = String(input.valueWei ?? '')
    if (!from || !to || !amountWei) {
      throw new PaymentError('INVALID_INPUT', 'transfer: from, to and valueWei are required', 400)
    }
    const asset = (input.asset ?? NATIVE_ASSET).toLowerCase()
    const reference = String(input.reference ?? `tf_${randomUUID()}`).toLowerCase()
    const existing = await this.transfers.getTransferByReference(reference)
    if (existing) return { transferId: existing.transferId, status: existing.status }
    const transferId = `tf_${randomUUID()}`
    await this.transfers.createTransfer({
      transferId,
      fromAddr: from,
      toAddr: to,
      asset,
      amountWei,
      status: 'requested',
      confirmMethod: 'callback',
      reference,
      metadata: input.metadata,
    })
    await this.emit('transfer.requested', transferId, { transferId, from, to, amountWei, asset, reference, metadata: input.metadata })
    return { transferId, status: 'requested' }
  }

  /**
   * Confirm (and execute) a requested transfer. The payer's host calls this
   * once; the store debits `from` and credits `to` atomically.
   */
  async confirmTransfer(transferId: string): Promise<{ ok: boolean; status: PaymentTransfer['status']; reason?: string }> {
    if (!this.transfers) throw new PaymentError('NOT_CONFIGURED', 'Transfer rail is not configured', 503)
    const result = await this.transfers.executeTransfer(transferId)
    if (result.ok) {
      await this.emit('transfer.executed', transferId, { transferId })
      return { ok: true, status: 'executed' }
    }
    await this.emit('transfer.rejected', transferId, { transferId, reason: result.reason })
    return { ok: false, status: 'rejected', reason: result.reason }
  }

  /** Read a transfer's state. */
  async getTransfer(transferId: string): Promise<PaymentTransfer | null> {
    if (!this.transfers) throw new PaymentError('NOT_CONFIGURED', 'Transfer rail is not configured', 503)
    return this.transfers.getTransfer(transferId)
  }

  /** Cancel an open (requested) transfer. */
  async cancelTransfer(transferId: string): Promise<void> {
    if (!this.transfers) throw new PaymentError('NOT_CONFIGURED', 'Transfer rail is not configured', 503)
    await this.transfers.cancelTransfer(transferId)
  }

  /** List transfers for an address (from=debited, to=credited). */
  async listTransfers(address: string, role: 'from' | 'to'): Promise<PaymentTransfer[]> {
    if (!this.transfers) throw new PaymentError('NOT_CONFIGURED', 'Transfer rail is not configured', 503)
    return this.transfers.listTransfers(address, role)
  }

  // ── Capabilities (pluggable rail discovery) ────────────────────────────

  /**
   * Current capability map (id → info). Callers probe this before using any
   * rail; the generic router mounts endpoints dynamically from the same map.
   */
  capabilities(): Capabilities {
    const caps: Capabilities = {
      chain: {
        id: 'chain',
        enabled: true,
        description: 'On-chain plan pricing + escrow subscription status (SubscriptionManager reads)',
        endpoints: ['GET /price', 'GET /chain-info/:chain', 'GET /subscription/:chain/:subscriber/:resourceId'],
      },
      fiat: {
        id: 'fiat',
        enabled: !!this.stripe,
        description: 'Stripe checkout + webhook (signature verified in-engine)',
        endpoints: ['POST /checkout', 'POST /webhook'],
        config: this.stripe ? { provider: 'stripe' } : undefined,
      },
      x402: {
        id: 'x402',
        enabled: !!this.x402,
        description: 'Single-shot on-chain payment verification (native + stablecoin)',
        endpoints: ['POST /verify', 'GET /info'],
        config: this.x402
          ? { chain: this.x402.chain(), payTo: this.x402.payTo(), stablecoin: this.x402.stablecoinAvailable() }
          : undefined,
      },
      mpp: {
        id: 'mpp',
        enabled: !!this.mpp,
        description: 'Payment channels (open → vouchers* → settle/close)',
        endpoints: ['POST /mpp/open', 'POST /mpp/voucher', 'POST /mpp/topup', 'POST /mpp/settle', 'POST /mpp/close', 'GET /mpp/session'],
        config: this.mpp ? { payee: this.mpp.payeeOf(), chain: this.mpp.chain() } : undefined,
      },
      a2a: {
        id: 'a2a',
        enabled: !!this.x402 && (this.opts.a2a?.enabled ?? true),
        description: 'Two-phase account-to-account: intent → on-chain tx → settle',
        endpoints: ['POST /a2a', 'POST /a2a/settle'],
        config: this.x402 ? { defaultPayee: this.x402.payTo() } : undefined,
      },
      batch: {
        id: 'batch',
        enabled: !!this.opts.batch && !!this.x402 && (this.opts.a2a?.enabled ?? true),
        description: 'One-shot multi-payee collection (N a2a intents in one request)',
        endpoints: ['POST /batch', 'POST /batch/settle', 'GET /batch', 'POST /batch/cancel'],
        config: this.opts.batch ? { store: 'payment_batches' } : undefined,
      },
      period: {
        id: 'period',
        enabled: !!this.opts.authorizations,
        description: 'Subscription billing: one authorization funds n periods, charged without re-signing',
        endpoints: ['POST /period/charge', 'GET /period/authorization'],
        config: this.opts.authorizations ? { store: 'payment_authorizations' } : undefined,
      },
      invite: {
        id: 'invite',
        enabled: !!this.invites,
        description: 'Billing invitations: agent A charges agent B (a2a intent + bill), settle on-chain or from balance',
        endpoints: ['POST /invites', 'GET /invites', 'GET /invites/:inviteId', 'POST /invites/:inviteId/cancel', 'POST /invites/:inviteId/settle', 'POST /invites/:inviteId/pay'],
        config: this.invites ? { store: 'payment_invites', defaultPayee: this.x402?.payTo() } : undefined,
      },
      transfer: {
        id: 'transfer',
        enabled: !!this.transfers,
        description: 'Ledger-internal transfers: debit from → credit to atomically, no new signature (payer host confirms once)',
        endpoints: ['POST /transfers', 'POST /transfers/:transferId/confirm', 'GET /transfers', 'GET /transfers/:transferId', 'POST /transfers/:transferId/cancel'],
        config: this.transfers ? { store: 'payment_transfers' } : undefined,
      },
    }
    return caps
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
