// Capability-layer regression: /capabilities discovery, a2a / period / batch
// rails (service + router), and the 503 guard for disabled rails.
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import type { Express } from 'express'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createPaymentsRouter } from '../src/router'
import type { BatchStore, PaymentAuthorization, PaymentBatch, PaymentBatchInput, AuthorizationStore } from '../src/store'
import type { VerifiedPayment } from '../src/types'
import { makeService } from './helpers'

const SUB = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const PAYEE_A = '0x1111111111111111111111111111111111111111'
const PAYEE_B = '0x2222222222222222222222222222222222222222'

const verified = (over: Partial<VerifiedPayment> = {}): VerifiedPayment => ({
  reference: '0xtx1',
  payer: SUB,
  creditedWei: 1000000000000000n,
  asset: '0x0000000000000000000000000000000000000000',
  chain: 'sepolia',
  ...over,
})

// ── fake seams ──────────────────────────────────────────────────────────────

function makeAuthStore(): AuthorizationStore {
  const rows = new Map<string, PaymentAuthorization>()
  return {
    createAuthorization: vi.fn(async (a: PaymentAuthorization) => { rows.set(a.id, a) }),
    getAuthorization: vi.fn(async (id: string) => rows.get(id) ?? null),
    chargePeriod: vi.fn(async (id: string) => {
      const a = rows.get(id)
      if (!a || a.status !== 'active') throw new Error(`Authorization ${id} cannot be charged`)
      const rem = BigInt(a.remainingWei) - BigInt(a.periodPriceWei)
      const renewed = rem >= BigInt(a.periodPriceWei)
      rows.set(id, { ...a, remainingWei: rem.toString(), status: renewed ? 'active' : 'exhausted' })
      return { renewed, remainingWei: rows.get(id)!.remainingWei }
    }),
  } as unknown as AuthorizationStore
}

function makeBatchStore(): BatchStore {
  const batches = new Map<string, PaymentBatch>()
  return {
    createBatch: vi.fn(async (b: PaymentBatchInput) => { batches.set(b.batchId, { ...b, createdAt: new Date() }) }),
    getBatch: vi.fn(async (id: string) => batches.get(id) ?? null),
    settleItem: vi.fn(async (batchId: string, itemId: string, reference: string) => {
      const b = batches.get(batchId)
      if (!b) return
      const items = b.items.map((i) => (i.itemId === itemId ? { ...i, status: 'paid' as const, reference } : i))
      batches.set(batchId, { ...b, items, status: items.every((i) => i.status === 'paid') ? 'completed' : b.status })
    }),
    cancelBatch: vi.fn(async (id: string) => {
      const b = batches.get(id)
      if (b) batches.set(id, { ...b, status: 'cancelled' })
    }),
  } as unknown as BatchStore
}

// ── service layer ───────────────────────────────────────────────────────────

describe('PaymentsService capabilities discovery', () => {
  it('defaults: chain/x402/a2a on; period/batch off without seams', () => {
    const { payments } = makeService()
    const caps = payments.capabilities()
    expect(caps.chain?.enabled).toBe(true)
    expect(caps.x402?.enabled).toBe(true)
    expect(caps.a2a?.enabled).toBe(true)
    expect(caps.period?.enabled).toBe(false)
    expect(caps.batch?.enabled).toBe(false)
    expect(caps.fiat?.enabled).toBe(true) // makeService defaults withStripe
  })

  it('period/batch light up with injected seams; a2a flips off via option', () => {
    const { payments } = makeService({}, { authorizations: makeAuthStore(), batch: makeBatchStore(), a2a: { enabled: false } })
    const caps = payments.capabilities()
    expect(caps.period?.enabled).toBe(true)
    expect(caps.batch?.enabled).toBe(false) // a2a off disables batch too
    expect(caps.a2a?.enabled).toBe(false)
  })
})

describe('PaymentsService a2a rail', () => {
  it('createPayment(method=a2a) returns a paymentId + amount + payee', async () => {
    const { store, payments } = makeService()
    const result = await payments.createPayment({ method: 'a2a', subscriber: SUB, valueWei: '1000000000000000', metadata: { agentId: 9 } })
    expect(result.method).toBe('a2a')
    if (result.method !== 'a2a') return
    expect(result.paymentId.startsWith('a2a_')).toBe(true)
    expect(result.amountWei).toBe('1000000000000000')
    expect(result.payee).toBe('0x' + '22'.repeat(20))
    expect(store.recordIntent).toHaveBeenCalledWith(expect.objectContaining({ method: 'a2a', status: 'created' }))
  })

  it('a2aSettle verifies the tx, credits and marks the intent paid', async () => {
    const { store, payments } = makeService()
    vi.spyOn(payments.x402!, 'verifyAndCredit').mockResolvedValue(verified())
    const v = await payments.a2aSettle({ paymentId: 'a2a_1', txHash: '0xtx1' })
    expect(v?.payer).toBe(SUB)
    expect(store.updateIntentStatus).toHaveBeenCalledWith('a2a_1', 'paid')
  })

  it('createPayment(method=a2a) throws 503 when the rail is off', async () => {
    const { payments } = makeService({ withX402: false })
    await expect(payments.createPayment({ method: 'a2a', subscriber: SUB, valueWei: '1' })).rejects.toMatchObject({ code: 'NOT_CONFIGURED', status: 503 })
  })
})

describe('PaymentsService period rail', () => {
  it('create + charge + read an authorization', async () => {
    const auths = makeAuthStore()
    const { payments } = makeService({}, { authorizations: auths })
    await auths.createAuthorization({
      id: 'auth_1', owner: SUB, asset: '0x0000000000000000000000000000000000000000', chain: 'sepolia',
      amountWei: '3000000000000000000', remainingWei: '3000000000000000000',
      periodPriceWei: '1000000000000000000', periods: 3, nonce: '0x1', reference: 'ref_auth_1', status: 'active', createdAt: new Date(),
    })
    const first = await payments.chargePeriod('auth_1')
    expect(first).toEqual({ renewed: true, remainingWei: '2000000000000000000' })
    const auth = await payments.getAuthorization('auth_1')
    expect(auth?.remainingWei).toBe('2000000000000000000')
    // exhausting the last period
    await payments.chargePeriod('auth_1')
    const last = await payments.chargePeriod('auth_1')
    expect(last.renewed).toBe(false) // status → exhausted
    expect(last.remainingWei).toBe('0')
  })

  it('chargePeriod throws 503 without the authorization seam', async () => {
    const { payments } = makeService()
    await expect(payments.chargePeriod('auth_1')).rejects.toMatchObject({ code: 'NOT_CONFIGURED', status: 503 })
  })
})

describe('PaymentsService batch rail', () => {
  it('creates one a2a intent per item and returns them', async () => {
    const { store, payments } = makeService({}, { batch: makeBatchStore() })
    const result = await payments.createPayment({
      method: 'batch', subscriber: SUB,
      items: [
        { payee: PAYEE_A, amountWei: '1000', metadata: { agentId: 1 } },
        { payee: PAYEE_B, amountWei: '2000' },
      ],
    })
    expect(result.method).toBe('batch')
    if (result.method !== 'batch') return
    expect(result.batchId.startsWith('batch_')).toBe(true)
    expect(result.items).toHaveLength(2)
    expect(result.items[0].paymentId.startsWith('a2a_')).toBe(true)
    expect(result.items[0].payee).toBe(PAYEE_A)
    expect(store.recordIntent).toHaveBeenCalledTimes(2)
  })

  it('settles an item and flips the batch to completed when all are paid', async () => {
    const batches = makeBatchStore()
    const { payments } = makeService({}, { batch: batches })
    vi.spyOn(payments.x402!, 'verifyAndCredit').mockResolvedValue(verified())
    const result = await payments.createPayment({
      method: 'batch', subscriber: SUB,
      items: [{ payee: PAYEE_A, amountWei: '1000' }, { payee: PAYEE_B, amountWei: '2000' }],
    })
    if (result.method !== 'batch') throw new Error('expected batch')
    const [first, second] = result.items
    const v1 = await payments.settleBatchItem({ batchId: result.batchId, itemId: first.itemId, txHash: '0xtx1' })
    expect(v1).not.toBeNull()
    let batch = await payments.getBatch(result.batchId)
    expect(batch?.status).toBe('open')
    expect(batch?.items[0].status).toBe('paid')
    await payments.settleBatchItem({ batchId: result.batchId, itemId: second.itemId, txHash: '0xtx2' })
    batch = await payments.getBatch(result.batchId)
    expect(batch?.status).toBe('completed')
  })

  it('cancels an open batch', async () => {
    const batches = makeBatchStore()
    const { payments } = makeService({}, { batch: batches })
    const result = await payments.createPayment({ method: 'batch', subscriber: SUB, items: [{ payee: PAYEE_A, amountWei: '1000' }] })
    if (result.method !== 'batch') throw new Error('expected batch')
    await payments.cancelBatch(result.batchId)
    expect((await payments.getBatch(result.batchId))?.status).toBe('cancelled')
  })
})

// ── router layer ────────────────────────────────────────────────────────────

let app: Express
let server: Server
let base = ''
let paymentsService: ReturnType<typeof makeService>['payments']

const jpost = (path: string, body: any) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }))

beforeAll(async () => {
  const svc = makeService({}, { authorizations: makeAuthStore(), batch: makeBatchStore() })
  paymentsService = svc.payments
  app = express()
  app.use(express.json({ verify: (req: any, _res, buf) => { req.rawBody = buf } }))
  app.use('/', createPaymentsRouter(paymentsService))
  server = app.listen(0)
  await new Promise((r) => server.once('listening', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

describe('createPaymentsRouter capability endpoints', () => {
  it('GET /capabilities lists all rails with endpoints', async () => {
    const r = await fetch(base + '/capabilities').then((res) => res.json())
    expect(r.capabilities.a2a.enabled).toBe(true)
    expect(r.capabilities.period.enabled).toBe(true)
    expect(r.capabilities.batch.enabled).toBe(true)
    expect(r.capabilities.chain.endpoints).toContain('GET /price')
  })

  it('POST /a2a creates an intent (phase 1)', async () => {
    const r = await jpost('/a2a', { subscriber: SUB, valueWei: '1000', payee: PAYEE_A })
    expect(r.status).toBe(200)
    expect(r.body.method).toBe('a2a')
    expect(r.body.paymentId.startsWith('a2a_')).toBe(true)
  })

  it('POST /a2a/settle rejects a non-payment tx with 422', async () => {
    const r = await jpost('/a2a/settle', { paymentId: 'a2a_1', txHash: '0xdead' })
    expect(r.status).toBe(422)
  })

  it('POST /period/charge surfaces the store error (unknown authorization)', async () => {
    const r = await fetch(base + '/period/charge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ authorizationId: 'missing' }),
    })
    expect(r.status).toBe(500) // store throws on unknown auth — handled by express next
  })

  it('POST /batch creates a batch', async () => {
    const r = await jpost('/batch', { subscriber: SUB, items: [{ payee: PAYEE_A, amountWei: '1000' }] })
    expect(r.status).toBe(200)
    expect(r.body.batchId.startsWith('batch_')).toBe(true)
  })
})

describe('createPaymentsRouter disabled-rail guard', () => {
  it('a2a endpoints answer 503 when the rail is off', async () => {
    const svc = makeService({ withX402: false })
    const gapp = express()
    gapp.use(express.json())
    gapp.use('/', createPaymentsRouter(svc.payments))
    const gserver = gapp.listen(0)
    await new Promise((r) => gserver.once('listening', r))
    const gbase = `http://127.0.0.1:${(gserver.address() as AddressInfo).port}`
    try {
      const r = await fetch(gbase + '/a2a', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscriber: SUB, valueWei: '1000' }),
      })
      expect(r.status).toBe(503)
      expect((await r.json()).error).toContain('not enabled')
    } finally {
      await new Promise<void>((resolve) => gserver.close(() => resolve()))
    }
  })

  it('period endpoints answer 503 without the authorization seam', async () => {
    const svc = makeService({})
    const gapp = express()
    gapp.use(express.json())
    gapp.use('/', createPaymentsRouter(svc.payments))
    const gserver = gapp.listen(0)
    await new Promise((r) => gserver.once('listening', r))
    const gbase = `http://127.0.0.1:${(gserver.address() as AddressInfo).port}`
    try {
      const r = await fetch(gbase + '/period/charge', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ authorizationId: 'auth_1' }),
      })
      expect(r.status).toBe(503)
    } finally {
      await new Promise<void>((resolve) => gserver.close(() => resolve()))
    }
  })
})
