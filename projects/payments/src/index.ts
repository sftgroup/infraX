// ---------------------------------------------------------------------------
// @0xinfrax/payments — public entry point
// ---------------------------------------------------------------------------

export * from './types'
export * from './store'
export * from './service'
export * from './client'
export * from './forwarder'
export * from './protocol/x402-v2'
export * from './protocol/mpp-voucher'
export * from './protocol/stablecoin'
export { PaymentError, isPaymentError } from './errors'
export type { PaymentErrorCode } from './errors'
export { ChainAdapter } from './adapters/chain'
export type { ChainInfo, ChainConfig } from './adapters/chain'
export { StripeAdapter } from './adapters/stripe'
export type { StripeConfig, CheckoutSessionInput } from './adapters/stripe'
export { X402Adapter, escrowDepositAbi } from './adapters/x402'
export type { X402Config, X402Deps, PaymentRequiredBody } from './adapters/x402'
export { MPPAdapter } from './adapters/mpp'
export type { MPPConfig, MPPDeps, MPPSessionInput, MPPVoucherInput, MPPSettleResult } from './adapters/mpp'
export { StablecoinAdapter } from './adapters/stablecoin'
export type { StablecoinConfig, StablecoinDeps } from './adapters/stablecoin'
