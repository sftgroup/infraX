import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { config } from './config';
import { logger } from './utils/logger';
import { initDatabase } from './models/database';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { requestLogger } from './middleware/requestLogger';
import { generalLimiter } from './middleware/rateLimiter';
import { processPendingEvents } from './services/webhookService';
import { scanAllChains } from './services/scannerService';
import { withLock } from './services/lockService';
import { retryPendingBroadcasts } from './services/txService';
import { processPendingSweeps, ensureColdSweep } from './services/saasService';

// Routes
import authRoutes from './routes/authRoutes';
import walletRoutes from './routes/walletRoutes';
import txRoutes from './routes/txRoutes';
import riskRoutes from './routes/riskRoutes';
import eventRoutes from './routes/eventRoutes';
import dashboardRoutes from './routes/dashboardRoutes';
import internalRoutes from './routes/internalRoutes';
import saasRoutes from './routes/saasRoutes';
import subscriptionRoutes from './routes/subscriptionRoutes';
import dataSubscriptionRoutes from './routes/dataSubscriptionRoutes';
// MQ-9: payment/mpc 路由已迁独立服务（projects/payment/server.ts :9106 / projects/mpc/server.ts :9104），
// waas 不再挂载（遗留 routes/paymentRoutes.ts、routes/mpcRoutes.ts、services/mpcService.ts 已删除）

const app = express();

// Security headers
app.use(helmet());

// CORS
app.use(cors({
  origin: config.corsOrigin,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-Wallet-Address', 'X-Wallet-Signature', 'X-Wallet-Timestamp', 'X-CWallet-Signature', 'X-CWallet-Timestamp'],
  credentials: true,
}));

// Compression
app.use(compression());

// Body parsing
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

// JSON parse error handler
app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err instanceof SyntaxError && 'body' in (err as any)) {
    res.status(400).json({ code: 1001, message: 'Invalid JSON in request body', data: null });
    return;
  }
  next(err);
});

// Request logging
app.use(requestLogger);

// Rate limiting
app.use(generalLimiter);

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '2.0.0' });
});

// Routes
app.use('/api/v2/auth', authRoutes);
app.use('/api/v2/wallet', walletRoutes);
app.use('/api/v2/tx', txRoutes);
app.use('/api/v2/risk', riskRoutes);
app.use('/api/v2/events', eventRoutes);
app.use('/api/v2/webhooks', eventRoutes);
app.use('/api/v2/dashboard', dashboardRoutes);
app.use('/api/v2/internal', internalRoutes);
app.use('/api/v2/saas', saasRoutes);
app.use('/api/v2/subscription', subscriptionRoutes);
app.use('/api/v2/data', dataSubscriptionRoutes);

app.get('/admin', (_req, res) => {
  const fs = require('fs');
  const path = require('path');
  let html = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');
  res.setHeader('Cache-Control', 'no-store');
  res.type('html').send(html);
});
// MQ-9: Payment routes served by independent service :9106 — projects/payment/server.ts
// MQ-9: MPC routes served by independent service :9104 — projects/mpc/server.ts

// 404 handler
app.use(notFoundHandler);

// Error handler
app.use(errorHandler);

async function start(): Promise<void> {
  try {
    await initDatabase();

    await processPendingEvents();

    app.listen(config.port, () => {
      logger.info(`InfraX Backend v2.0 started on port ${config.port}`, {
        env: config.nodeEnv,
        chains: config.supportedChains,
      });
    });

    // Block scanner — only if interval configured (>0)
    if (config.blockScanner.intervalMs > 0) {
    const scanInterval = setInterval(async () => {
      try {
        // W-9: 分布式锁防多实例重复扫描
        const result = await withLock('block-scan', scanAllChains);
        if (result && result.depositsProcessed > 0) {
          logger.info('Block scan cycle completed', result);
        }
      } catch (err: any) {
        logger.error('Block scan cycle error', { error: err.message });
      }
    }, config.blockScanner.intervalMs);

    if (typeof scanInterval === 'object' && 'unref' in scanInterval) {
      scanInterval.unref();
    }
    } else {
      logger.info('Block scanner disabled (BLOCK_SCAN_INTERVAL_MS=0)');
    }

    // W-3/W-9: 广播重试 + W-11 sweep 执行 + W-16 冷热归集 worker（分布式锁互斥）
    const workerInterval = setInterval(async () => {
      try {
        const retried = await withLock('tx-broadcast-retry', retryPendingBroadcasts);
        const swept = await withLock('sweep-worker', () => processPendingSweeps(10));
        const coldQueued = await withLock('cold-sweep', ensureColdSweep);
        if ((retried ?? 0) > 0 || (swept ?? 0) > 0 || (coldQueued ?? 0) > 0) {
          logger.info('WAAS worker cycle completed', { retried, swept, coldQueued });
        }
      } catch (err: any) {
        logger.error('WAAS worker cycle error', { error: err.message });
      }
    }, config.sweep.workerIntervalMs);
    workerInterval.unref();

  } catch (err: any) {
    logger.error('Failed to start server', { error: err.message });
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received — shutting down');
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received — shutting down');
  process.exit(0);
});

start();

export default app;
