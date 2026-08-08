// ---------------------------------------------------------------------------
// @0xinfrax/payments — StripeAdapter
// ---------------------------------------------------------------------------
// Protocol-level Stripe integration (checkout sessions + webhook verification)
// with a configurable API base so local mock Stripe servers can be used in
// end-to-end tests. Business handling of webhook events is NOT here — it is
// delegated to the host (onWebhookEvent callback in PaymentsService).
// ---------------------------------------------------------------------------

import { hmacSha256Hex, timingSafeEqualStr } from '../crypto'
import { PaymentError } from '../errors'
import type { StripeSession, WebhookEvent } from '../types'

export interface StripeConfig {
  apiBase: string
  secretKey: string
  webhookSecret: string
}

export interface CheckoutSessionInput {
  amountCents: number
  currency: string
  period: string
  subscriber: string
  /** Human-readable product label (e.g. resource id). */
  resourceLabel: string
  /** Opaque reference echoed back in webhook events (pipe-delimited). */
  clientReference: string
  successUrl?: string
  cancelUrl?: string
}

export class StripeAdapter {
  constructor(private cfg: StripeConfig) {}

  enabled(): boolean {
    return Boolean(this.cfg.secretKey)
  }

  /** Create a Stripe Checkout Session (subscription mode). */
  async createCheckoutSession(input: CheckoutSessionInput): Promise<StripeSession> {
    const body = new URLSearchParams()
    body.set('mode', 'subscription')
    body.set('client_reference_id', input.clientReference)
    body.set('line_items[0][quantity]', '1')
    body.set('line_items[0][price_data][currency]', input.currency)
    body.set('line_items[0][price_data][unit_amount]', String(input.amountCents))
    body.set('line_items[0][price_data][product_data][name]', `Subscription — ${input.resourceLabel}`)
    body.set('line_items[0][price_data][recurring][interval]', String(input.period))
    body.set(
      'success_url',
      input.successUrl ||
        `https://payments.local/pay/success?subscriber=${encodeURIComponent(input.subscriber)}&resource=${encodeURIComponent(input.resourceLabel)}`
    )
    body.set('cancel_url', input.cancelUrl || `https://payments.local/pay/cancel?resource=${encodeURIComponent(input.resourceLabel)}`)

    const resp = await fetch(`${this.cfg.apiBase}/checkout/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.cfg.secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
    })
    const data = (await resp.json()) as StripeSession
    if (!resp.ok || !data.url) {
      throw new PaymentError('PROVIDER_ERROR', `Stripe checkout failed (${resp.status}): ${JSON.stringify(data).slice(0, 300)}`, 502)
    }
    return data
  }

  /** Verify Stripe webhook signature (v1 scheme: `t=...,v1=...` HMAC over payload). */
  async verifyWebhookSignature(payload: string, signatureHeader: string): Promise<boolean> {
    const parts: Record<string, string> = {}
    for (const pair of signatureHeader.split(',')) {
      const idx = pair.indexOf('=')
      if (idx > 0) parts[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim()
    }
    const { t, v1 } = parts
    if (!t || !v1) return false
    const expected = await hmacSha256Hex(this.cfg.webhookSecret, `${t}.${payload}`)
    return timingSafeEqualStr(expected, v1.toLowerCase())
  }

  /** Parse a Stripe webhook payload into the normalized `{ type, object }` shape. */
  parseEvent(payload: string): WebhookEvent {
    const parsed = JSON.parse(payload) as { type: string; data?: { object?: Record<string, any> } }
    return { type: parsed.type, object: parsed.data?.object ?? {} }
  }
}
