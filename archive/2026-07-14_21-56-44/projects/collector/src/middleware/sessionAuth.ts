import { Request, Response, NextFunction } from 'express';

/**
 * In-memory session store (tokens → expiry timestamp).
 * Replace with Redis for multi-instance deployments.
 */
const sessions = new Map<string, number>();

const SESSION_TTL_MS = 8 * 3600 * 1000; // 8 hours

/** Register a new session token */
export function initSessionStore(token: string): void {
  sessions.set(token, Date.now() + SESSION_TTL_MS);
}

/** Clean up expired sessions (called periodically by middleware) */
let lastCleanup = 0;
function cleanupExpired(): void {
  const now = Date.now();
  if (now - lastCleanup < 60_000) return; // clean at most once per minute
  lastCleanup = now;
  for (const [token, expiry] of sessions) {
    if (now > expiry) sessions.delete(token);
  }
}

/**
 * Cookie-based session authentication middleware.
 * Validates random session tokens stored in memory.
 */
export function sessionAuth(req: Request, res: Response, next: NextFunction): void {
  cleanupExpired();

  const token = req.cookies?.admin_session;
  if (token && sessions.has(token)) {
    // Refresh TTL on activity
    sessions.set(token, Date.now() + SESSION_TTL_MS);
    return next();
  }

  // Fallback: accept Basic Auth header (legacy compatibility)
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
      const [username, password] = decoded.split(':');
      if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) return next();
    } catch { /* fall through */ }
  }

  res.status(401).json({ code: -1, message: 'Authentication required' });
}

/**
 * Helper: check if request has valid session (not a middleware, just a guard).
 * Used in index.ts for SPA route gate.
 */
export const hasSession = (req: Request): boolean => {
  cleanupExpired();
  const token = req.cookies?.admin_session;
  return !!token && sessions.has(token);
};
