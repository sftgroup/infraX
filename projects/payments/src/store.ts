// ---------------------------------------------------------------------------
// @0xinfrax/payments — PaymentStore (data-access seam)
// ---------------------------------------------------------------------------
// PaymentsService never touches the database directly. All persistence goes
// through a `PaymentStore`, so each deployment injects its own schema:
//
//   - Generic deployments use PgPaymentStore (module-owned `payment_*` tables).
//   - AgentX embeds an AgentX-backed store over its own tables.
//
// This is what keeps the module independent and migratable.
// ---------------------------------------------------------------------------

import { NATIVE_ASSET } from './types'
import type { ChainKey, PaymentCredit, PaymentEvent } from './types'

/**
 * Structural subset of a pg Pool (or any SQL driver with the same shape).
 * The module deliberately does NOT depend on @types/pg so hosts can inject
 * their own pool regardless of its `pg` type version.
 */
export interface SqlExecutor {
  query<R = any>(text: string, values?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>
}

/** What the caller wants access to (opaque — the store knows how to read it). */
export type AccessResource = string | number | Record<string, unknown>

export interface AccessCheckOptions {
  chain?: ChainKey
}

/** Lifecycle of a payment intent (audit trail across all rails). */
export type PaymentIntentStatus = 'created' | 'paid' | 'failed' | 'closed'

export const PAYMENT_INTENT_STATUSES: readonly PaymentIntentStatus[] = ['created', 'paid', 'failed', 'closed']

/** A unified payment-intent row (audit trail across all rails). */
export interface PaymentIntentInput {
  paymentId: string
  method: string
  subscriber?: string
  asset?: string
  /** Atomic units (decimal string or bigint). */
  amountWei?: bigint | string
  currency?: string
  chain?: string
  status?: PaymentIntentStatus
  metadata?: Record<string, unknown>
}

export interface PaymentStore {
  /** Current credit balance (wei, per asset) of an address. */
  balanceOf(address: string, asset?: string): Promise<bigint>
  /** Record a verified incoming payment. Idempotent on `reference`. */
  credit(credit: PaymentCredit): Promise<void>
  /** Whether a reference was already credited (idempotency probe). */
  isCreditRecorded(reference: string): Promise<boolean>
  /** Atomically deduct from a balance; false when insufficient. */
  deduct(address: string, amount: bigint, asset?: string): Promise<boolean>
  /** Unified access check (the store decides how to interpret `resource`). */
  resolveAccess(subscriber: string, resource: AccessResource, opts?: AccessCheckOptions): Promise<boolean>
  /** Record a payment intent (audit trail). Optional — hosts may skip. */
  recordIntent?(intent: PaymentIntentInput): Promise<void>
  /**
   * Advance a payment intent's lifecycle. Optional — hosts may skip.
   * Module convention: `created → paid | failed | closed`; `paid → closed`.
   */
  updateIntentStatus?(paymentId: string, status: PaymentIntentStatus): Promise<void>
  /**
   * Append an outbound lifecycle event (see `PaymentEvent`). Optional — hosts
   * that consume lifecycle via callbacks (onWebhookEvent / onCredit) may skip.
   */
  emitEvent?(event: PaymentEvent): Promise<void>
}

// ---------------------------------------------------------------------------
// Generic Postgres store — module-owned schema (`payment_*`).
// ---------------------------------------------------------------------------

export class PgPaymentStore implements PaymentStore {
  constructor(private pool: SqlExecutor) {}

  async balanceOf(address: string, asset: string = NATIVE_ASSET): Promise<bigint> {
    const { rows } = await this.pool.query(
      'SELECT balance_wei FROM payment_balances WHERE address = $1 AND asset = $2',
      [address.toLowerCase(), asset.toLowerCase()]
    )
    return rows.length ? BigInt(rows[0].balance_wei) : 0n
  }

  async credit(credit: PaymentCredit): Promise<void> {
    const res = await this.pool.query(
      `INSERT INTO payment_credits (reference, payer, amount_wei, asset, chain_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (reference) DO NOTHING`,
      [
        credit.reference.toLowerCase(),
        credit.payer.toLowerCase(),
        credit.amountWei,
        credit.asset.toLowerCase(),
        credit.chainId,
        credit.metadata ? JSON.stringify(credit.metadata) : null,
      ]
    )
    if ((res.rowCount ?? 0) === 0) return // already credited
    await this.pool.query(
      `INSERT INTO payment_balances (address, asset, balance_wei) VALUES ($1, $2, $3)
       ON CONFLICT (address, asset) DO UPDATE SET
         balance_wei = (payment_balances.balance_wei::numeric + $3::numeric)::text,
         updated_at = NOW()`,
      [credit.payer.toLowerCase(), credit.asset.toLowerCase(), credit.amountWei]
    )
  }

  async isCreditRecorded(reference: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      'SELECT 1 FROM payment_credits WHERE reference = $1',
      [reference.toLowerCase()]
    )
    return rows.length > 0
  }

  async recordIntent(intent: PaymentIntentInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO payment_intents (intent_id, method, subscriber, asset, amount_wei, currency, chain, status, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (intent_id) DO NOTHING`,
      [
        intent.paymentId.toLowerCase(),
        intent.method,
        intent.subscriber?.toLowerCase() ?? null,
        (intent.asset ?? NATIVE_ASSET).toLowerCase(),
        intent.amountWei !== undefined ? String(intent.amountWei) : null,
        intent.currency ?? null,
        intent.chain ?? null,
        intent.status ?? 'created',
        intent.metadata ? JSON.stringify(intent.metadata) : null,
      ]
    )
  }

  async updateIntentStatus(paymentId: string, status: PaymentIntentStatus): Promise<void> {
    await this.pool.query(
      'UPDATE payment_intents SET status = $2, updated_at = NOW() WHERE intent_id = $1',
      [paymentId.toLowerCase(), status]
    )
  }

  async deduct(address: string, amount: bigint, asset: string = NATIVE_ASSET): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE payment_balances SET balance_wei = (balance_wei::numeric - $3::numeric)::text, updated_at = NOW()
       WHERE address = $1 AND asset = $2 AND balance_wei::numeric >= $3`,
      [address.toLowerCase(), asset.toLowerCase(), amount.toString()]
    )
    return (res.rowCount ?? 0) > 0
  }

  async resolveAccess(
    subscriber: string,
    resource: AccessResource,
    _opts?: AccessCheckOptions
  ): Promise<boolean> {
    // Generic registry: payment_access rows granted by the module owner.
    const res = await this.pool.query(
      `SELECT 1 FROM payment_access
       WHERE subscriber = $1 AND resource = $2 AND status = 'active'
         AND (expires_at IS NULL OR expires_at > NOW()) LIMIT 1`,
      [subscriber.toLowerCase(), JSON.stringify(resource ?? {})]
    )
    return res.rows.length > 0
  }

  async emitEvent(event: PaymentEvent): Promise<void> {
    await this.pool.query(
      `INSERT INTO payment_events (event_type, reference, payload)
       VALUES ($1, $2, $3)`,
      [event.type, event.reference, JSON.stringify(event.payload ?? {})]
    )
  }
}

// ---------------------------------------------------------------------------
// MPP session store — payment channels (open → vouchers* → close, with topup).
// Kept as a separate seam: hosts that keep sessions in their own schema inject
// their own implementation; the generic module owns `payment_sessions`.
// ---------------------------------------------------------------------------

export interface MPPSessionRow {
  channelId: string
  payer: string
  payee: string
  chain: string
  asset: string
  /** Deposit frozen at open (atomic units). */
  depositWei: string
  /** Latest signed cumulative amount (monotonic, ≤ deposit). */
  currentCum: string
  /** Amount already settled (deducted from the payer balance). */
  spentWei: string
  lastSignature: string | null
  status: 'open' | 'closed'
  salt: string | null
  lastSettleAt: Date | null
  autoSettle: boolean
  settleIntervalSec: number
}

export interface MPPSessionStore {
  getSession(channelId: string): Promise<MPPSessionRow | null>
  createSession(row: MPPSessionRow): Promise<void>
  /** Atomically accept a voucher: current_cum = cum, last_signature = sig. */
  applyVoucher(channelId: string, cumulativeAmount: string, signature: string): Promise<void>
  /** Append a voucher row (audit trail, one row per signature). */
  recordVoucher(channelId: string, cumulativeAmount: string, signature: string): Promise<void>
  /** Atomically consume: spent_wei += consume; updates last_settle_at. */
  applySettle(channelId: string, consumeWei: string): Promise<void>
  /** Increase the deposit after a new funding tx. */
  topUp(channelId: string, additionalWei: string): Promise<void>
  closeSession(channelId: string): Promise<void>
}

export class PgMPPSessionStore implements MPPSessionStore {
  constructor(private pool: SqlExecutor) {}

  async getSession(channelId: string): Promise<MPPSessionRow | null> {
    const { rows } = await this.pool.query('SELECT * FROM payment_sessions WHERE channel_id = $1', [channelId.toLowerCase()])
    if (!rows.length) return null
    const r = rows[0]
    return {
      channelId: r.channel_id,
      payer: r.payer,
      payee: r.payee,
      chain: r.chain,
      asset: r.asset,
      depositWei: r.deposit_wei,
      currentCum: r.current_cum,
      spentWei: r.spent_wei,
      lastSignature: r.last_signature,
      status: r.status,
      salt: r.salt,
      lastSettleAt: r.last_settle_at,
      autoSettle: r.auto_settle,
      settleIntervalSec: r.settle_interval_sec,
    }
  }

  async createSession(row: MPPSessionRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO payment_sessions
        (channel_id, payer, payee, chain, asset, deposit_wei, current_cum, spent_wei,
         last_signature, status, salt, auto_settle, settle_interval_sec)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (channel_id) DO NOTHING`,
      [
        row.channelId.toLowerCase(),
        row.payer.toLowerCase(),
        row.payee.toLowerCase(),
        row.chain,
        row.asset.toLowerCase(),
        row.depositWei,
        row.currentCum,
        row.spentWei,
        row.lastSignature,
        row.status,
        row.salt,
        row.autoSettle,
        row.settleIntervalSec,
      ]
    )
  }

  async applyVoucher(channelId: string, cumulativeAmount: string, signature: string): Promise<void> {
    const res = await this.pool.query(
      `UPDATE payment_sessions
       SET current_cum = $2, last_signature = $3, updated_at = NOW()
       WHERE channel_id = $1 AND status = 'open' AND current_cum::numeric < $2::numeric`,
      [channelId.toLowerCase(), cumulativeAmount, signature]
    )
    if ((res.rowCount ?? 0) === 0) {
      throw new Error(`Voucher rejected: not open or cumulative ${cumulativeAmount} is not monotonic`)
    }
  }

  async recordVoucher(channelId: string, cumulativeAmount: string, signature: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO payment_vouchers (channel_id, cumulative_amount, signature)
       VALUES ($1, $2, $3)`,
      [channelId.toLowerCase(), cumulativeAmount, signature]
    )
  }

  async applySettle(channelId: string, consumeWei: string): Promise<void> {
    await this.pool.query(
      `UPDATE payment_sessions
       SET spent_wei = (spent_wei::numeric + $2::numeric)::text,
           last_settle_at = NOW(), updated_at = NOW()
       WHERE channel_id = $1`,
      [channelId.toLowerCase(), consumeWei]
    )
  }

  async topUp(channelId: string, additionalWei: string): Promise<void> {
    await this.pool.query(
      `UPDATE payment_sessions
       SET deposit_wei = (deposit_wei::numeric + $2::numeric)::text, updated_at = NOW()
       WHERE channel_id = $1 AND status = 'open'`,
      [channelId.toLowerCase(), additionalWei]
    )
  }

  async closeSession(channelId: string): Promise<void> {
    await this.pool.query(
      `UPDATE payment_sessions SET status = 'closed', closed_at = NOW(), updated_at = NOW()
       WHERE channel_id = $1`,
      [channelId.toLowerCase()]
    )
  }
}
