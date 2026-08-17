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
//   GET  /orders      payment intent audit trail (admin/ops read-back)
//   POST /access      unified access check (delegates to the injected store)
//   GET  /capabilities pluggable rail discovery
//   POST /a2a         two-phase a2a intent (phase 1)
//   POST /a2a/settle  a2a settle (phase 2: verify the on-chain tx)
//   POST /period/charge    charge one period of an authorization
//   GET  /period/authorization authorization state
//   POST /batch        one-shot multi-payee collection intent
//   POST /batch/settle settle one batch item (a2a tx verify)
//   GET  /batch        batch state
//   POST /batch/cancel cancel a batch
//
// Rail endpoints are mounted dynamically from the service capability map:
// when a capability is off, its endpoints still exist but answer 503 so
// callers get an explicit "not enabled" instead of a bare 404.
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

  // Capability guard: endpoints of disabled rails answer 503 (explicit
  // "not enabled" instead of a bare 404 / confusing internal error).
  const cap = (enabled: boolean, handler: (req: Request, res: Response, next: NextFunction) => void) => {
    if (!enabled) {
      return (_req: Request, res: Response) =>
        res.status(503).json({ error: 'Capability not enabled for this deployment' })
    }
    return handler
  }

  // Snapshot of the capability map — router mounts endpoints from it.
  const caps = payments.capabilities()

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

  // GET /chain-info/:chain — chain slot metadata (chainId + SubscriptionManager)
  // for hosts that drive the on-chain subscribe flow directly from the frontend.
  router.get('/chain-info/:chain', (req: Request, res: Response, next: NextFunction) => {
    const chain = String(req.params.chain) as ChainKey
    handle(
      () => Promise.resolve(payments.chain.chainConfigOf(chain)),
      res,
      next,
      (info) => res.json({ chain, chainId: info.chainId, subscriptionManager: info.subscriptionManager, nativeAsset: payments.chain.nativeAsset() })
    )
  })

  // GET /subscription/:chain/:subscriber/:resourceId — on-chain subscription status
  // (SubscriptionManager.hasActiveSubscription). Read rail; used by hosts to
  // confirm an escrow subscription has been paid and activate their business state.
  router.get('/subscription/:chain/:subscriber/:resourceId', (req: Request, res: Response, next: NextFunction) => {
    const chain = String(req.params.chain) as ChainKey
    const subscriber = String(req.params.subscriber ?? '').toLowerCase()
    const resourceId = Number(req.params.resourceId)
    if (!subscriber || !resourceId) {
      res.status(400).json({ error: 'subscriber and resourceId are required' })
      return
    }
    handle(
      () => payments.chain.hasActiveSubscription(chain, subscriber, resourceId),
      res,
      next,
      (active) => res.json({ active })
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

  // GET /orders — payment intent audit trail (admin/ops read-back)
  // query: limit, offset, status, subscriber — newest first
  router.get('/orders', (req: Request, res: Response, next: NextFunction) => {
    const { limit, offset, status, subscriber } = req.query
    handle(
      () =>
        payments.listIntents({
          limit: limit !== undefined ? Number(limit) : undefined,
          offset: offset !== undefined ? Number(offset) : undefined,
          status: status !== undefined ? String(status) : undefined,
          subscriber: subscriber !== undefined ? String(subscriber) : undefined,
        }),
      res,
      next,
      (orders) => res.json({ orders })
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

  // ── Capabilities (pluggable rail discovery) ──────────────────────────────

  // GET /capabilities — which rails are enabled and their endpoints
  router.get('/capabilities', (_req: Request, res: Response) => {
    res.json({ capabilities: caps })
  })

  // ── a2a rail (paymentId two-phase) ───────────────────────────────────────

  // POST /a2a — phase 1: create an a2a payment intent
  // body: { subscriber, valueWei, payee?, asset?, chain?, metadata? }
  router.post('/a2a', cap(caps.a2a?.enabled ?? false, (req: Request, res: Response, next: NextFunction) => {
    const { subscriber, valueWei, payee, asset, chain, metadata } = req.body ?? {}
    if (!subscriber || !valueWei) {
      res.status(400).json({ error: 'subscriber and valueWei are required' })
      return
    }
    handle(
      () => payments.createPayment({ method: 'a2a', subscriber: String(subscriber), valueWei: String(valueWei), payee, asset, chain, metadata }),
      res,
      next,
      (result) => res.json({ method: 'a2a', paymentId: result.paymentId, amountWei: result.amountWei, payee: result.payee })
    )
  }))

  // POST /a2a/settle — phase 2: verify the payer's on-chain payment tx
  // body: { paymentId, txHash?, chain?, mode? ('tx' default | 'balance'), subscriber?, amountWei?, asset?, ref? }
  //   mode 'tx'      → txHash required; verifies + credits the on-chain payment
  //   mode 'balance' → deducts from the payer's ledger balance (AX-8/A2A-1)
  router.post('/a2a/settle', cap(caps.a2a?.enabled ?? false, (req: Request, res: Response, next: NextFunction) => {
    const { paymentId, txHash, chain, mode, subscriber, amountWei, asset, ref } = req.body ?? {}
    if (!paymentId) {
      res.status(400).json({ error: 'paymentId is required' })
      return
    }
    if ((mode ?? 'tx') !== 'balance' && !txHash) {
      res.status(400).json({ error: 'tx mode requires txHash (or pass mode: "balance" for a balance settle)' })
      return
    }
    handle(
      () => payments.a2aSettle({ paymentId: String(paymentId), txHash: txHash ? String(txHash) : undefined, chain, mode, subscriber, amountWei, asset, ref }),
      res,
      next,
      (verified) => {
        if (!verified) {
          res.status(422).json({ error: 'Transaction is not a valid payment to the platform wallet' })
          return
        }
        res.json({
          settled: true,
          paymentId: String(paymentId),
          reference: verified.reference,
          payer: verified.payer,
          creditedWei: verified.creditedWei.toString(),
          asset: verified.asset,
          chain: verified.chain,
        })
      }
    )
  }))

  // ── Period authorizations (subscription billing) ─────────────────────────

  // POST /period/charge — charge one period of an authorization
  // body: { authorizationId }
  router.post('/period/charge', cap(caps.period?.enabled ?? false, (req: Request, res: Response, next: NextFunction) => {
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
  }))

  // GET /period/authorization?authorizationId= — authorization state
  router.get('/period/authorization', cap(caps.period?.enabled ?? false, (req: Request, res: Response, next: NextFunction) => {
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
        res.json({ id: auth.id, owner: auth.owner, asset: auth.asset, chain: auth.chain, amountWei: auth.amountWei, remainingWei: auth.remainingWei, periods: auth.periods, status: auth.status })
      }
    )
  }))

  // ── Batch rail (one-shot multi-payee collection) ─────────────────────────

  // POST /batch — create a batch of a2a intents
  // body: { subscriber, items: [{ payee, amountWei, asset?, metadata? }], chain?, metadata? }
  router.post('/batch', cap(caps.batch?.enabled ?? false, (req: Request, res: Response, next: NextFunction) => {
    const { subscriber, items, chain, metadata } = req.body ?? {}
    if (!subscriber || !Array.isArray(items) || !items.length) {
      res.status(400).json({ error: 'subscriber and items (non-empty array) are required' })
      return
    }
    handle(
      () => payments.createPayment({ method: 'batch', subscriber: String(subscriber), items, chain, metadata }),
      res,
      next,
      (result) => res.json({ method: 'batch', batchId: result.batchId, items: result.items })
    )
  }))

  // POST /batch/settle — settle one item of a batch (verify its on-chain tx)
  // body: { batchId, itemId, txHash, chain? }
  router.post('/batch/settle', cap(caps.batch?.enabled ?? false, (req: Request, res: Response, next: NextFunction) => {
    const { batchId, itemId, txHash, chain } = req.body ?? {}
    if (!batchId || !itemId || !txHash) {
      res.status(400).json({ error: 'batchId, itemId and txHash are required' })
      return
    }
    handle(
      () => payments.settleBatchItem({ batchId: String(batchId), itemId: String(itemId), txHash: String(txHash), chain }),
      res,
      next,
      (verified) => {
        if (!verified) {
          res.status(422).json({ error: 'Transaction is not a valid payment to the platform wallet' })
          return
        }
        res.json({
          settled: true,
          batchId: String(batchId),
          itemId: String(itemId),
          reference: verified.reference,
          payer: verified.payer,
          creditedWei: verified.creditedWei.toString(),
        })
      }
    )
  }))

  // GET /batch?batchId= — batch state
  router.get('/batch', cap(caps.batch?.enabled ?? false, (req: Request, res: Response, next: NextFunction) => {
    const batchId = String(req.query.batchId ?? '')
    if (!batchId) {
      res.status(400).json({ error: 'batchId is required' })
      return
    }
    handle(
      () => payments.getBatch(batchId),
      res,
      next,
      (batch) => {
        if (!batch) {
          res.status(404).json({ error: 'Batch not found' })
          return
        }
        res.json({ batchId: batch.batchId, payer: batch.payer, chain: batch.chain, status: batch.status, items: batch.items })
      }
    )
  }))

  // POST /batch/cancel — cancel a batch (items that were never paid)
  // body: { batchId }
  router.post('/batch/cancel', cap(caps.batch?.enabled ?? false, (req: Request, res: Response, next: NextFunction) => {
    const batchId = String(req.body?.batchId ?? '')
    if (!batchId) {
      res.status(400).json({ error: 'batchId is required' })
      return
    }
    handle(
      () => payments.cancelBatch(batchId),
      res,
      next,
      () => res.json({ cancelled: true, batchId })
    )
  }))

  // ── Invites (billing invitations) ────────────────────────────────────────

  // POST /invites — create a billing invitation
  // body: { payer, payee, valueWei, asset?, chain?, dueAt?, memo?, metadata? }
  router.post('/invites', cap(caps.invite?.enabled ?? false, (req: Request, res: Response, next: NextFunction) => {
    const { payer, payee, valueWei, asset, chain, dueAt, memo, metadata } = req.body ?? {}
    if (!payer || !payee || !valueWei) {
      res.status(400).json({ error: 'payer, payee and valueWei are required' })
      return
    }
    handle(
      () => payments.createInvite({ payer: String(payer), payee: String(payee), valueWei: String(valueWei), asset, chain, dueAt, memo, metadata }),
      res,
      next,
      (invite) => res.json({ inviteId: invite.inviteId, paymentId: invite.paymentId, amountWei: invite.amountWei, payee: invite.payee, dueAt: invite.dueAt })
    )
  }))

  // GET /invites?address=&role=payer|payee&status= — list invitations
  router.get('/invites', cap(caps.invite?.enabled ?? false, (req: Request, res: Response, next: NextFunction) => {
    const address = String(req.query.address ?? '')
    const role = String(req.query.role ?? '')
    if (!address || !['payer', 'payee'].includes(role)) {
      res.status(400).json({ error: 'address and role (payer|payee) are required' })
      return
    }
    handle(
      () => payments.listInvites(address, role as 'payer' | 'payee', req.query.status !== undefined ? String(req.query.status) as never : undefined),
      res,
      next,
      (invites) => res.json({ invites })
    )
  }))

  // GET /invites/:inviteId — one invite
  router.get('/invites/:inviteId', cap(caps.invite?.enabled ?? false, (req: Request, res: Response, next: NextFunction) => {
    handle(
      () => payments.getInvite(String(req.params.inviteId)),
      res,
      next,
      (invite) => {
        if (!invite) {
          res.status(404).json({ error: 'Invite not found' })
          return
        }
        res.json({ inviteId: invite.inviteId, paymentId: invite.paymentId, payer: invite.payer, payee: invite.payee, amountWei: invite.amountWei, memo: invite.memo, dueAt: invite.dueAt, status: invite.status, settledMethod: invite.settledMethod, settledRef: invite.settledRef })
      }
    )
  }))

  // POST /invites/:inviteId/cancel — cancel an open invite
  router.post('/invites/:inviteId/cancel', cap(caps.invite?.enabled ?? false, (req: Request, res: Response, next: NextFunction) => {
    handle(
      () => payments.cancelInvite(String(req.params.inviteId)),
      res,
      next,
      (result) => res.json({ inviteId: String(req.params.inviteId), cancelled: result.cancelled })
    )
  }))

  // POST /invites/:inviteId/settle — settle on-chain (verify the payer's tx)
  // body: { txHash, chain? }
  router.post('/invites/:inviteId/settle', cap(caps.invite?.enabled ?? false, (req: Request, res: Response, next: NextFunction) => {
    const { txHash, chain } = req.body ?? {}
    if (!txHash) {
      res.status(400).json({ error: 'txHash is required' })
      return
    }
    handle(
      () => payments.settleInvite(String(req.params.inviteId), String(txHash), chain),
      res,
      next,
      (result) => {
        if (!result) {
          res.status(422).json({ error: 'Transaction is not a valid payment to the platform wallet' })
          return
        }
        res.json({ inviteId: String(req.params.inviteId), settled: result.settled, reference: result.reference })
      }
    )
  }))

  // POST /invites/:inviteId/pay — settle from the payer's ledger balance
  router.post('/invites/:inviteId/pay', cap(caps.invite?.enabled ?? false, (req: Request, res: Response, next: NextFunction) => {
    handle(
      () => payments.payInviteByBalance(String(req.params.inviteId)),
      res,
      next,
      (result) => res.json({ inviteId: String(req.params.inviteId), settled: result.settled, transferId: result.transferId })
    )
  }))

  // ── Transfers (ledger-internal) ──────────────────────────────────────────

  // POST /transfers — request a ledger transfer
  // body: { from, to, valueWei, asset?, reference?, metadata? }
  router.post('/transfers', cap(caps.transfer?.enabled ?? false, (req: Request, res: Response, next: NextFunction) => {
    const { from, to, valueWei, asset, reference, metadata } = req.body ?? {}
    if (!from || !to || !valueWei) {
      res.status(400).json({ error: 'from, to and valueWei are required' })
      return
    }
    handle(
      () => payments.createTransfer({ from: String(from), to: String(to), valueWei: String(valueWei), asset, reference, metadata }),
      res,
      next,
      (result) => res.json({ transferId: result.transferId, status: result.status })
    )
  }))

  // POST /transfers/:transferId/confirm — confirm + atomically execute
  router.post('/transfers/:transferId/confirm', cap(caps.transfer?.enabled ?? false, (req: Request, res: Response, next: NextFunction) => {
    handle(
      () => payments.confirmTransfer(String(req.params.transferId)),
      res,
      next,
      (result) => {
        if (!result.ok) {
          res.status(422).json({ transferId: String(req.params.transferId), executed: false, status: result.status, error: result.reason })
          return
        }
        res.json({ transferId: String(req.params.transferId), executed: true, status: 'executed' })
      }
    )
  }))

  // GET /transfers?address=&role=from|to — list transfers
  router.get('/transfers', cap(caps.transfer?.enabled ?? false, (req: Request, res: Response, next: NextFunction) => {
    const address = String(req.query.address ?? '')
    const role = String(req.query.role ?? '')
    if (!address || !['from', 'to'].includes(role)) {
      res.status(400).json({ error: 'address and role (from|to) are required' })
      return
    }
    handle(
      () => payments.listTransfers(address, role as 'from' | 'to'),
      res,
      next,
      (transfers) => res.json({ transfers })
    )
  }))

  // GET /transfers/:transferId — one transfer
  router.get('/transfers/:transferId', cap(caps.transfer?.enabled ?? false, (req: Request, res: Response, next: NextFunction) => {
    handle(
      () => payments.getTransfer(String(req.params.transferId)),
      res,
      next,
      (transfer) => {
        if (!transfer) {
          res.status(404).json({ error: 'Transfer not found' })
          return
        }
        res.json({ transferId: transfer.transferId, from: transfer.fromAddr, to: transfer.toAddr, asset: transfer.asset, amountWei: transfer.amountWei, status: transfer.status, reference: transfer.reference, executedAt: transfer.executedAt })
      }
    )
  }))

  // POST /transfers/:transferId/cancel — cancel an open transfer
  router.post('/transfers/:transferId/cancel', cap(caps.transfer?.enabled ?? false, (req: Request, res: Response, next: NextFunction) => {
    handle(
      () => payments.cancelTransfer(String(req.params.transferId)),
      res,
      next,
      () => res.json({ cancelled: true, transferId: String(req.params.transferId) })
    )
  }))

  return router
}
