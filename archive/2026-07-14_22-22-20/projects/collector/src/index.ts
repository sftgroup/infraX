import express from 'express';
import http from 'http';
import path from 'path';
import crypto from 'crypto';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import { config } from './config';
import { logger } from './logger';
import { migrateEventCollectorTables } from './services/migration';
import { BlockScanner, getScanner } from './services/scanner';
import { DataCleaner } from './services/cleaner';
import { BinanceFuturesCollector, getBinanceCollector } from './services/binanceFutures';
import { OkxChainOSCollector, getOkxCollector } from './services/okxChainOS';
import adminRoutes from './routes/adminRoutes';
import dataRoutes from './routes/dataRoutes';
import managementRoutes from './routes/managementRoutes';
import apiKeyRoutes from './routes/apiKeyRoutes';
import { apiKeyAuth } from './middleware/apiKeyAuth';
import { sessionAuth, hasSession, initSessionStore } from './middleware/sessionAuth';
import { handleWsUpgrade } from './services/eventBus';
import relayRoutes from './routes/relayRoutes';
import priceRoutes from './routes/priceRoutes';

const app = express();

// Security headers (Helmet)
app.use(helmet({ contentSecurityPolicy: false }));

// CORS — restrict to configured origin
const allowedOrigins = (process.env.CORS_ORIGIN || '').split(',').filter(Boolean);
app.use(cors({
  origin: allowedOrigins.length > 0 && allowedOrigins[0] !== '*' ? allowedOrigins : '*',
  credentials: true,
}));

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// ── Public ──
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ── Static assets (must be BEFORE wildcard /admin/* routes) ──
const assetsDir = path.join(__dirname, '..', 'admin-panel', 'dist', 'assets');
app.use('/admin/assets', express.static(assetsDir));

// ── SPA index.html helper ──
function sendSPA(res: express.Response) {
  const fs = require('fs');
  res.setHeader('Cache-Control', 'no-store');
  const file = path.join(__dirname, '..', 'admin-panel', 'dist', 'index.html');
  if (fs.existsSync(file)) return res.type('html').send(fs.readFileSync(file, 'utf8'));
  res.status(500).send('Admin panel not built');
}

// ── Session token management ──
// Uses random tokens stored in memory (replace with Redis for multi-instance)
function setSession(res: express.Response): string {
  const token = crypto.randomBytes(32).toString('hex');
  res.cookie('admin_session', token, {
    httpOnly: true, sameSite: 'lax', maxAge: 8 * 3600 * 1000, secure: false,
  });
  initSessionStore(token);
  return token;
}

// ── Brute-force protection: login rate limiter ──
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 10,                    // 10 attempts per window
  message: { code: -1, message: 'Too many login attempts, try again in 15 minutes' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── API: login / logout ──
app.post('/api/v2/admin/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  if (username === config.admin.username && password === config.admin.password) {
    setSession(res);
    return res.json({ code: 0, message: 'ok' });
  }
  res.status(401).json({ code: -1, message: 'Invalid credentials' });
});
app.post('/api/v2/admin/logout', (_req, res) => {
  res.clearCookie('admin_session');
  res.json({ code: 0, message: 'ok' });
});

// ── Login page (public, serve SPA) ──
app.get('/admin/login', (_req, res) => sendSPA(res));

// ── /admin (gate: redirect or serve) ──
app.get('/admin', (req, res) => {
  hasSession(req) ? sendSPA(res) : res.redirect('/admin/login');
});

// ── /admin/* wildcard (must be AFTER static and /admin/login) ──
app.get('/admin/*', (req, res) => {
  hasSession(req) ? sendSPA(res) : res.redirect('/admin/login');
});

// ── API routes ──
// Admin: session auth at mount point prevents accidental bypass
app.use('/api/v2/admin', sessionAuth, apiKeyRoutes, adminRoutes, managementRoutes);
// Data: API key auth at mount point
app.use('/api/v2/data', apiKeyAuth, dataRoutes);
app.use('/api/v2/data', apiKeyAuth, priceRoutes);
// Relay: API key auth at mount point (was previously inside router only)
app.use('/api/v1', apiKeyAuth, relayRoutes);

// ── Start ──
async function main() {
  // 1. Database tables
  await migrateEventCollectorTables();

  // 2. HTTP server (start immediately, don't wait for collectors)
  const port = config.port || 3000;
  const server = http.createServer(app);
  server.on('upgrade', (req, socket, head) => handleWsUpgrade(req as any, socket, head));
  server.listen(port, () => logger.info(`InfraX Collector listening on port ${port}`));

  // 3. Block scanner (allow failure, don't block market data)
  try {
    const scanner = getScanner();
    await scanner.init();
    scanner.start();
  } catch (e: any) {
    logger.error('[scanner] Init failed', { error: e.message });
  }

  // 4. Data cleaner
  try {
    const cleaner = new DataCleaner();
    cleaner.start();
  } catch (e: any) {
    logger.error('[cleaner] Start failed', { error: e.message });
  }

  // 5. Market data collectors (non-blocking, independent)
  if (config.binance.wsEnabled !== false) {
    getBinanceCollector().start().catch((e: any) => logger.error('[binance] Start failed', { error: e.message }));
  }
  if (config.okx.wsEnabled !== false) {
    getOkxCollector().start().catch((e: any) => logger.error('[okx] Start failed', { error: e.message }));
  }
}
main().catch((e) => { logger.error('Startup failed', e); process.exit(1); });
