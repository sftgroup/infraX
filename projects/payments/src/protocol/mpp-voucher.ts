// ---------------------------------------------------------------------------
// @0xinfrax/payments — MPP voucher protocol (EIP-712)
// ---------------------------------------------------------------------------
// Multi-Purpose Payments: the payer pre-funds a payment channel, then signs
// cumulative vouchers (`Voucher(bytes32 channelId, uint256 cumulativeAmount)`).
// The cumulative amount is monotonically increasing and bounded by the deposit,
// so one signature covers every prior request — signature reuse is inherent.
//
// EIP-712 domain: { name: 'AgentX MPP', version: '1', chainId, verifyingContract }
// where verifyingContract is the deployment's configured MPP domain (the
// channel id formula matches a future on-chain escrow contract, so this model
// can migrate on-chain without changing the voucher wire format).
// ---------------------------------------------------------------------------

import { recoverTypedDataAddress } from 'viem'
import type { Address } from 'viem'

export const MPP_DOMAIN_NAME = 'AgentX MPP'
export const MPP_DOMAIN_VERSION = '1'

export const MPP_TYPES = {
  Voucher: [
    { name: 'channelId', type: 'bytes32' },
    { name: 'cumulativeAmount', type: 'uint256' },
  ],
} as const

export type MPPDomain = {
  name: string
  version: string
  chainId: number
  verifyingContract: Address
}

export interface MPPVoucher {
  /** keccak256(abi.encodePacked(payer, payee, asset, salt, chainId)) — hex bytes32. */
  channelId: `0x${string}`
  /** Monotonic cumulative authorized spend (atomic units, decimal string). */
  cumulativeAmount: string
}

/** The typed message a payer signs for a voucher. */
export function buildVoucherMessage(
  voucher: MPPVoucher,
  chainId: number,
  verifyingContract: Address
): {
  domain: MPPDomain
  types: typeof MPP_TYPES
  primaryType: 'Voucher'
  message: { channelId: `0x${string}`; cumulativeAmount: bigint }
} {
  return {
    domain: { name: MPP_DOMAIN_NAME, version: MPP_DOMAIN_VERSION, chainId, verifyingContract },
    types: MPP_TYPES,
    primaryType: 'Voucher',
    message: { channelId: voucher.channelId, cumulativeAmount: BigInt(voucher.cumulativeAmount) },
  }
}

/**
 * Recover the wallet that signed a voucher (offline, no RPC).
 * @returns signer address (lowercased), or null when the signature is malformed.
 */
export async function recoverVoucherSigner(
  voucher: MPPVoucher,
  chainId: number,
  verifyingContract: Address,
  signature: string
): Promise<Address | null> {
  try {
    const { domain, types, primaryType, message } = buildVoucherMessage(voucher, chainId, verifyingContract)
    const signer = await recoverTypedDataAddress({ domain, types, primaryType, message, signature: signature as `0x${string}` })
    return signer.toLowerCase() as Address
  } catch {
    return null
  }
}
