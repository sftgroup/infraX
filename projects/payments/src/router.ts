// ---------------------------------------------------------------------------
// @0xinfrax/payments — generic Express router (version-A deployments)
// ---------------------------------------------------------------------------
// A thin REST transport over PaymentsService for hosts that want a ready-made
// HTTP surface (mount under any prefix, e.g. app.use('/payments', router)).
//
// Routes:
//   GET  /info        x402 protocol discovery
//   GET  /price       on-chain plan pricing (getPlan)
//   POST /checkout    fiat checkout → Stripe session
//   POST /verify      verify an on-chain payment (x402 rail)
//   POST /webhook     Stripe webhook (signature verified in-engine)
//   GET  /balance     current ledger balance of an address
//   POST /access      unified access check (delegates to the injected store)
//
// The webhook route requires the raw body to be preserved by the host, e.g.:
//   app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf } }))
//
// express is an optional peer — importing this file (or the package root) does
// not require it; only calling createPaymentsRouter() does.
// ---------------------------------------------------------------------------

import { Router, Request, Response, NextFunction } from 'express'
import { PaymentsService } from './service'
import { isPaymentError } from './errors'
import type { ChainKey } from './types'

export function createPaymentsRouter(payments: PaymentsService): Router {
  const router = Router()

  // Uniform handler: PaymentError → its suggested status; anything else → next.
  const handle = async (
    work: () => Promise<unknown>,
    res: Response,
    next: NextFunction,
    onOk: (value: any) => void
  ): Promise<void> => {
    try {
      onOk(await work())
    } catch (err) {
      if (isPaymentError(err)) {
        res.status(err.status).json({ error: err.message })
        return
      }
      next(err)
    }
  }

  // GET /info — rails discovery (x402 + stablecoin + mpp)
  router.get('/info', (_req: Request, res: Response) => {
    const x = payments.x402
    const mpp = payments.mpp
    if (!x || !x.available()) {
      res.json({ enabled: false, mpp: mpp?.available() ? { enabled: true, payee: mpp.payeeOf(), chain: mpp.chain() } : { enabled: false } })
      return
    }
    res.json({
      enabled: true,
      priceWei: x.priceWei().toString(),
      payTo: x.payTo(),
      network: x.network(),
      chain: x.chain(),
      rails: {
        x402: x.available(),
        stablecoin: x.stablecoinAvailable(),
        period: Boolean(x.periodAsset()),
      },
      stablecoin: x.stablecoinAvailable()
        ? { enabled: true, asset: x.stablecoinAsset(), chain: x.chain() }
        : { enabled: false },
      mpp: mpp?.available() ? { enabled: true, payee: mpp.payeeOf(), chain: mpp.chain() } : { enabled: false },
    })
  })

  // GET /price?chain=&planId= — on-chain plan pricing
  router.get('/price', (req: Request, res: Response, next: NextFunction) => {
    const planId = Number(req.query.planId)
    if (!planId) {
      res.status(400).json({ error: 'planId is required' })
      return
    }
    const chain = (String(req.query.chain ?? 'oxachain')) as ChainKey
    handle(
      () => payments.chain.getPlan(chain, planId),
      res,
      next,
      (plan) =>
        res.json({
          planId: plan.planId,
          agentId: plan.agentId,
          price: plan.price.toString(),
          period: plan.period,
          active: plan.active,
          trialDays: plan.trialDays,
          payToken: plan.payToken,
        })
    )
  })

  // POST /checkout — fiat checkout
  // body: { subscriber, amountCents?, planId?, period?, currency?, chain?, metadata?, clientReference?, successUrl?, cancelUrl? }
  router.post('/checkout', (req: Request, res: Response, next: NextFunction) => {
    const { subscriber, amountCents, planId, period, currency, chain, metadata, clientReference, successUrl, cancelUrl } = req.body ?? {}
    handle(
      () =>
        payments.createPayment({
          method: 'fiat',
          subscriber,
          period,
          currency,
          chain,
          amountCents: amountCents !== undefined ? Number(amountCents) : undefined,
          pricing: planId ? { planId: Number(planId) } : undefined,
          metadata,
          clientReference,
          successUrl,
          cancelUrl,
        }),
      res,
      next,
      (result) =>
        res.json({
          method: 'fiat',
          paymentId: result.paymentId,
          sessionUrl: result.sessionUrl,
          sessionId: result.sessionId,
        })
    )
  })

  // POST /verify — verify an on-chain payment (x402 rail)
  // body: { txHash, chain? }
  router.post('/verify', (req: Request, res: Response, next: NextFunction) => {
    const { txHash, chain } = req.body ?? {}
    if (!txHash) {
      res.status(400).json({ error: 'txHash is required' })
      return
    }
    handle(
      () => payments.verifyPayment(String(txHash), chain),
      res,
      next,
      (verified) => {
        if (!verified) {
          res.status(422).json({ error: 'Transaction is not a valid payment to the platform wallet' })
          return
        }
        res.json({
          verified: true,
          reference: verified.reference,
          payer: verified.payer,
          creditedWei: verified.creditedWei.toString(),
          asset: verified.asset,
          chain: verified.chain,
        })
      }
    )
  })

  // POST /webhook — Stripe webhook (requires host-preserved rawBody)
  router.post('/webhook', (req: Request, res: Response, next: NextFunction) => {
    const signature = req.headers['stripe-signature']
    const rawBody: Buffer | undefined = (req as any).rawBody
    if (!signature || !rawBody) {
      res.status(400).json({ error: 'Missing stripe-signature or rawBody — mount express.json with a verify() that stores req.rawBody' })
      return
    }
    handle(
      () => payments.handleWebhook(rawBody.toString(), String(signature)),
      res,
      next,
      () => res.json({ received: true })
    )
  })

  // GET /balance?address=&asset= — ledger balance
  router.get('/balance', (req: Request, res: Response, next: NextFunction) => {
    const address = String(req.query.address ?? '')
    if (!address) {
      res.status(400).json({ error: 'address is required' })
      return
    }
    handle(
      () => payments.balanceOf(address, req.query.asset !== undefined ? String(req.query.asset) : undefined),
      res,
      next,
      (balance) => res.json({ address, balanceWei: balance.toString() })
    )
  })

  // POST /access — unified access check
  // body: { subscriber, resource, chain? }
  router.post('/access', (req: Request, res: Response, next: NextFunction) => {
    const { subscriber, resource, chain } = req.body ?? {}
    if (!subscriber || resource === undefined) {
      res.status(400).json({ error: 'subscriber and resource are required' })
      return
    }
    handle(
      () => payments.resolveAccess(subscriber, resource, chain ? { chain } : undefined),
      res,
      next,
      (active) => res.json({ active })
    )
  })

  // ── MPP payment channels ──────────────────────────────────────────────────

  // POST /mpp/open — open a channel (verify the deposit tx)
  // body: { payer, depositWei, salt, txHash, chain?, metadata? }
  router.post('/mpp/open', (req: Request, res: Response, next: NextFunction) => {
    const { payer, depositWei, salt, txHash, chain, metadata } = req.body ?? {}
    if (!payer || !depositWei || !salt || !txHash) {
      res.status(400).json({ error: 'payer, depositWei, salt and txHash are required' })
      return
    }
    handle(
      () =>
        payments.createPayment({
          method: 'mpp',
          subscriber: String(payer),
          valueWei: String(depositWei),
          salt: String(salt),
          txHash: String(txHash),
          chain,
          metadata,
        }),
      res,
      next,
      (result) => res.json({ method: 'mpp', channelId: result.channelId, depositWei: result.depositWei, payee: result.payee })
    )
  })

  // POST /mpp/voucher — submit a cumulative voucher
  // body: { channelId, cumulativeAmount, signature }
  router.post('/mpp/voucher', (req: Request, res: Response, next: NextFunction) => {
    const { channelId, cumulativeAmount, signature } = req.body ?? {}
    if (!channelId || !cumulativeAmount || !signature) {
      res.status(400).json({ error: 'channelId, cumulativeAmount and signature are required' })
      return
    }
    handle(
      () => payments.mppVoucher({ channelId: String(channelId), cumulativeAmount: String(cumulativeAmount), signature: String(signature) }),
      res,
      next,
      (result) => res.json(result)
    )
  })

  // POST /mpp/topup — top up a channel
  // body: { channelId, txHash, additionalWei }
  router.post('/mpp/topup', (req: Request, res: Response, next: NextFunction) => {
    const { channelId, txHash, additionalWei } = req.body ?? {}
    if (!channelId || !txHash || !additionalWei) {
      res.status(400).json({ error: 'channelId, txHash and additionalWei are required' })
      return
    }
    handle(
      () => payments.mppTopUp({ channelId: String(channelId), txHash: String(txHash), additionalWei: String(additionalWei) }),
      res,
      next,
      (result) => res.json(result)
    )
  })

  // POST /mpp/settle — batch-deduct un-settled consumption
  router.post('/mpp/settle', (req: Request, res: Response, next: NextFunction) => {
    const channelId = String(req.body?.channelId ?? '')
    if (!channelId) {
      res.status(400).json({ error: 'channelId is required' })
      return
    }
    handle(
      () => payments.mppSettle(channelId),
      res,
      next,
      (result) => res.json(result)
    )
  })

  // POST /mpp/close — close a channel (settles the tail first)
  router.post('/mpp/close', (req: Request, res: Response, next: NextFunction) => {
    const channelId = String(req.body?.channelId ?? '')
    if (!channelId) {
      res.status(400).json({ error: 'channelId is required' })
      return
    }
    handle(
      () => payments.mppClose(channelId),
      res,
      next,
      (result) => res.json(result)
    )
  })

  // GET /mpp/session?channelId= — current channel state
  router.get('/mpp/session', (req: Request, res: Response, next: NextFunction) => {
    const channelId = String(req.query.channelId ?? '')
    if (!channelId) {
      res.status(400).json({ error: 'channelId is required' })
      return
    }
    handle(
      () => payments.mppSession(channelId),
      res,
      next,
      (session) => {
        if (!session) {
          res.status(404).json({ error: 'MPP session not found' })
          return
        }
        res.json({ channelId: session.channelId, status: session.status, currentCum: session.currentCum, spentWei: session.spentWei, depositWei: session.depositWei })
      }
    )
  })

  // ── a2a-pay (paymentId two-phase) ─────────────────────────────────────────

  // POST /a2a — phase 1: create a payment intent
  // body: { payer, amountWei, payee?, chain?, metadata? }
  router.post('/a2a', (req: Request, res: Response, next: NextFunction) => {
    const { payer, amountWei, payee, chain, metadata } = req.body ?? {}
    if (!payer || !amountWei) {
      res.status(400).json({ error: 'payer and amountWei are required' })
      return
    }
    handle(
      () =>
        payments.createPayment({
          method: 'a2a',
          subscriber: String(payer),
          valueWei: String(amountWei),
          payee: payee ? String(payee) : undefined,
          chain,
          metadata,
        }),
      res,
      next,
      (result) => res.json({ method: 'a2a', paymentId: result.paymentId, amountWei: result.amountWei, payee: result.payee })
    )
  })

  // POST /a2a/settle — phase 2: verify the payer's on-chain payment tx
  // body: { paymentId, txHash, chain? }
  router.post('/a2a/settle', (req: Request, res: Response, next: NextFunction) => {
    const { paymentId, txHash, chain } = req.body ?? {}
    if (!paymentId || !txHash) {
      res.status(400).json({ error: 'paymentId and txHash are required' })
      return
    }
    handle(
      () => payments.a2aSettle({ paymentId: String(paymentId), txHash: String(txHash), chain }),
      res,
      next,
      async (verified) => {
        if (!verified) {
          res.status(422).json({ error: 'Transaction is not a valid payment to the platform wallet' })
          return
        }
        const balance = await payments.balanceOf(verified.payer)
        res.json({ verified: true, paymentId: String(paymentId), payer: verified.payer, creditedWei: verified.creditedWei, balanceWei: balance.toString() })
      }
    )
  })

  // ── Period authorizations (P4) ────────────────────────────────────────────

  // POST /period/charge — charge one period of an authorization
  // body: { authorizationId }
  router.post('/period/charge', (req: Request, res: Response, next: NextFunction) => {
    const authorizationId = String(req.body?.authorizationId ?? '')
    if (!authorizationId) {
      res.status(400).json({ error: 'authorizationId is required' })
      return
    }
    handle(
      () => payments.chargePeriod(authorizationId),
      res,
      next,
      (result) => res.json({ authorizationId, ...result })
    )
  })

  // GET /period/authorization?authorizationId= — authorization state
  router.get('/period/authorization', (req: Request, res: Response, next: NextFunction) => {
    const authorizationId = String(req.query.authorizationId ?? '')
    if (!authorizationId) {
      res.status(400).json({ error: 'authorizationId is required' })
      return
    }
    handle(
      () => payments.getAuthorization(authorizationId),
      res,
      next,
      (auth) => {
        if (!auth) {
          res.status(404).json({ error: 'Authorization not found' })
          return
        }
        res.json({ id: auth.id, owner: auth.owner, amountWei: auth.amountWei, remainingWei: auth.remainingWei, periods: auth.periods, status: auth.status })
      }
    )
  })

  return router
}
