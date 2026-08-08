// ---------------------------------------------------------------------------
// @0xinfrax/payments — X402Adapter (x402 v2: native + stablecoin + period)
// ---------------------------------------------------------------------------
// Pay-per-request rail implementing the x402 v2 challenge/verify handshake.
// Schemes:
//   * `exact`  — amount fixed to the challenge price (native or stablecoin)
//   * `upto`   — client picks an amount within [price, cap] (native)
//   * `period` — one authorization funds n periods; charged over time without
//                re-signing (payment_authorizations, see P4)
// All payments use the verifyOnly model: the on-chain tx (native value transfer
// or stablecoin Transfer event) is the credential, credited once into the
// ledger (idempotent per txHash) and consumed per request via deduct — or, for
// period, committed into an authorization that drains on each period boundary.
// ---------------------------------------------------------------------------

import type { PublicClient } from 'viem'
import { NATIVE_ASSET } from '../types'
import type { ChainKey, VerifiedPayment } from '../types'
import type { AuthorizationStore, PaymentStore } from '../store'
import { StablecoinAdapter } from './stablecoin'
import type { StablecoinConfig } from './stablecoin'
import {
  decodeHeader,
  encodeHeader,
  recoverPaymentSigner,
} from '../protocol/x402-v2'
import type { X402Accept, X402PaymentPayload, X402PaymentRequired } from '../protocol/x402-v2'

export interface X402Config {
  enabled: boolean
  payTo: string
  priceWei: string
  chain: ChainKey
  /** `upto` scheme cap (wei). Defaults to priceWei × 10. */
  maxAmountWei?: string
  /** Stablecoin accept + verification (P3). */
  stablecoin?: StablecoinConfig
  /** `period` scheme (P4). Requires a configured asset (native or stablecoin). */
  period?: { enabled: boolean; periodPriceWei: string; maxPeriods: number }
}

export interface X402Deps {
  store: PaymentStore
  /** Optional: period rail persists authorizations through this seam. */
  authorizations?: AuthorizationStore
  getClient: (chain: ChainKey) => PublicClient
  chainIdOf: (chain: ChainKey) => number
}

export class X402Adapter {
  private stablecoin: StablecoinAdapter | null

  constructor(private cfg: X402Config, private deps: X402Deps) {
    this.stablecoin = cfg.stablecoin?.enabled && cfg.stablecoin.asset
      ? new StablecoinAdapter(cfg.stablecoin, { store: deps.store, getClient: deps.getClient, chainIdOf: deps.chainIdOf })
      : null
  }

  priceWei(): bigint {
    return BigInt(this.cfg.priceWei)
  }

  /** `upto` scheme cap (wei). */
  maxAmountWei(): bigint {
    return this.cfg.maxAmountWei ? BigInt(this.cfg.maxAmountWei) : this.priceWei() * 10n
  }

  available(): boolean {
    return this.cfg.enabled && Boolean(this.cfg.payTo)
  }

  stablecoinAvailable(): boolean {
    return this.stablecoin?.available() ?? false
  }

  stablecoinAsset(): string | null {
    return this.stablecoin?.available() ? this.stablecoin!.asset() : null
  }

  payTo(): string {
    return this.cfg.payTo
  }

  chain(): ChainKey {
    return this.cfg.chain
  }

  network(): string {
    return `eip155:${this.deps.chainIdOf(this.chain())}`
  }

  periodAsset(): string {
    return this.cfg.period && this.stablecoinAvailable() ? this.stablecoin!.asset() : NATIVE_ASSET
  }

  /** Build the v2 challenge for a protected resource (all enabled schemes). */
  paymentRequired(resource?: string): X402PaymentRequired {
    const base: Omit<X402Accept, 'scheme' | 'amount'> = {
      network: this.network(),
      asset: NATIVE_ASSET,
      payTo: this.cfg.payTo,
      maxTimeoutSeconds: 300,
    }
    const accepts: X402Accept[] = [
      { ...base, scheme: 'exact', amount: this.priceWei().toString() },
      { ...base, scheme: 'upto', amount: this.maxAmountWei().toString() },
    ]
    if (this.stablecoinAvailable()) {
      accepts.push(this.stablecoin!.accept(this.cfg.payTo))
    }
    if (this.cfg.period?.enabled) {
      const periodPrice = BigInt(this.cfg.period.periodPriceWei)
      const maxPeriods = this.cfg.period.maxPeriods
      accepts.push({
        scheme: 'period',
        network: this.network(),
        amount: (periodPrice * BigInt(maxPeriods)).toString(),
        asset: this.periodAsset(),
        payTo: this.cfg.payTo,
        maxTimeoutSeconds: 600,
        extra: { periodPriceWei: periodPrice.toString(), maxPeriods },
      })
    }
    return { x402Version: 2, resource, accepts }
  }

  /**
   * HTTP 402 response headers: v2 `PAYMENT-REQUIRED` (base64 challenge) plus
   * the legacy v1 `x-*` headers for backward compatibility.
   */
  paymentRequiredHeaders(resource?: string): Record<string, string> {
    return {
      'payment-required': encodeHeader(this.paymentRequired(resource)),
      'x-price': this.priceWei().toString(),
      'x-pay-to': this.cfg.payTo,
      'x-network': this.network(),
    }
  }

  /**
   * Verify a v2 `PAYMENT-SIGNATURE` header:
   *   1. decodes + checks x402Version / accepted matches this deployment
   *   2. recovers the EIP-712 signer
   *   3. enforces scheme rules (exact / upto / period)
   *   4. verifies the funding tx (native value transfer or stablecoin Transfer)
   *   5. credits the ledger (idempotent per txHash) — the guard then deducts
   *      `settledAmount` per request; period commits the full amount into an
   *      authorization instead and returns settledAmount = 0.
   * @returns payer + settled amount + accepted, or null when the payload is invalid.
   */
  async verifyPaymentSignature(header: string, expected?: X402PaymentRequired): Promise<{ payer: string; settledAmount: bigint; accepted: X402Accept; authorizationId?: string } | null> {
    if (!this.available()) return null
    let payload: X402PaymentPayload
    try {
      payload = decodeHeader<X402PaymentPayload>(header)
    } catch {
      return null
    }
    if (payload.x402Version !== 2 || !payload.accepted || !payload.payload?.txHash) return null

    const { accepted } = payload
    // accepted must describe this deployment
    if (accepted.payTo.toLowerCase() !== this.cfg.payTo.toLowerCase()) return null
    if (accepted.network !== this.network()) return null

    const isToken = (accepted.asset ?? NATIVE_ASSET).toLowerCase() !== NATIVE_ASSET.toLowerCase()
    if (isToken && !this.stablecoinAvailable()) return null
    if (isToken && accepted.asset!.toLowerCase() !== this.stablecoin!.asset().toLowerCase()) return null
    if (!isToken && accepted.asset!.toLowerCase() !== NATIVE_ASSET.toLowerCase()) return null

    // scheme rules (against the expected challenge when supplied)
    const amount = BigInt(accepted.amount)
    const expectedAccept = expected?.accepts.find((a) => a.scheme === accepted.scheme)

    // ── period: amount == periodPrice × periods (client-chosen, ≤ maxPeriods) ──
    if (accepted.scheme === 'period') {
      const periodPrice = BigInt(String(accepted.extra?.periodPriceWei ?? expectedAccept?.extra?.periodPriceWei ?? ''))
      const periods = Number(accepted.extra?.periods ?? 0)
      const maxPeriods = Number(expectedAccept?.extra?.maxPeriods ?? this.cfg.period?.maxPeriods ?? 0)
      if (!periodPrice || !periods || periods < 1 || periods > maxPeriods) return null
      if (amount !== periodPrice * BigInt(periods)) return null
      if (!this.cfg.period?.enabled) return null
      if ((accepted.asset ?? NATIVE_ASSET).toLowerCase() !== this.periodAsset().toLowerCase()) return null

      const signer = await recoverPaymentSigner(payload)
      if (!signer) return null

      const verified = isToken
        ? await this.stablecoin!.verifyAndCredit(payload.payload.txHash, this.cfg.payTo, this.chain())
        : await this.verifyAndCredit(payload.payload.txHash, this.chain())
      if (!verified || verified.payer.toLowerCase() !== signer.toLowerCase()) return null

      const authorizationId = await this.commitAuthorization({
        owner: signer,
        asset: accepted.asset ?? NATIVE_ASSET,
        amount,
        periodPrice,
        periods,
        nonce: payload.payload.salt,
        reference: payload.payload.txHash.toLowerCase(),
      })
      return { payer: signer, settledAmount: 0n, accepted, authorizationId }
    }

    // ── exact / upto (native or stablecoin) ──────────────────────────────────
    if (accepted.scheme === 'exact') {
      const want = expectedAccept ? BigInt(expectedAccept.amount) : isToken ? this.stablecoin!.priceWei() : this.priceWei()
      if (amount !== want) return null
    } else if (accepted.scheme === 'upto' && !isToken) {
      const cap = expectedAccept ? BigInt(expectedAccept.amount) : this.maxAmountWei()
      if (amount < this.priceWei() || amount > cap) return null
    } else {
      return null
    }

    // EIP-712 signature → signer
    const signer = await recoverPaymentSigner(payload)
    if (!signer) return null

    // verifyOnly: the funding tx must be a valid payment from the signer
    const verified = isToken
      ? await this.stablecoin!.verifyAndCredit(payload.payload.txHash, this.cfg.payTo, this.chain())
      : await this.verifyAndCredit(payload.payload.txHash, this.chain())
    if (!verified || verified.payer.toLowerCase() !== signer.toLowerCase()) return null

    return { payer: signer, settledAmount: amount, accepted }
  }

  /**
   * Verify an on-chain funding tx to the platform wallet and credit the
   * sender's balance. Tries the native path (value transfer to payTo) first,
   * then the stablecoin path (Transfer event on the configured token) when the
   * tx is not a native payment. Idempotent per tx hash (via the store).
   * @returns verified payment, or null when the tx is not a valid payment.
   */
  async verifyAndCredit(txHash: string, chain?: ChainKey): Promise<VerifiedPayment | null> {
    if (!this.available()) return null
    const c = chain ?? this.chain()

    const native = await this.verifyNativeTx(txHash, c)
    if (native) return native

    // Stablecoin rail: a Transfer(from → payTo, value ≥ price) on the token.
    if (this.stablecoinAvailable()) {
      const verified = await this.stablecoin!.verifyAndCredit(txHash, this.cfg.payTo, c)
      if (verified) {
        return {
          reference: txHash.toLowerCase(),
          payer: verified.payer,
          creditedWei: verified.creditedWei,
          asset: this.stablecoin!.asset(),
          chain: c,
        }
      }
    }
    return null
  }

  /** Native path: success + tx.to == payTo + value ≥ price → credit. */
  private async verifyNativeTx(txHash: string, c: ChainKey): Promise<VerifiedPayment | null> {
    const client = this.deps.getClient(c)
    const hash = txHash as `0x${string}`
    const [receipt, tx] = await Promise.all([
      client.getTransactionReceipt({ hash }).catch(() => null),
      client.getTransaction({ hash }).catch(() => null),
    ])
    if (!receipt || receipt.status !== 'success' || !tx) return null

    const payTo = this.cfg.payTo.toLowerCase()
    if ((tx.to ?? '').toLowerCase() !== payTo) return null

    const amount = tx.value ?? 0n
    if (amount < this.priceWei()) return null

    const from = tx.from.toLowerCase()
    await this.deps.store.credit({
      reference: txHash.toLowerCase(),
      payer: from,
      amountWei: amount.toString(),
      asset: NATIVE_ASSET,
      chainId: this.deps.chainIdOf(c),
    })
    return { reference: txHash.toLowerCase(), payer: from, creditedWei: amount.toString(), asset: NATIVE_ASSET, chain: c }
  }

  /**
   * Commit a period funding into a payment_authorization and lock the funds by
   * deducting the full amount from the payer's balance (idempotent per tx hash).
   */
  private async commitAuthorization(input: {
    owner: string
    asset: string
    amount: bigint
    periodPrice: bigint
    periods: number
    nonce: string
    reference: string
  }): Promise<string> {
    if (!this.deps.authorizations) {
      throw new Error('Period rail requires an authorization store')
    }
    // Deterministic id → replayed funding txs cannot double-create.
    const id = `auth:${input.reference}`
    await this.deps.store.credit({
      reference: input.reference,
      payer: input.owner,
      amountWei: input.amount.toString(),
      asset: input.asset,
      chainId: this.deps.chainIdOf(this.chain()),
    })
    await this.deps.store.deduct(input.owner, input.amount, input.asset)
    await this.deps.authorizations.createAuthorization({
      id,
      owner: input.owner,
      asset: input.asset,
      chain: this.chain(),
      amountWei: input.amount.toString(),
      remainingWei: input.amount.toString(),
      periodPriceWei: input.periodPrice.toString(),
      periods: input.periods,
      nonce: input.nonce,
      reference: input.reference,
      status: 'active',
      createdAt: new Date(),
    })
    return id
  }

  async balanceOf(address: string): Promise<bigint> {
    return this.deps.store.balanceOf(address, NATIVE_ASSET)
  }

  async deduct(address: string, amount: bigint): Promise<boolean> {
    return this.deps.store.deduct(address, amount, NATIVE_ASSET)
  }
}
