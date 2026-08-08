// ---------------------------------------------------------------------------
// @0xinfrax/payments — typed errors (machine-readable codes for hosts)
// ---------------------------------------------------------------------------
// Hosts should map `code` → HTTP status instead of string-matching messages.
// `status` is a suggested default; the host remains free to override.
// ---------------------------------------------------------------------------

export type PaymentErrorCode =
  | 'NOT_CONFIGURED'       // a rail is not configured (stripe / x402 missing)
  | 'INVALID_INPUT'        // required field missing / malformed
  | 'AUTO_PRICE_FAILED'    // plan auto-pricing failed
  | 'AMOUNT_TOO_SMALL'     // below the provider minimum
  | 'PROVIDER_ERROR'       // upstream provider call failed
  | 'INVALID_SIGNATURE'    // webhook signature verification failed
  | 'UNSUPPORTED_METHOD'   // createPayment called with an unimplemented rail
  | 'NOT_FOUND'            // nothing matched

export class PaymentError extends Error {
  constructor(
    public code: PaymentErrorCode,
    message: string,
    /** Suggested HTTP status for the host to return. */
    public status: number = 400,
  ) {
    super(message)
    this.name = 'PaymentError'
  }
}

export function isPaymentError(err: unknown): err is PaymentError {
  return err instanceof PaymentError
}
