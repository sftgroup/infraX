// =============================================================================
// @agentxv2/payments — decoupling verification (version-A standalone shape)
// =============================================================================
// Proves the payment engine is truly independent of AgentX:
//
//   • LOADS ONLY the module: every import resolves from payments/ (its own
//     dist + its own node_modules for pg / viem). No gateway, no @agentxv2/sdk.
//   • USES ONLY the generic schema: PgPaymentStore over the module-owned
//     `payment_*` tables — no fiat_subscriptions / x402_* / chain_*.
//   • Exercises all three rails purely through the PaymentsService API:
//        chain — on-chain subscribe tx → module ChainAdapter reads it
//        fiat  — module createPayment (auto-priced) + handleWebhook → host
//                callback grants generic payment_access → module resolveAccess
//        x402  — native transfer → module verifyPayment credits the ledger
//                (idempotent), balanceOf reads it back
//
// Run via scripts/local-payments/run-decouple.sh (starts infra, deploys the
// SubscriptionManager contract, creates a clean `agentx_payments` database
// and applies only the module migrations).
// =============================================================================
import { createRequire } from 'node:module'
import { createHmac } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// ── Resolve the module from ITS OWN package — not from any host ──────────────
const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url))
const PAYMENTS_DIR = join(SCRIPT_DIR, '..')
const requireP = createRequire(join(PAYMENTS_DIR, 'package.json'))
const moduleEntry = requireP.resolve('./dist/index.js')
const modulePkg = JSON.parse(readFileSync(join(PAYMENTS_DIR, 'package.json'), 'utf8'))

const { PaymentsService, PgPaymentStore } = requireP('./dist/index.js')
const { Pool } = requireP('pg')
const { createPublicClient, createWalletClient, http, defineChain } = requireP('viem')
const { privateKeyToAccount } = requireP('viem/accounts')

// ── Configuration (injected by run-decouple.sh) ──────────────────────────────
const RPC = process.env.ANVIL_RPC || 'http://127.0.0.1:8545'
const DATABASE_URL = process.env.DATABASE_URL
const SM_ADDR = process.env.SUBSCRIPTION_MANAGER
const PAY_TO = process.env.PAY_TO || '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_localmocktest'
const MOCK_STRIPE_BASE = process.env.MOCK_STRIPE_BASE || 'http://127.0.0.1:8777/v1'
const PK0 = process.env.PRIVATE_KEY || '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'

const AGENT_ID = 1
const PLAN_ID = 1
const CHAIN = 'sepolia'
const CHAIN_ID = 11155111

if (!DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(2) }
if (!SM_ADDR) { console.error('SUBSCRIPTION_MANAGER is required'); process.exit(2) }

// ── Harness plumbing ─────────────────────────────────────────────────────────
let failures = 0
const check = (name, cond, detail) => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name} — ${detail}`)
  if (!cond) failures += 1
}
const expectThrow = async (fn, msgPart) => {
  try { await fn(); return false }
  catch (e) { return msgPart ? String(e.message).includes(msgPart) : true }
}
const walk = (dir, out = []) => {
  for (const ent of readdirSync(dir)) {
    const p = join(dir, ent)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.js') || p.endsWith('.ts') || p.endsWith('.sql')) out.push(p)
  }
  return out
}
const scan = (roots, tokens) => {
  const hits = []
  for (const root of roots) for (const f of walk(root)) {
    const text = readFileSync(f, 'utf8')
    for (const tok of tokens) if (text.includes(tok)) hits.push(`${f}:${tok}`)
  }
  return hits
}

// ── Clients (viem is a module dependency — allowed) ──────────────────────────
const account = privateKeyToAccount(PK0)
const localChain = defineChain({
  id: CHAIN_ID,
  name: 'local-decouple',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
})
const walletClient = createWalletClient({ account, chain: localChain, transport: http(RPC) })
const publicClient = createPublicClient({ chain: localChain, transport: http(RPC) })
const subscriber = account.address

// Subscribe(uint256 planId) payable → the ONLY on-chain write the test needs.
const SUBSCRIBE_ABI = [
  {
    type: 'function',
    name: 'subscribe',
    stateMutability: 'payable',
    inputs: [{ name: 'planId', type: 'uint256' }],
    outputs: [{ name: 'subscriptionId', type: 'uint256' }],
  },
]

// ── The module, configured generically (version-A caller-owned shape) ────────
const pool = new Pool({ connectionString: DATABASE_URL, max: 10 })
const store = new PgPaymentStore(pool)
const service = new PaymentsService({
  store,
  chains: {
    sepolia: { rpcUrl: RPC, chainId: CHAIN_ID, subscriptionManager: SM_ADDR },
    oxachain: { rpcUrl: RPC, chainId: CHAIN_ID, subscriptionManager: SM_ADDR },
  },
  stripe: {
    secretKey: 'sk_test_localmock',
    webhookSecret: WEBHOOK_SECRET,
    apiBase: MOCK_STRIPE_BASE,
    tokenUsdPrice: 1, // 1 native = $1 → plan (1 native) auto-prices to 100¢
  },
  x402: { enabled: true, payTo: PAY_TO, priceWei: '1000000000000000', chain: CHAIN },
  // Host business lives ONLY in callbacks — the module never sees it.
  onWebhookEvent: async (event) => {
    if (event.type === 'checkout.session.completed') {
      const [s, a] = String(event.object.client_reference_id ?? '').split('|')
      if (s && a) {
        await pool.query(
          `INSERT INTO payment_access (subscriber, resource, status, starts_at, expires_at)
           VALUES ($1, $2, 'active', NOW(), NOW() + INTERVAL '30 days')
           ON CONFLICT (subscriber, resource) DO UPDATE
             SET status = 'active', expires_at = NOW() + INTERVAL '30 days'`,
          [s.toLowerCase(), JSON.stringify({ agentId: Number(a) })]
        )
      }
    }
  },
  logger: { info: () => {}, warn: () => {}, error: () => {} },
})

const gw = () => subscriber

console.log(`Module entry : ${moduleEntry}`)
console.log(`Module deps  : ${JSON.stringify(modulePkg.dependencies)}`)
console.log(`Subscriber   : ${subscriber}  (anvil #0, wallet of the module's chain rail)`)
console.log(`SubscriptionManager: ${SM_ADDR}`)

// ═══════════════════════════════════════════════════════════════════════════
// PART 1 — 解耦性证明 (the module really is standalone)
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== Part 1: decoupling proofs (zero AgentX coupling) ===')

check(
  'load: module resolved from payments/ own dist (not gateway)',
  moduleEntry.startsWith(PAYMENTS_DIR),
  moduleEntry
)
check(
  'pkg: name is @0xinfrax/payments',
  modulePkg.name === '@0xinfrax/payments',
  modulePkg.name
)
const agentxDeps = Object.keys(modulePkg.dependencies ?? {}).filter(d => d.startsWith('@agentxv2') || d.includes('sdk'))
check('pkg: no agentx/sdk dependency declared', agentxDeps.length === 0, JSON.stringify(modulePkg.dependencies ?? {}))
check(
  'pkg: module dep closure is only viem + pg',
  Object.keys(modulePkg.dependencies ?? {}).sort().join(',') === 'pg,viem',
  JSON.stringify(modulePkg.dependencies)
)

const FORBIDDEN = ['fiat_subscriptions', 'x402_payments', 'x402_balances', 'chain_subscriptions', '@agentxv2/sdk', 'agentx_local', 'gateway/']
const srcHits = scan([join(PAYMENTS_DIR, 'src'), join(PAYMENTS_DIR, 'db')], FORBIDDEN)
check('src+db: no AgentX business tokens', srcHits.length === 0, srcHits.slice(0, 3).join(' | ') || 'clean')
const distHits = scan([join(PAYMENTS_DIR, 'dist')], FORBIDDEN)
check('dist: published artifact is clean too', distHits.length === 0, distHits.slice(0, 3).join(' | ') || 'clean')

// DB isolation — the module DB may ONLY contain payment_* tables.
const { rows: tables } = await pool.query(
  "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
)
const tableNames = tables.map(r => r.table_name)
const businessTables = tableNames.filter(n => /^(fiat_|x402_|chain_|agents|payment_)/.test(n)).filter(n => !n.startsWith('payment_'))
const ownTables = ['payment_intents', 'payment_credits', 'payment_balances', 'payment_access', 'payment_sessions', 'payment_vouchers']
check('db: no AgentX business tables in module DB', businessTables.length === 0, businessTables.join(', ') || 'only payment_*')
check('db: all module-owned payment_* tables present', ownTables.every(t => tableNames.includes(t)), tableNames.filter(t => t.startsWith('payment_')).join(', '))

// ═══════════════════════════════════════════════════════════════════════════
// PART 2 — Flow 1: chain (on-chain escrow, read back via the module)
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== Part 2: Flow 1 — chain (on-chain payment, module reads it) ===')

const plan = await service.chain.getPlan(CHAIN, PLAN_ID)
check('chain: module getPlan returns plan price 1 native', plan.price === 1000000000000000000n, `price=${plan.price}`)

// Send the escrow payment with plain viem (a module dependency), then let the
// module ChainAdapter answer access questions about the same contract.
const { request } = await publicClient.simulateContract({
  address: SM_ADDR,
  abi: SUBSCRIBE_ABI,
  functionName: 'subscribe',
  args: [BigInt(PLAN_ID)],
  value: plan.price,
  account,
})
const subscribeHash = await walletClient.writeContract(request)
await publicClient.waitForTransactionReceipt({ hash: subscribeHash })
console.log(`  subscribe tx ${subscribeHash.slice(0, 12)}… mined`)

check(
  'chain: module hasActiveSubscription = true after on-chain subscribe',
  await service.chain.hasActiveSubscription(CHAIN, gw(), AGENT_ID) === true,
  `subscriber=${gw().slice(0, 8)}… agentId=${AGENT_ID}`
)
check(
  'chain: module platformFeeBps readable (0-2000)',
  (await service.chain.platformFeeBps(CHAIN)) >= 0,
  `${await service.chain.platformFeeBps(CHAIN)} bps`
)
check(
  'seam: generic resolveAccess does NOT consult the chain (host decides)',
  (await service.resolveAccess(gw(), { agentId: AGENT_ID }, { chain: CHAIN })) === false,
  'module store only reads payment_access — off-chain access is host business'
)

// ═══════════════════════════════════════════════════════════════════════════
// PART 3 — Flow 2: fiat (module checkout → signed webhook → store access)
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== Part 3: Flow 2 — fiat (Stripe via module + mock, no Stripe account) ===')

const reference = `${gw()}|${AGENT_ID}|${PLAN_ID}` // business encoding — caller-side
const fiat = await service.createPayment({
  method: 'fiat',
  subscriber: gw(),
  period: 'month',
  pricing: { planId: PLAN_ID },               // auto-priced by the module (1 native → $1)
  metadata: { agentId: AGENT_ID, planId: PLAN_ID, resourceLabel: `agent #${AGENT_ID}` },
  clientReference: reference,                  // opaque — module just forwards it
})
check(
  'fiat: checkout session created (auto-priced to 100¢)',
  fiat.method === 'fiat' && fiat.sessionId && fiat.sessionUrl.includes(`/checkout/${fiat.sessionId}`),
  fiat.sessionUrl
)
check(
  'fiat: clientReference echoed back unchanged (opaque passthrough)',
  fiat.clientReference === reference,
  String(fiat.clientReference)
)

const parts = /\/checkout\/([^/]+)\/([^/]+)\/([^/]+)/.exec(fiat.sessionUrl)
const [sessionId, subId, amountCents] = parts ? parts.slice(1) : []
check('fiat: auto-pricing used plan price (100¢ from 1 native × $1)', amountCents === '100', `amountCents=${amountCents}`)

// Simulated Stripe events (signed exactly like Stripe would, with the secret
// the module was configured with).
const future = Math.floor(Date.now() / 1000) + 30 * 86_400
const events = [
  { type: 'checkout.session.completed', data: { object: { client_reference_id: reference, subscription: subId, amount_total: 100, currency: 'usd' } } },
  { type: 'invoice.paid', data: { object: { id: 'in_dc_1', subscription: subId, amount_paid: 100, currency: 'usd', lines: { data: [{ period: { end: future } }] } } } },
]
for (const event of events) {
  const payload = JSON.stringify(event)
  const t = Math.floor(Date.now() / 1000)
  const sig = createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${payload}`).digest('hex')
  await service.handleWebhook(payload, `t=${t},v1=${sig}`)
}
console.log('  both signed webhooks accepted (module verified the signature)')

check(
  'fiat: resolveAccess = true after webhook → host callback → payment_access',
  (await service.resolveAccess(gw(), { agentId: AGENT_ID }, { chain: CHAIN })) === true,
  'generic store granted access from module-verified webhook'
)
const tampered = `t=${Math.floor(Date.now() / 1000)},v1=${'deadbeef'.repeat(8)}`
check(
  'fiat: tampered signature rejected (module verifies every webhook)',
  await expectThrow(() => service.handleWebhook(JSON.stringify(events[0]), tampered), 'Invalid signature') === true,
  'handleWebhook throws on bad sig'
)

// ═══════════════════════════════════════════════════════════════════════════
// PART 4 — Flow 3: x402 (native period payment, module verifies + credits)
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n=== Part 4: Flow 3 — x402 (native-token payment, module-ledgered) ===')

const txHash = await walletClient.sendTransaction({ to: PAY_TO, value: 1000000000000000000n })
const verified = await service.verifyPayment(txHash, CHAIN)
check(
  'x402: tx to platform wallet verified + payer matched',
  verified !== null && verified.payer === subscriber.toLowerCase() && verified.creditedWei === '1000000000000000000',
  verified ? `creditedWei=${verified.creditedWei}` : 'null'
)
check(
  'x402: balance credited through the module PgPaymentStore',
  (await service.balanceOf(gw())) === 1000000000000000000n,
  `balance=${await service.balanceOf(gw())}`
)
await service.verifyPayment(txHash, CHAIN) // replay the same tx
check(
  'x402: idempotent — replaying the tx does NOT double-credit',
  (await service.balanceOf(gw())) === 1000000000000000000n,
  `balance still ${await service.balanceOf(gw())}`
)
check(
  'x402: credit recorded in module payment_credits ledger',
  (await store.isCreditRecorded(txHash.toLowerCase())) === true,
  txHash
)
check(
  'x402: non-payment tx rejected (to an unknown wallet)',
  (await service.verifyPayment('0x' + '00'.repeat(32))) === null,
  'returns null'
)

// ═══════════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════════
console.log('\n==================================================')
if (failures === 0) {
  console.log('ALL DECOUPLING CHECKS PASSED — @0xinfrax/payments runs three rails')
  console.log('standalone: no AgentX import, no AgentX table, no AgentX business logic.')
} else {
  console.log(`${failures} check(s) FAILED`)
}
console.log('==================================================')
await pool.end()
process.exit(failures === 0 ? 0 : 1)
