import { Request, Response, NextFunction } from 'express';
import { pool } from '../database';
import crypto from 'crypto';
import { config } from '../config';

// E-1c 同款：外部签发 key（dx_/mx_/ar_ 等，存于 data 服务 SQLite）实时校验。
//   config.dx.apiKeyVerifyUrl/Key      data 服务 URL + 调 data 的鉴权 key（DATA_API_KEY，Bearer）
//   config.dx.externalKeyPrefixes     外部 key 前缀家族（DX_EXTERNAL_KEY_PREFIXES 可配置）
// 未配置 → 仅本地表 key（pkx_）。

// 外部签发 key 前缀家族（非 collector 本地 api_keys 表签发）
const EXTERNAL_KEY_RE = new RegExp(
  `^(${config.dx.externalKeyPrefixes.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`,
);

/** 外部 key 实时校验：POST {url}/api-keys/verify（fail-closed，5s 超时）。 */
async function verifyExternalKey(key: string): Promise<boolean> {
  if (!config.dx.apiKeyVerifyUrl || !config.dx.apiKeyVerifyKey) return false;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(`${config.dx.apiKeyVerifyUrl}/api-keys/verify`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.dx.apiKeyVerifyKey}`,
      },
      body: JSON.stringify({ api_key: key, scope: 'data' }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * In-memory rate limiter — sliding window per API key.
 * Replace with Redis for multi-instance deployments.
 */
const rateWindows = new Map<string, { windowStart: number; count: number }>();

function checkRateLimit(key: string | number, rateLimit: number): boolean {
  const now = Date.now();
  const windowMs = 60_000; // 1-minute sliding window
  const k = typeof key === 'number' ? String(key) : `ext:${key}`;
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
  // 平台 bridge key 直通（内部代理 web server.js 统一注入 X-Service-Key，WEB-10）：
  // 与 /api/v2/data/my-keys 等 data 服务契约一致，匹配即放行（视为外部 key，跳过本地配额）
  const svcKey = req.headers['x-service-key'] as string;
  if (config.service.apiKey && svcKey && svcKey === config.service.apiKey) {
    (req as any).apiKey = { external: true, label: 'service-bridge', rateLimit: Infinity, marketPlanId: 'market_pro' };
    return next();
  }

  const key = req.headers['x-api-key'] as string;
  if (!key) {
    res.status(401).json({ code: -1, message: 'Missing X-API-Key header' });
    return;
  }

  pool.query('SELECT id, label, rate_limit, enabled, market_plan_id FROM api_keys WHERE api_key = $1', [key])
    .then(r => {
      if (r.rows.length === 0) {
        // 本地表无此 key：外部签发 key（dx_ 等）→ data 服务实时校验（E-1c 模式）
        if (EXTERNAL_KEY_RE.test(key)) {
          verifyExternalKey(key).then(ok => {
            if (!ok) {
              res.status(401).json({ code: -1, message: 'Invalid API Key' });
              return;
            }
            // 外部 key 与本地表 key 同套滑动窗口限流（DX_EXTERNAL_KEY_RATE_LIMIT，默认 100/min）
            const limit = config.dx.externalRateLimit;
            if (!checkRateLimit(key, limit)) {
              res.status(429).json({ code: -1, message: 'Rate limit exceeded' });
              return;
            }
            (req as any).apiKey = { external: true, label: key.slice(0, 12), rateLimit: limit, marketPlanId: 'market_free' };
            next();
          }).catch(() => res.status(401).json({ code: -1, message: 'Invalid API Key' }));
          return;
        }
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

      (req as any).apiKey = { id: row.id, label: row.label, rateLimit: limit, marketPlanId: row.market_plan_id || 'market_free' };

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
