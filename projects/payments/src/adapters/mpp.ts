// ---------------------------------------------------------------------------
// @0xinfrax/payments — MPPAdapter (multi-purpose payment channels)
// ---------------------------------------------------------------------------
// Payment-channel rail: the payer funds a deposit on-chain (native to the
// platform wallet), then signs cumulative EIP-712 vouchers to authorize spend
// up to the deposit. Consumption is deducted from the payer's ledger balance
// in batch at settle time (by threshold or interval), so high-frequency
// requests cost no per-request writes — the OKX "aggr_deferred" model.
//
// Lifecycle: open → (voucher)* → close, with topup at any time.
// Funds: the deposit tx is credited to the payer balance at open; settle
// deducts consumption; close just freezes the session (refund = deposit − spent
// is whatever remains on the payer balance).
// ---------------------------------------------------------------------------

import { encodePacked, keccak256 } from 'viem'
import type { Address, PublicClient } from 'viem'
import { NATIVE_ASSET } from '../types'
import type { ChainKey } from '../types'
import type { MPPSessionRow, MPPSessionStore, PaymentStore } from '../store'
import { PaymentError } from '../errors'
import { recoverVoucherSigner } from '../protocol/mpp-voucher'

export interface MPPConfig {
  enabled: boolean
  /** EIP-712 domain verifyingContract for vouchers (a configured MPP domain). */
  domain: string
  /** Platform wallet receiving deposits. */
  payee: string
  chain: ChainKey
  /** Auto-settle: consume threshold (wei) before an on-demand settle fires. */
  settleThresholdWei?: string
  /** Auto-settle: minimum interval between settles (seconds). */
  settleIntervalSec?: number
}

export interface MPPDeps {
  store: PaymentStore
  sessions: MPPSessionStore
  getClient: (chain: ChainKey) => PublicClient
  chainIdOf: (chain: ChainKey) => number
  /** Logger hook (optional). */
  log?: (msg: string) => void
}

export interface MPPSessionInput {
  payer: string
  /** Deposit amount in native wei. */
  depositWei: string
  /** Channel salt — binds the channel to a fresh context. */
  salt: string
  /** Funding tx (payer → payee, value ≥ deposit). */
  txHash: string
  chain?: ChainKey
  asset?: string
}

export interface MPPVoucherInput {
  channelId: string
  /** Monotonic cumulative authorized amount (wei). */
  cumulativeAmount: string
  /** EIP-712 signature over Voucher(channelId, cumulativeAmount). */
  signature: string
}

export interface MPPSettleResult {
  consumedWei: string
  spentWei: string
  currentCum: string
}

export class MPPAdapter {
  constructor(private cfg: MPPConfig, private deps: MPPDeps) {}

  available(): boolean {
    return this.cfg.enabled && Boolean(this.cfg.domain) && Boolean(this.cfg.payee)
  }

  chain(): ChainKey {
    return this.cfg.chain
  }

  /** Platform wallet receiving deposits. */
  payeeOf(): string {
    return this.cfg.payee
  }

  private log(msg: string): void {
    this.deps.log?.(msg)
  }

  /** keccak256(abi.encodePacked(payer, payee, asset, salt, chainId)) — bytes32. */
  channelId(input: { payer: string; payee: string; asset: string; salt: string; chainId: number }): `0x${string}` {
    return keccak256(
      encodePacked(
        ['address', 'address', 'address', 'bytes32', 'uint256'],
        [
          input.payer as Address,
          input.payee as Address,
          input.asset as Address,
          input.salt as `0x${string}`,
          BigInt(input.chainId),
        ]
      )
    )
  }

  /**
   * Verify the funding tx and open a channel. The deposit credits the payer's
   * balance (the platform wallet is funded; the payer holds an equivalent
   * off-chain balance that settle will consume against).
   */
  async open(input: MPPSessionInput): Promise<{ channelId: string; depositWei: string }> {
    if (!this.available()) throw new PaymentError('NOT_CONFIGURED', 'MPP is not configured', 503)
    const chain = input.chain ?? this.cfg.chain
    const deposit = BigInt(input.depositWei)
    if (deposit <= 0n) throw new PaymentError('INVALID_INPUT', 'depositWei must be positive', 400)

    const verified = await this.verifyDepositTx(input.txHash, input.payer, chain, deposit)
    if (!verified) {
      throw new PaymentError('INVALID_SIGNATURE', 'Deposit tx is not a valid payment to the platform wallet', 422)
    }

    const asset = input.asset ?? NATIVE_ASSET
    const ch = this.channelId({ payer: input.payer, payee: this.cfg.payee, asset, salt: input.salt, chainId: this.deps.chainIdOf(chain) })
    const row: MPPSessionRow = {
      channelId: ch,
      payer: input.payer.toLowerCase(),
      payee: this.cfg.payee.toLowerCase(),
      chain,
      asset: asset.toLowerCase(),
      depositWei: deposit.toString(),
      currentCum: '0',
      spentWei: '0',
      lastSignature: null,
      status: 'open',
      salt: input.salt,
      lastSettleAt: new Date(),
      autoSettle: true,
      settleIntervalSec: this.cfg.settleIntervalSec ?? 86_400,
    }
    await this.deps.sessions.createSession(row)
    this.log(`mpp.open(channel=${ch.slice(0, 18)}…, payer=${input.payer.slice(0, 10)}, deposit=${deposit})`)
    return { channelId: ch, depositWei: deposit.toString() }
  }

  /**
   * Accept a cumulative voucher: verify the EIP-712 signature (payer), enforce
   * monotonicity and the deposit bound, then record it. Optionally triggers an
   * auto-settle when the un-settled consumption crosses the threshold.
   */
  async voucher(input: MPPVoucherInput): Promise<{ accepted: boolean; mode: 'sign' | 'reuse'; channelId: string }> {
    if (!this.available()) throw new PaymentError('NOT_CONFIGURED', 'MPP is not configured', 503)
    const session = await this.deps.sessions.getSession(input.channelId)
    if (!session || session.status !== 'open') {
      throw new PaymentError('NOT_FOUND', `MPP session ${input.channelId.slice(0, 18)}… is not open`, 404)
    }

    const cum = BigInt(input.cumulativeAmount)
    const deposit = BigInt(session.depositWei)
    const current = BigInt(session.currentCum)
    if (cum > deposit) {
      throw new PaymentError('INVALID_INPUT', `cumulative ${cum} exceeds deposit ${deposit}`, 400)
    }
    // Signature reuse: repeating the latest cumulative amount with the same
    // signature is a replay of the most recent voucher (idempotent).
    if (cum === current && session.lastSignature === input.signature) {
      return { accepted: true, mode: 'reuse', channelId: input.channelId }
    }
    if (cum <= current) {
      throw new PaymentError('INVALID_INPUT', `cumulative ${cum} is not monotonic (current ${current})`, 400)
    }

    const signer = await recoverVoucherSigner(
      { channelId: input.channelId as `0x${string}`, cumulativeAmount: input.cumulativeAmount },
      this.deps.chainIdOf(session.chain as ChainKey),
      this.cfg.domain as Address,
      input.signature
    )
    if (!signer || signer.toLowerCase() !== session.payer) {
      throw new PaymentError('INVALID_SIGNATURE', 'Voucher signature does not match the channel payer', 401)
    }

    await this.deps.sessions.applyVoucher(input.channelId, input.cumulativeAmount, input.signature)
    await this.deps.sessions.recordVoucher(input.channelId, input.cumulativeAmount, input.signature)

    // Auto-settle policy: cross the threshold → settle on the spot (the payer
    // balance has been pre-funded by the deposit, so deduct is atomic).
    const settleThreshold = this.cfg.settleThresholdWei ? BigInt(this.cfg.settleThresholdWei) : deposit
    const pending = cum - BigInt(session.spentWei)
    if (session.autoSettle && pending >= settleThreshold) {
      await this.settle(input.channelId)
    }
    this.log(`mpp.voucher(channel=${input.channelId.slice(0, 18)}…, cum=${cum}, mode=${cum === current ? 'reuse' : 'sign'})`)
    return { accepted: true, mode: cum === current ? 'reuse' : 'sign', channelId: input.channelId }
  }

  /** Increase the deposit after a new funding tx (the channel stays open). */
  async topUp(input: { channelId: string; txHash: string; additionalWei: string }): Promise<{ depositWei: string }> {
    const session = await this.deps.sessions.getSession(input.channelId)
    if (!session || session.status !== 'open') {
      throw new PaymentError('NOT_FOUND', `MPP session ${input.channelId.slice(0, 18)}… is not open`, 404)
    }
    const extra = BigInt(input.additionalWei)
    const verified = await this.verifyDepositTx(input.txHash, session.payer, session.chain as ChainKey, extra)
    if (!verified) {
      throw new PaymentError('INVALID_SIGNATURE', 'Top-up tx is not a valid payment to the platform wallet', 422)
    }
    await this.deps.sessions.topUp(input.channelId, extra.toString())
    return { depositWei: (BigInt(session.depositWei) + extra).toString() }
  }

  /**
   * Settle: deduct the un-settled consumption (current_cum − spent) from the
   * payer's ledger balance and mark it spent. Idempotent — settles nothing
   * when there is nothing pending.
   */
  async settle(channelId: string): Promise<MPPSettleResult> {
    const session = await this.deps.sessions.getSession(channelId)
    if (!session) throw new PaymentError('NOT_FOUND', `MPP session ${channelId.slice(0, 18)}… not found`, 404)
    const consumed = BigInt(session.currentCum) - BigInt(session.spentWei)
    if (consumed > 0n) {
      const ok = await this.deps.store.deduct(session.payer, consumed, session.asset)
      if (!ok) {
        throw new PaymentError('INVALID_INPUT', `Payer balance cannot cover settle amount ${consumed}`, 422)
      }
      await this.deps.sessions.applySettle(channelId, consumed.toString())
      this.log(`mpp.settle(channel=${channelId.slice(0, 18)}…, consumed=${consumed}, payer=${session.payer.slice(0, 10)})`)
    }
    return { consumedWei: consumed.toString(), spentWei: (BigInt(session.spentWei) + consumed).toString(), currentCum: session.currentCum }
  }

  /** Close: settle the tail, mark closed; refund = deposit − spent. */
  async close(channelId: string): Promise<{ spentWei: string; refundWei: string; depositWei: string }> {
    const session = await this.deps.sessions.getSession(channelId)
    if (!session) throw new PaymentError('NOT_FOUND', `MPP session ${channelId.slice(0, 18)}… not found`, 404)
    if (session.status === 'closed') {
      return { spentWei: session.spentWei, refundWei: (BigInt(session.depositWei) - BigInt(session.spentWei)).toString(), depositWei: session.depositWei }
    }
    await this.settle(channelId)
    const fresh = await this.deps.sessions.getSession(channelId)
    await this.deps.sessions.closeSession(channelId)
    const spent = BigInt(fresh!.spentWei)
    const deposit = BigInt(fresh!.depositWei)
    const refund = deposit - spent < 0n ? 0n : deposit - spent
    this.log(`mpp.close(channel=${channelId.slice(0, 18)}…, spent=${spent}, refund=${refund})`)
    return { spentWei: spent.toString(), refundWei: refund.toString(), depositWei: deposit.toString() }
  }

  /** Read the current session state (open/closed, cum, spent). */
  async session(channelId: string): Promise<MPPSessionRow | null> {
    return this.deps.sessions.getSession(channelId)
  }

  /**
   * Verify a native funding tx: success, to == payee, value ≥ deposit, and
   * credit the payer's balance (idempotent per tx hash).
   */
  private async verifyDepositTx(txHash: string, payer: string, chain: ChainKey, minWei: bigint): Promise<boolean> {
    const client = this.deps.getClient(chain)
    const hash = txHash as `0x${string}`
    const [receipt, tx] = await Promise.all([
      client.getTransactionReceipt({ hash }).catch(() => null),
      client.getTransaction({ hash }).catch(() => null),
    ])
    if (!receipt || receipt.status !== 'success' || !tx) return false
    if ((tx.to ?? '').toLowerCase() !== this.cfg.payee.toLowerCase()) return false
    if ((tx.value ?? 0n) < minWei) return false
    if (tx.from.toLowerCase() !== payer.toLowerCase()) return false

    await this.deps.store.credit({
      reference: txHash.toLowerCase(),
      payer: payer.toLowerCase(),
      amountWei: (tx.value ?? 0n).toString(),
      asset: NATIVE_ASSET,
      chainId: this.deps.chainIdOf(chain),
    })
    return true
  }
}
