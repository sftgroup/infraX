// P2–P4 service-level tests: MPP rail, a2a-pay, period authorizations.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { PaymentsService } from '../src/service'
import type { AuthorizationStore, MPPSessionRow, MPPSessionStore } from '../src/store'
import type { X402PaymentPayload } from '../src/protocol/x402-v2'
import { buildPaymentMessage, encodeHeader } from '../src/protocol/x402-v2'
import { makeService, makeStore } from './helpers'

const ACCOUNT = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
const SUB = ACCOUNT.address
const PAY_TO = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const CHAIN = 'sepolia'
const CHAIN_ID = 11155111

afterEach(() => vi.unstubAllGlobals())

/** In-memory MPPSessionStore mirroring the Pg schema semantics. */
function makeSessions(): MPPSessionStore & { rows: Map<string, MPPSessionRow> } {
  const rows = new Map<string, MPPSessionRow>()
  return {
    rows,
    getSession: vi.fn(async (id: string) => {
      const row = rows.get(id.toLowerCase())
      return row ? { ...row } : null // snapshot like the Pg store
    }),
    createSession: vi.fn(async (row: MPPSessionRow) => {
      rows.set(row.channelId.toLowerCase(), row)
    }),
    applyVoucher: vi.fn(async (id: string, cum: string, sig: string) => {
      const row = rows.get(id.toLowerCase())
      if (row) { row.currentCum = cum; row.lastSignature = sig }
    }),
    recordVoucher: vi.fn(async () => {}),
    applySettle: vi.fn(async (id: string, consumed: string) => {
      const row = rows.get(id.toLowerCase())
      if (row) row.spentWei = (BigInt(row.spentWei) + BigInt(consumed)).toString()
    }),
    topUp: vi.fn(async (id: string, extra: string) => {
      const row = rows.get(id.toLowerCase())
      if (row) row.depositWei = (BigInt(row.depositWei) + BigInt(extra)).toString()
    }),
    closeSession: vi.fn(async (id: string) => {
      const row = rows.get(id.toLowerCase())
      if (row) row.status = 'closed'
    }),
  } as unknown as MPPSessionStore & { rows: Map<string, MPPSessionRow> }
}

function makeAuths(): AuthorizationStore & { byId: Map<string, any> } {
  const byId = new Map<string, any>()
  return {
    byId,
    createAuthorization: vi.fn(async (a: any) => {
      byId.set(a.id, { ...a })
    }),
    getAuthorization: vi.fn(async (id: string) => byId.get(id) ?? null),
    chargePeriod: vi.fn(async (id: string) => {
      const a = byId.get(id)
      if (!a || a.status !== 'active') throw new Error('not chargeable')
      a.remainingWei = (BigInt(a.remainingWei) - BigInt(a.periodPriceWei)).toString()
      a.status = BigInt(a.remainingWei) >= BigInt(a.periodPriceWei) ? 'active' : 'exhausted'
      return { renewed: a.status === 'active', remainingWei: a.remainingWei }
    }),
  } as unknown as AuthorizationStore & { byId: Map<string, any> }
}

/** A public-client stub returning one deposit tx (payer → payee). */
function makePublicClient(value: bigint = 10n ** 19n) {
  return {
    getTransaction: vi.fn(async () => ({ to: PAY_TO.toLowerCase(), value, from: SUB.toLowerCase() })),
    getTransactionReceipt: vi.fn(async () => ({ status: 'success' })),
  } as never
}

function makeServiceWithP2p4() {
  const store = makeStore()
  const sessions = makeSessions()
  const authorizations = makeAuths()
  const payments = new PaymentsService({
    store,
    chains: { sepolia: { rpcUrl: 'http://127.0.0.1:8545', chainId: CHAIN_ID, subscriptionManager: '0x' + '11'.repeat(20) } },
    x402: {
      enabled: true,
      payTo: PAY_TO,
      priceWei: '1000000000000000',
      chain: CHAIN,
      period: { enabled: true, periodPriceWei: '2000000000000000', maxPeriods: 10 },
    },
    mpp: {
      enabled: true,
      domain: '0x0000000000000000000000000000000000000010',
      payee: PAY_TO,
      chain: CHAIN,
      settleThresholdWei: '9000000000000000000',
    },
    mppStore: sessions,
    authorizations,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  })
  return { store, sessions, authorizations, payments }
}

const TX = '0x' + 'ab'.repeat(32)
const SALT = '0x' + '01'.repeat(32)

describe('PaymentsService — MPP rail', () => {
  it('createPayment(method=mpp) verifies the deposit and opens a channel', async () => {
    const { payments, sessions } = makeServiceWithP2p4()
    vi.spyOn(payments.chain, 'getPublicClient').mockReturnValue(makePublicClient())
    const res = await payments.createPayment({
      method: 'mpp',
      subscriber: SUB,
      valueWei: (10n ** 19n).toString(),
      salt: SALT,
      txHash: TX,
      chain: CHAIN,
      metadata: { agentId: 1 },
    })
    expect(res.method).toBe('mpp')
    if (res.method !== 'mpp') return
    const session = await sessions.getSession(res.channelId)
    expect(session?.status).toBe('open')
    expect(session?.payer).toBe(SUB.toLowerCase())
  })

  it('mppVoucher → mppSettle → mppClose round-trips through the service', async () => {
    const { payments, store, sessions } = makeServiceWithP2p4()
    vi.spyOn(payments.chain, 'getPublicClient').mockReturnValue(makePublicClient())
    const opened = await payments.createPayment({
      method: 'mpp',
      subscriber: SUB,
      valueWei: (10n ** 19n).toString(),
      salt: SALT,
      txHash: TX,
      chain: CHAIN,
    })
    if (opened.method !== 'mpp') throw new Error('open failed')
    const { channelId } = opened

    const voucher = await payments.mppVoucher({
      channelId,
      cumulativeAmount: (3n * 10n ** 18n).toString(),
      signature: await signForChannel(channelId, (3n * 10n ** 18n).toString()),
    })
    expect(voucher.accepted).toBe(true)

    const settled = await payments.mppSettle(channelId)
    expect(settled.consumedWei).toBe((3n * 10n ** 18n).toString())
    expect(store.deduct).toHaveBeenCalled()

    const closed = await payments.mppClose(channelId)
    expect(closed.refundWei).toBe((7n * 10n ** 18n).toString())
    expect((await sessions.getSession(channelId))?.status).toBe('closed')
  })

  it('mppVoucher rejects a bad signature with INVALID_SIGNATURE', async () => {
    const { payments } = makeServiceWithP2p4()
    vi.spyOn(payments.chain, 'getPublicClient').mockReturnValue(makePublicClient())
    const opened = await payments.createPayment({
      method: 'mpp', subscriber: SUB, valueWei: (10n ** 18n).toString(), salt: SALT, txHash: TX, chain: CHAIN,
    })
    if (opened.method !== 'mpp') throw new Error('open failed')
    await expect(
      payments.mppVoucher({ channelId: opened.channelId, cumulativeAmount: '100', signature: '0x' + 'ff'.repeat(65) })
    ).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' })
  })
})

async function signForChannel(channelId: string, cumulativeAmount: string) {
  const { domain, types, primaryType, message } = await import('../src/protocol/mpp-voucher').then((m) =>
    m.buildVoucherMessage({ channelId: channelId as `0x${string}`, cumulativeAmount }, CHAIN_ID, '0x0000000000000000000000000000000000000010' as `0x${string}`)
  )
  return ACCOUNT.signTypedData({ domain, types, primaryType, message })
}

describe('PaymentsService — a2a-pay', () => {
  it('createPayment(method=a2a) → a2aSettle credits the payer and marks the intent paid', async () => {
    const { payments, store } = makeServiceWithP2p4()
    const created = await payments.createPayment({
      method: 'a2a',
      subscriber: SUB,
      valueWei: (10n ** 19n).toString(),
      payee: PAY_TO,
      chain: CHAIN,
      metadata: { agentId: 1 },
    })
    expect(created.method).toBe('a2a')
    if (created.method !== 'a2a') return
    expect(created.paymentId.startsWith('a2a_')).toBe(true)
    expect(created.amountWei).toBe((10n ** 19n).toString())
    expect(store.recordIntent).toHaveBeenCalledWith(
      expect.objectContaining({ paymentId: created.paymentId, method: 'a2a', subscriber: SUB, status: 'created' })
    )

    vi.spyOn(payments.x402!, 'verifyAndCredit').mockResolvedValue({
      reference: TX.toLowerCase(),
      payer: SUB.toLowerCase(),
      creditedWei: (10n ** 19n).toString(),
      asset: '0x0000000000000000000000000000000000000000',
      chain: CHAIN,
    })
    const settled = await payments.a2aSettle({ paymentId: created.paymentId, txHash: TX, chain: CHAIN })
    expect(settled?.payer).toBe(SUB.toLowerCase())
    expect(store.updateIntentStatus).toHaveBeenCalledWith(created.paymentId, 'paid')
  })
})

describe('PaymentsService — period authorizations', () => {
  it('creates an authorization through the x402 period scheme and charges it', async () => {
    const { payments, authorizations } = makeServiceWithP2p4()
    // Build a valid period-scheme payment payload signed by the payer.
    const periodPrice = 2n * 10n ** 15n
    const periods = 4
    const payload: X402PaymentPayload = {
      x402Version: 2,
      accepted: {
        scheme: 'period',
        network: `eip155:${CHAIN_ID}`,
        amount: (periodPrice * BigInt(periods)).toString(),
        asset: '0x0000000000000000000000000000000000000000',
        payTo: PAY_TO,
        maxTimeoutSeconds: 600,
        extra: { periodPriceWei: periodPrice.toString(), periods, maxPeriods: 10 },
      },
      payload: { method: 'GET', url: 'https://agent.local/resource', salt: '0x' + '11'.repeat(32), txHash: TX },
      signature: '',
    }
    const { domain, types, primaryType, message } = buildPaymentMessage(payload)
    payload.signature = await ACCOUNT.signTypedData({ domain, types, primaryType, message })

    // Funding tx verification (native path) must return the signer as payer.
    vi.spyOn(payments.x402!, 'verifyAndCredit').mockResolvedValue({
      reference: TX.toLowerCase(),
      payer: ACCOUNT.address.toLowerCase(),
      creditedWei: (periodPrice * BigInt(periods)).toString(),
      asset: '0x0000000000000000000000000000000000000000',
      chain: CHAIN,
    })

    const result = await payments.x402!.verifyPaymentSignature(encodeHeader(payload))
    expect(result).not.toBeNull()
    expect(result?.authorizationId).toBe(`auth:${TX.toLowerCase()}`)
    expect(result?.settledAmount).toBe(0n)

    const auth = await payments.getAuthorization(result!.authorizationId!)
    expect(auth?.owner).toBe(ACCOUNT.address.toLowerCase())
    expect(auth?.remainingWei).toBe((periodPrice * BigInt(periods)).toString())
    expect(auth?.periods).toBe(periods)

    // Draining: 4 periods → exhausted on the last one.
    const charges = []
    for (let i = 0; i < periods; i++) {
      charges.push(await payments.chargePeriod(result!.authorizationId!))
    }
    expect(charges[0].renewed).toBe(true)
    expect(charges[charges.length - 1].renewed).toBe(false) // exhausted
    expect(charges[charges.length - 1].remainingWei).toBe('0')
  })

  it('getAuthorization / chargePeriod fail cleanly without the authorizations seam', async () => {
    const { payments } = makeService()
    await expect(payments.chargePeriod('auth:nope')).rejects.toMatchObject({ code: 'NOT_CONFIGURED', status: 503 })
    await expect(payments.getAuthorization('auth:nope')).rejects.toMatchObject({ code: 'NOT_CONFIGURED' })
  })
})
