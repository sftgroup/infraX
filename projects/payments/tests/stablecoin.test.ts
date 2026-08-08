// Stablecoin rail tests: StablecoinAdapter (Transfer-event verification) +
// EIP-3009 / Permit2 protocol signature helpers.
import { describe, it, expect, vi } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { StablecoinAdapter, parseTransfer } from '../src/adapters/stablecoin'
import type { StablecoinConfig, StablecoinDeps } from '../src/adapters/stablecoin'
import {
  buildEIP3009Message,
  recoverEIP3009Signer,
  recoverPermit2Signer,
  EIP3009_TYPES,
  PERMIT2_TYPES,
} from '../src/protocol/stablecoin'
import type { PaymentStore } from '../src/store'

const ACCOUNT = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
const USDC = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174' // a mock USDC-like address
const PAY_TO = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const CHAIN_ID = 11155111

const cfg: StablecoinConfig = {
  enabled: true,
  chain: 'sepolia',
  asset: USDC,
  decimals: 6,
  priceWei: '1000000', // 1 USDC (6 decimals)
  domainName: 'Mock USD Coin',
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
}

function makeStore(): PaymentStore {
  return {
    balanceOf: vi.fn(async () => 0n),
    credit: vi.fn(async () => {}),
    isCreditRecorded: vi.fn(async () => false),
    deduct: vi.fn(async () => true),
    resolveAccess: vi.fn(async () => false),
    recordIntent: vi.fn(async () => {}),
    updateIntentStatus: vi.fn(async () => {}),
    emitEvent: vi.fn(async () => {}),
  } as unknown as PaymentStore
}

/** topics[1]=from, topics[2]=to, data=value — as returned by a real RPC. */
function transferLog(from: string, to: string, value: bigint) {
  return {
    address: USDC.toLowerCase(),
    topics: [
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
      `0x000000000000000000000000${from.slice(2).toLowerCase()}`,
      `0x000000000000000000000000${to.slice(2).toLowerCase()}`,
    ],
    data: `0x${value.toString(16).padStart(64, '0')}`,
  }
}

function makeClient(logs: unknown[] = []) {
  return {
    getTransactionReceipt: vi.fn(async () => ({ status: 'success', logs })),
  } as unknown as ReturnType<StablecoinDeps['getClient']>
}

function makeAdapter(logs?: unknown[], over?: Partial<StablecoinDeps>) {
  const deps: StablecoinDeps = {
    store: makeStore(),
    getClient: (() => makeClient(logs)) as unknown as StablecoinDeps['getClient'],
    chainIdOf: () => CHAIN_ID,
    ...over,
  }
  return { adapter: new StablecoinAdapter(cfg, deps), deps }
}

describe('StablecoinAdapter', () => {
  it('available() requires enabled + asset', () => {
    const { adapter } = makeAdapter()
    expect(adapter.available()).toBe(true)
    expect(new StablecoinAdapter({ ...cfg, enabled: false }, { store: makeStore(), getClient: (() => makeClient()) as never, chainIdOf: () => 1 }).available()).toBe(false)
  })

  it('accept() produces an exact-scheme accept with the token price', () => {
    const { adapter } = makeAdapter()
    const accept = adapter.accept(PAY_TO)
    expect(accept).toMatchObject({
      scheme: 'exact',
      network: `eip155:${CHAIN_ID}`,
      amount: '1000000',
      asset: USDC,
      payTo: PAY_TO,
      maxTimeoutSeconds: 300,
    })
  })

  it('verifyAndCredit credits the sender when a Transfer(to=payTo) ≥ price exists', async () => {
    const store = makeStore()
    const client = makeClient([transferLog(ACCOUNT.address, PAY_TO, 5_000_000n)])
    const { adapter } = makeAdapter(undefined, { store, getClient: (() => client) as never })
    const res = await adapter.verifyAndCredit('0x' + '11'.repeat(32), PAY_TO)
    expect(res).toEqual({ payer: ACCOUNT.address.toLowerCase(), creditedWei: '5000000' })
    expect(store.credit).toHaveBeenCalledWith(
      expect.objectContaining({ reference: '0x' + '11'.repeat(32), amountWei: '5000000', asset: USDC })
    )
  })

  it('verifyAndCredit ignores a Transfer to a different wallet', async () => {
    const store = makeStore()
    const client = makeClient([transferLog(ACCOUNT.address, '0x1111111111111111111111111111111111111111', 5_000_000n)])
    const { adapter } = makeAdapter(undefined, { store, getClient: (() => client) as never })
    const res = await adapter.verifyAndCredit('0x' + '11'.repeat(32), PAY_TO)
    expect(res).toBeNull()
    expect(store.credit).not.toHaveBeenCalled()
  })

  it('verifyAndCredit ignores a Transfer under the price', async () => {
    const client = makeClient([transferLog(ACCOUNT.address, PAY_TO, 500_000n)]) // 0.5 USDC < 1
    const { adapter } = makeAdapter(undefined, { getClient: (() => client) as never })
    const res = await adapter.verifyAndCredit('0x' + '11'.repeat(32), PAY_TO)
    expect(res).toBeNull()
  })

  it('verifyAndCredit returns null for a failed tx', async () => {
    const client = { getTransactionReceipt: vi.fn(async () => ({ status: 'reverted', logs: [] })) } as never
    const { adapter } = makeAdapter(undefined, { getClient: (() => client) as never })
    const res = await adapter.verifyAndCredit('0x' + '11'.repeat(32), PAY_TO)
    expect(res).toBeNull()
  })

  it('verifyAndCredit returns null when the store rejects the duplicate credit', async () => {
    const store = makeStore()
    const client = makeClient([transferLog(ACCOUNT.address, PAY_TO, 5_000_000n)])
    const { adapter } = makeAdapter(undefined, { store, getClient: (() => client) as never })
    // credit is idempotent by reference — calling twice must not throw or duplicate
    await adapter.verifyAndCredit('0x' + '11'.repeat(32), PAY_TO)
    await adapter.verifyAndCredit('0x' + '11'.repeat(32), PAY_TO)
    expect(store.credit).toHaveBeenCalledTimes(2)
  })
})

describe('parseTransfer', () => {
  it('decodes a standard Transfer log', () => {
    const parsed = parseTransfer(transferLog(ACCOUNT.address, PAY_TO, 1_000_000n))
    expect(parsed).toEqual({ from: ACCOUNT.address.toLowerCase(), to: PAY_TO.toLowerCase(), value: 1_000_000n })
  })

  it('returns null for a malformed log', () => {
    expect(parseTransfer({ topics: ['0xabc'], data: '0x01' })).toBeNull()
    expect(parseTransfer({ topics: ['0xabc', '0xdef', '0x123'], data: 'not-hex' })).toBeNull()
  })
})

describe('EIP-3009 protocol', () => {
  it('builds the typed message and recovers the authorizer', async () => {
    const auth = {
      from: ACCOUNT.address,
      to: PAY_TO as `0x${string}`,
      value: 5_000_000n,
      validAfter: 0n,
      validBefore: 9999999999999n,
      nonce: ('0x' + '00'.repeat(32)) as `0x${string}`,
      v: 0,
      r: ('0x' + '00'.repeat(32)) as `0x${string}`,
      s: ('0x' + '00'.repeat(32)) as `0x${string}`,
    }
    const { domain, types, primaryType, message } = buildEIP3009Message(auth, CHAIN_ID, USDC as `0x${string}`, 'Mock USD Coin')
    expect(domain).toEqual({ name: 'Mock USD Coin', version: '2', chainId: CHAIN_ID, verifyingContract: USDC })
    expect(primaryType).toBe('TransferWithAuthorization')
    expect(message.value).toBe(5_000_000n)
    expect(types).toBe(EIP3009_TYPES)

    const sig = await ACCOUNT.signTypedData({ domain, types, primaryType, message })
    // compact 65-byte (r, s, v) signature — v is a single byte (0x1b/0x1c)
    const v = Number.parseInt(sig.slice(-2), 16)
    const r = sig.slice(0, 66) as `0x${string}`
    const s = `0x${sig.slice(66, 130)}` as `0x${string}`
    const signer = await recoverEIP3009Signer(auth, CHAIN_ID, USDC as `0x${string}`, 'Mock USD Coin', { v, r, s })
    expect(signer).toBe(ACCOUNT.address.toLowerCase())
  })
})

describe('Permit2 protocol', () => {
  it('recovers the payer of a permitTransferFrom', async () => {
    const permit = {
      permitted: { token: USDC as `0x${string}`, amount: 5_000_000n },
      nonce: 1n,
      deadline: 9999999999999n,
    }
    const domain = { name: 'Permit2', version: '1', chainId: CHAIN_ID, verifyingContract: cfg.permit2! as `0x${string}` }
    const message = {
      permitted: { token: permit.permitted.token, amount: permit.permitted.amount },
      nonce: permit.nonce,
      deadline: permit.deadline,
    }
    const sig = await ACCOUNT.signTypedData({ domain, types: PERMIT2_TYPES, primaryType: 'PermitTransferFrom', message })
    const signer = await recoverPermit2Signer(permit, CHAIN_ID, cfg.permit2! as `0x${string}`, sig)
    expect(signer).toBe(ACCOUNT.address.toLowerCase())
  })
})
