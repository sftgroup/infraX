// MQ-14 unit tests: invite state machine + transfer atomic ledger movement.
import { describe, expect, it, vi } from 'vitest'
import type { InviteStore, PaymentInvite, PaymentTransfer, TransferStore } from '../src/store'
import type { VerifiedPayment } from '../src/types'
import { makeService } from './helpers'

const PAYER = '0xaaaa'.padEnd(42, 'a')
const PAYEE = '0xbbbb'.padEnd(42, 'b')
const OTHER = '0xcccc'.padEnd(42, 'c')
const ASSET = '0x0000000000000000000000000000000000000000'

const verified = (over: Partial<VerifiedPayment> = {}): VerifiedPayment => ({
  reference: '0xtx1',
  payer: PAYER,
  creditedWei: 1000n,
  asset: ASSET,
  chain: 'sepolia',
  ...over,
})

// ── fake seams ──────────────────────────────────────────────────────────────

/** In-memory InviteStore with SQL-like state guards + lazy expiry. */
function makeInviteStore() {
  const rows = new Map<string, PaymentInvite>()
  const now = () => new Date()
  return {
    rows,
    createInvite: vi.fn(async (i: PaymentInvite) => { rows.set(i.inviteId, { ...i, createdAt: now(), updatedAt: now() }) }),
    getInvite: vi.fn(async (id: string) => rows.get(id) ?? null),
    listInvites: vi.fn(async (address: string, q: { role: 'payer' | 'payee'; status?: string }) => {
      const col = q.role === 'payee' ? 'payee' : 'payer'
      return [...rows.values()].filter((r) => {
        const roleOk = r[col].toLowerCase() === address.toLowerCase()
        const statusOk = !q.status || q.status === 'open' ? ['created', 'sent'].includes(r.status) : r.status === q.status
        return roleOk && statusOk
      }).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
    }),
    markSettled: vi.fn(async (id: string, method: 'chain' | 'balance', ref: string) => {
      const r = rows.get(id)
      if (!r || !['created', 'sent'].includes(r.status)) return false
      rows.set(id, { ...r, status: 'settled', settledMethod: method, settledRef: ref, updatedAt: now() })
      return true
    }),
    markCancelled: vi.fn(async (id: string) => {
      const r = rows.get(id)
      if (!r || !['created', 'sent'].includes(r.status)) return false
      rows.set(id, { ...r, status: 'cancelled', updatedAt: now() })
      return true
    }),
    expireDue: vi.fn(async (id?: string) => {
      let count = 0
      for (const [key, r] of rows) {
        if (r.status !== 'created' && r.status !== 'sent') continue
        if (r.dueAt && r.dueAt.getTime() < Date.now()) {
          if (id && r.inviteId !== id) continue
          rows.set(key, { ...r, status: 'expired', updatedAt: now() })
          count++
        }
      }
      return count
    }),
  } as unknown as InviteStore
}

/**
 * In-memory TransferStore with atomic-movement semantics: a confirm either
 * completes the whole debit+credit or leaves both balances untouched. Shares
 * a `balances` map so tests can assert that no partial movement happened.
 */
function makeTransferStore(balances: Map<string, string>) {
  const rows = new Map<string, PaymentTransfer>()
  return {
    rows,
    createTransfer: vi.fn(async (t: PaymentTransfer) => { rows.set(t.transferId, { ...t, createdAt: new Date() }) }),
    getTransfer: vi.fn(async (id: string) => rows.get(id) ?? null),
    getTransferByReference: vi.fn(async (ref: string) => [...rows.values()].find((t) => t.reference === ref) ?? null),
    listTransfers: vi.fn(async (address: string, role: 'from' | 'to') => {
      const col = role === 'to' ? 'toAddr' : 'fromAddr'
      return [...rows.values()].filter((t) => t[col].toLowerCase() === address.toLowerCase())
    }),
    executeTransfer: vi.fn(async (id: string) => {
      const t = rows.get(id)
      if (!t) return { ok: false, reason: 'transfer not found' }
      if (t.status !== 'requested') return { ok: false, reason: `transfer already ${t.status}` }
      const fromBal = BigInt(balances.get(t.fromAddr.toLowerCase()) ?? '0')
      if (fromBal < BigInt(t.amountWei)) return { ok: false, reason: 'insufficient balance' }
      // atomic: both sides move together or not at all
      const toBal = BigInt(balances.get(t.toAddr.toLowerCase()) ?? '0')
      balances.set(t.fromAddr.toLowerCase(), (fromBal - BigInt(t.amountWei)).toString())
      balances.set(t.toAddr.toLowerCase(), (toBal + BigInt(t.amountWei)).toString())
      rows.set(id, { ...t, status: 'executed', executedAt: new Date() })
      return { ok: true }
    }),
    cancelTransfer: vi.fn(async (id: string) => {
      const t = rows.get(id)
      if (t?.status === 'requested') rows.set(id, { ...t, status: 'cancelled' })
    }),
  } as unknown as TransferStore
}

// ── invite state machine ────────────────────────────────────────────────────

describe('invite state machine', () => {
  it('createInvite wraps an a2a intent and starts as created', async () => {
    const invites = makeInviteStore()
    const { store, payments } = makeService({}, { invites })
    const inv = await payments.createInvite({ payer: PAYER, payee: PAYEE, valueWei: '1000', memo: 'consulting' })
    expect(inv.inviteId.startsWith('inv_')).toBe(true)
    expect(inv.paymentId.startsWith('a2a_')).toBe(true)
    expect(inv.payee).toBe(PAYEE)
    expect(invites.rows.get(inv.inviteId)?.status).toBe('created')
    expect(store.recordIntent).toHaveBeenCalledWith(expect.objectContaining({ method: 'a2a', subscriber: PAYER }))
  })

  it('settleInvite (chain) marks the invite settled with the tx reference', async () => {
    const invites = makeInviteStore()
    const { payments } = makeService({}, { invites })
    vi.spyOn(payments.x402!, 'verifyAndCredit').mockResolvedValue(verified())
    const inv = await payments.createInvite({ payer: PAYER, payee: PAYEE, valueWei: '1000' })
    const result = await payments.settleInvite(inv.inviteId, '0xtx1')
    expect(result?.settled).toBe(true)
    expect(result?.reference).toBe('0xtx1')
    const stored = invites.rows.get(inv.inviteId)!
    expect(stored.status).toBe('settled')
    expect(stored.settledMethod).toBe('chain')
    expect(stored.settledRef).toBe('0xtx1')
  })

  it('settleInvite rejects an invalid tx (returns null)', async () => {
    const invites = makeInviteStore()
    const { payments } = makeService({}, { invites })
    vi.spyOn(payments.x402!, 'verifyAndCredit').mockResolvedValue(null)
    const inv = await payments.createInvite({ payer: PAYER, payee: PAYEE, valueWei: '1000' })
    expect(await payments.settleInvite(inv.inviteId, '0xdead')).toBeNull()
    expect(invites.rows.get(inv.inviteId)?.status).toBe('created') // unchanged
  })

  it('settling twice is a no-op (idempotent)', async () => {
    const invites = makeInviteStore()
    const { payments } = makeService({}, { invites })
    vi.spyOn(payments.x402!, 'verifyAndCredit').mockResolvedValue(verified())
    const inv = await payments.createInvite({ payer: PAYER, payee: PAYEE, valueWei: '1000' })
    await payments.settleInvite(inv.inviteId, '0xtx1')
    const second = await payments.settleInvite(inv.inviteId, '0xtx2')
    expect(second?.settled).toBe(false)
  })

  it('cancelling an open invite moves it to cancelled; settled invites cannot cancel', async () => {
    const invites = makeInviteStore()
    const { payments } = makeService({}, { invites })
    vi.spyOn(payments.x402!, 'verifyAndCredit').mockResolvedValue(verified())
    const a = await payments.createInvite({ payer: PAYER, payee: PAYEE, valueWei: '1000' })
    expect((await payments.cancelInvite(a.inviteId)).cancelled).toBe(true)
    expect(invites.rows.get(a.inviteId)?.status).toBe('cancelled')
    const b = await payments.createInvite({ payer: PAYER, payee: PAYEE, valueWei: '1000' })
    await payments.settleInvite(b.inviteId, '0xtx1')
    expect((await payments.cancelInvite(b.inviteId)).cancelled).toBe(false)
  })

  it('past-due invites expire lazily and cannot settle afterwards', async () => {
    const invites = makeInviteStore()
    const { payments } = makeService({}, { invites })
    const past = new Date(Date.now() - 60_000).toISOString()
    const inv = await payments.createInvite({ payer: PAYER, payee: PAYEE, valueWei: '1000', dueAt: past })
    // not expired until read
    expect(invites.rows.get(inv.inviteId)?.status).toBe('created')
    const read = await payments.getInvite(inv.inviteId)
    expect(read?.status).toBe('expired')
    await expect(payments.settleInvite(inv.inviteId, '0xtx1')).rejects.toMatchObject({ code: 'EXPIRED', status: 410 })
  })

  it('future-due invites do not expire', async () => {
    const invites = makeInviteStore()
    const { payments } = makeService({}, { invites })
    const future = new Date(Date.now() + 60_000).toISOString()
    const inv = await payments.createInvite({ payer: PAYER, payee: PAYEE, valueWei: '1000', dueAt: future })
    expect((await payments.getInvite(inv.inviteId))?.status).toBe('created')
  })

  it('listInvites filters by role and open status', async () => {
    const invites = makeInviteStore()
    const { payments } = makeService({}, { invites })
    await payments.createInvite({ payer: PAYER, payee: PAYEE, valueWei: '1000' })
    await payments.createInvite({ payer: OTHER, payee: PAYER, valueWei: '2000' })
    const owed = await payments.listInvites(PAYER, 'payee')
    expect(owed).toHaveLength(1)
    expect(owed[0].payer).toBe(OTHER)
    const issued = await payments.listInvites(PAYER, 'payer')
    expect(issued).toHaveLength(1)
    expect(issued[0].payee).toBe(PAYEE)
  })

  it('payInviteByBalance settles via a ledger transfer and records the reference', async () => {
    const balances = new Map<string, string>([[PAYER.toLowerCase(), '5000']])
    const invites = makeInviteStore()
    const transfers = makeTransferStore(balances)
    const { payments } = makeService({}, { invites, transfers })
    const inv = await payments.createInvite({ payer: PAYER, payee: PAYEE, valueWei: '1000' })
    const result = await payments.payInviteByBalance(inv.inviteId)
    expect(result.settled).toBe(true)
    expect(result.transferId).toBeTruthy()
    expect(balances.get(PAYER.toLowerCase())).toBe('4000') // debited
    expect(balances.get(PAYEE.toLowerCase())).toBe('1000') // credited
    const stored = invites.rows.get(inv.inviteId)!
    expect(stored.status).toBe('settled')
    expect(stored.settledMethod).toBe('balance')
    expect(stored.settledRef).toBe(result.transferId)
  })

  it('payInviteByBalance rejects with INSUFFICIENT_BALANCE and moves nothing', async () => {
    const balances = new Map<string, string>([[PAYER.toLowerCase(), '100']])
    const invites = makeInviteStore()
    const transfers = makeTransferStore(balances)
    const { payments } = makeService({}, { invites, transfers })
    const inv = await payments.createInvite({ payer: PAYER, payee: PAYEE, valueWei: '1000' })
    await expect(payments.payInviteByBalance(inv.inviteId)).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE', status: 400 })
    expect(balances.get(PAYER.toLowerCase())).toBe('100') // untouched
    expect(balances.has(PAYEE.toLowerCase())).toBe(false)
    expect(invites.rows.get(inv.inviteId)?.status).toBe('created') // still open
  })

  it('invite endpoints answer 503 when the capability is off', async () => {
    const { payments } = makeService({}) // no invites seam
    await expect(payments.createInvite({ payer: PAYER, payee: PAYEE, valueWei: '1' })).rejects.toMatchObject({ code: 'NOT_CONFIGURED', status: 503 })
  })

  it('creation + balance settlement work without x402; on-chain settle still requires it', async () => {
    const balances = new Map<string, string>([[PAYER.toLowerCase(), '5000']])
    const invites = makeInviteStore()
    const transfers = makeTransferStore(balances)
    const { payments } = makeService({ withX402: false }, { invites, transfers })
    const inv = await payments.createInvite({ payer: PAYER, payee: PAYEE, valueWei: '1000' })
    expect(inv.inviteId.startsWith('inv_')).toBe(true)
    const result = await payments.payInviteByBalance(inv.inviteId)
    expect(result.settled).toBe(true)
    expect(balances.get(PAYEE.toLowerCase())).toBe('1000')
    // a still-open invite settles on-chain only with the x402 engine
    const second = await payments.createInvite({ payer: PAYER, payee: PAYEE, valueWei: '2000' })
    await expect(payments.settleInvite(second.inviteId, '0xtx1')).rejects.toMatchObject({ code: 'NOT_CONFIGURED', status: 503 })
  })
})

// ── transfer atomic movement ────────────────────────────────────────────────

describe('transfer atomic ledger movement', () => {
  it('creates a requested transfer and is idempotent on reference', async () => {
    const balances = new Map<string, string>()
    const transfers = makeTransferStore(balances)
    const { payments } = makeService({}, { transfers })
    const a = await payments.createTransfer({ from: PAYER, to: PAYEE, valueWei: '1000', reference: 'inv_1' })
    expect(a.status).toBe('requested')
    const b = await payments.createTransfer({ from: PAYER, to: PAYEE, valueWei: '1000', reference: 'inv_1' })
    expect(b.transferId).toBe(a.transferId) // same transfer, no duplicate
  })

  it('confirm executes: debits from, credits to, marks executed', async () => {
    const balances = new Map<string, string>([[PAYER.toLowerCase(), '5000']])
    const transfers = makeTransferStore(balances)
    const { payments } = makeService({}, { transfers })
    const t = await payments.createTransfer({ from: PAYER, to: PAYEE, valueWei: '2000' })
    const result = await payments.confirmTransfer(t.transferId)
    expect(result.ok).toBe(true)
    expect(result.status).toBe('executed')
    expect(balances.get(PAYER.toLowerCase())).toBe('3000')
    expect(balances.get(PAYEE.toLowerCase())).toBe('2000')
  })

  it('confirm with insufficient balance rejects and leaves both balances untouched', async () => {
    const balances = new Map<string, string>([[PAYER.toLowerCase(), '500']])
    const transfers = makeTransferStore(balances)
    const { payments } = makeService({}, { transfers })
    const t = await payments.createTransfer({ from: PAYER, to: PAYEE, valueWei: '1000' })
    const result = await payments.confirmTransfer(t.transferId)
    expect(result.ok).toBe(false)
    expect(result.status).toBe('rejected')
    expect(result.reason).toContain('insufficient')
    expect(balances.get(PAYER.toLowerCase())).toBe('500') // atomic: nothing moved
    expect(balances.has(PAYEE.toLowerCase())).toBe(false)
  })

  it('confirming twice does not double-move funds', async () => {
    const balances = new Map<string, string>([[PAYER.toLowerCase(), '5000']])
    const transfers = makeTransferStore(balances)
    const { payments } = makeService({}, { transfers })
    const t = await payments.createTransfer({ from: PAYER, to: PAYEE, valueWei: '1000' })
    expect((await payments.confirmTransfer(t.transferId)).ok).toBe(true)
    const second = await payments.confirmTransfer(t.transferId)
    expect(second.ok).toBe(false) // already executed
    expect(balances.get(PAYER.toLowerCase())).toBe('4000') // not 3000
    expect(balances.get(PAYEE.toLowerCase())).toBe('1000') // not 2000
  })

  it('cancel only works on open (requested) transfers', async () => {
    const balances = new Map<string, string>([[PAYER.toLowerCase(), '5000']])
    const transfers = makeTransferStore(balances)
    const { payments } = makeService({}, { transfers })
    const t = await payments.createTransfer({ from: PAYER, to: PAYEE, valueWei: '1000' })
    await payments.cancelTransfer(t.transferId)
    expect((await payments.getTransfer(t.transferId))?.status).toBe('cancelled')
    // cancelled transfer cannot be executed
    const exec = await payments.confirmTransfer(t.transferId)
    expect(exec.ok).toBe(false)
  })

  it('transfer endpoints answer 503 when the capability is off', async () => {
    const { payments } = makeService({})
    await expect(payments.createTransfer({ from: PAYER, to: PAYEE, valueWei: '1' })).rejects.toMatchObject({ code: 'NOT_CONFIGURED', status: 503 })
  })
})
