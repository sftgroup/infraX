// WebhookForwarder — standalone-service event delivery tests.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createWebhookForwarder } from '../src/forwarder'
import type { PaymentCredit, WebhookEvent } from '../src/types'

const jsonResponse = (status: number) => ({ ok: status >= 200 && status < 300, status })

describe('createWebhookForwarder', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const webhookEvent: WebhookEvent = {
    type: 'checkout.session.completed',
    object: { id: 'cs_1', client_reference_id: '0xuser|1|1' },
  }
  const credit: PaymentCredit = {
    reference: '0xtx1',
    payer: '0xabc',
    amountWei: '1000',
    asset: 'native',
    chainId: 11155111,
    metadata: { agentId: 1 },
  }

  it('forwards webhook events to the target URL with an idempotency key', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200))
    const fwd = createWebhookForwarder({ targets: ['https://biz.example/cb'] })
    await fwd.onWebhookEvent(webhookEvent)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://biz.example/cb')
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers['idempotency-key']).toBe('cs_1')
    const body = JSON.parse(init.body as string)
    expect(body.type).toBe('webhook')
    expect(body.eventId).toBe('cs_1')
    expect(body.event.type).toBe('checkout.session.completed')
  })

  it('forwards credits with the reference as the idempotency key', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200))
    const fwd = createWebhookForwarder({ targets: ['https://biz.example/cb'] })
    await fwd.onCredit(credit)

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(headers['idempotency-key']).toBe('0xtx1')
    const body = JSON.parse(init.body as string)
    expect(body.type).toBe('credit')
    expect(body.event.reference).toBe('0xtx1')
  })

  it('signs the body with HMAC-SHA256 when a secret is configured', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200))
    const fwd = createWebhookForwarder({ targets: ['https://biz.example/cb'], secret: 's3cret' })
    await fwd.onWebhookEvent(webhookEvent)

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const headers = init.headers as Record<string, string>
    expect(headers['x-payments-signature']).toMatch(/^[0-9a-f]{64}$/)
  })

  it('retries transient failures with backoff and succeeds on the second attempt', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(500)).mockResolvedValueOnce(jsonResponse(200))
    const fwd = createWebhookForwarder({ targets: ['https://biz.example/cb'], maxRetries: 2 })
    await fwd.onWebhookEvent(webhookEvent)

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('never throws after exhausting retries', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500))
    const fwd = createWebhookForwarder({ targets: ['https://biz.example/cb'], maxRetries: 1 })
    await expect(fwd.onCredit(credit)).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('forwards one event to every target independently (multi-target)', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200))
    const fwd = createWebhookForwarder({ targets: ['https://waas.example/cb', 'https://dc.example/cb'] })
    await fwd.onWebhookEvent(webhookEvent)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const urls = fetchMock.mock.calls.map((c) => c[0])
    expect(urls).toContain('https://waas.example/cb')
    expect(urls).toContain('https://dc.example/cb')
    // 两个目标收到相同事件体（相同 idempotency-key，业务方各自幂等）
    const [, init1] = fetchMock.mock.calls[0] as [string, RequestInit]
    const [, init2] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect((init1.headers as Record<string, string>)['idempotency-key'])
      .toBe((init2.headers as Record<string, string>)['idempotency-key'])
    expect(init1.body).toBe(init2.body)
  })

  it('one failing target does not block delivery to the other target', async () => {
    fetchMock.mockImplementation((url: string) => Promise.resolve(jsonResponse(url.includes('down') ? 500 : 200)))
    const fwd = createWebhookForwarder({ targets: ['https://down.example/cb', 'https://up.example/cb'], maxRetries: 1 })
    await fwd.onCredit(credit)

    expect(fetchMock).toHaveBeenCalledTimes(3) // down 重试 2 次失败 + up 成功
    const urls = fetchMock.mock.calls.map((c) => c[0])
    expect(urls.filter((u) => u === 'https://up.example/cb')).toHaveLength(1)
  })
})
