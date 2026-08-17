// ---------------------------------------------------------------------------
// @0xinfrax/payments — X402Adapter (x402 v2: native + stablecoin)
// ---------------------------------------------------------------------------
// Pay-per-request rail implementing the x402 v2 challenge/verify handshake.
// Schemes:
//   * `exact`  — amount fixed to the challenge price (native or stablecoin)
//   * `upto`   — client picks an amount within [price, cap] (native)
// All payments use the verifyOnly model: the on-chain tx (native value transfer
// or stablecoin Transfer event) is the credential, credited once into the
// ledger (idempotent per txHash) and consumed per request via deduct.
// ---------------------------------------------------------------------------

import { parseAbi, parseEventLogs, type PublicClient } from 'viem'
import { NATIVE_ASSET } from '../types'
import type { ChainKey, VerifiedPayment } from '../types'
import type { PaymentStore } from '../store'
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
  /** OE-5: Escrow 托管合约（x402 充值目标 = AA_PLATFORM_ADDRESS → Escrow）。
   *   verify 时解析 deposit() 的 Deposited 事件入账 ledger（索引/对账层）。 */
  escrow?: { address: string }
}

/** InfraXEscrow.deposit() 事件（native deposit: token = address(0)）。
 *  AX-1/OE-1：导出供集成方合约对齐（对齐 InfraXEscrow 接口）。 */
export const escrowDepositAbi = parseAbi([
  'event Deposited(address indexed user, uint256 amount, address token)',
])

export interface X402Deps {
  store: PaymentStore
  getClient: (chain: ChainKey) => PublicClient
  chainIdOf: (chain: ChainKey) => number
}

/** AX-7/PC-3: 结构化 402 body（前端可直接渲染付款卡片）。 */
export interface PaymentRequiredBody {
  priceWei: string
  payTo: string
  resource: string
  /** 待付款闭环关联键（宿主传入，如 a2a paymentId）。 */
  resumeRef: string
  /** 付款模式二选一：充值并继续 / 改为订阅。 */
  mode: 'topup' | 'subscribe'
  network: string
  asset: string
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

  /** AX-1/OE-1: 已配置的 escrow 金库地址（未配置返回 null）。 */
  escrowAddress(): string | null {
    return this.cfg.escrow?.address ?? null
  }

  chain(): ChainKey {
    return this.cfg.chain
  }

  network(): string {
    return `eip155:${this.deps.chainIdOf(this.chain())}`
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
   * AX-7/PC-3: 结构化 402 body（供前端直接渲染"付款按钮"）。
   * 字段：priceWei / payTo / resource / resumeRef / mode（topup | subscribe）。
   * resumeRef 由宿主传入待付款闭环关联键（如 a2a paymentId）；mode 二选一。
   */
  paymentRequiredBody(
    resource: string,
    opts?: { resumeRef?: string; mode?: 'topup' | 'subscribe' }
  ): PaymentRequiredBody {
    return {
      priceWei: this.priceWei().toString(),
      payTo: this.cfg.payTo,
      resource,
      resumeRef: opts?.resumeRef ?? '',
      mode: opts?.mode ?? 'topup',
      network: this.network(),
      asset: NATIVE_ASSET,
    }
  }

  /**
   * Verify a v2 `PAYMENT-SIGNATURE` header:
   *   1. decodes + checks x402Version / accepted matches this deployment
   *   2. recovers the EIP-712 signer
   *   3. enforces scheme rules (exact / upto)
   *   4. verifies the funding tx (native value transfer or stablecoin Transfer)
   *   5. credits the ledger (idempotent per txHash) — the guard then deducts
   *      `settledAmount` per request.
   * @returns payer + settled amount + accepted, or null when the payload is invalid.
   */
  async verifyPaymentSignature(header: string, expected?: X402PaymentRequired): Promise<{ payer: string; settledAmount: bigint; accepted: X402Accept } | null> {
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

    // OE-5: Escrow deposit path — a deposit() into the escrow contract is the
    // credential for a top-up (balance lives on-chain; ledger keeps an index).
    if (this.cfg.escrow?.address) {
      const escrow = await this.verifyEscrowDepositTx(txHash, c)
      if (escrow) return escrow
    }

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
   * OE-5/AX-3: Escrow deposit path. tx.to == escrow.address + Deposited event
   * + amount ≥ price → credit the depositor (ledger 索引).
   *  - native deposit（token == address(0)）: amount ≥ x402 price，asset = native
   *  - ERC20 deposit（token != address(0), OE-3/AX-3）: 资金同样进金库托管；
   *    需 stablecoin rail 已配置且 token 匹配，amount ≥ stablecoin price。
   * The authoritative balance stays on-chain (InfraXEscrow.balanceOf); the
   * ledger entry is the index/reconciliation layer (OE-8).
   */
  private async verifyEscrowDepositTx(txHash: string, c: ChainKey): Promise<VerifiedPayment | null> {
    const escrow = this.cfg.escrow!.address.toLowerCase()
    const client = this.deps.getClient(c)
    const hash = txHash as `0x${string}`
    const [receipt, tx] = await Promise.all([
      client.getTransactionReceipt({ hash }).catch(() => null),
      client.getTransaction({ hash }).catch(() => null),
    ])
    if (!receipt || receipt.status !== 'success' || !tx) return null
    if ((tx.to ?? '').toLowerCase() !== escrow) return null

    const logs = parseEventLogs({
      abi: escrowDepositAbi,
      eventName: 'Deposited',
      logs: receipt.logs.filter((l) => l.address.toLowerCase() === escrow),
    })
    if (logs.length === 0) return null

    const deposited = logs[0].args
    const user = (deposited.user as string).toLowerCase()
    const amount = deposited.amount as bigint
    const token = (deposited.token as string).toLowerCase()
    const zeroAddr = `0x${'0'.repeat(40)}`

    if (token === zeroAddr) {
      // native deposit
      if (amount < this.priceWei()) return null
      await this.deps.store.credit({
        reference: txHash.toLowerCase(),
        payer: user,
        amountWei: amount.toString(),
        asset: NATIVE_ASSET,
        chainId: this.deps.chainIdOf(c),
      })
      return { reference: txHash.toLowerCase(), payer: user, creditedWei: amount.toString(), asset: NATIVE_ASSET, chain: c }
    }

    // AX-3/OE-3: ERC20 deposit into escrow — 资金进金库托管（非 payTo 直收）。
    // 需 stablecoin rail 已配置且 token 匹配，否则不误入账。
    const sc = this.stablecoin
    if (!sc || !sc.available() || token !== sc.asset().toLowerCase()) return null
    if (amount < sc.priceWei()) return null

    const asset = sc.asset()
    await this.deps.store.credit({
      reference: txHash.toLowerCase(),
      payer: user,
      amountWei: amount.toString(),
      asset,
      chainId: this.deps.chainIdOf(c),
    })
    return { reference: txHash.toLowerCase(), payer: user, creditedWei: amount.toString(), asset, chain: c }
  }

  async balanceOf(address: string): Promise<bigint> {
    return this.deps.store.balanceOf(address, NATIVE_ASSET)
  }

  async deduct(address: string, amount: bigint): Promise<boolean> {
    return this.deps.store.deduct(address, amount, NATIVE_ASSET)
  }
}
