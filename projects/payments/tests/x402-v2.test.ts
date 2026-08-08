import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { X402Adapter } from '../src/adapters/x402'
import { X402Client } from '../src/client'
import {
  buildPaymentMessage,
  decodeHeader,
  encodeHeader,
  recoverPaymentSigner,
} from '../src/protocol/x402-v2'
import type { X402PaymentPayload } from '../src/protocol/x402-v2'
import { makeStore } from './helpers'

const PAY_TO = '0x' + '22'.repeat(20)
const PRICE_WEI = 1000000000000000n // 0.001 native
const account = privateKeyToAccount('0x' + 'ac'.repeat(32))
const account2 = privateKeyToAccount('0x' + 'bd'.repeat(32))
const walletClient = createWalletClient({ account, transport: http('http://127.0.0.1:8545') })

// Fake on-chain client: every tx to PAY_TO for the full price is "mined".
const makeAdapter = (over = {}) => {
  const store = makeStore()
  const adapter = new X402Adapter(
    { enabled: true, payTo: PAY_TO, priceWei: PRICE_WEI.toString(), chain: 'sepolia', ...over },
    {
      store,
      chainIdOf: () => 11155111,
      getClient: () =>
        ({
          getTransaction: async () => ({ to: PAY_TO, from: account.address, value: 10n ** 18n }),
          getTransactionReceipt: async () => ({ status: 'success' }),
        }) as any,
    }
  )
  return { store, adapter }
}

const signPayload = async (p: X402PaymentPayload, who = account) => {
  const { domain, types, primaryType, message } = buildPaymentMessage(p)
  p.signature = await walletClient.signTypedData({ domain, types, primaryType, message, account: who })
  return p
}

const buildPayload = async (opts: { scheme?: 'exact' | 'upto'; amount?: bigint; signer?: typeof account } = {}) => {
  const { scheme = 'exact', amount = PRICE_WEI, signer = account } = opts
  const p: X402PaymentPayload = {
    x402Version: 2,
    accepted: { scheme, network: 'eip155:11155111', amount: amount.toString(), asset: '0x' + '0'.repeat(40), payTo: PAY_TO, maxTimeoutSeconds: 300 },
    payload: { method: 'GET', url: 'http://localhost/echo', salt: '0x' + 'ab'.repeat(32), txHash: '0x' + 'cd'.repeat(32) },
    signature: '',
  }
  return signPayload(p, signer)
}

afterEach(() => vi.unstubAllGlobals())

describe('x402 v2 header encoding', () => {
  it('round-trips through base64 and tolerates url-safe variants', () => {
    const obj = { a: 1, b: 'x' }
    const encoded = encodeHeader(obj)
    expect(encoded).not.toContain('{')
    expect(decodeHeader(encoded)).toEqual(obj)
    // url-safe (no padding) variant still decodes
    const urlsafe = encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    expect(decodeHeader(urlsafe)).toEqual(obj)
  })

  it('recovers the EIP-712 signer of a PaymentPayload', async () => {
    const p = await buildPayload()
    expect(await recoverPaymentSigner(p)).toBe(account.address.toLowerCase())
  })

  it('recovers a different signer when signed by another wallet', async () => {
    const p = await buildPayload({ signer: account2 })
    expect(await recoverPaymentSigner(p)).toBe(account2.address.toLowerCase())
  })
})

describe('X402Adapter.verifyPaymentSignature', () => {
  it('accepts a valid exact payment at the challenge price', async () => {
    const { store, adapter } = makeAdapter()
    const challenge = adapter.paymentRequired('/echo')
    const header = encodeHeader(await buildPayload({ scheme: 'exact', amount: PRICE_WEI }))
    const result = await adapter.verifyPaymentSignature(header, challenge)
    expect(result).not.toBeNull()
    expect(result?.payer.toLowerCase()).toBe(account.address.toLowerCase())
    expect(result?.settledAmount).toBe(PRICE_WEI)
    expect(result?.accepted.scheme).toBe('exact')
    // funding tx credited into the ledger (idempotent per txHash)
    expect(store.credit).toHaveBeenCalledTimes(1)
  })

  it('accepts an upto payment within [price, cap]', async () => {
    const { adapter } = makeAdapter()
    const challenge = adapter.paymentRequired('/echo')
    const twoX = PRICE_WEI * 2n
    const header = encodeHeader(await buildPayload({ scheme: 'upto', amount: twoX }))
    const result = await adapter.verifyPaymentSignature(header, challenge)
    expect(result?.settledAmount).toBe(twoX)
  })

  it('rejects an exact amount different from the challenge price', async () => {
    const { adapter } = makeAdapter()
    const challenge = adapter.paymentRequired('/echo')
    const header = encodeHeader(await buildPayload({ scheme: 'exact', amount: PRICE_WEI * 2n }))
    expect(await adapter.verifyPaymentSignature(header, challenge)).toBeNull()
  })

  it('rejects an upto amount above the cap', async () => {
    const { adapter } = makeAdapter()
    const challenge = adapter.paymentRequired('/echo')
    const header = encodeHeader(await buildPayload({ scheme: 'upto', amount: PRICE_WEI * 11n }))
    expect(await adapter.verifyPaymentSignature(header, challenge)).toBeNull()
  })

  it('rejects a payload signed by a different wallet than the funding tx sender', async () => {
    const { adapter } = makeAdapter()
    const challenge = adapter.paymentRequired('/echo')
    const p = await buildPayload({ signer: account2 })
    const header = encodeHeader(p)
    expect(await adapter.verifyPaymentSignature(header, challenge)).toBeNull()
  })

  it('rejects garbage / malformed headers', async () => {
    const { adapter } = makeAdapter()
    expect(await adapter.verifyPaymentSignature('not-base64!!!', undefined)).toBeNull()
    expect(await adapter.verifyPaymentSignature('', undefined)).toBeNull()
  })

  it('paymentRequired exposes exact + upto accepts', () => {
    const { adapter } = makeAdapter()
    const challenge = adapter.paymentRequired('/echo')
    expect(challenge.x402Version).toBe(2)
    expect(challenge.resource).toBe('/echo')
    const schemes = challenge.accepts.map((a) => a.scheme)
    expect(schemes).toEqual(['exact', 'upto'])
    expect(challenge.accepts[1].amount).toBe((PRICE_WEI * 10n).toString())
  })
})

describe('X402Client v2 helpers', () => {
  it('quote returns null for a free resource and throws on unhandled payment path', async () => {
    const client = new X402Client({ baseUrl: 'http://127.0.0.1:3091' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
    expect(await client.quote('http://x/echo')).toBeNull()
  })

  it('replay attaches PAYMENT-SIGNATURE and parses PAYMENT-RESPONSE', async () => {
    const client = new X402Client({ baseUrl: 'http://127.0.0.1:3091' })
    const receipt = { status: 'success', reference: 'r1', settledAmount: '1000', network: 'eip155:1', payer: '0xaa' }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: any) => {
        expect((init.headers as any)['payment-signature']).toBe('abc')
        return new Response('{}', {
          status: 200,
          headers: { 'payment-response': encodeHeader(receipt) },
        })
      })
    )
    const out = await client.replay('http://x/echo', 'abc')
    expect(out.status).toBe(200)
    expect(out.paymentResponse?.settledAmount).toBe('1000')
  })
})
