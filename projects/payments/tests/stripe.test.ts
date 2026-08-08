import { createHmac } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StripeAdapter } from '../src/adapters/stripe'
import { fakeStripeSession, stubFetch } from './helpers'

const SECRET = 'whsec_test'
const adapter = new StripeAdapter({
  apiBase: 'http://mock.local/v1',
  secretKey: 'sk_test',
  webhookSecret: SECRET,
})

const sign = (payload: string, secret = SECRET) => {
  const t = Math.floor(Date.now() / 1000)
  const sig = createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')
  return { t, sig }
}

afterEach(() => vi.unstubAllGlobals())

describe('StripeAdapter.verifyWebhookSignature', () => {
  it('accepts a valid v1 signature', async () => {
    const payload = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_1' } } })
    const { t, sig } = sign(payload)
    await expect(adapter.verifyWebhookSignature(payload, `t=${t},v1=${sig}`)).resolves.toBe(true)
  })

  it('rejects a tampered payload', async () => {
    const payload = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_1' } } })
    const { t, sig } = sign(payload)
    const tampered = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_2' } } })
    await expect(adapter.verifyWebhookSignature(tampered, `t=${t},v1=${sig}`)).resolves.toBe(false)
  })

  it('rejects a signature signed with a different secret', async () => {
    const payload = JSON.stringify({ type: 'x' })
    const { t, sig } = sign(payload, 'whsec_other')
    await expect(adapter.verifyWebhookSignature(payload, `t=${t},v1=${sig}`)).resolves.toBe(false)
  })

  it('rejects malformed signature headers', async () => {
    await expect(adapter.verifyWebhookSignature('{}', 'garbage')).resolves.toBe(false)
    await expect(adapter.verifyWebhookSignature('{}', 't=1')).resolves.toBe(false)
  })
})

describe('StripeAdapter.parseEvent', () => {
  it('normalizes { type, object } and tolerates missing data', () => {
    const ev = adapter.parseEvent(
      JSON.stringify({ type: 'invoice.paid', data: { object: { id: 'in_1', subscription: 'sub_1' } } })
    )
    expect(ev.type).toBe('invoice.paid')
    expect(ev.object.subscription).toBe('sub_1')
    expect(adapter.parseEvent(JSON.stringify({ type: 'ping' })).object).toEqual({})
  })
})

describe('StripeAdapter.createCheckoutSession', () => {
  it('posts subscription params and returns the session', async () => {
    stubFetch(fakeStripeSession({ client_reference_id: '0xuser|1|1' }))
    const session = await adapter.createCheckoutSession({
      amountCents: 100,
      currency: 'usd',
      period: 'month',
      subscriber: '0xuser',
      resourceLabel: 'agent #1',
      clientReference: '0xuser|1|1',
    })
    expect(session.id).toBe('cs_1')
    expect(session.client_reference_id).toBe('0xuser|1|1')
    const fetchMock = vi.mocked(fetch)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toContain('/checkout/sessions')
    const decoded = decodeURIComponent(String(init?.body))
    expect(decoded).toContain('client_reference_id=0xuser|1|1')
    expect(decoded).toContain('line_items[0][price_data][unit_amount]=100')
  })

  it('throws PROVIDER_ERROR (502) on upstream failure', async () => {
    stubFetch({ ok: false, status: 500, json: async () => ({ error: { message: 'boom' } }) })
    await expect(
      adapter.createCheckoutSession({
        amountCents: 100,
        currency: 'usd',
        period: 'month',
        subscriber: '0xuser',
        resourceLabel: 'r',
        clientReference: 'ref',
      })
    ).rejects.toMatchObject({ code: 'PROVIDER_ERROR', status: 502 })
  })
})
