// ---------------------------------------------------------------------------
// InfraX Payments — standalone generic payment gateway (infrax-payments)
// DB: pocketx_payments | Port: 9132 (default) | shape: standalone-library
// Entry: tsx server.ts (CJS, run directly against TypeScript sources).
//
// Standalone deployment of @0xinfrax/payments as a microservice, aligned with
// the platform conventions: unified auth (Bearer / X-API-Key / X-Service-Key),
// per-service DB (pocketx_payments), chain reads via the chain-rpc gateway
// (DC-10) when CHAIN_RPC_READ_KEY is set, /health for observability.
// ---------------------------------------------------------------------------
import express from 'express'
import cors from 'cors'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Pool } from 'pg'
import { createAuthMiddleware } from '../shared/auth-express'
import { createPaymentsRouter } from './src/router'
import {
  PaymentsService,
  PgPaymentStore,
  PgMPPSessionStore,
  PgAuthorizationStore,
  createWebhookForwarder,
} from './src/index'

const logger = {
  info: (m: string) => console.log(`[infrax-payments] ${m}`),
  warn: (m: string) => console.warn(`[infrax-payments] ${m}`),
  error: (m: string) => console.error(`[infrax-payments] ${m}`),
}

const app = express()
app.use(cors({ origin: true, credentials: true }))
// Preserve the raw body for the Stripe webhook route (signature verified in-engine).
app.use(express.json({ verify: (req, _res, buf) => { (req as any).rawBody = buf } }))

// Unified platform auth (Bearer / X-API-Key / X-Service-Key). /health /metrics
// are exempt by default; the webhook route is exempt too (verified by signature
// inside the engine, so Stripe callbacks carry no platform key).
const authMw = createAuthMiddleware({
  envKeys: process.env.PAYMENTS_API_KEY,
  scope: 'payments',
  verifyUrl: process.env.DATA_URL,
  verifyKey: process.env.DATA_API_KEY,
  exempt: ['/payments/webhook'],
})
app.use(authMw)

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://ubuntu@localhost:5432/pocketx_payments',
  max: 10,
  idleTimeoutMillis: 30_000,
})

// ── Chain config (env-prefix driven; route via chain-rpc when a key is set) ──
const CHAIN_KEYS = ['oxachain', 'sepolia', 'polygon', 'base'] as const

function buildChains(): Record<string, { rpcUrl: string; chainId: number; subscriptionManager: string; rpcHeaders?: Record<string, string> }> {
  const chains: Record<string, { rpcUrl: string; chainId: number; subscriptionManager: string; rpcHeaders?: Record<string, string> }> = {}
  const gwKey = process.env.CHAIN_RPC_READ_KEY
  for (const key of CHAIN_KEYS) {
    const env = key.toUpperCase()
    const rpcUrl = process.env[`CHAIN_${env}_RPC_URL`]
    const chainId = Number(process.env[`CHAIN_${env}_CHAIN_ID`] ?? 0)
    const subscriptionManager = process.env[`CHAIN_${env}_SUBSCRIPTION_MANAGER`]
    if (rpcUrl && chainId && subscriptionManager) {
      chains[key] = {
        rpcUrl,
        chainId,
        subscriptionManager,
        rpcHeaders: gwKey ? { 'X-Service-Key': gwKey } : undefined,
      }
    }
  }
  if (Object.keys(chains).length === 0) {
    throw new Error(
      'No chain configured — set CHAIN_<NAME>_RPC_URL / CHAIN_<NAME>_CHAIN_ID / CHAIN_<NAME>_SUBSCRIPTION_MANAGER ' +
      '(optionally CHAIN_RPC_READ_KEY to route reads via the chain-rpc gateway)'
    )
  }
  return chains
}

// ── Event forwarding (standalone shape: business state lives on the host) ──
const forwarder = process.env.WEBHOOK_FORWARD_URL
  ? createWebhookForwarder({
      targetUrl: process.env.WEBHOOK_FORWARD_URL,
      secret: process.env.WEBHOOK_FORWARD_SECRET,
      logger,
    })
  : null

const chains = buildChains()

if (process.env.X402_ENABLED === 'true' && (!process.env.X402_PAY_TO || !process.env.X402_PRICE_WEI)) {
  throw new Error('X402_ENABLED=true requires X402_PAY_TO and X402_PRICE_WEI')
}

const payments = new PaymentsService({
  store: new PgPaymentStore(pool),
  mppStore: new PgMPPSessionStore(pool),
  authorizations: new PgAuthorizationStore(pool),
  chains,
  stripe: process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET
    ? { secretKey: process.env.STRIPE_SECRET_KEY, webhookSecret: process.env.STRIPE_WEBHOOK_SECRET }
    : undefined,
  x402: process.env.X402_ENABLED === 'true'
    ? {
        enabled: true,
        payTo: process.env.X402_PAY_TO as string,
        priceWei: process.env.X402_PRICE_WEI as string,
        chain: (process.env.X402_CHAIN ?? 'oxachain') as never,
      }
    : undefined,
  mpp: process.env.MPP_ENABLED === 'true'
    ? {
        enabled: true,
        domain: process.env.MPP_DOMAIN ?? '',
        payee: process.env.MPP_PAYEE ?? '',
        chain: (process.env.MPP_CHAIN ?? 'oxachain') as never,
        settleThresholdWei: process.env.MPP_SETTLE_THRESHOLD_WEI,
        settleIntervalSec: Number(process.env.MPP_SETTLE_INTERVAL_SEC ?? 0) || undefined,
      }
    : undefined,
  onWebhookEvent: forwarder?.onWebhookEvent,
  onCredit: forwarder?.onCredit,
  logger,
})

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'infrax-payments', uptime: process.uptime() }))
app.use('/payments', createPaymentsRouter(payments))

// ── Apply the module migrations (001-005) on boot (idempotent) ──
async function runMigrations(): Promise<void> {
  const dir = join(__dirname, 'db', 'migrations')
  const files = readdirSync(dir).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort()
  for (const file of files) {
    await pool.query(readFileSync(join(dir, file), 'utf8'))
  }
  logger.info(`migrations applied (${files.length})`)
}

const PORT = Number(process.env.PORT ?? 9132)

async function boot(): Promise<void> {
  try {
    await runMigrations()
    app.listen(PORT, () =>
      logger.info(`listening on :${PORT} (rails: stripe=${!!payments.stripe} x402=${!!payments.x402} mpp=${!!payments.mpp})`)
    )
  } catch (err) {
    logger.error(`boot failed: ${(err as Error).message}`)
    process.exit(1)
  }
}

boot()
