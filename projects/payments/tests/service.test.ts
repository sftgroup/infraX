import { afterEach, describe, expect, it, vi } from 'vitest'
import { PaymentsService } from '../src/service'
import { PaymentError } from '../src/errors'
import type { PlanInfo, VerifiedPayment } from '../src/types'
import { fakeStripeSession, makeService, makeStore, stubFetch } from './helpers'

const SUB = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'

const plan = (price = 1000000000000000000n): PlanInfo => ({
  planId: 1,
  agentId: 1,
  creator: '0x0000000000000000000000000000000000000000',
  price,
  period: 'month',
  active: true,
  payToken: '0x0000000000000000000000000000000000000000',
  trialDays: 0,
})

const verified = (over: Partial<VerifiedPayment> = {}): VerifiedPayment => ({
  reference: 'ref_1',
  payer: SUB,
  creditedWei: 1000000000000000000n,
  asset: '0x0000000000000000000000000000000000000000',
  chain: 'sepolia',
  ...over,
})

afterEach(() => vi.unstubAllGlobals())

describe('PaymentsService.createPayment (fiat)', () => {
  it('throws NOT_CONFIGURED (503) when stripe is absent', async () => {
    const { payments } = makeService({ withStripe: false })
    await expect(
      payments.createPayment({ method: 'fiat', subscriber: SUB, amountCents: 100 })
    ).rejects.toMatchObject({ code: 'NOT_CONFIGURED', status: 503 })
  })

  it('throws INVALID_INPUT (400) without a subscriber', async () => {
    const { payments } = makeService()
    await expect(payments.createPayment({ method: 'fiat', amountCents: 100 })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      status: 400,
    })
  })

  it('throws AMOUNT_TOO_SMALL (400) below the Stripe minimum', async () => {
    const { payments } = makeService()
    await expect(payments.createPayment({ method: 'fiat', subscriber: SUB, amountCents: 49 })).rejects.toMatchObject({
      code: 'AMOUNT_TOO_SMALL',
      status: 400,
    })
  })

  it('auto-prices an on-chain plan (1 native × $1 = 100¢) and records an intent', async () => {
    stubFetch(fakeStripeSession())
    const { store, payments } = makeService()
    vi.spyOn(payments.chain, 'getPlan').mockResolvedValue(plan())

    const result = await payments.createPayment({
      method: 'fiat',
      subscriber: SUB,
      period: 'month',
      pricing: { planId: 1 },
      metadata: { agentId: 1, planId: 1 },
      clientReference: `${SUB}|1|1`,
    })
    expect(result.method).toBe('fiat')
    if (result.method !== 'fiat') return
    expect(result.paymentId.startsWith('pi_')).toBe(true)
    expect(result.clientReference).toBe(`${SUB}|1|1`)
    expect(result.sessionUrl).toContain('/checkout/')
    // intent recorded with the auto-priced metadata passthrough
    expect(store.recordIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: result.paymentId,
        method: 'fiat',
        subscriber: SUB,
        currency: 'usd',
        status: 'created',
        metadata: { agentId: 1, planId: 1 },
      })
    )
    // provider received the auto-priced amount
    const decoded = decodeURIComponent(String((fetch as any).mock.calls[0][1].body))
    expect(decoded).toContain('line_items[0][price_data][unit_amount]=100')
  })

  it('uses an explicit amountCents and skips auto-pricing', async () => {
    stubFetch(fakeStripeSession())
    const { payments } = makeService()
    const spy = vi.spyOn(payments.chain, 'getPlan').mockResolvedValue(plan())
    await payments.createPayment({ method: 'fiat', subscriber: SUB, amountCents: 500 })
    expect(spy).not.toHaveBeenCalled()
  })

  it('throws AUTO_PRICE_FAILED (400) when the plan is unreadable', async () => {
    stubFetch(fakeStripeSession())
    const { payments } = makeService()
    vi.spyOn(payments.chain, 'getPlan').mockRejectedValue(new Error('rpc down'))
    await expect(
      payments.createPayment({ method: 'fiat', subscriber: SUB, pricing: { planId: 99 } })
    ).rejects.toMatchObject({ code: 'AUTO_PRICE_FAILED', status: 400 })
  })
})

describe('PaymentsService.createPayment (chain / unknown)', () => {
  it('records a chain intent and returns a paymentId', async () => {
    const { store, payments } = makeService()
    const result = await payments.createPayment({
      method: 'chain',
      subscriber: SUB,
      chain: 'sepolia',
      metadata: { agentId: 1 },
    })
    expect(result.method).toBe('chain')
    if (result.method !== 'chain') return
    expect(result.paymentId.startsWith('pi_')).toBe(true)
    expect(store.recordIntent).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: result.paymentId, method: 'chain', status: 'created', chain: 'sepolia' })
    )
  })

  it('throws NOT_CONFIGURED for rails without a configured seam', async () => {
    const { payments } = makeService()
    // mpp is a real rail now; without mppStore configured it must fail cleanly.
    await expect(payments.createPayment({ method: 'mpp' } as any)).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
    })
    // A completely unknown method is still rejected outright.
    await expect(payments.createPayment({ method: 'teleport' } as any)).rejects.toMatchObject({
      code: 'UNSUPPORTED_METHOD',
    })
  })
})

describe('PaymentsService.verifyPayment (x402)', () => {
  it('credits, records a paid intent (x402:<tx>) and fires onCredit', async () => {
    let credited = 0
    const { store, payments } = makeService({}, { onCredit: async () => { credited += 1 } })
    vi.spyOn(payments.x402!, 'verifyAndCredit').mockResolvedValue(verified())
    const ok = await payments.verifyPayment('0xabc', 'sepolia')
    expect(ok?.payer).toBe(SUB)
    expect(store.recordIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentId: 'x402:0xabc',
        method: 'x402',
        status: 'paid',
        amountWei: 1000000000000000000n,
      })
    )
    expect(credited).toBe(1)
  })

  it('does not record when the tx is not a valid payment', async () => {
    const { store, payments } = makeService()
    vi.spyOn(payments.x402!, 'verifyAndCredit').mockResolvedValue(null)
    await expect(payments.verifyPayment('0xdead', 'sepolia')).resolves.toBeNull()
    expect(store.recordIntent).not.toHaveBeenCalled()
  })

  it('throws NOT_CONFIGURED (503) when x402 is absent', async () => {
    const { payments } = makeService({ withX402: false })
    await expect(payments.verifyPayment('0xabc')).rejects.toMatchObject({ code: 'NOT_CONFIGURED', status: 503 })
  })
})

describe('PaymentsService.handleWebhook', () => {
  it('forwards valid signed events to onWebhookEvent', async () => {
    let seen: string | null = null
    const { payments } = makeService({}, { onWebhookEvent: async (e) => { seen = e.type } })
    const payload = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_1' } } })
    const t = Math.floor(Date.now() / 1000)
    const { createHmac } = await import('node:crypto')
    const sig = createHmac('sha256', 'whsec_test').update(`${t}.${payload}`).digest('hex')
    await payments.handleWebhook(payload, `t=${t},v1=${sig}`)
    expect(seen).toBe('checkout.session.completed')
  })

  it('rejects invalid signatures with INVALID_SIGNATURE (400)', async () => {
    const { payments } = makeService()
    await expect(
      payments.handleWebhook('{}', `t=${Math.floor(Date.now() / 1000)},v1=${'ab'.repeat(16)}`)
    ).rejects.toMatchObject({ code: 'INVALID_SIGNATURE', status: 400 })
  })
})

describe('PaymentsService.updateIntentStatus', () => {
  it('validates the status and delegates to the injected store', async () => {
    const { store, payments } = makeService()
    await payments.updateIntentStatus('pi_1', 'paid')
    expect(store.updateIntentStatus).toHaveBeenCalledWith('pi_1', 'paid')

    await expect(payments.updateIntentStatus('pi_1', 'bogus' as any)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      status: 400,
    })
    // invalid status must not reach the store
    expect(store.updateIntentStatus).toHaveBeenCalledTimes(1)
  })

  it('is a no-op when the store does not implement the optional seam', async () => {
    const bare = makeStore()
    delete (bare as any).updateIntentStatus
    const { payments } = makeService({}, { store: bare })
    await expect(payments.updateIntentStatus('pi_1', 'paid')).resolves.toBeUndefined()
  })
})

describe('PaymentsService lifecycle events (payment_events)', () => {
  it('emits payment.intent.created for fiat checkouts', async () => {
    stubFetch(fakeStripeSession())
    const { store, payments } = makeService()
    const result = await payments.createPayment({
      method: 'fiat',
      subscriber: SUB,
      amountCents: 100,
      metadata: { agentId: 1 },
    })
    if (result.method !== 'fiat') return
    expect(store.emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'payment.intent.created',
        reference: result.paymentId,
        payload: expect.objectContaining({ paymentId: result.paymentId, method: 'fiat', sessionId: 'cs_1' }),
      })
    )
  })

  it('emits payment.intent.created for chain intents', async () => {
    const { store, payments } = makeService()
    const result = await payments.createPayment({ method: 'chain', subscriber: SUB, chain: 'sepolia' })
    if (result.method !== 'chain') return
    expect(store.emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'payment.intent.created', reference: result.paymentId })
    )
  })

  it('emits payment.credited when an on-chain payment is verified', async () => {
    const { store, payments } = makeService()
    vi.spyOn(payments.x402!, 'verifyAndCredit').mockResolvedValue(verified())
    await payments.verifyPayment('0xabc', 'sepolia')
    expect(store.emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'payment.credited',
        reference: 'ref_1',
        payload: expect.objectContaining({ reference: 'ref_1', payer: SUB, amountWei: 1000000000000000000n }),
      })
    )
  })

  it('emits payment.intent.status when the lifecycle advances', async () => {
    const { store, payments } = makeService()
    await payments.updateIntentStatus('pi_1', 'paid')
    expect(store.emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'payment.intent.status', reference: 'pi_1', payload: { paymentId: 'pi_1', status: 'paid' } })
    )
  })

  it('emits payment.webhook.received for signed provider events', async () => {
    const { store, payments } = makeService()
    const payload = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_1' } } })
    const t = Math.floor(Date.now() / 1000)
    const { createHmac } = await import('node:crypto')
    const sig = createHmac('sha256', 'whsec_test').update(`${t}.${payload}`).digest('hex')
    await payments.handleWebhook(payload, `t=${t},v1=${sig}`)
    expect(store.emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'payment.webhook.received', reference: 'cs_1' })
    )
  })

  it('is a no-op when the store does not implement emitEvent', async () => {
    const bare = makeStore()
    delete (bare as any).emitEvent
    const { payments } = makeService({}, { store: bare })
    await expect(payments.updateIntentStatus('pi_1', 'paid')).resolves.toBeUndefined()
  })
})

describe('PaymentsService delegates to the injected store', () => {
  it('resolveAccess / balanceOf / deduct go through the store seam', async () => {
    const { store, payments } = makeService()
    await payments.resolveAccess(SUB, { agentId: 1 })
    expect(store.resolveAccess).toHaveBeenCalledWith(SUB, { agentId: 1 }, undefined)
    await payments.balanceOf(SUB)
    expect(store.balanceOf).toHaveBeenCalledWith(SUB, '0x0000000000000000000000000000000000000000')
    await payments.deduct(SUB, 100n)
    expect(store.deduct).toHaveBeenCalled()
  })
})

describe('AX-5/PC-1 resolveAccess default composer', () => {
  it('denies when no source matches', async () => {
    const { payments } = makeService()
    const ok = await payments.resolveAccess(SUB, 'agent:1', {
      chain: 'sepolia',
      composer: { chainSub: async () => false, payPerCall: { priceWei: '1000' } },
    })
    expect(ok).toBe(false)
  })

  it('grants via offchain subscription source', async () => {
    const { payments } = makeService()
    const ok = await payments.resolveAccess(SUB, 'agent:1', {
      composer: { offchain: async () => true, payPerCall: { priceWei: '1000' } },
    })
    expect(ok).toBe(true)
  })

  it('grants via chain subscription (first in order)', async () => {
    const { payments } = makeService()
    const ok = await payments.resolveAccess(SUB, 'agent:1', {
      chain: 'sepolia',
      composer: {
        chainSub: async () => true,
        offchain: async () => false,
        payPerCall: { priceWei: '1000' },
        order: ['chain', 'offchain', 'balance'],
      },
    })
    expect(ok).toBe(true)
  })

  it('grants via balance >= price', async () => {
    const { store, payments } = makeService()
    store.balanceOf.mockResolvedValueOnce(2000n)
    const ok = await payments.resolveAccess(SUB, 'agent:1', {
      composer: { payPerCall: { priceWei: '1000' } },
    })
    expect(ok).toBe(true)
    expect(store.balanceOf).toHaveBeenCalled()
  })

  it('denies when balance < price', async () => {
    const { store, payments } = makeService()
    store.balanceOf.mockResolvedValueOnce(500n)
    const ok = await payments.resolveAccess(SUB, 'agent:1', {
      composer: { payPerCall: { priceWei: '1000' } },
    })
    expect(ok).toBe(false)
  })

  it('falls back to store.resolveAccess when no composer is provided', async () => {
    const { store, payments } = makeService()
    store.resolveAccess.mockResolvedValueOnce(true)
    const ok = await payments.resolveAccess(SUB, 'agent:1')
    expect(ok).toBe(true)
    expect(store.resolveAccess).toHaveBeenCalled()
  })
})

describe('AX-6/PC-2 deductForAccess (audit + idempotency)', () => {
  it('deducts and records an access.deducted event', async () => {
    const { store, payments } = makeService()
    const res = await payments.deductForAccess(SUB, 'agent:1', 100n, { ref: 'a2a_pay_log:1' })
    expect(res).toEqual({ ok: true })
    expect(store.recordAccessDeduction).toHaveBeenCalledWith(
      expect.objectContaining({ refId: 'a2a_pay_log:1', subscriber: SUB, resource: 'agent:1', amountWei: '100' })
    )
    expect(store.deduct).toHaveBeenCalledWith(SUB, 100n, '0x0000000000000000000000000000000000000000')
    expect(store.emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'access.deducted', reference: 'a2a_pay_log:1' })
    )
  })

  it('is idempotent: skips deduct when the ref was already recorded', async () => {
    const { store, payments } = makeService()
    store.recordAccessDeduction.mockResolvedValueOnce(false)
    const res = await payments.deductForAccess(SUB, 'agent:1', 100n, { ref: 'a2a_pay_log:dup' })
    expect(res).toEqual({ ok: true, idempotent: true })
    expect(store.deduct).not.toHaveBeenCalled()
  })

  it('rolls back the audit placeholder when balance is insufficient', async () => {
    const { store, payments } = makeService()
    store.deduct.mockResolvedValueOnce(false)
    const res = await payments.deductForAccess(SUB, 'agent:1', 100n, { ref: 'a2a_pay_log:2' })
    expect(res).toEqual({ ok: false, reason: 'insufficient_balance' })
    expect(store.deleteAccessDeduction).toHaveBeenCalledWith('a2a_pay_log:2')
  })

  it('degrades to a bare deduct when the store has no audit seam', async () => {
    const bare = makeStore()
    delete (bare as any).recordAccessDeduction
    const { payments } = makeService({}, { store: bare })
    const res = await payments.deductForAccess(SUB, 'agent:1', 100n)
    expect(res).toEqual({ ok: true })
    expect(bare.deduct).toHaveBeenCalled()
    expect(bare.emitEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'access.deducted' }))
  })
})

describe('AX-8/A2A-1 a2aSettle balance mode', () => {
  const AMOUNT = '500000000000000000'
  const intent = (over: Record<string, unknown> = {}) => ({
    intentId: 'a2a_bal_1',
    method: 'a2a',
    subscriber: SUB,
    asset: '0x0000000000000000000000000000000000000000',
    amountWei: AMOUNT,
    currency: null,
    chain: 'sepolia',
    status: 'created',
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  })

  it('deducts the intent amount, marks paid, emits events and calls onCredit', async () => {
    const onCredit = vi.fn(async () => {})
    const { store, payments } = makeService({}, { onCredit })
    store.getIntent.mockResolvedValueOnce(intent())
    const v = await payments.a2aSettle({ paymentId: 'a2a_bal_1', mode: 'balance' })
    expect(v).toEqual({ reference: 'a2a_bal_1', payer: SUB.toLowerCase(), creditedWei: AMOUNT, asset: intent().asset, chain: 'sepolia' })
    expect(store.deduct).toHaveBeenCalledWith(SUB.toLowerCase(), BigInt(AMOUNT), intent().asset)
    expect(store.updateIntentStatus).toHaveBeenCalledWith('a2a_bal_1', 'paid')
    expect(store.emitEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'a2a.settled', reference: 'a2a_bal_1' }))
    expect(store.emitEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'payment.credited', reference: 'a2a_bal_1' }))
    expect(onCredit).toHaveBeenCalledWith(expect.objectContaining({ reference: 'a2a_bal_1', payer: SUB.toLowerCase(), amountWei: AMOUNT }))
  })

  it('works without store.getIntent when subscriber/amountWei are passed explicitly', async () => {
    const { store, payments } = makeService()
    store.getIntent.mockResolvedValueOnce(null)
    const v = await payments.a2aSettle({ paymentId: 'a2a_bal_2', mode: 'balance', subscriber: SUB, amountWei: AMOUNT, asset: intent().asset, chain: 'sepolia' })
    expect(v?.payer).toBe(SUB.toLowerCase())
    expect(store.deduct).toHaveBeenCalledWith(SUB.toLowerCase(), BigInt(AMOUNT), intent().asset)
  })

  it('throws INSUFFICIENT_BALANCE when the balance cannot cover the deduct', async () => {
    const { store, payments } = makeService()
    store.getIntent.mockResolvedValueOnce(intent())
    store.deduct.mockResolvedValueOnce(false)
    await expect(payments.a2aSettle({ paymentId: 'a2a_bal_1', mode: 'balance' }))
      .rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE', status: 400 })
    // audit placeholder rolled back to keep balance + audit consistent
    expect(store.deleteAccessDeduction).toHaveBeenCalled()
    expect(store.updateIntentStatus).not.toHaveBeenCalled()
  })

  it('is idempotent: an already-paid intent settles without a second deduct', async () => {
    const { store, payments } = makeService()
    store.getIntent.mockResolvedValueOnce(intent({ status: 'paid' }))
    const v = await payments.a2aSettle({ paymentId: 'a2a_bal_1', mode: 'balance' })
    expect(v?.reference).toBe('a2a_bal_1')
    expect(store.deduct).not.toHaveBeenCalled()
    expect(store.updateIntentStatus).not.toHaveBeenCalled()
  })

  it('is idempotent by ref: a repeated ref short-circuits the deduct', async () => {
    const { store, payments } = makeService()
    store.getIntent.mockResolvedValueOnce(intent())
    store.recordAccessDeduction.mockResolvedValueOnce(false) // ref already used
    const v = await payments.a2aSettle({ paymentId: 'a2a_bal_1', mode: 'balance', ref: 'a2a_pay_log:bal' })
    expect(v?.reference).toBe('a2a_pay_log:bal')
    expect(store.deduct).not.toHaveBeenCalled()
    expect(store.updateIntentStatus).toHaveBeenCalledWith('a2a_bal_1', 'paid')
  })

  it('does not require x402 (balance settlement is server-side only)', async () => {
    const { store, payments } = makeService({ withX402: false })
    store.getIntent.mockResolvedValueOnce(intent())
    const v = await payments.a2aSettle({ paymentId: 'a2a_bal_1', mode: 'balance' })
    expect(v?.creditedWei).toBe(AMOUNT)
  })

  it('tx mode stays backward compatible: missing txHash is an INVALID_INPUT error', async () => {
    const { payments } = makeService()
    await expect(payments.a2aSettle({ paymentId: 'a2a_1' }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT', status: 400 })
  })
})
