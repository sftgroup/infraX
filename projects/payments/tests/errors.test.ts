import { describe, expect, it } from 'vitest'
import { PaymentError, isPaymentError } from '../src/errors'

describe('PaymentError', () => {
  it('carries a machine-readable code and suggested HTTP status', () => {
    const err = new PaymentError('NOT_CONFIGURED', 'x402 is not configured', 503)
    expect(err.code).toBe('NOT_CONFIGURED')
    expect(err.status).toBe(503)
    expect(err.message).toBe('x402 is not configured')
    expect(err.name).toBe('PaymentError')
  })

  it('defaults to HTTP 400', () => {
    const err = new PaymentError('INVALID_INPUT', 'bad')
    expect(err.status).toBe(400)
  })

  it('is identifiable via isPaymentError', () => {
    expect(isPaymentError(new PaymentError('INVALID_SIGNATURE', 'Invalid signature'))).toBe(true)
    expect(isPaymentError(new Error('Invalid signature'))).toBe(false)
    expect(isPaymentError(null)).toBe(false)
  })
})
