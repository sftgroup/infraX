// Mock Stripe — minimal stand-in for api.stripe.com/v1 used by the Gateway
// fiat rail (STRIPE_API_BASE=http://127.0.0.1:8777/v1). Zero dependencies.
//
// Implemented endpoints:
//   POST /v1/checkout/sessions   → creates a fake Checkout Session
//   GET  /checkout/:session/:sub/:amount  → simulated hosted payment page
//
// The mock is NOT Stripe: it exists so the full Gateway fiat flow
// (checkout → webhook → fiat_subscriptions → unified access control) can be
// exercised locally without a Stripe account. Swap STRIPE_API_BASE for
// https://api.stripe.com/v1 + a real sk_test_ key to hit the real Stripe.
import { createServer } from 'node:http'

const PORT = Number(process.env.MOCK_STRIPE_PORT || 8777)
const BASE = `http://127.0.0.1:${PORT}`

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, BASE)

  // Gateway calls: POST /v1/checkout/sessions (application/x-www-form-urlencoded)
  if (req.method === 'POST' && url.pathname === '/v1/checkout/sessions') {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const params = new URLSearchParams(raw)

    if (!(req.headers.authorization || '').startsWith('Bearer sk_test_')) {
      json(res, 401, { error: { message: 'Invalid API key: must look like sk_test_...' } })
      return
    }

    const amount = Number(params.get('line_items[0][price_data][unit_amount]') || 0)
    const currency = params.get('line_items[0][price_data][currency]') || 'usd'
    const sessionId = `cs_test_local_${Date.now()}`
    const subscription = `sub_local_${Date.now()}`
    console.log(`[mock-stripe] checkout session ${sessionId} (sub=${subscription}, amount=${amount} ${currency})`)

    // URL encodes sessionId / subscription / amount so the flows harness can
    // drive the simulated webhook events deterministically.
    json(res, 200, {
      id: sessionId,
      object: 'checkout_session',
      url: `${BASE}/checkout/${sessionId}/${subscription}/${amount}`,
      subscription,
      amount_total: amount,
      currency,
      client_reference_id: params.get('client_reference_id'),
    })
    return
  }

  // Simulated "hosted payment page".
  if (req.method === 'GET' && url.pathname.startsWith('/checkout/')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(
      '<html><body style="font-family:sans-serif;text-align:center;padding-top:80px">' +
        '<h2>Mock Stripe Checkout</h2>' +
        '<p>This is a simulated payment page. Payment complete (no real card charged).</p>' +
        '<p><a href="#">Continue →</a></p></body></html>'
    )
    return
  }

  json(res, 404, { error: 'Not found' })
})

server.listen(PORT, () => console.log(`[mock-stripe] listening on ${BASE}/v1`))
