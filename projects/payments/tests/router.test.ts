import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import type { Express } from 'express'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPaymentsRouter } from '../src/router'
import { makeService } from './helpers'

let app: Express
let server: Server
let base = ''

const jpost = (path: string, body: any) =>
  fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }))

beforeAll(async () => {
  const { payments } = makeService()
  app = express()
  app.use(express.json({ verify: (req: any, _res, buf) => { req.rawBody = buf } }))
  app.use('/', createPaymentsRouter(payments))
  server = app.listen(0)
  await new Promise((r) => server.once('listening', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

describe('createPaymentsRouter', () => {
  it('GET /info exposes x402 protocol discovery', async () => {
    const info = await fetch(base + '/info').then((r) => r.json())
    expect(info.enabled).toBe(true)
    expect(info.priceWei).toBe('1000000000000000')
    expect(info.payTo).toBe('0x' + '22'.repeat(20))
    expect(info.network).toBe('eip155:11155111')
  })

  it('GET /price requires planId (400)', async () => {
    const r = await fetch(base + '/price')
    expect(r.status).toBe(400)
  })

  it('POST /checkout rejects missing subscriber with 400 (INVALID_INPUT)', async () => {
    const r = await jpost('/checkout', { amountCents: 100 })
    expect(r.status).toBe(400)
  })

  it('POST /access delegates to the injected store', async () => {
    const r = await jpost('/access', { subscriber: '0xuser', resource: { agentId: 1 } })
    expect(r.body.active).toBe(false)
  })

  it('GET /balance requires an address (400)', async () => {
    const r = await fetch(base + '/balance')
    expect(r.status).toBe(400)
  })

  it('POST /webhook requires a stripe-signature header', async () => {
    const r = await fetch(base + '/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(r.status).toBe(400)
    expect((await r.json()).error).toContain('stripe-signature')
  })
})
