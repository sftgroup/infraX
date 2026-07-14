import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';
import { config } from '../config';
import { pool } from '../models/database';
import { logger } from '../utils/logger';
import { Errors } from '../utils/errors';

/**
 * BE-08: Webhook Event Service
 * (F-022, L-008) Event queue, retry 3x, timeout 10s, SSE push, tenant HTTP delivery
 */

// SSE event emitter — one per connected client
export const sseEmitter = new EventEmitter();
sseEmitter.setMaxListeners(100);

// SSE client set
interface SSEClient {
  id: string;
  userId: string;
  res: any;
}

const sseClients: Map<string, SSEClient> = new Map();

/**
 * Register an SSE client for real-time event push
 */
export function registerSSEClient(userId: string, res: any): string {
  const clientId = uuidv4();
  sseClients.set(clientId, { id: clientId, userId, res });

  // Send initial keepalive
  res.write(`data: ${JSON.stringify({ type: 'connected', clientId })}\n\n`);

  // Remove on disconnect
  res.on('close', () => {
    sseClients.delete(clientId);
    logger.info('SSE client disconnected', { clientId, userId });
  });

  logger.info('SSE client connected', { clientId, userId });
  return clientId;
}

/**
 * Unregister an SSE client (cleanup on disconnect)
 */
export function unregisterSSEClient(clientId: string): void {
  sseClients.delete(clientId);
}

/**
 * Push an event to all SSE clients for a specific user
 */
export function pushEventToUser(userId: string, event: any): void {
  const payload = JSON.stringify({ data: event });
  for (const [clientId, client] of sseClients) {
    if (client.userId === userId || userId === '*') {
      try {
        client.res.write(`event: ${event.type || 'message'}\n`);
        client.res.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch (err: any) {
        logger.warn('Failed to push SSE event', { clientId, error: err.message });
        sseClients.delete(clientId);
      }
    }
  }
}

/**
 * Create a webhook event and queue it for delivery (L-008)
 */
export async function createWebhookEvent(
  eventType: 'deposit' | 'withdrawal' | 'failed' | 'blocked',
  userId: string,
  walletId: string | null,
  payload: any
): Promise<string> {
  const eventId = uuidv4();
  await pool.query(
    `INSERT INTO webhook_events (id, event_type, user_id, wallet_id, payload, status)
     VALUES ($1, $2, $3, $4, $5, 'pending')`,
    [eventId, eventType, userId, walletId, JSON.stringify(payload)]
  );

  // Attempt delivery immediately (async, non-blocking)
  processNextEvent(eventId).catch(err => logger.warn('processNextEvent error', { eventId, error: err.message }));

  return eventId;
}

/**
 * Process a webhook event — deliver via SSE + tenant HTTP webhook, handle retries
 */
async function processNextEvent(eventId: string): Promise<void> {
  const result = await pool.query(
    'SELECT * FROM webhook_events WHERE id = $1',
    [eventId]
  );
  if (result.rows.length === 0) return;

  const event = result.rows[0];
  if (event.status === 'delivered') return;

  let deliveryOk = true;
  try {
    // 1. Push via SSE to connected clients
    pushEventToUser(event.user_id, event.payload);

    // 2. HTTP POST to tenant webhook URL (if configured)
    await deliverToTenantWebhook(event);

    // Mark as delivered
    await pool.query(
      `UPDATE webhook_events SET status = 'delivered' WHERE id = $1`,
      [eventId]
    );
    logger.info('Webhook event delivered', { eventId, eventType: event.event_type });
  } catch (err: any) {
    deliveryOk = false;
    logger.warn('Webhook event delivery failed', { eventId, error: err.message });

    const newRetryCount = event.retry_count + 1;
    if (newRetryCount >= config.webhook.retryMax) {
      await pool.query(
        `UPDATE webhook_events SET retry_count = $1, status = 'failed', last_error = $2 WHERE id = $3`,
        [newRetryCount, err.message || 'Max retries exceeded', eventId]
      );
      logger.error('Webhook event failed after max retries', { eventId });
    } else {
      // Retry with exponential backoff: 2^1=2s, 2^2=4s, 2^3=8s (max 30s)
      const delay = Math.min(2000 * Math.pow(2, newRetryCount - 1), 30000);
      await pool.query(
        `UPDATE webhook_events SET retry_count = $1, last_error = $2 WHERE id = $3`,
        [newRetryCount, err.message || 'Retry scheduled', eventId]
      );
      setTimeout(() => processNextEvent(eventId), delay);
    }
  }
}

/**
 * Deliver event to tenant's HTTP webhook URL
 * Looks up tenant by user's wallet chain/tenant info, POSTs payload
 */
async function deliverToTenantWebhook(event: any): Promise<void> {
  // Find tenant webhook URL via user's wallet / tenant linkage
  const tenantResult = await pool.query(
    `SELECT t.webhook_url, t.id as tenant_id
     FROM tenants t
     JOIN wallets w ON w.tenant_id = t.id
     WHERE w.user_id = $1
     LIMIT 1`,
    [event.user_id]
  );
  if (tenantResult.rows.length === 0 || !tenantResult.rows[0].webhook_url) {
    // No tenant webhook configured — delivery is SSE-only, which is fine
    return;
  }

  const webhookUrl = tenantResult.rows[0].webhook_url;
  try {
    await axios.post(webhookUrl, {
      event_id: event.id,
      event_type: event.event_type,
      payload: event.payload,
      timestamp: event.created_at,
    }, {
      headers: { 'Content-Type': 'application/json', 'x-infrax-ignature': 'v1' },
      timeout: config.webhook.timeoutMs,
    });
    logger.info('Tenant webhook delivered', { tenantId: tenantResult.rows[0].tenant_id, eventId: event.id });
  } catch (err: any) {
    logger.warn('Tenant webhook delivery failed', { webhookUrl, eventId: event.id, error: err.message });
    throw err; // triggers retry
  }
}

/**
 * Process all pending + failed webhook events (called on startup)
 */
export async function processPendingEvents(): Promise<void> {
  const pending = await pool.query(
    "SELECT id FROM webhook_events WHERE status = 'pending' OR status = 'failed' ORDER BY created_at ASC LIMIT 100"
  );
  for (const row of pending.rows) {
    processNextEvent(row.id).catch(err => logger.warn('Startup retry error', { eventId: row.id, error: err.message }));
  }
  logger.info(`Processing ${pending.rows.length} pending/failed webhook events on startup`);
}

/**
 * List webhook events (for admin dashboard)
 */
export async function listWebhookEvents(params: {
  status?: string;
  eventType?: string;
  limit?: number;
  offset?: number;
}): Promise<{ items: any[]; total: number }> {
  const { status, eventType, limit = 50, offset = 0 } = params;
  let where = '1=1';
  const values: any[] = [];
  let i = 1;

  if (status) { where += ` AND status = $${i++}`; values.push(status); }
  if (eventType) { where += ` AND event_type = $${i++}`; values.push(eventType); }

  const countResult = await pool.query(
    `SELECT COUNT(*) FROM webhook_events WHERE ${where}`, values
  );
  const total = parseInt(countResult.rows[0].count, 10);

  const rowsResult = await pool.query(
    `SELECT * FROM webhook_events WHERE ${where} ORDER BY created_at DESC LIMIT $${i++} OFFSET $${i++}`,
    [...values, limit, offset]
  );

  return { items: rowsResult.rows, total };
}

/**
 * Manually retry a failed webhook event (admin action)
 */
export async function retryWebhookEvent(eventId: string): Promise<void> {
  const result = await pool.query(
    "SELECT * FROM webhook_events WHERE id = $1 AND status = 'failed'",
    [eventId]
  );
  if (result.rows.length === 0) {
    throw Errors.notFound('Failed webhook event');
  }

  // Reset retry count and re-process
  await pool.query(
    `UPDATE webhook_events SET status = 'pending', retry_count = 0, last_error = NULL WHERE id = $1`,
    [eventId]
  );
  processNextEvent(eventId).catch(err => logger.warn('Manual retry error', { eventId, error: err.message }));
  logger.info('Webhook event manually retried', { eventId });
}

/**
 * Handle incoming CWallet webhook callback
 */
export async function handleCWalletWebhook(payload: any): Promise<void> {
  logger.info('CWallet webhook received', { payload });

  const eventType = payload.event_type || payload.type;
  let userId: string | null = payload.user_id || null;
  let walletId: string | null = payload.wallet_id || null;

  if (!eventType) {
    logger.warn('CWallet webhook missing event_type');
    throw Errors.paramError('Missing event_type in webhook payload');
  }

  // Validate UUIDs — reject webhooks without valid user_id/wallet_id
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!userId || !uuidRegex.test(userId)) {
    logger.warn('CWallet webhook: missing or invalid user_id, rejecting', { userId });
    throw Errors.invalidInput('user_id');
  }
  if (!walletId || !uuidRegex.test(walletId)) {
    logger.warn('CWallet webhook: missing or invalid wallet_id, rejecting', { walletId });
    throw Errors.invalidInput('wallet_id');
  }

  // Map CWallet event type to our types
  let mappedType: 'deposit' | 'withdrawal' | 'failed' | 'blocked';
  switch (eventType) {
    case 'deposit':
    case 'incoming':
      mappedType = 'deposit';
      break;
    case 'withdraw':
    case 'outgoing':
      mappedType = 'withdrawal';
      break;
    case 'tx_failed':
      mappedType = 'failed';
      break;
    case 'blocked':
    case 'risk_blocked':
      mappedType = 'blocked';
      break;
    default:
      logger.warn('Unknown CWallet event type', { eventType });
      return;
  }

  await createWebhookEvent(mappedType, userId, walletId, payload);
}
