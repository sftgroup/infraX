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
  /**
   * Optional multi-statement transaction runner. Needed by stores whose
   * operations must be atomic across rows (e.g. transfers: debit + credit).
   * `fn` receives a bound executor sharing the same connection; a throw rolls
   * back. Hosts without this capability get transfers that reject at confirm.
   */
  transaction?<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>
}

/** What the caller wants access to (opaque — the store knows how to read it). */
export type AccessResource = string | number | Record<string, unknown>

export interface AccessCheckOptions {
  chain?: ChainKey
}

/** Lifecycle of a payment intent (audit trail across all rails). */
export type PaymentIntentStatus = 'created' | 'paid' | 'failed' | 'closed'

export const PAYMENT_INTENT_STATUSES: readonly PaymentIntentStatus[] = ['created', 'paid', 'failed', 'closed']

/** A persisted payment-intent row (read-back for admin/ops consoles). */
export interface PaymentIntentRow {
  intentId: string
  method: string
  subscriber: string | null
  asset: string | null
  /** Atomic units, string to stay exact at any magnitude. */
  amountWei: string | null
  currency: string | null
  chain: string | null
  status: PaymentIntentStatus
  metadata: Record<string, unknown> | null
  createdAt: Date
  updatedAt: Date
}

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
   * Read back payment intents (admin/ops audit view). Optional — hosts may
   * skip; callers then get an empty list. Newest-first, paginated.
   */
  listIntents?(params: { limit?: number; offset?: number; status?: string; subscriber?: string }): Promise<PaymentIntentRow[]>
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

  async listIntents(params: { limit?: number; offset?: number; status?: string; subscriber?: string } = {}): Promise<PaymentIntentRow[]> {
    const where: string[] = []
    const values: unknown[] = []
    if (params.status) {
      values.push(String(params.status))
      where.push(`status = $${values.length}`)
    }
    if (params.subscriber) {
      values.push(String(params.subscriber).toLowerCase())
      where.push(`subscriber = $${values.length}`)
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const limit = Math.min(Math.max(Number(params.limit) || 50, 1), 200)
    const offset = Math.max(Number(params.offset) || 0, 0)
    values.push(limit, offset)
    const { rows } = await this.pool.query(
      `SELECT intent_id, method, subscriber, asset, amount_wei, currency, chain, status, metadata, created_at, updated_at
       FROM payment_intents ${whereSql}
       ORDER BY created_at DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    )
    return rows.map((r) => ({
      intentId: r.intent_id,
      method: r.method,
      subscriber: r.subscriber,
      asset: r.asset,
      amountWei: r.amount_wei !== null && r.amount_wei !== undefined ? String(r.amount_wei) : null,
      currency: r.currency,
      chain: r.chain,
      status: r.status,
      metadata: r.metadata ? (typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata) : null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }))
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

// ---------------------------------------------------------------------------
// Period authorization store — the `period` capability (permit2-style / native):
// one authorization funds n periods; each period boundary charges one unit
// without re-signing (deducted from remaining until exhausted).
// ---------------------------------------------------------------------------

export interface PaymentAuthorization {
  id: string
  owner: string
  asset: string
  chain: string
  amountWei: string
  remainingWei: string
  periodPriceWei: string
  periods: number
  nonce: string
  /** Idempotency key (funding tx hash / salt). */
  reference: string
  status: 'active' | 'exhausted' | 'revoked'
  createdAt: Date
}

export interface AuthorizationStore {
  createAuthorization(auth: PaymentAuthorization): Promise<void>
  getAuthorization(id: string): Promise<PaymentAuthorization | null>
  /**
   * Atomically charge one period: remaining -= periodPrice. Returns the new
   * remaining; marks `exhausted` when the remaining can no longer cover a
   * full period. Throws when not active / insufficient.
   */
  chargePeriod(id: string): Promise<{ renewed: boolean; remainingWei: string }>
}

export class PgAuthorizationStore implements AuthorizationStore {
  constructor(private pool: SqlExecutor) {}

  async createAuthorization(auth: PaymentAuthorization): Promise<void> {
    await this.pool.query(
      `INSERT INTO payment_authorizations
        (id, owner, asset, chain, amount_wei, remaining_wei, period_price_wei, periods, nonce, reference, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (id) DO NOTHING`,
      [
        auth.id,
        auth.owner.toLowerCase(),
        auth.asset.toLowerCase(),
        auth.chain,
        auth.amountWei,
        auth.remainingWei,
        auth.periodPriceWei,
        auth.periods,
        auth.nonce,
        auth.reference,
        auth.status,
      ]
    )
  }

  async getAuthorization(id: string): Promise<PaymentAuthorization | null> {
    const { rows } = await this.pool.query('SELECT * FROM payment_authorizations WHERE id = $1', [id])
    if (!rows.length) return null
    const r = rows[0]
    return {
      id: r.id,
      owner: r.owner,
      asset: r.asset,
      chain: r.chain,
      amountWei: r.amount_wei,
      remainingWei: r.remaining_wei,
      periodPriceWei: r.period_price_wei,
      periods: r.periods,
      nonce: r.nonce,
      reference: r.reference,
      status: r.status,
      createdAt: r.created_at,
    }
  }

  async chargePeriod(id: string): Promise<{ renewed: boolean; remainingWei: string }> {
    const res = await this.pool.query(
      `UPDATE payment_authorizations
       SET remaining_wei = (remaining_wei::numeric - period_price_wei::numeric)::text,
           status = CASE
             WHEN (remaining_wei::numeric - period_price_wei::numeric) < period_price_wei::numeric THEN 'exhausted'
             ELSE 'active'
           END
       WHERE id = $1 AND status = 'active' AND remaining_wei::numeric >= period_price_wei::numeric
       RETURNING remaining_wei, status`,
      [id]
    )
    if (!res.rows.length) {
      const existing = await this.getAuthorization(id)
      if (!existing) throw new Error(`Authorization ${id} not found`)
      throw new Error(`Authorization ${id} cannot be charged (status=${existing.status}, remaining=${existing.remainingWei})`)
    }
    const row = res.rows[0]
    return { renewed: row.status === 'active', remainingWei: row.remaining_wei }
  }
}

// ---------------------------------------------------------------------------
// Batch store — one-shot multi-payee collection (the `batch` capability).
// A batch groups several a2a intents so an agent can collect from N peers in
// one request; each item settles through its own tx (POST /a2a/settle).
// ---------------------------------------------------------------------------

export interface BatchStoreItem {
  itemId: string
  paymentId: string
  payee: string
  amountWei: string
  asset: string
  status: 'pending' | 'paid' | 'failed'
  reference?: string | null
  metadata?: Record<string, unknown> | null
}

export interface PaymentBatch {
  batchId: string
  payer: string
  chain: string | null
  status: 'open' | 'completed' | 'cancelled'
  items: BatchStoreItem[]
  metadata?: Record<string, unknown> | null
  createdAt: Date
}

/** What callers pass when creating a batch (createdAt is DB-owned). */
export type PaymentBatchInput = Omit<PaymentBatch, 'createdAt'>

export interface BatchStore {
  createBatch(batch: PaymentBatchInput): Promise<void>
  getBatch(batchId: string): Promise<PaymentBatch | null>
  /**
   * Atomically mark one item paid (by reference) and flip the batch to
   * `completed` when every item is paid.
   */
  settleItem(batchId: string, itemId: string, reference: string): Promise<void>
  /** Mark the whole batch `cancelled` (items that were never paid). */
  cancelBatch(batchId: string): Promise<void>
}

export class PgBatchStore implements BatchStore {
  constructor(private pool: SqlExecutor) {}

  async createBatch(batch: PaymentBatch): Promise<void> {
    await this.pool.query(
      `INSERT INTO payment_batches (batch_id, payer, chain, status, items, metadata)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
       ON CONFLICT (batch_id) DO NOTHING`,
      [
        batch.batchId.toLowerCase(),
        batch.payer.toLowerCase(),
        batch.chain,
        batch.status,
        JSON.stringify(batch.items),
        batch.metadata ? JSON.stringify(batch.metadata) : null,
      ]
    )
  }

  async getBatch(batchId: string): Promise<PaymentBatch | null> {
    const { rows } = await this.pool.query('SELECT * FROM payment_batches WHERE batch_id = $1', [batchId.toLowerCase()])
    if (!rows.length) return null
    const r = rows[0]
    return {
      batchId: r.batch_id,
      payer: r.payer,
      chain: r.chain,
      status: r.status,
      items: r.items as BatchStoreItem[],
      metadata: r.metadata,
      createdAt: r.created_at,
    }
  }

  async settleItem(batchId: string, itemId: string, reference: string): Promise<void> {
    await this.pool.query(
      `WITH updated AS (
         UPDATE payment_batches
         SET items = (
           SELECT jsonb_agg(
             CASE WHEN item->>'itemId' = $3
               THEN item || jsonb_build_object('status', 'paid', 'reference', $4)
               ELSE item END
           )
           FROM jsonb_array_elements(items) item
         ),
         updated_at = NOW()
         WHERE batch_id = $1 AND status = 'open'
         RETURNING batch_id, items
       )
       UPDATE payment_batches pb
       SET status = 'completed', updated_at = NOW()
       FROM updated u
       WHERE pb.batch_id = u.batch_id
         AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(u.items) it WHERE it->>'status' <> 'paid')`,
      [batchId.toLowerCase(), batchId.toLowerCase(), itemId, reference]
    )
  }

  async cancelBatch(batchId: string): Promise<void> {
    await this.pool.query(
      `UPDATE payment_batches SET status = 'cancelled', updated_at = NOW()
       WHERE batch_id = $1 AND status = 'open'`,
      [batchId.toLowerCase()]
    )
  }
}

// ---------------------------------------------------------------------------
// Invite store — business-level billing invitations (the `invite` capability).
// One invite wraps an a2a payment intent and tracks its lifecycle:
//   created → sent → settled | expired | cancelled
// The payer can settle by on-chain tx (POST /invites/:id/settle) or by
// authorizing a ledger transfer from their balance (POST /invites/:id/pay).
// ---------------------------------------------------------------------------

export type InviteStatus = 'created' | 'sent' | 'settled' | 'expired' | 'cancelled'

export interface PaymentInvite {
  inviteId: string
  /** Underlying a2a payment intent (paymentId of phase-1 a2a). */
  paymentId: string
  /** The paying agent. */
  payer: string
  /** The collecting agent. */
  payee: string
  asset: string
  chain: string
  amountWei: string
  memo?: string | null
  /** Optional deadline; past-due invites expire lazily. */
  dueAt?: Date | null
  status: InviteStatus
  /** How the invite was finally settled. */
  settledMethod?: 'chain' | 'balance' | null
  /** tx hash (chain) or transfer id (balance). */
  settledRef?: string | null
  metadata?: Record<string, unknown> | null
  createdAt: Date
  updatedAt: Date
}

export type InviteInput = Omit<PaymentInvite, 'createdAt' | 'updatedAt'>

export interface InviteListQuery {
  role: 'payer' | 'payee'
  status?: InviteStatus | 'open'
  limit?: number
}

export interface InviteStore {
  createInvite(invite: InviteInput): Promise<void>
  getInvite(inviteId: string): Promise<PaymentInvite | null>
  listInvites(address: string, query: InviteListQuery): Promise<PaymentInvite[]>
  /**
   * Mark an invite settled (only from created/sent). Returns false when the
   * invite is not settleable (already settled / expired / cancelled / missing).
   */
  markSettled(inviteId: string, method: 'chain' | 'balance', reference: string): Promise<boolean>
  /** Cancel an open invite (only from created/sent). Returns false otherwise. */
  markCancelled(inviteId: string): Promise<boolean>
  /**
   * Lazily expire invites whose due_at passed while still created/sent.
   * Scoped to one invite when `inviteId` given; otherwise global. Returns the
   * number of invites expired.
   */
  expireDue(inviteId?: string): Promise<number>
}

export class PgInviteStore implements InviteStore {
  constructor(private pool: SqlExecutor) {}

  async createInvite(invite: InviteInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO payment_invites
        (invite_id, payment_id, payer, payee, asset, chain, amount_wei, memo, due_at, status, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (invite_id) DO NOTHING`,
      [
        invite.inviteId.toLowerCase(),
        invite.paymentId.toLowerCase(),
        invite.payer.toLowerCase(),
        invite.payee.toLowerCase(),
        invite.asset.toLowerCase(),
        invite.chain,
        invite.amountWei,
        invite.memo ?? null,
        invite.dueAt ?? null,
        invite.status,
        invite.metadata ? JSON.stringify(invite.metadata) : null,
      ]
    )
  }

  async getInvite(inviteId: string): Promise<PaymentInvite | null> {
    const { rows } = await this.pool.query('SELECT * FROM payment_invites WHERE invite_id = $1', [inviteId.toLowerCase()])
    return rows.length ? mapInvite(rows[0]) : null
  }

  async listInvites(address: string, query: InviteListQuery): Promise<PaymentInvite[]> {
    const col = query.role === 'payee' ? 'payee' : 'payer'
    if (!query.status || query.status === 'open') {
      const { rows } = await this.pool.query(
        `SELECT * FROM payment_invites
         WHERE ${col} = $1 AND status IN ('created','sent')
         ORDER BY created_at DESC
         LIMIT $2`,
        [address.toLowerCase(), query.limit ?? 50]
      )
      return rows.map(mapInvite)
    }
    const { rows } = await this.pool.query(
      `SELECT * FROM payment_invites
       WHERE ${col} = $1 AND status = $2
       ORDER BY created_at DESC
       LIMIT $3`,
      [address.toLowerCase(), query.status, query.limit ?? 50]
    )
    return rows.map(mapInvite)
  }

  async markSettled(inviteId: string, method: 'chain' | 'balance', reference: string): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE payment_invites
       SET status = 'settled', settled_method = $2, settled_ref = $3, updated_at = NOW()
       WHERE invite_id = $1 AND status IN ('created','sent')`,
      [inviteId.toLowerCase(), method, reference]
    )
    return (res.rowCount ?? 0) > 0
  }

  async markCancelled(inviteId: string): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE payment_invites
       SET status = 'cancelled', updated_at = NOW()
       WHERE invite_id = $1 AND status IN ('created','sent')`,
      [inviteId.toLowerCase()]
    )
    return (res.rowCount ?? 0) > 0
  }

  async expireDue(inviteId?: string): Promise<number> {
    const scope = inviteId ? 'AND invite_id = $1' : ''
    const values: unknown[] = inviteId ? [inviteId.toLowerCase()] : []
    const res = await this.pool.query(
      `UPDATE payment_invites
       SET status = 'expired', updated_at = NOW()
       WHERE status IN ('created','sent')
         AND due_at IS NOT NULL AND due_at < NOW()
         ${scope}`,
      values.length ? [values[0]] : []
    )
    return res.rowCount ?? 0
  }
}

function mapInvite(r: any): PaymentInvite {
  return {
    inviteId: r.invite_id,
    paymentId: r.payment_id,
    payer: r.payer,
    payee: r.payee,
    asset: r.asset,
    chain: r.chain,
    amountWei: r.amount_wei,
    memo: r.memo,
    dueAt: r.due_at,
    status: r.status,
    settledMethod: r.settled_method,
    settledRef: r.settled_ref,
    metadata: r.metadata,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

// ---------------------------------------------------------------------------
// Transfer store — ledger-internal transfers (the `transfer` capability).
// Unlike a2a (on-chain proof), a transfer moves funds between platform
// balances with no new signature: the payer's host confirms once, then the
// store debits the payer and credits the payee atomically (single tx).
//   requested → executed | rejected
// ---------------------------------------------------------------------------

export type TransferStatus = 'requested' | 'executed' | 'rejected' | 'cancelled'

export interface PaymentTransfer {
  transferId: string
  fromAddr: string
  toAddr: string
  asset: string
  amountWei: string
  status: TransferStatus
  confirmMethod: 'callback'
  /** Idempotency key — a reference is executed at most once. */
  reference: string
  executedAt?: Date | null
  metadata?: Record<string, unknown> | null
  createdAt: Date
}

export type TransferInput = Omit<PaymentTransfer, 'createdAt'>

export interface TransferStore {
  createTransfer(t: TransferInput): Promise<void>
  getTransfer(transferId: string): Promise<PaymentTransfer | null>
  getTransferByReference(reference: string): Promise<PaymentTransfer | null>
  listTransfers(address: string, role: 'from' | 'to'): Promise<PaymentTransfer[]>
  /**
   * Atomically execute a requested transfer: debit `from`, credit `to` within
   * one transaction. Returns the outcome:
   *   - { ok: true }  — funds moved, transfer → executed
   *   - { ok: false, reason } — insufficient balance / not found / not requestable
   */
  executeTransfer(transferId: string): Promise<{ ok: boolean; reason?: string }>
  /** Cancel an open transfer (requested only). */
  cancelTransfer(transferId: string): Promise<void>
}

/** Pg helper for hosts whose pool supports BEGIN/COMMIT through a tx runner. */
export class PgTransferStore implements TransferStore {
  constructor(private pool: SqlExecutor) {}

  async createTransfer(t: TransferInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO payment_transfers
        (transfer_id, from_addr, to_addr, asset, amount_wei, status, confirm_method, reference, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (transfer_id) DO NOTHING`,
      [
        t.transferId.toLowerCase(),
        t.fromAddr.toLowerCase(),
        t.toAddr.toLowerCase(),
        t.asset.toLowerCase(),
        t.amountWei,
        t.status,
        t.confirmMethod,
        t.reference.toLowerCase(),
        t.metadata ? JSON.stringify(t.metadata) : null,
      ]
    )
  }

  async getTransfer(transferId: string): Promise<PaymentTransfer | null> {
    const { rows } = await this.pool.query('SELECT * FROM payment_transfers WHERE transfer_id = $1', [transferId.toLowerCase()])
    return rows.length ? mapTransfer(rows[0]) : null
  }

  async getTransferByReference(reference: string): Promise<PaymentTransfer | null> {
    const { rows } = await this.pool.query('SELECT * FROM payment_transfers WHERE reference = $1', [reference.toLowerCase()])
    return rows.length ? mapTransfer(rows[0]) : null
  }

  async listTransfers(address: string, role: 'from' | 'to'): Promise<PaymentTransfer[]> {
    const col = role === 'to' ? 'to_addr' : 'from_addr'
    const { rows } = await this.pool.query(
      `SELECT * FROM payment_transfers WHERE ${col} = $1 ORDER BY created_at DESC LIMIT 100`,
      [address.toLowerCase()]
    )
    return rows.map(mapTransfer)
  }

  async executeTransfer(transferId: string): Promise<{ ok: boolean; reason?: string }> {
    if (!this.pool.transaction) {
      return { ok: false, reason: 'host executor does not support transactions' }
    }
    try {
      return await this.pool.transaction(async (tx) => {
        // 1) claim the transfer (requested → in-flight) — prevents double-run
        const claim = await tx.query(
          `UPDATE payment_transfers SET status = 'executed', executed_at = NOW()
           WHERE transfer_id = $1 AND status = 'requested'
           RETURNING from_addr, to_addr, asset, amount_wei, reference`,
          [transferId.toLowerCase()]
        )
        if (!claim.rows.length) {
          const existing = await this.getTransfer(transferId)
          if (!existing) return { ok: false, reason: 'transfer not found' }
          return { ok: false, reason: `transfer already ${existing.status}` }
        }
        const t = claim.rows[0]
        // 2) atomic debit (insufficient → roll back via throw)
        const debit = await tx.query(
          `UPDATE payment_balances
           SET balance_wei = (balance_wei::numeric - $2::numeric)::text, updated_at = NOW()
           WHERE address = $1 AND asset = $3 AND balance_wei::numeric >= $2::numeric`,
          [t.from_addr.toLowerCase(), t.amount_wei, t.asset.toLowerCase()]
        )
        if (!debit.rowCount) throw new Error('insufficient balance')
        // 3) credit the payee (upsert)
        await tx.query(
          `INSERT INTO payment_balances (address, asset, balance_wei) VALUES ($1, $2, $3)
           ON CONFLICT (address, asset) DO UPDATE SET
             balance_wei = (payment_balances.balance_wei::numeric + $3::numeric)::text,
             updated_at = NOW()`,
          [t.to_addr.toLowerCase(), t.asset.toLowerCase(), t.amount_wei]
        )
        return { ok: true }
      })
    } catch (err) {
      // roll back: return the transfer to requested on failure
      await this.pool.query(
        `UPDATE payment_transfers SET status = 'requested', executed_at = NULL
         WHERE transfer_id = $1 AND status = 'executed'`,
        [transferId.toLowerCase()]
      ).catch(() => undefined)
      return { ok: false, reason: (err as Error).message }
    }
  }

  async cancelTransfer(transferId: string): Promise<void> {
    await this.pool.query(
      `UPDATE payment_transfers SET status = 'cancelled'
       WHERE transfer_id = $1 AND status = 'requested'`,
      [transferId.toLowerCase()]
    )
  }
}

function mapTransfer(r: any): PaymentTransfer {
  return {
    transferId: r.transfer_id,
    fromAddr: r.from_addr,
    toAddr: r.to_addr,
    asset: r.asset,
    amountWei: r.amount_wei,
    status: r.status,
    confirmMethod: r.confirm_method,
    reference: r.reference,
    executedAt: r.executed_at,
    metadata: r.metadata,
    createdAt: r.created_at,
  }
}
