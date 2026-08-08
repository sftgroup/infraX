// ---------------------------------------------------------------------------
// @0xinfrax/payments — x402 v2 protocol (native-token verifyOnly subset)
// ---------------------------------------------------------------------------
// Implements the x402 v2 HTTP payment handshake for native-token payments:
//
//   1. Server replies 402 + `PAYMENT-REQUIRED: <base64(PaymentRequired)>`
//   2. Client funds the platform wallet on-chain, signs a PaymentPayload
//      (EIP-712) and retries with `PAYMENT-SIGNATURE: <base64(Payload)>`
//   3. Server verifies signature + on-chain tx, deducts, replies 200 +
//      `PAYMENT-RESPONSE: <base64(Response)>`
//
// Schemes implemented here: `exact` (amount fixed to the challenge price) and
// `upto` (client picks an amount within [price, cap]). Both use the native
// `verifyOnly` model: the payment tx is the credential, credited once into the
// ledger (idempotent per txHash) and consumed per request via deduct.
//
// EIP-712 domain: { name: 'x402', version: '2', chainId, verifyingContract: payTo }
// ---------------------------------------------------------------------------

import { fromBase64, toBase64 } from '../crypto'
import { recoverTypedDataAddress } from 'viem'
import type { Address } from 'viem'

// ── Wire structures ──────────────────────────────────────────────────────────

export interface X402Accept {
  scheme: 'exact' | 'upto' | 'period'
  /** CAIP-2 network id, e.g. `eip155:11155111`. */
  network: string
  /** Amount in atomic units (decimal string). exact → fixed; upto → cap; period → full authorization. */
  amount: string
  /** Token contract; `0x0…0` = native. */
  asset: string
  /** Platform receiving wallet. */
  payTo: string
  maxTimeoutSeconds: number
  extra?: Record<string, unknown>
}

export interface X402PaymentRequired {
  x402Version: 2
  error?: string
  /** The protected resource the 402 refers to. */
  resource?: string
  accepts: X402Accept[]
  extensions?: Record<string, unknown>
}

export interface X402PaymentPayload {
  x402Version: 2
  accepted: X402Accept
  payload: {
    method: string
    url: string
    /** Replay-protection nonce (hex string). */
    salt: string
    /** Native verifyOnly: the funding tx. */
    txHash: string
  }
  extensions?: Record<string, unknown>
  /** EIP-712 signature over the message built from accepted + payload. */
  signature: string
}

export interface X402PaymentResponse {
  status: 'success' | 'failed'
  /** Idempotency / audit reference (per-request). */
  reference: string
  settledAmount: string
  network: string
  payer: string
  reason?: string
}

// ── base64 encoding (tolerant of url-safe variants on decode) ───────────────

export function encodeHeader<T>(obj: T): string {
  return toBase64(JSON.stringify(obj))
}

export function decodeHeader<T>(value: string): T {
  return JSON.parse(fromBase64(value.trim())) as T
}

// ── EIP-712 signing / verification ───────────────────────────────────────────

export const X402_DOMAIN_NAME = 'x402'
export const X402_DOMAIN_VERSION = '2'

export const X402_TYPES = {
  Payment: [
    { name: 'scheme', type: 'string' },
    { name: 'network', type: 'string' },
    { name: 'amount', type: 'string' },
    { name: 'asset', type: 'address' },
    { name: 'payTo', type: 'address' },
    { name: 'method', type: 'string' },
    { name: 'url', type: 'string' },
    { name: 'salt', type: 'string' },
    { name: 'txHash', type: 'string' },
  ],
} as const

export type X402Domain = {
  name: string
  version: string
  chainId: number
  verifyingContract: Address
}

type PaymentMessage = {
  scheme: string
  network: string
  amount: string
  asset: `0x${string}`
  payTo: `0x${string}`
  method: string
  url: string
  salt: string
  txHash: string
}

/** The typed message a wallet signs for a PaymentPayload. */
export function buildPaymentMessage(p: X402PaymentPayload): {
  domain: X402Domain
  types: typeof X402_TYPES
  primaryType: 'Payment'
  message: PaymentMessage
} {
  const { accepted, payload } = p
  return {
    domain: {
      name: X402_DOMAIN_NAME,
      version: X402_DOMAIN_VERSION,
      chainId: Number(accepted.network.replace('eip155:', '')),
      verifyingContract: accepted.payTo as Address,
    },
    types: X402_TYPES,
    primaryType: 'Payment',
    message: {
      scheme: accepted.scheme,
      network: accepted.network,
      amount: accepted.amount,
      asset: accepted.asset as `0x${string}`,
      payTo: accepted.payTo as `0x${string}`,
      method: payload.method,
      url: payload.url,
      salt: payload.salt,
      txHash: payload.txHash,
    },
  }
}

/**
 * Recover the wallet that signed a PaymentPayload (offline, no RPC).
 * @returns signer address, or null when the signature is malformed.
 */
export async function recoverPaymentSigner(p: X402PaymentPayload): Promise<Address | null> {
  try {
    const { domain, types, primaryType, message } = buildPaymentMessage(p)
    const signer = await recoverTypedDataAddress({ domain, types, primaryType, message, signature: p.signature as `0x${string}` })
    // Normalize to lowercase so module-internal comparisons are case-insensitive.
    return signer.toLowerCase() as Address
  } catch {
    return null
  }
}

/** Build the server-side settlement receipt. */
export function buildPaymentResponse(partial: Omit<X402PaymentResponse, 'x402Version'> & { reference: string; settledAmount: string; network: string; payer: string }): X402PaymentResponse {
  return partial
}
