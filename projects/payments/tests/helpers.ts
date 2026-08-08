// Shared test fixtures for @0xinfrax/payments unit tests.
import { vi } from 'vitest'
import { PaymentsService } from '../src/service'
import type { PaymentStore } from '../src/store'

export function makeStore(): PaymentStore & {
  recordIntent: ReturnType<typeof vi.fn>
  updateIntentStatus: ReturnType<typeof vi.fn>
  emitEvent: ReturnType<typeof vi.fn>
} {
  return {
    balanceOf: vi.fn(async () => 0n),
    credit: vi.fn(async () => {}),
    isCreditRecorded: vi.fn(async () => false),
    deduct: vi.fn(async () => true),
    resolveAccess: vi.fn(async () => false),
    recordIntent: vi.fn(async () => {}),
    updateIntentStatus: vi.fn(async () => {}),
    emitEvent: vi.fn(async () => {}),
  }
}

export interface MakeServiceOptions {
  withStripe?: boolean
  withX402?: boolean
}

type ServiceOptions = ConstructorParameters<typeof PaymentsService>[0]

/** Real PaymentsService with a mock store and optional rails enabled. */
export function makeService(
  opts: MakeServiceOptions = {},
  overrides: Partial<ServiceOptions> = {}
): {
  store: ReturnType<typeof makeStore>
  payments: PaymentsService
} {
  const store = makeStore()
  const { withStripe = true, withX402 = true } = opts
  const payments = new PaymentsService({
    store,
    chains: {
      sepolia: { rpcUrl: 'http://127.0.0.1:8545', chainId: 11155111, subscriptionManager: '0x' + '11'.repeat(20) },
    },
    stripe: withStripe
      ? { secretKey: 'sk_test', webhookSecret: 'whsec_test', apiBase: 'http://mock.local/v1', tokenUsdPrice: 1 }
      : undefined,
    x402: withX402
      ? { enabled: true, payTo: '0x' + '22'.repeat(20), priceWei: '1000000000000000', chain: 'sepolia' }
      : undefined,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    ...overrides,
  })
  return { store, payments }
}

/** Stub the global fetch (used by StripeAdapter). */
export function stubFetch(response: any): void {
  vi.stubGlobal('fetch', vi.fn(async () => response))
}

/** A valid Stripe-like session returned by the mock provider. */
export const fakeStripeSession = (over: Record<string, unknown> = {}) => ({
  ok: true,
  json: async () => ({
    id: 'cs_1',
    url: 'https://mock.local/checkout/cs_1/sub_1/100',
    subscription: 'sub_1',
    amount_total: 100,
    currency: 'usd',
    client_reference_id: '0xuser|1|1',
    ...over,
  }),
})
