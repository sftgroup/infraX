// ---------------------------------------------------------------------------
// @0xinfrax/payments — webhook event forwarder (standalone-service shape)
// ---------------------------------------------------------------------------
// Bridges the in-process onWebhookEvent / onCredit callbacks to a remote
// business endpoint over HTTP, so a standalone payment service can deliver
// normalized payment events to the host that owns the business state.
//
// Delivery contract (both callbacks):
//   POST {each targetUrl}
//     headers:
//       content-type: application/json
//       idempotency-key: <event object id | credit.reference>   (idempotent)
//       x-payments-signature: HMAC-SHA256(body, secret)          (when secret set)
//     body: { type: 'webhook' | 'credit', eventId, event, forwardedAt }
//
// Multiple targets (MQ-16 前置项): opts.targets 是独立业务回调端点数组，事件逐一投递到
// 每个目标，各目标独立重试/退避——单个目标失败不影响其余目标（业务方各自按 reference 幂等对账）。
// Failures never throw — the payment engine keeps working; delivery is
// retried with exponential backoff and dropped with a warn log when exhausted
// (the business host is expected to reconcile from the payment_* tables).
// ---------------------------------------------------------------------------

import { hmacSha256Hex } from './crypto'
import type { PaymentCredit, WebhookEvent } from './types'

export interface WebhookForwardOptions {
  /** Business callback endpoints that consume the normalized events (>=1). */
  targets: string[]
  /** HMAC-SHA256 signing secret for `x-payments-signature`. Optional. */
  secret?: string
  /** Per-attempt request timeout in ms. Default 10_000. */
  timeoutMs?: number
  /** Retries after the first attempt (exponential backoff). Default 3. */
  maxRetries?: number
  /** Shared logger (optional; console fallback). */
  logger?: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void }
}

export interface WebhookForwarder {
  /** Normalized provider webhook event → forwarded to the business endpoint. */
  onWebhookEvent: (event: WebhookEvent) => Promise<void>
  /** Payment credit → forwarded to the business endpoint. */
  onCredit: (credit: PaymentCredit) => Promise<void>
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function createWebhookForwarder(opts: WebhookForwardOptions): WebhookForwarder {
  const timeoutMs = opts.timeoutMs ?? 10_000
  const maxRetries = opts.maxRetries ?? 3
  const log = opts.logger ?? {
    info: (m: string) => console.log(`[payments-forwarder] ${m}`),
    warn: (m: string) => console.warn(`[payments-forwarder] ${m}`),
    error: (m: string) => console.error(`[payments-forwarder] ${m}`),
  }

  /** POST one normalized event to every target; per-target retry with backoff; never throws. */
  async function deliver(kind: 'webhook' | 'credit', eventId: string, payload: unknown): Promise<void> {
    const body = JSON.stringify({ type: kind, eventId, event: payload, forwardedAt: new Date().toISOString() })
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'idempotency-key': eventId,
    }
    if (opts.secret) {
      headers['x-payments-signature'] = await hmacSha256Hex(opts.secret, body)
    }
    for (const target of opts.targets) {
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          const res = await fetch(target, {
            method: 'POST',
            headers,
            body,
            signal: AbortSignal.timeout(timeoutMs),
          })
          if (res.ok) {
            log.info(`${kind} ${eventId} → ${target} (attempt ${attempt + 1})`)
            break
          }
          throw new Error(`status ${res.status}`)
        } catch (err) {
          if (attempt >= maxRetries) {
            log.error(`${kind} ${eventId} → ${target} failed after ${maxRetries + 1} attempts: ${(err as Error).message}`)
            continue
          }
          const backoffMs = 500 * 2 ** attempt
          log.warn(`${kind} ${eventId} → ${target} attempt ${attempt + 1} failed: ${(err as Error).message} — retry in ${backoffMs}ms`)
          await sleep(backoffMs)
        }
      }
    }
  }

  return {
    async onWebhookEvent(event: WebhookEvent): Promise<void> {
      const objectId = typeof event.object === 'object' && event.object !== null ? (event.object as { id?: unknown }).id : undefined
      const eventId = objectId ? String(objectId) : `webhook-${event.type}`
      await deliver('webhook', eventId, event)
    },
    async onCredit(credit: PaymentCredit): Promise<void> {
      await deliver('credit', credit.reference, credit)
    },
  }
}
