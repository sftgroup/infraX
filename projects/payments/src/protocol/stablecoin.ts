// ---------------------------------------------------------------------------
// @0xinfrax/payments — stablecoin protocols (EIP-3009 + Permit2)
// ---------------------------------------------------------------------------
// Signature formats the module verifies when a payer funds the platform wallet
// with a stablecoin:
//
//   * EIP-3009 `transferWithAuthorization` — token-agnostic authorization; the
//     tx carries (from, to, value, validAfter, validBefore, nonce, v, r, s) and
//     anyone (facilitator) may submit it. The module verifies the resulting
//     `Transfer` event on the token contract (to == payTo).
//   * Permit2 (Uniswap) `permitTransferFrom` — payer signs a PermitTransferFrom
//     (token + amount + nonce + deadline) and the spender calls transferFrom.
//     The module verifies the resulting `Transfer` event the same way.
//
// Both helpers produce the exact typed message for `recoverTypedDataAddress`,
// so a deployment can double-check the signature *before* submitting the tx
// (defense in depth); the on-chain Transfer event remains the source of truth.
// ---------------------------------------------------------------------------

import { recoverTypedDataAddress } from 'viem'
import type { Address } from 'viem'

// ── EIP-3009 (transferWithAuthorization) ─────────────────────────────────────

export const EIP3009_DOMAIN_VERSION = '2'

export const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const

export interface TransferWithAuthorization {
  from: Address
  to: Address
  value: bigint
  validAfter: bigint
  validBefore: bigint
  nonce: `0x${string}`
  v: number
  r: `0x${string}`
  s: `0x${string}`
}

/** EIP-712 message for EIP-3009 (token-specific domain name, e.g. 'USD Coin'). */
export function buildEIP3009Message(
  auth: TransferWithAuthorization,
  chainId: number,
  token: Address,
  domainName: string
): {
  domain: { name: string; version: string; chainId: number; verifyingContract: Address }
  types: typeof EIP3009_TYPES
  primaryType: 'TransferWithAuthorization'
  message: { from: Address; to: Address; value: bigint; validAfter: bigint; validBefore: bigint; nonce: `0x${string}` }
} {
  return {
    domain: { name: domainName, version: EIP3009_DOMAIN_VERSION, chainId, verifyingContract: token },
    types: EIP3009_TYPES,
    primaryType: 'TransferWithAuthorization',
    message: {
      from: auth.from,
      to: auth.to,
      value: auth.value,
      validAfter: auth.validAfter,
      validBefore: auth.validBefore,
      nonce: auth.nonce,
    },
  }
}

/**
 * Recover the authorizer of an EIP-3009 transfer (must equal `from`).
 * @returns the signer address, or null when the signature is malformed.
 */
export async function recoverEIP3009Signer(
  auth: TransferWithAuthorization,
  chainId: number,
  token: Address,
  domainName: string,
  signature: { v: number; r: `0x${string}`; s: `0x${string}` }
): Promise<Address | null> {
  try {
    const { domain, types, primaryType, message } = buildEIP3009Message(auth, chainId, token, domainName)
    const compact = `0x${signature.r.slice(2)}${signature.s.slice(2)}${signature.v.toString(16).padStart(2, '0')}`
    const signer = await recoverTypedDataAddress({ domain, types, primaryType, message, signature: compact as `0x${string}` })
    return signer.toLowerCase() as Address
  } catch {
    return null
  }
}

// ── Permit2 (permitTransferFrom) ─────────────────────────────────────────────

export const PERMIT2_DOMAIN_NAME = 'Permit2'
export const PERMIT2_DOMAIN_VERSION = '1'

export const PERMIT2_TYPES = {
  PermitTransferFrom: [
    { name: 'permitted', type: 'TokenPermissions' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
  TokenPermissions: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
} as const

export interface PermitTransferFrom {
  permitted: { token: Address; amount: bigint }
  nonce: bigint
  deadline: bigint
}

/**
 * Recover the payer of a Permit2 permitTransferFrom (must equal the signer the
 * spender will transfer from). `signature` is the raw (r, s, v) hex.
 * @returns the signer address, or null when the signature is malformed.
 */
export async function recoverPermit2Signer(
  permit: PermitTransferFrom,
  chainId: number,
  permit2: Address,
  signature: `0x${string}`
): Promise<Address | null> {
  try {
    const domain = { name: PERMIT2_DOMAIN_NAME, version: PERMIT2_DOMAIN_VERSION, chainId, verifyingContract: permit2 }
    const message = {
      permitted: { token: permit.permitted.token, amount: permit.permitted.amount },
      nonce: permit.nonce,
      deadline: permit.deadline,
    }
    const signer = await recoverTypedDataAddress({
      domain,
      types: PERMIT2_TYPES,
      primaryType: 'PermitTransferFrom',
      message,
      signature,
    })
    return signer.toLowerCase() as Address
  } catch {
    return null
  }
}
