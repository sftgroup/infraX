// ---------------------------------------------------------------------------
// @0xinfrax/payments — generic clients (P0 minimal set)
// ---------------------------------------------------------------------------
// Protocol-level clients that can point at any deployment of the module
// (AgentX-hosted or caller-owned). Business semantics stay in the caller.
// ---------------------------------------------------------------------------

import { randomHex } from './crypto'
import type { Address, WalletClient } from 'viem'
import type { ChainKey, CreatePaymentInput, CreatePaymentResult, X402Info } from './types'
import {
  buildPaymentMessage,
  decodeHeader,
  encodeHeader,
} from './protocol/x402-v2'
import type { X402PaymentPayload, X402PaymentRequired, X402PaymentResponse } from './protocol/x402-v2'

export interface ClientOptions {
  baseUrl: string
  accessToken?: string
}

async function request(baseUrl: string, path: string, init?: RequestInit, accessToken?: string): Promise<any> {
  const base = baseUrl.replace(/\/$/, '')
  const headers: Record<string, string> = {
    ...((init?.headers as Record<string, string>) ?? {}),
  }
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`
  const resp = await fetch(`${base}${path}`, { ...init, headers })
  if (!resp.ok) {
    let message = `Payments request failed (${resp.status}): ${path}`
    try {
      const body = (await resp.json()) as { error?: string }
      if (body.error) message = body.error
    } catch { /* non-JSON */ }
    throw new Error(message)
  }
  return resp.json()
}

/** x402 protocol client: discovery, verify, balance. */
export class X402Client {
  constructor(private opts: ClientOptions) {}

  async info(): Promise<X402Info> {
    return request(this.opts.baseUrl, '/api/v1/x402/info', undefined, this.opts.accessToken)
  }

  async verify(txHash: string, chain?: ChainKey): Promise<{ verified: boolean; creditedWei: string; payer: string; balanceWei: string }> {
    return request(
      this.opts.baseUrl,
      '/api/v1/x402/verify',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ txHash, chain }) },
      this.opts.accessToken
    )
  }

  async balance(address: string): Promise<bigint> {
    const data = await request(this.opts.baseUrl, `/api/v1/x402/balance?address=${encodeURIComponent(address)}`, undefined, this.opts.accessToken)
    return BigInt(data.balanceWei ?? '0')
  }

  /**
   * Fetch the x402 v2 challenge for a resource. Equivalent to `quote`.
   * @returns the parsed PaymentRequired, or null when the resource is free (200).
   */
  async quote(url: string, init?: RequestInit): Promise<X402PaymentRequired | null> {
    return this.fetchChallenge(url, init)
  }

  /** Alias of `quote` (x402 client vocabulary: quote / challenge / pay / replay). */
  fetchChallenge(url: string, init?: RequestInit): Promise<X402PaymentRequired | null> {
    return (async () => {
      const resp = await fetch(url, init)
      const header = resp.headers.get('payment-required')
      if (resp.status === 402 && header) return decodeHeader<X402PaymentRequired>(header)
      return null
    })()
  }

  /**
   * Full v2 payment: fetch challenge → fund the platform wallet on-chain →
   * sign the PaymentPayload (EIP-712) → replay the request with
   * `PAYMENT-SIGNATURE` → return the response + `PAYMENT-RESPONSE` receipt.
   *
   * Requires a WalletClient whose chain matches the challenge network.
   */
  async pay(opts: X402PayOptions): Promise<{ status: number; data: unknown; paymentResponse: X402PaymentResponse | null }> {
    const { url, method = 'GET', body, headers = {}, walletClient, account, scheme = 'exact', amountWei } = opts
    const init: RequestInit = { method, body, headers: { ...headers } }
    const challenge = await this.fetchChallenge(url, init)
    if (!challenge) throw new Error('Resource did not require payment (no 402 challenge)')
    const accept = challenge.accepts.find((a) => a.scheme === scheme)
    if (!accept) throw new Error(`Scheme "${scheme}" is not accepted by the resource`)

    const cap = BigInt(accept.amount)
    const amount = amountWei ?? (scheme === 'exact' ? cap : cap)
    if (scheme === 'upto' && amountWei === undefined) {
      throw new Error('amountWei is required for the upto scheme')
    }

    // 1. fund the platform wallet (native transfer, verifyOnly model)
    const txHash = await walletClient.sendTransaction({
      to: accept.payTo as Address,
      value: amount,
      account,
      chain: undefined,
    })

    // 2. build + sign the PaymentPayload
    const payload: X402PaymentPayload = {
      x402Version: 2,
      accepted: { ...accept, amount: amount.toString() },
      payload: {
        method,
        url,
        salt: `0x${randomHex(32)}`,
        txHash,
      },
      signature: '',
    }
    const { domain, types, primaryType, message } = buildPaymentMessage(payload)
    payload.signature = await walletClient.signTypedData({ domain, types, primaryType, message, account })

    // 3. replay the original request with the proof
    return this.replay(url, encodeHeader(payload), { method, body, headers })
  }

  /** Replay a request carrying a `PAYMENT-SIGNATURE` proof. */
  async replay(url: string, paymentSignature: string, init?: RequestInit): Promise<{ status: number; data: unknown; paymentResponse: X402PaymentResponse | null }> {
    const headers: Record<string, string> = { ...((init?.headers as Record<string, string>) ?? {}) }
    headers['payment-signature'] = paymentSignature
    const resp = await fetch(url, { ...init, headers })
    const data = await resp.json().catch(() => null)
    const prHeader = resp.headers.get('payment-response')
    return {
      status: resp.status,
      data,
      paymentResponse: prHeader ? decodeHeader<X402PaymentResponse>(prHeader) : null,
    }
  }
}

/** Options for X402Client.pay. */
export interface X402PayOptions {
  url: string
  method?: string
  body?: string
  headers?: Record<string, string>
  walletClient: WalletClient
  account: Address
  scheme?: 'exact' | 'upto'
  /** Required for `upto`: amount within [price, cap]. */
  amountWei?: bigint
}

/** Unified payment client (maps to POST /api/v1/payments + friends). */
export class PaymentsClient {
  constructor(private opts: ClientOptions) {}

  async create(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    return request(
      this.opts.baseUrl,
      '/api/v1/payments',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) },
      this.opts.accessToken
    )
  }

  /** Verify an on-chain payment tx and credit the payer's balance. */
  async verify(txHash: string, chain?: ChainKey): Promise<{ verified: boolean; creditedWei: string; payer: string; chain?: ChainKey; balanceWei: string }> {
    return request(
      this.opts.baseUrl,
      '/api/v1/payments/verify',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ txHash, chain }) },
      this.opts.accessToken
    )
  }

  /** Unified access check (chain OR off-chain rails, decided by the host). */
  async access(subscriber: string, agentId: number, chain?: ChainKey): Promise<{ active: boolean }> {
    const params = new URLSearchParams({ subscriber, agentId: String(agentId) })
    if (chain) params.set('chain', chain)
    return request(this.opts.baseUrl, `/api/v1/payments/access?${params}`, undefined, this.opts.accessToken)
  }

  /** Rails discovery / pricing from the host deployment. */
  async info(): Promise<{
    rails: { fiat: { enabled: boolean }; chain: { enabled: boolean }; x402: { enabled: boolean } }
    x402: { enabled: boolean; priceWei: string; payTo: string; network: string; chain: ChainKey }
    chains: { chain: ChainKey; chainId: number }
  }> {
    return request(this.opts.baseUrl, '/api/v1/payments/info', undefined, this.opts.accessToken)
  }

  /** Fetch the x402 v2 challenge for a protected resource on this host. */
  async quote(url: string): Promise<{ free: boolean; challenge?: X402PaymentRequired }> {
    return request(this.opts.baseUrl, `/api/v1/payments/quote?url=${encodeURIComponent(url)}`, undefined, this.opts.accessToken)
  }
}

/** MPP payment-channel client: open / voucher / topup / settle / close. */
export class MPPClient {
  constructor(private opts: ClientOptions) {}

  /** Open a channel (deposit tx must be sent before; txHash is the credential). */
  async open(input: { payer: string; depositWei: string; salt: string; txHash: string; chain?: ChainKey }): Promise<{ channelId: string; depositWei: string; payee: string }> {
    return request(
      this.opts.baseUrl,
      '/api/v1/payments/mpp/open',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) },
      this.opts.accessToken
    )
  }

  /** Submit a cumulative voucher (EIP-712 signed by the channel payer). */
  async voucher(input: { channelId: string; cumulativeAmount: string; signature: string }): Promise<{ accepted: boolean; mode: 'sign' | 'reuse'; channelId: string }> {
    return request(
      this.opts.baseUrl,
      '/api/v1/payments/mpp/voucher',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) },
      this.opts.accessToken
    )
  }

  async topUp(input: { channelId: string; txHash: string; additionalWei: string }): Promise<{ depositWei: string }> {
    return request(
      this.opts.baseUrl,
      '/api/v1/payments/mpp/topup',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) },
      this.opts.accessToken
    )
  }

  async settle(channelId: string): Promise<{ consumedWei: string; spentWei: string; currentCum: string }> {
    return request(
      this.opts.baseUrl,
      '/api/v1/payments/mpp/settle',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channelId }) },
      this.opts.accessToken
    )
  }

  async close(channelId: string): Promise<{ spentWei: string; refundWei: string; depositWei: string }> {
    return request(
      this.opts.baseUrl,
      '/api/v1/payments/mpp/close',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channelId }) },
      this.opts.accessToken
    )
  }

  async session(channelId: string): Promise<{ status: string; currentCum: string; spentWei: string; depositWei: string }> {
    return request(this.opts.baseUrl, `/api/v1/payments/mpp/session?channelId=${encodeURIComponent(channelId)}`, undefined, this.opts.accessToken)
  }
}
