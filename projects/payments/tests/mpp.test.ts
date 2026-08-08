// MPP (multi-purpose payment channels) adapter unit tests.
import { describe, it, expect, vi } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { MPPAdapter } from '../src/adapters/mpp'
import type { MPPConfig, MPPDeps } from '../src/adapters/mpp'
import type { MPPSessionRow, MPPSessionStore, PaymentStore } from '../src/store'
import { buildVoucherMessage } from '../src/protocol/mpp-voucher'
import { PaymentError } from '../src/errors'

// anvil account #0 (deterministic; payer) — signs vouchers
const ACCOUNT = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
const PAYEE = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' // anvil #1 (platform wallet)
const DOMAIN = '0x0000000000000000000000000000000000000010'
const CHAIN_ID = 11155111
const CHAIN = 'sepolia'

const cfg: MPPConfig = { enabled: true, domain: DOMAIN, payee: PAYEE, chain: CHAIN, settleThresholdWei: '9000000000000000000' }

function makeStore(): PaymentStore {
  const store = {
    balanceOf: vi.fn(async () => 100_000_000_000_000_000_000n),
    credit: vi.fn(async () => {}),
    isCreditRecorded: vi.fn(async () => false),
    deduct: vi.fn(async () => true),
    resolveAccess: vi.fn(async () => false),
    recordIntent: vi.fn(async () => {}),
    updateIntentStatus: vi.fn(async () => {}),
    emitEvent: vi.fn(async () => {}),
  }
  return store as unknown as PaymentStore
}

function makeSessions(): MPPSessionStore {
  const rows = new Map<string, MPPSessionRow>()
  return {
    getSession: vi.fn(async (id: string) => {
      const row = rows.get(id.toLowerCase())
      return row ? { ...row } : null // snapshot like the Pg store
    }),
    createSession: vi.fn(async (row: MPPSessionRow) => {
      rows.set(row.channelId.toLowerCase(), row)
    }),
    applyVoucher: vi.fn(async (id: string, cum: string, sig: string) => {
      const row = rows.get(id.toLowerCase())
      if (!row) throw new Error('no session')
      row.currentCum = cum
      row.lastSignature = sig
    }),
    recordVoucher: vi.fn(async () => {}),
    applySettle: vi.fn(async (id: string, consumed: string) => {
      const row = rows.get(id.toLowerCase())
      if (!row) throw new Error('no session')
      row.spentWei = (BigInt(row.spentWei) + BigInt(consumed)).toString()
      row.lastSettleAt = new Date()
    }),
    topUp: vi.fn(async (id: string, extra: string) => {
      const row = rows.get(id.toLowerCase())
      if (!row) throw new Error('no session')
      row.depositWei = (BigInt(row.depositWei) + BigInt(extra)).toString()
    }),
    closeSession: vi.fn(async (id: string) => {
      const row = rows.get(id.toLowerCase())
      if (!row) throw new Error('no session')
      row.status = 'closed'
    }),
  } as unknown as MPPSessionStore
}

/** Fake public client: one success deposit tx (payer → payee, value) + its receipt. */
function makeClient(value: bigint = 10n ** 19n, from: string = ACCOUNT.address, to: string = PAYEE) {
  const fromLower = from.toLowerCase()
  const toLower = to.toLowerCase()
  return {
    getTransaction: vi.fn(async () => ({ to: toLower as `0x${string}`, value, from: fromLower as `0x${string}` })),
    getTransactionReceipt: vi.fn(async () => ({ status: 'success' })),
  } as unknown as ReturnType<MPPDeps['getClient']>
}

function makeAdapter(sessions?: MPPSessionStore, store?: PaymentStore, over?: Partial<MPPDeps>) {
  const deps: MPPDeps = {
    store: store ?? makeStore(),
    sessions: sessions ?? makeSessions(),
    getClient: (() => makeClient(10n ** 19n)) as unknown as MPPDeps['getClient'],
    chainIdOf: () => CHAIN_ID,
    log: () => {},
    ...over,
  }
  return new MPPAdapter(cfg, deps)
}

async function signVoucher(channelId: string, cumulativeAmount: string) {
  const { domain, types, primaryType, message } = buildVoucherMessage({ channelId: channelId as `0x${string}`, cumulativeAmount }, CHAIN_ID, DOMAIN as `0x${string}`)
  return ACCOUNT.signTypedData({ domain, types, primaryType, message })
}

const txHash = '0x' + 'ab'.repeat(32)
const SALT = '0x' + '01'.repeat(32)

describe('MPPAdapter', () => {
  it('computes a deterministic channel id', () => {
    const a = makeAdapter()
    const c1 = a.channelId({ payer: ACCOUNT.address, payee: PAYEE, asset: '0x0000000000000000000000000000000000000000', salt: SALT, chainId: CHAIN_ID })
    const c2 = a.channelId({ payer: ACCOUNT.address, payee: PAYEE, asset: '0x0000000000000000000000000000000000000000', salt: SALT, chainId: CHAIN_ID })
    const c3 = a.channelId({ payer: ACCOUNT.address, payee: PAYEE, asset: '0x0000000000000000000000000000000000000000', salt: '0x' + '02'.repeat(32), chainId: CHAIN_ID })
    expect(c1).toBe(c2)
    expect(c1).not.toBe(c3)
    expect(c1).toMatch(/^0x[0-9a-f]{64}$/)
  })

  it('open verifies the deposit tx and creates a session', async () => {
    const sessions = makeSessions()
    const store = makeStore()
    const a = makeAdapter(sessions, store, {
      getClient: (() => makeClient(10n ** 19n)) as unknown as MPPDeps['getClient'],
    })
    const res = await a.open({ payer: ACCOUNT.address, depositWei: (10n ** 19n).toString(), salt: SALT, txHash })
    expect(res.depositWei).toBe((10n ** 19n).toString())
    expect(store.credit).toHaveBeenCalledWith(
      expect.objectContaining({ reference: txHash.toLowerCase(), payer: ACCOUNT.address.toLowerCase(), amountWei: (10n ** 19n).toString() })
    )
    const session = await sessions.getSession(res.channelId)
    expect(session?.status).toBe('open')
    expect(session?.depositWei).toBe((10n ** 19n).toString())
    expect(session?.payer).toBe(ACCOUNT.address.toLowerCase())
  })

  it('open rejects a deposit tx that is not from the payer', async () => {
    const a = makeAdapter(makeSessions(), makeStore(), {
      getClient: (() => makeClient(10n ** 18n, '0x1111111111111111111111111111111111111111')) as unknown as MPPDeps['getClient'],
    })
    await expect(a.open({ payer: ACCOUNT.address, depositWei: (10n ** 19n).toString(), salt: SALT, txHash })).rejects.toBeInstanceOf(PaymentError)
  })

  it('open rejects a deposit tx under the requested amount', async () => {
    const a = makeAdapter(makeSessions(), makeStore(), {
      getClient: (() => makeClient(5n ** 17n)) as unknown as MPPDeps['getClient'],
    })
    await expect(a.open({ payer: ACCOUNT.address, depositWei: (10n ** 19n).toString(), salt: SALT, txHash })).rejects.toBeInstanceOf(PaymentError)
  })

  it('voucher accepts a valid cumulative signature and records it', async () => {
    const sessions = makeSessions()
    const a = makeAdapter(sessions)
    const { channelId } = await a.open({ payer: ACCOUNT.address, depositWei: (10n ** 19n).toString(), salt: SALT, txHash })
    const sig = await signVoucher(channelId, (5n * 10n ** 17n).toString())
    const res = await a.voucher({ channelId, cumulativeAmount: (5n * 10n ** 17n).toString(), signature: sig })
    expect(res.accepted).toBe(true)
    expect(res.mode).toBe('sign')
    const session = await sessions.getSession(channelId)
    expect(session?.currentCum).toBe((5n * 10n ** 17n).toString())
    expect(sessions.recordVoucher).toHaveBeenCalled()
  })

  it('voucher rejects a signature from a non-payer wallet', async () => {
    const a = makeAdapter()
    const { channelId } = await a.open({ payer: ACCOUNT.address, depositWei: (10n ** 19n).toString(), salt: SALT, txHash })
    const other = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d') // anvil #2
    const { domain, types, primaryType, message } = buildVoucherMessage({ channelId: channelId as `0x${string}`, cumulativeAmount: '100' }, CHAIN_ID, DOMAIN as `0x${string}`)
    const sig = await other.signTypedData({ domain, types, primaryType, message })
    await expect(a.voucher({ channelId, cumulativeAmount: '100', signature: sig })).rejects.toMatchObject({ code: 'INVALID_SIGNATURE' })
  })

  it('voucher rejects a non-monotonic cumulative amount', async () => {
    const a = makeAdapter()
    const { channelId } = await a.open({ payer: ACCOUNT.address, depositWei: (10n ** 19n).toString(), salt: SALT, txHash })
    const sig2 = await signVoucher(channelId, (2n * 10n ** 18n).toString())
    await a.voucher({ channelId, cumulativeAmount: (2n * 10n ** 18n).toString(), signature: sig2 })
    const sig1 = await signVoucher(channelId, (10n ** 18n).toString())
    await expect(a.voucher({ channelId, cumulativeAmount: (10n ** 18n).toString(), signature: sig1 })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('voucher replay of the latest signature is idempotent (mode reuse)', async () => {
    const a = makeAdapter()
    const { channelId } = await a.open({ payer: ACCOUNT.address, depositWei: (10n ** 19n).toString(), salt: SALT, txHash })
    const sig = await signVoucher(channelId, (10n ** 18n).toString())
    await a.voucher({ channelId, cumulativeAmount: (10n ** 18n).toString(), signature: sig })
    const res = await a.voucher({ channelId, cumulativeAmount: (10n ** 18n).toString(), signature: sig })
    expect(res.mode).toBe('reuse')
  })

  it('voucher rejects cumulative above the deposit', async () => {
    const a = makeAdapter()
    const { channelId } = await a.open({ payer: ACCOUNT.address, depositWei: (10n ** 19n).toString(), salt: SALT, txHash })
    const sig = await signVoucher(channelId, (11n * 10n ** 18n).toString())
    await expect(a.voucher({ channelId, cumulativeAmount: (11n * 10n ** 18n).toString(), signature: sig })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('settle deducts the un-settled consumption from the payer balance', async () => {
    const store = makeStore()
    const sessions = makeSessions()
    const a = makeAdapter(sessions, store)
    const { channelId } = await a.open({ payer: ACCOUNT.address, depositWei: (10n ** 19n).toString(), salt: SALT, txHash })
    const sig = await signVoucher(channelId, (3n * 10n ** 18n).toString())
    await a.voucher({ channelId, cumulativeAmount: (3n * 10n ** 18n).toString(), signature: sig })
    const res = await a.settle(channelId)
    expect(res.consumedWei).toBe((3n * 10n ** 18n).toString())
    expect(store.deduct).toHaveBeenCalledWith(ACCOUNT.address.toLowerCase(), 3n * 10n ** 18n, expect.any(String))
    const session = await sessions.getSession(channelId)
    expect(session?.spentWei).toBe((3n * 10n ** 18n).toString())
  })

  it('settle with nothing pending is a no-op', async () => {
    const store = makeStore()
    const sessions = makeSessions()
    const a = makeAdapter(sessions, store)
    const { channelId } = await a.open({ payer: ACCOUNT.address, depositWei: (10n ** 19n).toString(), salt: SALT, txHash })
    const res = await a.settle(channelId)
    expect(res.consumedWei).toBe('0')
    expect(store.deduct).not.toHaveBeenCalled()
  })

  it('topUp raises the deposit bound', async () => {
    const sessions = makeSessions()
    const a = makeAdapter(sessions, makeStore(), {
      getClient: (() => makeClient(2n * 10n ** 18n)) as unknown as MPPDeps['getClient'],
    })
    const { channelId } = await a.open({ payer: ACCOUNT.address, depositWei: (2n * 10n ** 18n).toString(), salt: SALT, txHash })
    const res = await a.topUp({ channelId, txHash: txHash.replace('ab', 'cd'), additionalWei: (2n * 10n ** 18n).toString() })
    expect(res.depositWei).toBe((4n * 10n ** 18n).toString())
  })

  it('close settles the tail and returns the refund', async () => {
    const store = makeStore()
    const sessions = makeSessions()
    const a = makeAdapter(sessions, store)
    const { channelId } = await a.open({ payer: ACCOUNT.address, depositWei: (10n ** 19n).toString(), salt: SALT, txHash })
    const sig = await signVoucher(channelId, (4n * 10n ** 18n).toString())
    await a.voucher({ channelId, cumulativeAmount: (4n * 10n ** 18n).toString(), signature: sig })
    const res = await a.close(channelId)
    expect(res.spentWei).toBe((4n * 10n ** 18n).toString())
    expect(res.refundWei).toBe((6n * 10n ** 18n).toString())
    const session = await sessions.getSession(channelId)
    expect(session?.status).toBe('closed')
  })

  it('close on an already-closed channel is idempotent', async () => {
    const sessions = makeSessions()
    const a = makeAdapter(sessions)
    const { channelId } = await a.open({ payer: ACCOUNT.address, depositWei: (10n ** 19n).toString(), salt: SALT, txHash })
    await a.close(channelId)
    const res = await a.close(channelId)
    expect(res.refundWei).toBe((10n ** 19n).toString())
  })
})
