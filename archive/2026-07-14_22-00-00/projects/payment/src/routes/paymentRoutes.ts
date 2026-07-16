
import { Router, Request, Response } from 'express';
import { asyncHandler, apiResponse } from '../utils/helpers';
import { authenticate } from '../middleware/auth';
import { pool } from '../models/database';
import crypto from 'crypto';

const router = Router();

/**
 * Unified Payment Routes — B2B2C
 *
 * POST   /api/v2/payment/create-order    — Create a payment order (returns pay_url / qr_code / on-chain tx)
 * GET    /api/v2/payment/order/:orderId   — Get order status
 * POST   /api/v2/payment/order/:orderId/pay — Execute payment (wallet transfer / on-chain)
 * POST   /api/v2/payment/stripe/webhook  — Stripe webhook callback
 * GET    /api/v2/payment/orders           — List user's payment orders
 * GET    /api/v2/payment/methods          — List available payment methods
 */

// ——— Types ———
interface CreateOrderBody {
  amount: number;          // USD amount (e.g. 49.00)
  currency?: string;       // default 'USD'
  description?: string;    // e.g. "WaaS Pro Monthly Subscription"
  metadata?: Record<string, any>; // custom order metadata
  paymentMethod?: 'stripe' | 'wallet' | 'qr' | 'auto';
  chain?: string;          // for on-chain: 'sepolia' | 'ethereum' | etc
  token?: string;          // for on-chain: 'ETH' | 'USDT' | etc
  redirectUrl?: string;
}

// ——— GET /methods ———
router.get('/methods', (req, res) => {
  res.json(apiResponse({
    methods: [
      {
        id: 'stripe',
        name: 'Credit / Debit Card',
        icon: '💳',
        description: 'Pay with Visa, Mastercard, or UnionPay via Stripe',
        minAmount: 1,
        maxAmount: 99999,
        currency: 'USD',
      },
      {
        id: 'wallet',
        name: 'Connected Wallet',
        icon: '🔐',
        description: 'Pay directly from your connected MPC or non-custodial wallet',
        minAmount: 0.001,
        maxAmount: 100,
        currency: 'ETH',
        chains: ['sepolia', 'ethereum'],
      },
      {
        id: 'qr',
        name: 'External Wallet (QR Scan)',
        icon: '📱',
        description: 'Scan QR code with MetaMask, OKX Wallet, or any wallet app',
        minAmount: 0.001,
        maxAmount: 100,
        currency: 'ETH',
        chains: ['sepolia', 'ethereum'],
      },
    ],
    defaultMethod: 'stripe',
  }));
});

// ——— POST /create-order ———
router.post(
  '/create-order',
  authenticate,
  asyncHandler(async (req: Request, res: Response) => {
    const { amount, currency, description, metadata, paymentMethod, chain, token, redirectUrl }: CreateOrderBody = req.body;
    const userId = req.user!.id;

    if (!amount || amount <= 0) {
      return res.status(400).json(apiResponse(null, 'Invalid amount', 1001));
    }

    const orderId = 'pay_' + crypto.randomBytes(12).toString('hex');
    const payCurrency = currency || 'USD';
    const payMethod = paymentMethod || 'auto';
    const payChain = chain || 'sepolia';
    const payToken = token || (payMethod === 'wallet' || payMethod === 'qr' ? 'ETH' : 'USD');

    // Stripe: generate payment intent (placeholder — real integration later)
    let stripeClientSecret: string | null = null;
    let qrAddress: string | null = null;
    let qrAmount: string | null = null;

    // For QR / on-chain: use a system receive address
    const systemWallet = process.env.PAYMENT_RECEIVE_ADDRESS || '0x0000000000000000000000000000000000000000';

    if (payMethod === 'qr') {
      qrAddress = systemWallet;
      qrAmount = amount.toString();
    }

    // Insert order
    await pool.query(
      `INSERT INTO payment_orders
       (order_id, user_id, amount, currency, description, payment_method,
        chain, token_symbol, status, metadata, stripe_client_secret,
        qr_address, qr_amount, redirect_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9,$10,$11,$12,$13)`,
      [
        orderId, userId, amount, payCurrency, description || '',
        payMethod, payChain, payToken,
        JSON.stringify(metadata || {}),
        stripeClientSecret, qrAddress, qrAmount,
        redirectUrl || null,
      ]
    );

    const result: any = {
      orderId,
      amount,
      currency: payCurrency,
      status: 'pending',
      paymentMethod: payMethod,
      payUrl: `/pay.html?order=${orderId}`,
    };

    if (stripeClientSecret) {
      result.stripeClientSecret = stripeClientSecret;
    }
    if (qrAddress && qrAmount) {
      result.qrAddress = qrAddress;
      result.qrAmount = qrAmount;
      result.qrChain = payChain;
    }
    if (redirectUrl) {
      result.redirectUrl = redirectUrl;
    }

    res.status(201).json(apiResponse(result, 'Order created'));
  })
);

// ——— GET /order/:orderId ———
router.get(
  '/order/:orderId',
  authenticate,
  asyncHandler(async (req, res) => {
    const { orderId } = req.params;
    const result = await pool.query(
      'SELECT * FROM payment_orders WHERE order_id = $1',
      [orderId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json(apiResponse(null, 'Order not found', 1002));
    }
    const order = result.rows[0];
    res.json(apiResponse({
      orderId: order.order_id,
      amount: order.amount,
      currency: order.currency,
      status: order.status,
      paymentMethod: order.payment_method,
      txHash: order.tx_hash,
      paidAt: order.paid_at,
      qrAddress: order.qr_address,
      qrAmount: order.qr_amount,
    }));
  })
);

// ——— POST /order/:orderId/pay ———
router.post(
  '/order/:orderId/pay',
  authenticate,
  asyncHandler(async (req, res) => {
    const { orderId } = req.params;
    const { txHash, fromAddress } = req.body;

    const result = await pool.query(
      'SELECT * FROM payment_orders WHERE order_id = $1',
      [orderId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json(apiResponse(null, 'Order not found', 1002));
    }

    const order = result.rows[0];
    if (order.status === 'paid') {
      return res.status(400).json(apiResponse(null, 'Order already paid', 1001));
    }

    // For wallet payments, require txHash
    if (order.payment_method === 'wallet' && !txHash) {
      return res.status(400).json(apiResponse(null, 'txHash required for wallet payment', 1001));
    }

    await pool.query(
      `UPDATE payment_orders
       SET status = 'paid', tx_hash = $2, from_address = $3, paid_at = NOW(),
           updated_at = NOW()
       WHERE order_id = $1`,
      [orderId, txHash || null, fromAddress || null]
    );

    res.json(apiResponse({ orderId, status: 'paid', txHash }, 'Payment confirmed'));
  })
);

// ——— POST /stripe/webhook ———
router.post(
  '/stripe/webhook',
  asyncHandler(async (req, res) => {
    // Placeholder: Stripe webhook will call this
    // In production: verify Stripe signature, extract orderId from metadata,
    // update order status to 'paid'
    console.log('[Stripe Webhook]', JSON.stringify(req.body));
    res.json({ received: true });
  })
);

// ——— GET /orders ———
router.get(
  '/orders',
  authenticate,
  asyncHandler(async (req, res) => {
    const userId = req.user!.id;
    const result = await pool.query(
      'SELECT * FROM payment_orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50',
      [userId]
    );
    res.json(apiResponse({
      orders: result.rows.map((o: any) => ({
        orderId: o.order_id,
        amount: o.amount,
        currency: o.currency,
        status: o.status,
        paymentMethod: o.payment_method,
        description: o.description,
        createdAt: o.created_at,
      })),
    }));
  })
);

// ——— x402 Protocol Support ———
// HTTP 402 Payment Required — Coinbase x402 open payment standard
// Flow: Client Request → 402 Payment Required → Signed TX → 200 OK

/**
 * GET /api/v2/payment/x402/info — x402 gateway endpoint info
 * Returns the x402 payment gateway metadata
 */
router.get('/x402/info', (req, res) => {
  res.json(apiResponse({
    protocol: 'x402',
    version: '2.0',
    name: 'InfraX x402 Gateway',
    supportedNetworks: ['ethereum-sepolia', 'ethereum-mainnet'],
    supportedTokens: ['ETH', 'USDC', 'USDT'],
    facilitator: {
      url: process.env.X402_FACILITATOR_URL || 'https://x402.polygon.technology',
      supportedSchemes: ['exact', 'upto'],
    },
    endpoints: {
      paymentRequired: '/api/v2/payment/x402/request',
      verify: '/api/v2/payment/x402/verify',
    },
  }));
});

/**
 * POST /api/v2/payment/x402/request — Initiate x402 payment request
 * Returns 402 Payment Required with payment requirements
 */
router.post(
  '/x402/request',
  authenticate,
  asyncHandler(async (req: Request, res: Response) => {
    const { amount, currency, resource, chain, token } = req.body;
    const userId = req.user!.id;

    if (!amount || amount <= 0) {
      return res.status(400).json(apiResponse(null, 'Invalid amount', 1001));
    }

    const orderId = 'x402_' + crypto.randomBytes(12).toString('hex');
    const payChain = chain || 'sepolia';
    const payToken = token || 'ETH';
    // USD-denominated amount converted to token amount (placeholder rate)
    const tokenAmount = amount; // In production: query oracle for ETH/USD rate

    const receiveAddress = process.env.PAYMENT_RECEIVE_ADDRESS || '0x0000000000000000000000000000000000000000';

    // Store order
    await pool.query(
      `INSERT INTO payment_orders
       (order_id, user_id, amount, currency, description, payment_method,
        chain, token_symbol, status, metadata)
       VALUES ($1,$2,$3,$4,$5,'x402',$6,$7,'pending',$8)`,
      [orderId, userId, amount, currency || 'USD', resource || '', payChain, payToken,
       JSON.stringify({ protocol: 'x402', facilitatorUrl: process.env.X402_FACILITATOR_URL || 'https://x402.polygon.technology' })]
    );

    // Return 402 Payment Required with x402 headers
    res.status(402).set({
      'X-PAYMENT-REQUIRED': 'true',
      'X-PAYMENT-CHAIN': payChain,
      'X-PAYMENT-TOKEN': payToken,
      'X-PAYMENT-AMOUNT': tokenAmount.toString(),
      'X-PAYMENT-RECIPIENT': receiveAddress,
      'X-PAYMENT-ORDER-ID': orderId,
      'X-PAYMENT-FACILITATOR': process.env.X402_FACILITATOR_URL || 'https://x402.polygon.technology',
      'Access-Control-Expose-Headers': 'X-PAYMENT-REQUIRED, X-PAYMENT-CHAIN, X-PAYMENT-TOKEN, X-PAYMENT-AMOUNT, X-PAYMENT-RECIPIENT, X-PAYMENT-ORDER-ID, X-PAYMENT-FACILITATOR',
    }).json(apiResponse({
      orderId,
      status: 'payment_required',
      network: payChain,
      token: payToken,
      amount: tokenAmount,
      recipientAddress: receiveAddress,
      resource: resource || 'InfraX API Resource',
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(), // 15 min expiry
    }));
  })
);

/**
 * POST /api/v2/payment/x402/verify — Verify x402 payment
 * Called by client with signed tx in X-PAYMENT header
 */
router.post(
  '/x402/verify',
  authenticate,
  asyncHandler(async (req: Request, res: Response) => {
    const paymentHeader = req.headers['x-payment'] as string;
    const orderId = req.headers['x-payment-order-id'] as string || req.body.orderId;

    if (!paymentHeader) {
      return res.status(402).set({
        'X-PAYMENT-REQUIRED': 'true',
        'X-PAYMENT-ERROR': 'Missing X-PAYMENT header',
      }).json(apiResponse(null, 'No payment attached — 402 Payment Required', 402));
    }

    if (!orderId) {
      return res.status(400).json(apiResponse(null, 'Missing order ID', 1001));
    }

    // In production: decode X-PAYMENT header, verify signature with facilitator
    // For now: accept payment and mark order as paid
    const paymentData = JSON.parse(paymentHeader);
    const txHash = paymentData.txHash || paymentData.tx_hash || null;

    await pool.query(
      `UPDATE payment_orders
       SET status = 'paid', tx_hash = $2, paid_at = NOW(), updated_at = NOW()
       WHERE order_id = $1`,
      [orderId, txHash]
    );

    res.set({
      'X-PAYMENT-RESPONSE': JSON.stringify({
        status: 'verified',
        orderId,
        txHash,
        settledAt: new Date().toISOString(),
      }),
    }).json(apiResponse({
      orderId,
      status: 'paid',
      txHash,
      message: 'Payment verified — resource access granted',
    }));
  })
);

export default router;
