// PaymentsClient (unified endpoint client) unit tests — stub fetch, assert
// request paths/bodies and response parsing.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PaymentsClient } from '../src/client'

const BASE = 'http://127.0.0.1:3091'
const SUB = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'

function stubRespond(data: unknown, status = 200): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => new Response(JSON.stringify(data), { status }))
  vi.stubGlobal('fetch', fn)
  return fn
}

afterEach(() => vi.unstubAllGlobals())

describe('PaymentsClient', () => {
  it('create POSTs to /api/v1/payments and returns the fiat result', async () => {
    const fetchMock = stubRespond({ method: 'fiat', paymentId: 'pi_1', url: 'https://x/checkout', sessionId: 'cs_1', redirect: true })
    const client = new PaymentsClient({ baseUrl: BASE })
    const out = await client.create({ method: 'fiat', subscriber: SUB, amountCents: 100, metadata: { agentId: 1 } })
    expect(out.method).toBe('fiat')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${BASE}/api/v1/payments`)
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toMatchObject({ method: 'fiat', subscriber: SUB, amountCents: 100 })
  })

  it('verify POSTs txHash + chain and parses the credit', async () => {
    const fetchMock = stubRespond({ verified: true, creditedWei: '1000', payer: SUB, chain: 'sepolia', balanceWei: '5000' })
    const client = new PaymentsClient({ baseUrl: BASE })
    const out = await client.verify('0xabc', 'sepolia')
    expect(out.verified).toBe(true)
    expect(out.creditedWei).toBe('1000')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${BASE}/api/v1/payments/verify`)
    expect(JSON.parse(String(init.body))).toEqual({ txHash: '0xabc', chain: 'sepolia' })
  })

  it('access GETs with subscriber/agentId/chain params', async () => {
    const fetchMock = stubRespond({ active: true })
    const client = new PaymentsClient({ baseUrl: BASE })
    const out = await client.access(SUB, 1, 'oxachain')
    expect(out.active).toBe(true)
    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toContain('/api/v1/payments/access?')
    expect(url).toContain(`subscriber=${encodeURIComponent(SUB)}`)
    expect(url).toContain('agentId=1')
    expect(url).toContain('chain=oxachain')
  })

  it('info GETs rails discovery', async () => {
    const fetchMock = stubRespond({ rails: { fiat: { enabled: false }, chain: { enabled: true }, x402: { enabled: true } }, x402: { priceWei: '1' } })
    const client = new PaymentsClient({ baseUrl: BASE })
    const out = await client.info()
    expect(out.rails.x402.enabled).toBe(true)
    expect(fetchMock.mock.calls[0][0]).toBe(`${BASE}/api/v1/payments/info`)
  })

  it('quote GETs the v2 challenge via url param', async () => {
    const fetchMock = stubRespond({ free: false, challenge: { x402Version: 2, accepts: [] } })
    const client = new PaymentsClient({ baseUrl: BASE })
    const out = await client.quote(`${BASE}/api/v1/x402/echo`)
    expect(out.free).toBe(false)
    expect(out.challenge?.x402Version).toBe(2)
    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toContain('/api/v1/payments/quote?url=')
  })

  it('forwards the Bearer access token when configured', async () => {
    const fetchMock = stubRespond({ active: false })
    const client = new PaymentsClient({ baseUrl: BASE, accessToken: 'tok123' })
    await client.access(SUB, 1)
    const init = fetchMock.mock.calls[0][1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer tok123')
  })
})
