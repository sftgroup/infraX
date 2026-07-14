import { Request, Response, NextFunction } from 'express';
import { pool } from '../database';
import crypto from 'crypto';

/**
 * In-memory rate limiter — sliding window per API key.
 * Replace with Redis for multi-instance deployments.
 */
const rateWindows = new Map<string, { windowStart: number; count: number }>();

function checkRateLimit(keyId: number, rateLimit: number): boolean {
  const now = Date.now();
  const windowMs = 60_000; // 1-minute sliding window
  const k = String(keyId);
  const entry = rateWindows.get(k);

  if (!entry || now - entry.windowStart > windowMs) {
    // New window
    rateWindows.set(k, { windowStart: now, count: 1 });
    return true;
  }

  if (entry.count >= rateLimit) {
    return false; // rate limited
  }

  entry.count++;
  return true;
}

// Clean up stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateWindows) {
    if (now - v.windowStart > 120_000) rateWindows.delete(k);
  }
}, 300_000).unref();

/**
 * API Key authentication middleware with rate limiting.
 */
export function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  const key = req.headers['x-api-key'] as string;
  if (!key) {
    res.status(401).json({ code: -1, message: 'Missing X-API-Key header' });
    return;
  }

  pool.query('SELECT id, label, rate_limit, enabled FROM api_keys WHERE api_key = $1', [key])
    .then(r => {
      if (r.rows.length === 0) {
        res.status(401).json({ code: -1, message: 'Invalid API Key' });
        return;
      }
      const row = r.rows[0];
      if (!row.enabled) {
        res.status(403).json({ code: -1, message: 'API Key disabled' });
        return;
      }

      // Rate limit check
      const limit = row.rate_limit || 100;
      if (!checkRateLimit(row.id, limit)) {
        res.status(429).json({ code: -1, message: 'Rate limit exceeded' });
        return;
      }

      (req as any).apiKey = { id: row.id, label: row.label, rateLimit: limit };

      // Fire-and-forget usage tracking
      pool.query(
        'UPDATE api_keys SET last_used_at = NOW(), request_count = request_count + 1 WHERE id = $1',
        [row.id]
      ).catch(() => {});

      next();
    })
    .catch(() => {
      res.status(500).json({ code: -1, message: 'Internal error' });
    });
}

export function generateApiKey(): string {
  return 'pkx_' + crypto.randomBytes(24).toString('hex');
}
