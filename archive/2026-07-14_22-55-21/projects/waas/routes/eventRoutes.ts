import { Router } from 'express';
import crypto from 'crypto';
import { asyncHandler, apiResponse } from '../utils/helpers';
import { authenticate, requireApiKey } from '../middleware/auth';
import * as webhookService from '../services/webhookService';

const router = Router();

/**
 * BE-08: Webhook & Event Routes
 * POST /api/v2/events/token — Generate a short-lived SSE token (avoids long-lived tokens in URL)
 * GET  /api/v2/events/stream — SSE event stream (uses SSE token, not wallet signature)
 * POST /api/v2/webhooks/cwallet — CWallet webhook callback
 */

// In-memory SSE token store: token → { userId, expiresAt }
// Short TTL (5 min) prevents URL leakage from being useful long-term
const sseTokens = new Map<string, { userId: string; expiresAt: number }>();
const SSE_TOKEN_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Clean up expired SSE tokens every 2 minutes
setInterval(() => {
  const now = Date.now();
  for (const [token, val] of sseTokens.entries()) {
    if (now > val.expiresAt) sseTokens.delete(token);
  }
}, 120000).unref?.();

/**
 * POST /api/v2/events/token
 * Generate a short-lived SSE connection token.
 * This avoids leaking the wallet signature in URL query strings.
 * Auth: Wallet signature required (via x-wallet-* headers)
 */
router.post(
  '/token',
  authenticate,
  asyncHandler(async (req, res) => {
    const userId = req.user!.id;
    const sseToken = crypto.randomBytes(32).toString('hex');
    sseTokens.set(sseToken, {
      userId,
      expiresAt: Date.now() + SSE_TOKEN_TTL_MS,
    });
    res.json(apiResponse({ token: sseToken, expiresIn: SSE_TOKEN_TTL_MS / 1000 }, 'SSE token generated'));
  })
);

/**
 * GET /api/v2/events/stream
 * Server-Sent Events stream for real-time notifications
 * Auth: SSE token (one-time use, short-lived) via query param
 * Query: token (SSE token, NOT a wallet signature)
 */
router.get(
  '/stream',
  asyncHandler(async (req, res) => {
    const sseToken = req.query.token as string;

    if (!sseToken) {
      return res.status(401).json(apiResponse(null, 'Missing SSE token', 1002));
    }

    // Validate SSE token
    const tokenData = sseTokens.get(sseToken);
    if (!tokenData || Date.now() > tokenData.expiresAt) {
      sseTokens.delete(sseToken);
      return res.status(401).json(apiResponse(null, 'Invalid or expired SSE token', 1002));
    }

    // Consume the token (one-time use) — prevents reuse if leaked
    sseTokens.delete(sseToken);

    const userId = tokenData.userId;

    // Set SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Register client
    const clientId = webhookService.registerSSEClient(userId, res);

    // Periodic keepalive (every 30s)
    const keepalive = setInterval(() => {
      try {
        res.write(`:keepalive ${Date.now()}\n\n`);
      } catch {
        clearInterval(keepalive);
      }
    }, 30000);

    req.on('close', () => {
      clearInterval(keepalive);
      webhookService.unregisterSSEClient(clientId);
    });
  })
);

/**
 * POST /api/v2/webhooks/cwallet
 * Receive webhook callbacks from CWallet
 * Body: { event_type, user_id, wallet_id, ... }
 * Protected by API Key authentication
 */
router.post(
  '/cwallet',
  requireApiKey,
  asyncHandler(async (req, res) => {
    const payload = req.body;

    if (!payload || typeof payload !== 'object') {
      return res.status(400).json(apiResponse(null, 'Invalid webhook payload', 1001));
    }

    await webhookService.handleCWalletWebhook(payload);
    res.json(apiResponse(null, 'Webhook received'));
  })
);

export default router;
