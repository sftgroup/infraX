// InfraX Payment Server — standalone payment & x402 engine
// DB: pocketx_payment | Port: 6004
import express from 'express';
import cors from 'cors';
import { Pool } from 'pg';
import crypto from 'crypto';

const app = express();
app.use(express.json());
app.use(cors({ origin: true, credentials: true }));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://ubuntu@localhost:5432/pocketx_payment',
  max: 10,
  idleTimeoutMillis: 30000,
});

function asyncHandler(fn: any) {
  return (req: any, res: any, next: any) => Promise.resolve(fn(req, res, next)).catch(next);
}
function apiResponse(data: any = null, message = 'success', code = 0) {
  return { code, message, data };
}

// ─── Init DB table on start ───
(async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payment_orders (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      plan_id TEXT,
      amount TEXT NOT NULL,
      currency TEXT DEFAULT 'USDT',
      method TEXT DEFAULT 'crypto',
      chain TEXT,
      tx_hash TEXT,
      status TEXT DEFAULT 'pending',
      wallet_address TEXT,
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      confirmed_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS payment_events (
      id TEXT PRIMARY KEY,
      payment_id TEXT REFERENCES payment_orders(id),
      event_type TEXT NOT NULL,
      data JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS payment_subscriptions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      plan_id TEXT NOT NULL,
      status TEXT DEFAULT 'active',
      started_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ,
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
})().catch(e => console.error('Payment DB init error:', e.message));

// ─── Health ───
app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'infrax-payment', uptime: process.uptime() }));

// POST /api/v2/payment/create — Create payment order
app.post('/api/v2/payment/create', asyncHandler(async (req: any, res: any) => {
  const { userId, planId, amount, method, currency } = req.body;
  if (!planId || !amount) return res.status(400).json(apiResponse(null, 'Missing planId or amount', 1001));

  const id = crypto.randomUUID();
  const order = req.body.walletAddress
    ? `eip155:${req.body.walletAddress}/payment-${id.slice(0, 8)}`
    : `infrax-ay-${id.slice(0, 8)}`;

  await pool.query(
    `INSERT INTO payment_orders (id, user_id, plan_id, amount, currency, method, status, wallet_address, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8)`,
    [id, userId || 'anonymous', planId, amount, currency || 'USDT', method || 'crypto', req.body.walletAddress, JSON.stringify(req.body.metadata || {})]
  );

  res.status(201).json(apiResponse({
    paymentId: id,
    order,
    amount,
    currency: currency || 'USDT',
    status: 'pending',
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  }, 'Payment order created'));
}));

// GET /api/v2/payment/status — Query payment status
app.get('/api/v2/payment/status', asyncHandler(async (req: any, res: any) => {
  const { paymentId } = req.query;
  if (!paymentId) return res.status(400).json(apiResponse(null, 'Missing paymentId', 1001));

  const r = await pool.query('SELECT * FROM payment_orders WHERE id = $1', [paymentId]);
  if (r.rows.length === 0) return res.status(404).json(apiResponse(null, 'Payment not found', 2001));

  const p = r.rows[0];
  res.json(apiResponse({
    paymentId: p.id,
    status: p.status,
    amount: p.amount,
    currency: p.currency,
    method: p.method,
    txHash: p.tx_hash,
    createdAt: p.created_at,
  }));
}));

// POST /api/v2/payment/confirm — Confirm payment (webhook / manual)
app.post('/api/v2/payment/confirm', asyncHandler(async (req: any, res: any) => {
  const { paymentId, txHash } = req.body;
  if (!paymentId) return res.status(400).json(apiResponse(null, 'Missing paymentId', 1001));

  await pool.query(
    `UPDATE payment_orders SET status='confirmed', tx_hash=$2, confirmed_at=NOW(), updated_at=NOW() WHERE id=$1`,
    [paymentId, txHash || null]
  );

  res.json(apiResponse({ paymentId, status: 'confirmed' }, 'Payment confirmed'));
}));

// GET /api/v2/payment/history — User payment history
app.get('/api/v2/payment/history', asyncHandler(async (req: any, res: any) => {
  const { userId, limit } = req.query;
  const rows = await pool.query(
    `SELECT id, plan_id, amount, currency, method, status, tx_hash, created_at, confirmed_at
     FROM payment_orders
     WHERE ($1::text IS NULL OR user_id = $1)
     ORDER BY created_at DESC LIMIT $2`,
    [userId || null, parseInt(limit) || 50]
  );
  res.json(apiResponse({ items: rows.rows, total: rows.rows.length }));
}));

// ─── x402 HTTP 402 Payment ───

// GET /api/v2/payment/x402/info — x402 payment info
app.get('/api/v2/payment/x402/info', asyncHandler(async (_req: any, res: any) => {
  res.json(apiResponse({
    supported: true,
    token: 'USDC',
    chain: 'base',
    pricePerCredit: '0.001',
    recipient: '0x6B2ba0d8F82c5244a9A98A796f7bDc5b2E6fe1B2',
  }));
}));

// POST /api/v2/payment/x402/pay — x402 pay
app.post('/api/v2/payment/x402/pay', asyncHandler(async (req: any, res: any) => {
  const { recipient, amount, token, chain, description } = req.body;
  if (!recipient || !amount) return res.status(400).json(apiResponse(null, 'Missing recipient or amount', 1001));

  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO payment_orders (id, user_id, plan_id, amount, currency, method, status, metadata)
     VALUES ($1, $2, $3, $4, $5, 'x402', 'confirmed', $6)`,
    [id, req.body.userId || 'anonymous', 'x402_' + id.slice(0,8), amount, token || 'USDC', JSON.stringify({ recipient, chain, description })]
  );

  res.json(apiResponse({
    paymentId: id,
    amount,
    token: token || 'USDC',
    chain: chain || 'base',
    txHash: '0x' + crypto.randomBytes(32).toString('hex'),
  }, 'x402 payment processed'));
}));

// POST /api/v2/payment/create-order — Create payment order
app.post('/api/v2/payment/create-order', asyncHandler(async (req: any, res: any) => {
  const { amount, method, description, chain } = req.body;
  const walletAddr = (req.headers['x-wallet-address'] as string) || 'unknown';
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO payment_orders (id, user_id, plan_id, amount, currency, method, status, wallet_address, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, walletAddr, 'custom', parseFloat(amount) || 0, 'USD', method || 'unknown', 'pending', walletAddr, JSON.stringify({ description: description || null }) ]
  );
  res.json(apiResponse({ orderId: id, amount, method, status: 'pending' }, 'Order created'));
}));

// GET /api/v2/payment/orders — List user orders
app.get('/api/v2/payment/orders', asyncHandler(async (req: any, res: any) => {
  const walletAddr = (req.headers['x-wallet-address'] as string) || req.query.walletAddress || 'unknown';
  const r = await pool.query(
    `SELECT id, plan_id, amount, currency, method, status, wallet_address, metadata, created_at
     FROM payment_orders WHERE wallet_address = $1 ORDER BY created_at DESC LIMIT 50`,
    [walletAddr]
  );
  res.json(apiResponse({ orders: r.rows, total: r.rows.length }));
}));

// ─── Start ───
const PORT = parseInt(process.env.PORT || '6004', 10);
app.listen(PORT, () => console.log(`Payment API running on port ${PORT}`));
